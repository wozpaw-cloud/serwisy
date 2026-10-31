// Odczyt pojedynczego cennika (CSV, XLSX, XML, JSON) do wspólnego rekordu.

import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import ExcelJS from 'exceljs';
import { mapColumns, missingRequired, type ColumnMap, type Field } from './columns.ts';
import { cleanVoivodeship, fold, isEmpty, parseDate, parseNumber, titleCase } from './normalize.ts';

export type UnitType = 'mieszkanie' | 'dom';
export type OfferStatus = 'dostepny' | 'zarezerwowany' | 'sprzedany' | null;

export interface PriceRecord {
  devName: string;
  devKrs: string | null;
  devNip: string | null;
  devWebsite: string | null;
  voivodeship: string | null;
  county: string | null;
  gmina: string | null;
  city: string;
  street: string | null;
  buildingNo: string | null;
  postalCode: string | null;
  investmentName: string | null;
  unitType: UnitType;
  unitRef: string;
  priceM2: number;
  priceM2Date: string | null;
  priceTotal: number | null;
  priceFull: number | null;
  area: number | null;
  rooms: number | null;
  status: OfferStatus;
  prospectusUrl: string | null;
}

export interface ParseResult {
  records: PriceRecord[];
  /** Pierwszy odrzucony wiersz dla każdego powodu (do diagnostyki). */
  rejectedSample?: Record<string, unknown[]>;
  rowsRead: number;
  /** wiersze lokali oznaczonych jako sprzedane: pomijane, ale to nie błąd */
  sold: number;
  rejected: Record<string, number>;
  unknownHeaders: string[];
  missingColumns: Field[];
  format: string;
  /** Nagłówki pliku (do diagnostyki odrzuconych plików). */
  headers?: string[];
}

export type Table = { headers: string[]; rows: unknown[][] };

// ---------- odczyt tabeli z pliku ----------

export async function readTable(buf: Buffer, format: string): Promise<Table> {
  const f = format.toLowerCase();
  if (f === 'xlsx' || f === 'xls') return readXlsx(buf);
  if (f === 'xml') return readXml(decode(buf));
  if (f === 'json') return readJson(decode(buf));
  return readCsv(decode(buf));
}

// Znak -> bajt w Windows-1250 (do naprawy tekstu UTF-8 odczytanego jako Windows-1250).
const CP1250 = (() => {
  const d = new TextDecoder('windows-1250');
  const m = new Map<string, number>();
  for (let b = 0; b < 256; b++) { const c = d.decode(Uint8Array.of(b)); if (!m.has(c)) m.set(c, b); }
  return m;
})();
// Polskie litery z UTF-8 odczytane jako Windows-1250: "WojewĂłdztwo", "uwzglÄ™dniajÄ…ca", "dziaĹ‚alnoĹ›ci".
const MOJIBAKE = /Ä[…‡™„†]|Ĺ[‚„›şĽ\u0081]|Ă[łšÓ]/g;
const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g;

/** Naprawia tekst z "krzakami" (UTF-8 zapisany albo odczytany jako Windows-1250). */
export function repairMojibake(s: string): string {
  const bad = s.match(MOJIBAKE)?.length ?? 0;
  if (bad < 3 || bad <= (s.match(POLISH)?.length ?? 0) - bad) return s;
  const bytes: number[] = [];
  for (const ch of s) {
    const b = CP1250.get(ch);
    if (b !== undefined) bytes.push(b);
    else bytes.push(...Buffer.from(ch, 'utf8'));
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

/** UTF-8; Windows-1250, gdy większość znaków spoza ASCII to błędne sekwencje UTF-8.
 *  Pojedyncze błędne bajty w pliku UTF-8 nie przełączają kodowania. */
export function decode(buf: Buffer): string {
  let s = new TextDecoder('utf-8').decode(buf);
  const invalid = s.match(/\uFFFD/g)?.length ?? 0;
  if (invalid) {
    const nonAscii = s.match(/[^\x00-\x7F]/g)?.length ?? 0;
    if (invalid > nonAscii * 0.3) s = new TextDecoder('windows-1250').decode(buf);
  }
  return repairMojibake(s).replace(/^\uFEFF/, '');
}

export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [';', ',', '\t', '|'].map((d) => [d, first.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}

export function readCsv(text: string): Table {
  const rows: string[][] = parseCsv(text, {
    delimiter: detectDelimiter(text),
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    bom: true,
  });
  const headerIdx = findHeaderRow(rows);
  return { headers: (rows[headerIdx] ?? []).map(String), rows: rows.slice(headerIdx + 1) };
}

/** Wartość komórki Excela: formuła -> wynik, tekst sformatowany -> zwykły tekst, link -> tekst. */
function xlsxValue(v: unknown): unknown {
  if (!v || typeof v !== 'object' || v instanceof Date) return v;
  const o = v as { result?: unknown; text?: unknown; richText?: { text?: string }[]; error?: unknown };
  if ('richText' in o && Array.isArray(o.richText)) return o.richText.map((p) => p.text ?? '').join('');
  if ('result' in o) return xlsxValue(o.result);
  if ('text' in o) return xlsxValue(o.text);
  if ('error' in o) return null;
  return v;
}

async function readXlsx(buf: Buffer): Promise<Table> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = (row.values as unknown[]).slice(1).map(xlsxValue);
    rows.push(vals);
  });
  const headerIdx = findHeaderRow(rows);
  return { headers: (rows[headerIdx] ?? []).map((v) => String(v ?? '')), rows: rows.slice(headerIdx + 1) };
}

/** Wiersz nagłówka to pierwszy wiersz, w którym rozpoznajemy co najmniej 3 pola. */
function findHeaderRow(rows: unknown[][]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const { map } = mapColumns(rows[i].map((v) => String(v ?? '')));
    if (Object.keys(map).length >= 3) return i;
  }
  return 0;
}

// Pliki XML i JSON nie mają nagłówków po polsku, tylko klucze w rodzaju
// "cenaM2" albo "nr_lokalu". Najpierw rozbijamy klucz na słowa, a gdy reguły
// nagłówków nie zadziałają, korzystamy ze słownika aliasów.
const KEY_ALIASES: Record<string, Field> = {
  nazwadewelopera: 'devName', deweloper: 'devName', krs: 'devKrs', nip: 'devNip',
  stronainternetowa: 'devWebsite', www: 'devWebsite',
  wojewodztwo: 'voivodeship', powiat: 'county', gmina: 'gmina', miejscowosc: 'city', miasto: 'city',
  ulica: 'street', nrnieruchomosci: 'buildingNo', kodpocztowy: 'postalCode',
  nazwainwestycji: 'investmentName', inwestycja: 'investmentName',
  rodzajnieruchomosci: 'unitType', rodzaj: 'unitType',
  nrlokalu: 'unitRef', numerlokalu: 'unitRef', oznaczenielokalu: 'unitRef', idlokalu: 'unitRef',
  cenam2: 'priceM2', cenazam2: 'priceM2', cenametra: 'priceM2',
  datacenym2: 'priceM2Date', cenacalkowita: 'priceTotal', cena: 'priceTotal', cenabrutto: 'priceTotal',
  powierzchnia: 'area', powierzchniauzytkowa: 'area', liczbapokoi: 'rooms', pokoje: 'rooms',
  status: 'status', prospekt: 'prospectusUrl',
  // Eksport jednego z systemów sprzedaży (klucze po angielsku).
  number: 'unitRef', unitnumber: 'unitRef', pricepermeter: 'priceM2', priceperm2: 'priceM2', totalprice: 'priceTotal',
  area: 'area', fulladdress: 'address', issold: 'status', city: 'city', kind: 'unitType',
};

function keyToHeader(k: string): string {
  return k.replace(/([a-ząćęłńóśźż])([A-ZĄĆĘŁŃÓŚŹŻ0-9])/g, '$1 $2').replace(/[_\-.]+/g, ' ');
}

function tableFromObjects(objs: Record<string, unknown>[]): Table {
  const keys = [...new Set(objs.flatMap((o) => Object.keys(o)))];
  const headers = keys.map((k) => {
    const h = keyToHeader(k);
    if (Object.keys(mapColumns([h]).map).length) return h;
    const alias = KEY_ALIASES[fold(k).replace(/\s+/g, '')];
    return alias ? ALIAS_HEADERS[alias] : h;
  });
  return { headers, rows: objs.map((o) => keys.map((k) => flatten(o[k]))) };
}

function flatten(v: unknown): unknown {
  if (v && typeof v === 'object' && '#text' in (v as object)) return (v as Record<string, unknown>)['#text'];
  return v;
}

// Nagłówki kanoniczne, które reguły z columns.ts rozpoznają jednoznacznie.
const ALIAS_HEADERS: Record<Field, string> = {
  devName: 'Nazwa dewelopera', devKrs: 'Nr KRS', devNip: 'NIP',
  devWebsite: 'Adres strony internetowej dewelopera', prospectusUrl: 'Prospekt informacyjny',
  voivodeship: 'Województwo lokalizacji', county: 'Powiat lokalizacji', gmina: 'Gmina lokalizacji',
  city: 'Miejscowość lokalizacji', address: 'Adres inwestycji', street: 'Ulica lokalizacji',
  salesCity: 'Miejscowość adresu lokalu, w którym prowadzona jest sprzedaż', salesVoiv: 'Województwo adresu lokalu, w którym prowadzona jest sprzedaż',
  seatCity: 'Miejscowość adresu siedziby dewelopera', seatVoiv: 'Województwo adresu siedziby dewelopera', buildingNo: 'Nr nieruchomości lokalizacji',
  postalCode: 'Kod pocztowy lokalizacji', investmentName: 'Nazwa inwestycji',
  unitType: 'Rodzaj nieruchomości', unitRef: 'Nr lokalu lub domu',
  priceM2: 'Cena m2 powierzchni użytkowej', priceM2Date: 'Data od której obowiązuje cena m2 powierzchni',
  priceTotal: 'Cena lokalu stanowiąca iloczyn', priceTotalDate: 'Data obowiązywania ceny iloczyn',
  priceFull: 'Cena lokalu uwzględniająca', priceFullDate: 'Data od której obowiązuje cena lokalu uwzględniająca',
  area: 'Powierzchnia użytkowa', rooms: 'Liczba pokoi', status: 'Status',
};

/** Największa tablica obiektów w drzewie: tam leżą lokale. */
function largestObjectArray(node: unknown): Record<string, unknown>[] {
  let best: Record<string, unknown>[] = [];
  const visit = (n: unknown) => {
    if (Array.isArray(n)) {
      const objs = n.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown>[];
      if (objs.length > best.length) best = objs;
      n.forEach(visit);
    } else if (n && typeof n === 'object') {
      Object.values(n).forEach(visit);
    }
  };
  visit(node);
  return best;
}

export function readXml(text: string): Table {
  const doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false, isArray: () => false }).parse(text);
  // Powtórzony element (np. <lokal>) parser zwraca jako tablicę obiektów.
  return tableFromObjects(largestObjectArray(doc));
}

export function readJson(text: string): Table {
  return tableFromObjects(largestObjectArray(JSON.parse(text)));
}

// ---------- zamiana na rekordy ----------

function cell(row: unknown[], map: ColumnMap, f: Field): unknown {
  const i = map[f];
  return i === undefined ? null : row[i];
}

function text(v: unknown): string | null {
  if (isEmpty(v)) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s || null;
}

function unitTypeOf(v: unknown): UnitType {
  return /dom|house/.test(fold(String(v ?? ''))) ? 'dom' : 'mieszkanie';
}

function statusOf(v: unknown): OfferStatus {
  const s = fold(String(v ?? ''));
  if (!s) return null;
  if (s.includes('sprzed')) return 'sprzedany';
  if (s.includes('rezerw')) return 'zarezerwowany';
  if (s.includes('dostep') || s.includes('wolny') || s.includes('w sprzedazy')) return 'dostepny';
  // Kolumna "is sold" / "sprzedany": tak/nie.
  if (s === 'true' || s === 'tak' || s === 'sold') return 'sprzedany';
  if (s === 'false' || s === 'nie' || s === 'available') return 'dostepny';
  return null;
}

// Granice wiarygodności. Wiersze spoza nich odrzucamy z podaniem powodu.
// Powierzchnia od 15 m²: mniejsze pozycje to zwykle miejsca postojowe i komórki bez opisu.
export const LIMITS = { priceM2: [2500, 100000], priceTotal: [50000, 60000000], area: [15, 800] } as const;

/** Format z zawartości pliku. Etykieta w portalu bywa myląca (np. "csv" przy pliku Excel). */
export function sniffFormat(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'xlsx';
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'xls-stary';
  const head = buf.subarray(0, 200).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<')) return 'xml';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return null;
}

/**
 * Nazwa dewelopera z tytułu zbioru, gdy plik nie ma takiej kolumny:
 * "Ceny ofertowe mieszkań dewelopera X sp. z o.o. w 2026 r." -> "X sp. z o.o.".
 */
export function devNameFromTitle(title: string | undefined): string | null {
  if (!title) return null;
  const t = title.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const m = t.match(/dewelopera\s+(.+)$/i);
  const name = (m ? m[1] : t.replace(/^ceny ofertowe\s+(\S+\s+)?/i, ''))
    .replace(/\s+(w|za)\s+(roku\s+)?20\d\d\s*(r\.?|roku)?.*$/i, '')
    .replace(/\s+(na dzień|z dnia|stan na)\s+.*$/i, '')
    .replace(/\s*[-–—]\s*(inwestycja|20\d\d|\d{2}\.\d{2}).*$/i, '')
    .replace(/\s+\d{2}\.\d{2}\.\d{4}.*$/, '')
    .replace(/\s+20\d\d-\d\d-\d\d.*$/, '')
    .trim();
  return name.length >= 2 ? name : null;
}

/** Miejscowość z całego adresu: "ul. Polna 5, 62-002 Suchy Las" -> "Suchy Las". */
export function cityFromAddress(address: string | null): string | null {
  if (!address) return null;
  const a = address.replace(/\s+/g, ' ').trim();
  const m = a.match(/\b\d{2}-\d{3}\s+([^\d,;()]+?)(?=\s*(?:,|;|\(|$|\bul\.|\bal\.|\d))/u);
  if (m) return m[1].trim();
  const part = a.split(/[,;]/).map((p) => p.trim()).find((p) => p && !/\d/.test(p) && !/^(ul|al|os|pl|osiedle)\.?\s/i.test(p));
  return part || null;
}

// Pozycje cennika, które nie są lokalem mieszkalnym ani domem.
const NOT_DWELLING = /parking|postoj|garaz|komork|hala|uslug|uzytkow|biur|magazyn|piwnic|rower|handlow|lokal komerc|przyleglos|garage|storage|commercial|cellar|office|bike/;

export function toRecords(table: Table, format = 'csv', opts: { devFallback?: string | null } = {}): ParseResult {
  const { map, unknown } = mapColumns(table.headers);
  const missing = missingRequired(map);
  const rejected: Record<string, number> = {};
  const rejectedSample: Record<string, unknown[]> = {};
  let current: unknown[] = [];
  const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; rejectedSample[why] ??= current; };
  const records: PriceRecord[] = [];
  let sold = 0;
  // Plik bez numerów lokali (brak kolumny albo prawie same puste wartości): lokal
  // rozpoznajemy po rodzaju i powierzchni, z licznikiem dla powtórzeń w pliku.
  const refFilled = map.unitRef === undefined ? 0
    : table.rows.filter((r) => r && !isEmpty(r[map.unitRef!])).length / Math.max(1, table.rows.length);
  const syntheticRefs = refFilled < 0.1;
  const refCount = new Map<string, number>();
  if (missing.length) {
    return { records, rowsRead: table.rows.length, sold: 0, rejected: { 'brak wymaganych kolumn': table.rows.length }, unknownHeaders: unknown, missingColumns: missing, format, headers: table.headers };
  }

  for (const row of table.rows) {
    if (!row || row.every((v) => isEmpty(v))) continue;
    current = row;
    const devName = text(cell(row, map, 'devName')) ?? opts.devFallback ?? null;
    // Miejsce: inwestycja, potem cały adres, potem biuro sprzedaży, na końcu siedziba dewelopera.
    const invCity = text(cell(row, map, 'city')) ?? cityFromAddress(text(cell(row, map, 'address')));
    const salesCity = invCity ? null : text(cell(row, map, 'salesCity'));
    const seatCity = invCity || salesCity ? null : text(cell(row, map, 'seatCity'));
    const cityRaw = invCity ?? salesCity ?? seatCity;
    const voivRaw = invCity ? text(cell(row, map, 'voivodeship')) : salesCity ? text(cell(row, map, 'salesVoiv')) : text(cell(row, map, 'seatVoiv'));
    if (NOT_DWELLING.test(fold(String(cell(row, map, 'unitType') ?? '')))) { reject('nie lokal mieszkalny (parking, komórka, usługi)'); continue; }
    if (!devName || !cityRaw) { reject('brak dewelopera lub miejscowości'); continue; }

    // Zero i liczby ujemne traktujemy jak brak wartości (np. "0.00" zamiast ceny za m²).
    const positive = (v: number | null) => (v !== null && v > 0 ? v : null);
    let priceM2 = positive(parseNumber(cell(row, map, 'priceM2')));
    let priceTotal = positive(parseNumber(cell(row, map, 'priceTotal')));
    const priceFull = positive(parseNumber(cell(row, map, 'priceFull')));
    let area = positive(parseNumber(cell(row, map, 'area')));
    if (priceTotal === null && priceFull !== null && priceM2 !== null && area !== null) priceTotal = priceFull;
    if (area === null && priceM2 && priceTotal) area = Math.round((priceTotal / priceM2) * 100) / 100;
    if (priceM2 === null && priceTotal && area) priceM2 = Math.round((priceTotal / area) * 100) / 100;

    // Numer lokalu. Gdy go brak (cały plik bez numerów albo "n/d" przy domu), a lokal ma
    // cenę i powierzchnię, rozpoznajemy go po rodzaju i metrażu: "lokal 142,43 m²".
    let unitRef = text(cell(row, map, 'unitRef'));
    if (!unitRef && area && (priceM2 || priceTotal) && (syntheticRefs || map.unitRef !== undefined)) {
      const base = `${unitTypeOf(cell(row, map, 'unitType')) === 'dom' ? 'dom' : 'lokal'} ${area.toFixed(2).replace('.', ',')} m²`;
      const n = (refCount.get(base) ?? 0) + 1;
      refCount.set(base, n);
      unitRef = n > 1 ? `${base} (${n})` : base;
    }
    if (!unitRef) { reject('brak numeru lokalu'); continue; }

    if (priceM2 === null) { reject('brak ceny za m²'); continue; }
    if (priceM2 < LIMITS.priceM2[0] || priceM2 > LIMITS.priceM2[1]) { reject('cena za m² poza zakresem'); continue; }
    if (priceTotal !== null && (priceTotal < LIMITS.priceTotal[0] || priceTotal > LIMITS.priceTotal[1])) { reject('cena całkowita poza zakresem'); continue; }
    if (area !== null && (area < LIMITS.area[0] || area > LIMITS.area[1])) { reject('powierzchnia poza zakresem'); continue; }

    const status = statusOf(cell(row, map, 'status'));
    if (status === 'sprzedany') { sold++; continue; }

    const roomsN = parseNumber(cell(row, map, 'rooms'));
    records.push({
      devName,
      devKrs: text(cell(row, map, 'devKrs')),
      devNip: text(cell(row, map, 'devNip'))?.replace(/\D/g, '') || null,
      devWebsite: text(cell(row, map, 'devWebsite')),
      voivodeship: cleanVoivodeship(voivRaw),
      // Powiat i gminę bierzemy tylko z adresu inwestycji; przy mieście z biura lub siedziby
      // gminę uzupełnia model danych na podstawie innych cenników z tej miejscowości.
      county: invCity ? text(cell(row, map, 'county')) : null,
      gmina: invCity ? text(cell(row, map, 'gmina')) : null,
      city: titleCase(cityRaw),
      street: text(cell(row, map, 'street')),
      buildingNo: text(cell(row, map, 'buildingNo')),
      postalCode: text(cell(row, map, 'postalCode')),
      investmentName: text(cell(row, map, 'investmentName')),
      unitType: unitTypeOf(cell(row, map, 'unitType')),
      unitRef,
      priceM2: Math.round(priceM2 * 100) / 100,
      priceM2Date: parseDate(cell(row, map, 'priceM2Date')),
      priceTotal: priceTotal === null ? null : Math.round(priceTotal),
      priceFull: priceFull === null ? null : Math.round(priceFull),
      area,
      rooms: roomsN !== null && roomsN >= 1 && roomsN <= 12 ? Math.round(roomsN) : null,
      status,
      prospectusUrl: text(cell(row, map, 'prospectusUrl')),
    });
  }
  return { records, rowsRead: table.rows.length, sold, rejected, rejectedSample, unknownHeaders: unknown, missingColumns: [], format, headers: table.headers };
}

export async function parseFile(buf: Buffer, format: string, opts: { devFallback?: string | null } = {}): Promise<ParseResult> {
  const f = sniffFormat(buf) ?? format;
  if (f === 'xls-stary') throw new Error('stary format Excel (.xls) nie jest obsługiwany');
  return toRecords(await readTable(buf, f), f, opts);
}

export function guessFormat(nameOrUrl: string, contentType = ''): string {
  const s = (nameOrUrl + ' ' + contentType).toLowerCase();
  if (/\.xlsx?\b|spreadsheet|excel/.test(s)) return 'xlsx';
  if (/\.xml\b|\/xml/.test(s)) return 'xml';
  if (/\.json\b|\/json/.test(s)) return 'json';
  return 'csv';
}
