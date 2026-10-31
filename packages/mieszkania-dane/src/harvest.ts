// Pobieranie cenników z dane.gov.pl (API 1.4, format JSON:API).
//
// Sprawdzone na prawdziwym API (30.10.2026, komenda "probe" w GitHub Actions):
//  - zbiory deweloperów mają tytuł "Ceny ofertowe mieszkań/domów …"; filtr
//    title[phrase]=ceny ofertowe zwraca tylko je (ok. 18,6 tys. zbiorów),
//    a wyszukiwanie pełnotekstowe (q=) zwraca dziesiątki tysięcy innych zbiorów;
//  - paginacja kończy się na 10 000 wyników, więc listę pobieramy dwa razy:
//    rosnąco i malejąco po id, i łączymy (wystarcza do 20 000 zbiorów);
//  - zasób (dzienny cennik) ma pola data_date (RRRR-MM-DD), download_url, format.

import type { DatabaseSync } from 'node:sqlite';
import { ingestSnapshot, type IngestSummary } from './ingest.ts';
import { devNameFromTitle, guessFormat, parseFile, readTable, sniffFormat, type ParseResult } from './parse.ts';
import { mapColumns } from './columns.ts';

export const API = process.env.DANE_API ?? 'https://api.dane.gov.pl/1.4';
const UA = 'prostedane.pl importer (kontakt@prostedane.pl)';
// Tytuły bywają różne: "Ceny ofertowe mieszkań/domów/lokali …", "Ceny ofertowe inwestycji …",
// "Ceny ofertowe nieruchomości dewelopera …". Pliki bez kolumn cennika odrzuca import.
const TITLE_RE = /ceny ofertowe/i;
const TITLE_PHRASE = 'ceny ofertowe';
const WINDOW = 10000;

interface ApiItem { id: string | number; attributes?: Record<string, unknown>; links?: Record<string, unknown> }
interface ApiList { data?: ApiItem[]; links?: { next?: string | null }; meta?: Record<string, unknown> }

export interface DatasetRef { id: string; title: string }
/** urls: adresy pliku po kolei (kopia w dane.gov.pl, potem link dewelopera); stored: plik
 *  ma kopię w dane.gov.pl (link do serwera dewelopera pokazuje zawsze bieżący cennik). */
export interface ResourceRef { id: string; date: string; url: string; urls: string[]; stored: boolean; format: string; raw: Record<string, unknown> }

/** Błąd zapytania (4xx poza 429): ponawianie nic nie da. */
class RequestError extends Error {}

async function getJson<T>(url: string, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} dla ${url}`);
      if (!res.ok) throw new RequestError(`HTTP ${res.status} dla ${url}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      if (e instanceof RequestError || i === tries - 1) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

/** Ogranicznik: najwyżej n zadań naraz. Parsowanie XLSX zajmuje dużo pamięci,
 *  więc pliki pobieramy równolegle, ale czytamy po jednym. */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <R>(fn: () => Promise<R>): Promise<R> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try { return await fn(); } finally { active--; queue.shift()?.(); }
  };
}
const parseSlot = limiter(Number(process.env.PARSE_CONCURRENCY ?? 1));

/**
 * Wszystkie zbiory z cenami ofertowymi. Szukamy po frazie i filtrujemy po tytule.
 * stopAfter: przerwij po tylu trafieniach (podgląd). Postęp idzie na stderr, żeby
 * w logu GitHub Actions było widać, że lista się pobiera.
 */
export async function listDeveloperDatasets(opts: { limitPages?: number; stopAfter?: number } = {}): Promise<DatasetRef[]> {
  const out = new Map<string, DatasetRef>();
  const limitPages = opts.limitPages ?? 120;
  const started = Date.now();
  let total = 0;
  for (const sort of ['id', '-id']) {
    for (let page = 1; page <= limitPages; page++) {
      const body = await getJson<ApiList>(`${API}/datasets?title[phrase]=${encodeURIComponent(TITLE_PHRASE)}&sort=${sort}&per_page=100&page=${page}`);
      total = Number(body.meta?.count ?? total);
      const items = body.data ?? [];
      for (const it of items) {
        const title = String(it.attributes?.title ?? '');
        if (TITLE_RE.test(title)) out.set(String(it.id), { id: String(it.id), title });
      }
      if (page % 20 === 0) console.error(`lista zbiorów (${sort}): strona ${page}, zbiorów ${out.size} z ${total}, ${Math.round((Date.now() - started) / 1000)} s`);
      if (opts.stopAfter && out.size >= opts.stopAfter) return [...out.values()].slice(0, opts.stopAfter);
      if (!items.length || !body.links?.next) break;
    }
    if (total <= WINDOW) break; // całość mieści się w jednym przebiegu
  }
  console.error(`lista zbiorów: ${out.size} zbiorów z cenami (portal podaje ${total} dla frazy w tytule)`);
  if (total > 2 * WINDOW) console.error(`UWAGA: zbiorów jest ponad ${2 * WINDOW}; część nie zmieściła się w dwóch przebiegach. Trzeba podzielić zapytanie.`);
  return [...out.values()];
}

/**
 * Diagnostyka API dane.gov.pl: kilka wariantów wyszukiwania (liczba wyników,
 * pierwsze tytuły, czas odpowiedzi) i surowe pola jednego zbioru i jego zasobów.
 * Wynik czytamy w logu GitHub Actions, żeby dopasować import do prawdziwego API.
 */
export async function probeApi(): Promise<void> {
  const show = async (label: string, url: string): Promise<ApiList | null> => {
    const t = Date.now();
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      console.log(`\n=== ${label}: HTTP ${res.status}, ${Date.now() - t} ms\n${url}`);
      let body: ApiList | null = null;
      try { body = JSON.parse(text) as ApiList; } catch { console.log(text.slice(0, 600)); return null; }
      console.log('meta:', JSON.stringify(body.meta ?? null).slice(0, 700));
      console.log('links:', JSON.stringify(body.links ?? null).slice(0, 500));
      for (const it of (body.data ?? []).slice(0, 8)) console.log(' -', it.id, '|', String(it.attributes?.title ?? '').slice(0, 140));
      return body;
    } catch (e) {
      console.log(`\n=== ${label}: BŁĄD ${(e as Error).message}\n${url}`);
      return null;
    }
  };
  const enc = encodeURIComponent;
  const bodies = [
    await show('fraza bez cudzysłowu', `${API}/datasets?q=${enc('ceny ofertowe mieszkań dewelopera')}&per_page=10`),
    await show('fraza w cudzysłowie', `${API}/datasets?q=${enc('"ceny ofertowe mieszkań"')}&per_page=10`),
    await show('filtr tytułu (phrase)', `${API}/datasets?title[phrase]=${enc('ceny ofertowe')}&per_page=10`),
    await show('filtr tytułu (match)', `${API}/datasets?title[match]=${enc('ceny ofertowe mieszkań')}&per_page=10`),
    await show('filtr tytułu, 100 na stronę, malejąco', `${API}/datasets?title[phrase]=${enc('ceny ofertowe')}&sort=-id&per_page=100`),
    await show('filtr tytułu, strona 100', `${API}/datasets?title[phrase]=${enc('ceny ofertowe')}&sort=id&per_page=100&page=100`),
  ];
  const hit = bodies.flatMap((b) => b?.data ?? []).find((it) => TITLE_RE.test(String(it.attributes?.title ?? '')));
  if (!hit) { console.log('\nŻaden wariant nie zwrócił zbioru z tytułem pasującym do', TITLE_RE); return; }
  const ds = await getJson<{ data?: ApiItem & { relationships?: unknown } }>(`${API}/datasets/${hit.id}`);
  console.log(`\n=== ZBIÓR ${hit.id}: atrybuty\n${JSON.stringify(ds.data?.attributes ?? null).slice(0, 4000)}`);
  console.log(`\n=== ZBIÓR ${hit.id}: powiązania\n${JSON.stringify((ds.data as { relationships?: unknown } | undefined)?.relationships ?? null).slice(0, 2000)}`);
  const rs = await getJson<ApiList>(`${API}/datasets/${hit.id}/resources?sort=-data_date&per_page=3`);
  console.log(`\n=== ZASOBY ZBIORU ${hit.id}: meta\n${JSON.stringify(rs.meta ?? null).slice(0, 600)}`);
  for (const r of (rs.data ?? []).slice(0, 2)) console.log(`\n--- zasób ${r.id}\n${JSON.stringify(r.attributes ?? null).slice(0, 4000)}`);
  await probeParse();
}

/**
 * Test czytania prawdziwych cenników: najnowszy plik z kilkunastu zbiorów
 * (różni deweloperzy, różne formaty), wynik importu i nierozpoznane kolumny.
 */
export async function probeParse(sample = 60): Promise<void> {
  // Zbiory z kilku miejsc listy (najnowsze, środek, najstarsze): różni deweloperzy i szablony.
  const pages = [
    `sort=-id&per_page=100`, `sort=id&per_page=100&page=40`, `sort=id&per_page=100&page=5`, `sort=-id&per_page=100&page=30`,
  ];
  const every = (xs: ApiItem[], n: number) => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / n)) === 0).slice(0, n);
  const picked: ApiItem[] = [];
  for (const q of pages) {
    const body = await getJson<ApiList>(`${API}/datasets?title[phrase]=${encodeURIComponent(TITLE_PHRASE)}&${q}`);
    picked.push(...every(body.data ?? [], sample / pages.length));
  }
  let units = 0, rowsAll = 0;
  const unknownAll = new Map<string, number>();
  let ok = 0;
  for (const it of picked) {
    const title = String(it.attributes?.title ?? '');
    try {
      const [res] = await listResources(String(it.id), 1);
      if (!res) { console.log(`\n### ${it.id} | ${title}\n   brak zasobu z plikiem`); continue; }
      const buf = await downloadAny(res.urls);
      const p = await parseFile(buf, res.format, { devFallback: devNameFromTitle(title) });
      if (p.records.length) ok++;
      units += p.records.length;
      rowsAll += p.rowsRead;
      for (const h of p.unknownHeaders) unknownAll.set(h, (unknownAll.get(h) ?? 0) + 1);
      const r = p.records[0];
      console.log(`\n### ${it.id} | ${title}\n   ${res.date} ${res.format} | wierszy ${p.rowsRead}, lokali ${p.records.length}, sprzedanych ${p.sold}` +
        `\n   odrzucone: ${JSON.stringify(p.rejected)} | brak kolumn: ${p.missingColumns.join(', ') || '-'}` +
        (r ? `\n   przykład: ${JSON.stringify({ dew: r.devName, woj: r.voivodeship, pow: r.county, gm: r.gmina, m: r.city, inw: r.investmentName, nr: r.unitRef, typ: r.unitType, pow_m2: r.area, zl_m2: r.priceM2, zl: r.priceTotal, data: r.priceM2Date })}` : ''));
      for (const [why, row] of Object.entries(p.rejectedSample ?? {})) {
        if (why === 'brak wymaganych kolumn') continue;
        const t = await readTable(buf, sniffFormat(buf) ?? res.format);
        const { map } = mapColumns(t.headers);
        const pick = Object.fromEntries(Object.entries(map).filter(([f]) => /city|unitRef|unitType|price|area|status|address|devName/.test(f)).map(([f, i]) => [f, (row as unknown[])[i as number]]));
        console.log(`   odrzucony („${why}”): ${JSON.stringify(pick).slice(0, 400)}`);
      }
      if (!p.records.length) {
        const table = await readTable(buf, sniffFormat(buf) ?? res.format);
        const { map } = mapColumns(table.headers);
        console.log(`   nagłówki (${sniffFormat(buf) ?? res.format}): ${JSON.stringify(table.headers)}\n   rozpoznane: ${JSON.stringify(map)}\n   pierwszy wiersz: ${JSON.stringify(table.rows[0] ?? null)}`);
      }
    } catch (e) {
      console.log(`\n### ${it.id} | ${title}\n   BŁĄD: ${(e as Error).message}`);
    }
  }
  console.log(`\n=== Wczytane z lokalami: ${ok} z ${picked.length} plików; lokali ${units} z ${rowsAll} wierszy`);
  console.log('=== Nierozpoznane nagłówki (ile plików):');
  for (const [h, n] of [...unknownAll].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`   ${n} × ${h}`);
}

const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v);
const DANE_HOST = /^https?:\/\/(api\.)?dane\.gov\.pl\//;

/** Adresy pliku zasobu: kopia w dane.gov.pl (download_url, file_url, files[]), potem link. */
function resourceUrls(a: Record<string, unknown>): string[] {
  const files = Array.isArray(a.files) ? (a.files as Record<string, unknown>[]) : [];
  const cands = [a.download_url, a.file_url, ...files.map((f) => f.download_url), a.link, a.url];
  return [...new Set(cands.filter(isUrl))];
}

function toResource(it: ApiItem): ResourceRef[] {
  const a = it.attributes ?? {};
  const urls = resourceUrls(a);
  const date = String(a.data_date ?? a.created ?? a.modified ?? '').slice(0, 10);
  if (!urls.length || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  // Data z przyszłości (literówka dewelopera, np. 2029) przesunęłaby "dziś" całego serwisu.
  if (date > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) return [];
  const stored = urls.some((u) => (DANE_HOST.test(u) || u.startsWith(new URL(API).origin)) && !/\/datasets\//.test(u));
  return [{ id: String(it.id), date, url: urls[0], urls, stored, format: guessFormat(urls.find((u) => /\.\w{3,4}(\?|$)/.test(u)) ?? urls[0], String(a.format ?? '')), raw: a }];
}

/** API przyjmuje najwyżej 100 wyników na stronę (więcej: HTTP 422). */
export const MAX_PER_PAGE = 100;

/** Najnowsze zasoby zbioru (od najnowszego). Każdy dzienny cennik to osobny zasób. */
export async function listResources(datasetId: string, perPage = 10): Promise<ResourceRef[]> {
  const body = await getJson<ApiList>(`${API}/datasets/${datasetId}/resources?sort=-data_date&per_page=${Math.min(perPage, MAX_PER_PAGE)}`);
  return (body.data ?? []).flatMap(toResource);
}

/** Wszystkie zasoby zbioru, strona po stronie (od najnowszego). Zbiór roczny
 *  z dziennymi cennikami ma ich do ok. 370, czyli 4 strony. */
export async function listAllResources(datasetId: string, maxPages = 30): Promise<ResourceRef[]> {
  const out: ResourceRef[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const body = await getJson<ApiList>(`${API}/datasets/${datasetId}/resources?sort=-data_date&per_page=${MAX_PER_PAGE}&page=${page}`);
    const items = body.data ?? [];
    out.push(...items.flatMap(toResource));
    if (items.length < MAX_PER_PAGE || !body.links?.next) break;
  }
  return out;
}

/** Pobiera plik zasobu: przy 404/410 próbuje kolejnego adresu (kopia, link dewelopera). */
async function downloadAny(urls: string[]): Promise<Buffer> {
  let last: unknown;
  for (const u of urls) {
    try { return await download(u); } catch (e) {
      last = e;
      if (!/HTTP (404|410|403)/.test(String((e as Error).message))) throw e;
    }
  }
  throw last;
}

/** Pobranie z ponowieniem po błędzie sieci, przekroczeniu czasu albo 429/5xx. */
async function download(url: string, maxBytes = 30 * 1024 * 1024, tries = 3): Promise<Buffer> {
  for (let i = 1; ; i++) {
    try {
      return await downloadOnce(url, maxBytes);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      const transient = /fetch failed|timeout|aborted|ECONNRESET|ETIMEDOUT|socket|HTTP (429|5\d\d)/i.test(msg);
      if (!transient || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function downloadOnce(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(90000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} przy pobieraniu ${url}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error(`plik za duży (${len} B)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`plik za duży (${buf.length} B)`);
  return buf;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export interface HarvestError { datasetId: string; error: string }

/** Odrzucone pliki pogrupowane po nagłówkach: materiał do ulepszania rozpoznawania kolumn. */
export interface RejectedFile { count: number; datasets: number; missing: string[]; rejected: Record<string, number>; headers: string[]; sample: unknown; example: { datasetId: string; date: string; url: string } }
export const rejectedFiles = new Map<string, RejectedFile & { ids: Set<string> }>();

function noteRejected(parsed: ParseResult, datasetId: string, date: string, url: string) {
  if (parsed.records.length > 0) return;
  const headers = (parsed.headers ?? []).map((h) => String(h).trim()).filter(Boolean);
  const key = parsed.missingColumns.join(',') + '|' + headers.map((h) => h.toLowerCase()).join('|');
  const cur = rejectedFiles.get(key);
  if (cur) { cur.count++; cur.ids.add(datasetId); return; }
  if (rejectedFiles.size >= 2000) return;
  rejectedFiles.set(key, {
    count: 1, datasets: 1, ids: new Set([datasetId]), missing: parsed.missingColumns, rejected: parsed.rejected,
    headers: headers.slice(0, 50), sample: Object.values(parsed.rejectedSample ?? {})[0] ?? null, example: { datasetId, date, url },
  });
}

/** Najczęstsze grupy odrzuconych plików (do pliku odrzucone.json). */
export function rejectedReport(limit = 200): RejectedFile[] {
  return [...rejectedFiles.values()].map(({ ids, ...r }) => ({ ...r, datasets: ids.size }))
    .sort((a, b) => b.datasets - a.datasets || b.count - a.count).slice(0, limit);
}

/** Stały dzień tygodnia (0-6) dla zbioru, z jego identyfikatora. */
function hashDay(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 7;
}

const lastSnapshots = (db: DatabaseSync) =>
  new Map((db.prepare('SELECT id, last_snapshot FROM datasets').all() as { id: string; last_snapshot: string | null }[]).map((r) => [String(r.id), r.last_snapshot]));

/** Ostatni dzień, z którego próbowaliśmy wczytać cennik zbioru (także odrzucony):
 *  ten sam plik nie jest pobierany drugi raz. */
const lastTriedDates = (db: DatabaseSync) =>
  new Map((db.prepare('SELECT dataset_id AS id, max(data_date) AS d FROM snapshots GROUP BY dataset_id').all() as { id: string; d: string }[]).map((r) => [String(r.id), r.d]));

/**
 * Codzienny import: dla każdego zbioru pobiera najnowszy cennik, jeśli jest
 * nowszy niż ostatnio wczytany. Pobieranie idzie równolegle, czytanie plików
 * i zapis do bazy po kolei (pamięć, SQLite). Najpierw zbiory najdawniej
 * aktualizowane: gdy skończy się limit czasu, pominięte zostaną te najświeższe.
 */
export async function harvest(db: DatabaseSync, opts: { concurrency?: number; dryRun?: boolean; limit?: number; minutes?: number; datasets?: DatasetRef[] } = {}) {
  const datasets = opts.datasets ?? (await listDeveloperDatasets({ stopAfter: opts.limit })).slice(0, opts.limit ?? Infinity);
  const last = lastSnapshots(db);
  const tried = lastTriedDates(db);
  const ordered = [...datasets].sort((a, b) => String(last.get(a.id) ?? '').localeCompare(String(last.get(b.id) ?? '')));
  const summaries: IngestSummary[] = [];
  const errors: HarvestError[] = [];
  const deadline = Date.now() + (opts.minutes ?? Infinity) * 60000;
  // Zbiory bez nowego cennika od ponad 45 dni (np. zbiory z poprzedniego roku: deweloperzy
  // zakładają nowy zbiór co rok) sprawdzamy raz w tygodniu, każdy innego dnia.
  const today = new Date().toISOString().slice(0, 10);
  const weekday = Math.floor(Date.parse(today) / 86400000) % 7;
  const dormant = (ds: DatasetRef) => {
    const prev = last.get(ds.id);
    return !!prev && Date.parse(today) - Date.parse(prev) > 45 * 86400000 && hashDay(ds.id) !== weekday;
  };
  let skippedDormant = 0;
  let skippedForTime = 0;
  let checked = 0;
  let lastLog = Date.now();

  await pool(ordered, opts.concurrency ?? 8, async (ds) => {
    if (!opts.limit && dormant(ds)) { skippedDormant++; return; }
    if (Date.now() >= deadline) { skippedForTime++; return; }
    if (Date.now() - lastLog > 60000) { lastLog = Date.now(); console.error(`import: ${checked} z ${ordered.length} zbiorów, nowych cenników ${summaries.length}, błędów ${errors.length}`); }
    try {
      const [res] = await listResources(ds.id, 1);
      if (!res) return;
      if (opts.dryRun) { console.log(JSON.stringify({ dataset: ds, resource: res.raw }, null, 1)); return; }
      const prev = last.get(ds.id);
      if (prev && prev >= res.date) return;
      const t = tried.get(ds.id);
      if (t && t >= res.date) return; // ten plik już był i został odrzucony
      const buf = await downloadAny(res.urls);
      await parseSlot(async () => {
        const parsed = await parseFile(buf, res.format, { devFallback: devNameFromTitle(ds.title) });
        noteRejected(parsed, ds.id, res.date, res.url);
        summaries.push(ingestSnapshot(db, { datasetId: ds.id, title: ds.title, date: res.date, sourceUrl: res.url }, parsed));
      });
    } catch (e) {
      errors.push({ datasetId: ds.id, error: String((e as Error).message ?? e) });
    } finally {
      checked++;
    }
  });
  console.error(`import: sprawdzono ${checked} zbiorów, nowych cenników ${summaries.length}, błędów ${errors.length}, uśpionych pominiętych ${skippedDormant}`);
  if (skippedForTime) console.error(`import: limit czasu, pominięto ${skippedForTime} zbiorów (wejdą jutro)`);
  return { datasets: datasets.length, summaries, errors, skippedForTime, skippedDormant };
}

/** Cenniki do historii: jeden na okres (domyślnie 28 dni) i zawsze najnowszy, jeden na dzień. */
export function choosePicks(all: ResourceRef[], stepDays = 28): ResourceRef[] {
  const sorted = [...all].sort((a, b) => a.date.localeCompare(b.date) || Number(b.stored) - Number(a.stored));
  // Do historii tylko pliki z kopią w dane.gov.pl: link do serwera dewelopera daje
  // dzisiejszy cennik, nie ten z dnia zasobu. Najnowszy cennik bierzemy zawsze.
  const periodic = new Map<number, ResourceRef>();
  for (const r of sorted.filter((x) => x.stored)) {
    const day = Math.floor(new Date(r.date + 'T00:00:00Z').getTime() / 86400000);
    periodic.set(Math.floor(day / stepDays), r); // zostaje ostatni cennik okresu
  }
  const latest = sorted.filter((x) => x.date === sorted.at(-1)?.date).sort((a, b) => Number(b.stored) - Number(a.stored))[0];
  const byDate = new Map<string, ResourceRef>();
  for (const r of [...periodic.values(), ...(latest ? [latest] : [])]) if (!byDate.has(r.date)) byDate.set(r.date, r);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Uzupełnienie historii. Najpierw lista cenników do wczytania ze wszystkich zbiorów,
 * potem wczytywanie dzień po dniu, od najstarszego: ten sam lokal bywa w dwóch
 * zbiorach (deweloperzy zakładają nowy zbiór co rok), więc historia musi wchodzić
 * w kolejności dat dla wszystkich zbiorów naraz. Pliki z jednego dnia pobieramy
 * równolegle, czytamy po jednym. Zbiór z wczytaną historią trafia do backfill_done;
 * po limicie czasu kolejne uruchomienie zaczyna od pierwszego niewczytanego dnia.
 * Błąd pojedynczego pliku nie zatrzymuje zbioru; błąd listy zasobów (API) tak.
 */
export async function backfill(db: DatabaseSync, opts: { datasets: DatasetRef[]; concurrency?: number; minutes?: number; stepDays?: number }) {
  const summaries: IngestSummary[] = [];
  const errors: HarvestError[] = [];
  const fileErrors: HarvestError[] = [];
  const done = new Set((db.prepare('SELECT dataset_id FROM backfill_done').all() as { dataset_id: string }[]).map((r) => r.dataset_id));
  const titles = new Map(opts.datasets.map((d) => [d.id, d.title]));
  const todo = opts.datasets.map((d) => d.id).filter((id) => !done.has(id));
  const markDone = db.prepare('INSERT OR REPLACE INTO backfill_done(dataset_id, finished) VALUES (?, ?)');
  // Ostatni wczytany dzień zbioru (także plik odrzucony): od niego wznawiamy.
  const lastTried = db.prepare('SELECT max(data_date) AS d FROM snapshots WHERE dataset_id = ?');
  const deadline = Date.now() + (opts.minutes ?? Infinity) * 60000;
  const conc = opts.concurrency ?? 10;
  let timedOut = false;
  let lastLog = Date.now();
  const log = (msg: () => string) => { if (Date.now() - lastLog > 60000) { lastLog = Date.now(); console.error(msg()); } };

  // 1. Lista cenników do wczytania.
  type Item = { id: string; date: string; urls: string[]; format: string; url: string };
  const plan: Item[] = [];
  const listed: string[] = [];
  let n = 0;
  await pool(todo, conc, async (id) => {
    if (Date.now() >= deadline) { timedOut = true; return; }
    log(() => `historia, lista cenników: ${n} z ${todo.length} zbiorów, cenników do wczytania ${plan.length}`);
    try {
      const picks = choosePicks(await listAllResources(id), opts.stepDays);
      const from = (lastTried.get(id) as { d: string | null } | undefined)?.d ?? '';
      for (const r of picks) if (r.date > from) plan.push({ id, date: r.date, urls: r.urls, format: r.format, url: r.url });
      listed.push(id);
    } catch (e) {
      errors.push({ datasetId: id, error: String((e as Error).message ?? e) });
    } finally {
      n++;
    }
  });
  console.error(`historia: lista gotowa, zbiorów ${listed.length}, cenników do wczytania ${plan.length}, błędów API ${errors.length}`);

  // 2. Wczytywanie dzień po dniu.
  plan.sort((a, b) => a.date.localeCompare(b.date));
  const lastDateOf = new Map<string, string>();
  for (const it of plan) lastDateOf.set(it.id, it.date);
  let doneUpTo = '';
  let k = 0;
  for (let i = 0; i < plan.length && !timedOut; ) {
    const date = plan[i].date;
    let j = i;
    while (j < plan.length && plan[j].date === date) j++;
    if (Date.now() >= deadline) { timedOut = true; break; }
    await pool(plan.slice(i, j), conc, async (it) => {
      try {
        const buf = await downloadAny(it.urls);
        await parseSlot(async () => {
          const parsed = await parseFile(buf, it.format, { devFallback: devNameFromTitle(titles.get(it.id)) });
          noteRejected(parsed, it.id, it.date, it.url);
          summaries.push(ingestSnapshot(db, { datasetId: it.id, title: titles.get(it.id), date: it.date, sourceUrl: it.url }, parsed));
        });
      } catch (e) {
        fileErrors.push({ datasetId: it.id, error: `${it.date}: ${String((e as Error).message ?? e)}` });
      } finally {
        k++;
      }
    });
    doneUpTo = date;
    i = j;
    log(() => `historia: dzień ${date}, plików ${k} z ${plan.length}, przyjętych ${summaries.filter((x) => x.status !== 'odrzucony').length}, błędów plików ${fileErrors.length}`);
  }

  // Zbiór jest gotowy, gdy wczytaliśmy wszystkie jego cenniki z planu.
  let finished = 0;
  const now = new Date().toISOString();
  for (const id of listed) {
    const last = lastDateOf.get(id);
    if (!last || (doneUpTo && last <= doneUpTo)) { markDone.run(id, now); finished++; }
  }
  return { summaries, errors, fileErrors, total: opts.datasets.length, todo: todo.length, remaining: todo.length - finished, timedOut, files: plan.length };
}
