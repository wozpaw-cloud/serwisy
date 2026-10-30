// Rozpoznawanie kolumn cennika po treści nagłówka, a nie po jego pozycji.
// Deweloperzy korzystają z wzorcowego pliku Ministerstwa Cyfryzacji, ale część
// skraca nagłówki, zmienia kolejność albo dodaje własne kolumny. Każdą kolumnę
// opisujemy regułą na znormalizowanym tekście nagłówka (bez polskich znaków).

import { fold } from './normalize.ts';

export type Field =
  | 'devName' | 'devKrs' | 'devNip' | 'devWebsite'
  | 'voivodeship' | 'county' | 'gmina' | 'city' | 'street' | 'buildingNo' | 'postalCode' | 'address'
  | 'investmentName' | 'unitType' | 'unitRef'
  | 'priceM2' | 'priceM2Date' | 'priceTotal' | 'priceTotalDate' | 'priceFull' | 'priceFullDate'
  | 'area' | 'rooms' | 'status' | 'prospectusUrl';

type Rule = (h: string) => boolean;
const has = (...parts: string[]): Rule => (h) => parts.every((p) => h.includes(p));
const not = (r: Rule, ...parts: string[]): Rule => (h) => r(h) && !parts.some((p) => h.includes(p));
const startsData = (h: string) => h.startsWith('data');
// Kolumna adresu inwestycji: "Miejscowość lokalizacji…" albo "Lokalizacja … - miejscowość".
// Adres siedziby dewelopera i biura sprzedaży pomijamy.
const NOT_INVESTMENT = /siedzib|glownego miejsca|sprzedaz|korespond|kontakt/;
const loc = (word: RegExp, bare: string[] = []): Rule => (h) =>
  !NOT_INVESTMENT.test(h) && ((h.includes('lokalizacj') && word.test(h)) || bare.includes(h));
// "iloczyn" bywa z literówką ("iloczym").
const ILOCZYN = /iloczy/;
const M2 = /\bm ?2\b|\bmetr/;
// Ceny, które nie są ceną lokalu: wykończenie, udział w gruncie, parking, promocje czasowe.
const NOT_UNIT_PRICE = /wykonczen|udzial|grunt|postoj|parking|garaz|komork|pomieszczen|promocj|obowiazuje|czesci/;

// Kolejność ma znaczenie: pierwsza pasująca reguła wygrywa, a każdy nagłówek
// przypisujemy do co najwyżej jednego pola.
const RULES: [Field, Rule][] = [
  ['devName', (h) => h.startsWith('nazwa dewelopera') || h === 'deweloper'],
  ['devKrs', (h) => /\bkrs\b/.test(h) && !h.includes('ceidg')],
  ['devNip', (h) => /\bnip\b/.test(h)],
  ['devWebsite', has('strony internetowej dewelopera')],
  ['prospectusUrl', has('prospekt')],

  ['voivodeship', loc(/wojewodztw/, ['wojewodztwo'])],
  ['county', loc(/powiat/, ['powiat'])],
  ['gmina', loc(/\bgmin/, ['gmina'])],
  ['city', loc(/miejscowosc|miasto/, ['miejscowosc', 'miasto', 'miejscowosc inwestycji', 'lokalizacja miejscowosc', 'miasto inwestycji'])],
  // Cały adres w jednej kolumnie: miasto wyciągamy z adresu, gdy nie ma osobnej kolumny.
  ['address', (h) => h === 'adres' || /^adres (inwestycji|lokalu|nieruchomosci|przedsiewziecia)$/.test(h) ||
    /^lokalizacja( przedsiewzi[e]?cia deweloperskiego| inwestycji)?$/.test(h)],
  ['street', loc(/\bulic/, ['ulica'])],
  ['buildingNo', loc(/\b(nr|numer) (nieruchomosci|budynku|domu)\b/, ['nr budynku', 'numer budynku'])],
  ['postalCode', loc(/kod pocztow/, ['kod pocztowy'])],
  ['investmentName', (h) => /nazwa (inwestycji|przedsiewziecia|zadania|projektu)/.test(h)],

  ['unitType', (h) => has('rodzaj nieruchomosci')(h) ||
    ['typ', 'rodzaj', 'produkt', 'kategoria produktu', 'rodzaj lokalu', 'typ lokalu', 'typ nieruchomosci', 'rodzaj produktu'].includes(h)],
  ['unitRef', (h) =>
    (/^(nr|numer) (lokalu lub domu|lokalu|domu|nieruchomosci nadany|produktu)/.test(h) || /^oznaczenie (lokalu|nieruchomosci|domu)/.test(h)) &&
    !/adres|siedzib|sprzedaz|korespond|lokalizacj/.test(h)],

  ['priceM2Date', (h) => (startsData(h) && h.includes('cena') && M2.test(h) && !ILOCZYN.test(h)) ||
    /^cena (za )?m ?2 obowiazuje od/.test(h) || h === 'data zmiany ceny' || h === 'data od ktorej obowiazuje cena'],
  ['priceTotalDate', (h) => (startsData(h) && ILOCZYN.test(h) && !h.includes('uwzgledn')) || h.startsWith('cena obowiazuje od')],
  ['priceFullDate', (h) => startsData(h) && h.includes('uwzgledn') && h.includes('lokal')],
  ['priceM2', (h) => !startsData(h) && h.includes('cena') && M2.test(h) &&
    !/iloczy|uwzgledn|calkowit|razem/.test(h) && !NOT_UNIT_PRICE.test(h)],
  ['priceTotal', (h) => !startsData(h) && !h.includes('uwzgledn') && !NOT_UNIT_PRICE.test(h) &&
    (ILOCZYN.test(h) || h === 'cena' || /^cena (pln|zl|brutto pln|brutto zl)$/.test(h) ||
     (/^(calkowita )?cena (lokalu|domu|nieruchomosci|calkowita|brutto|produktu|ofertowa)/.test(h) && !M2.test(h)))],
  ['priceFull', (h) => !startsData(h) && h.includes('uwzgledn') && h.startsWith('cena lokalu')],

  ['area', (h) => !h.includes('cena') && !/dzialk|ogrod|taras|balkon|komork|garaz|postoj|loggi|calkowit|piwnic/.test(h) &&
    (h === 'powierzchnia' || h === 'metraz' || h.startsWith('powierzchni') || /^pow (uzytk|lokalu)/.test(h))],
  ['rooms', (h) => h.includes('liczba pokoi') || h === 'pokoje' || /^ilosc pok/.test(h)],
  ['status', (h) => h === 'status' || h.startsWith('status ')],
];

export type ColumnMap = Partial<Record<Field, number>>;

// Kolumny wzorcowego pliku, które znamy, ale do analiz nie potrzebujemy.
// Nie trafiają do listy "nieznanych nagłówków", więc nie wywołują alarmu.
const IGNORED: Rule[] = [
  (h) => /siedzib|glownego miejsca|sprzedaz|kontaktu|\bid\b|pietro|kondygnacj|stawka vat|waluta|strony internetowej inwestycji/.test(h),
  (h) => /forma prawna|ceidg|regon|telefon|poczty elektronicznej|faks|fax/.test(h),
  (h) => /czesci nieruchomosci|pomieszczen przynaleznych|praw niezbednych|innych swiadczen|inne swiadczenia/.test(h),
  (h) => startsData(h),
];

/** Mapuje nagłówki pliku na pola. Zwraca też nagłówki, których nie rozpoznano. */
export function mapColumns(headers: string[]): { map: ColumnMap; unknown: string[] } {
  const map: ColumnMap = {};
  const unknown: string[] = [];
  headers.forEach((raw, i) => {
    const h = fold(raw ?? '');
    if (!h) return;
    const hit = RULES.find(([field, rule]) => map[field] === undefined && rule(h));
    if (hit) map[hit[0]] = i;
    else if (!IGNORED.some((r) => r(h))) unknown.push(raw);
  });
  // Brak numeru lokalu w typowej postaci: kolejno sprawdzamy inne nazwy kolumny,
  // które jednoznacznie wskazują lokal (identyfikator, oznaczenie, numer).
  if (map.unitRef === undefined) {
    const folded = headers.map((raw) => fold(raw ?? ''));
    const FALLBACK: RegExp[] = [
      /^id (lokalu|nieruchomosci|domu|mieszkania)$/, /^nazwa (mieszkania|lokalu)$/, /^oznaczenie$/, /^numer lokalu$/,
      /^(nr|numer)$/, /^kod produktu$/, /^lokal$/, /^nr lokalu lokalizacji/,
    ];
    for (const re of FALLBACK) {
      const i = folded.findIndex((h) => re.test(h));
      if (i >= 0) { map.unitRef = i; const u = unknown.indexOf(headers[i]); if (u >= 0) unknown.splice(u, 1); break; }
    }
  }
  return { map, unknown };
}

/** Minimalny zestaw pól, bez którego plik nie nadaje się do analizy:
 *  miejsce (miejscowość albo cały adres), numer lokalu i cena za m² (albo cena
 *  całkowita z powierzchnią, z których ją wyliczamy). Nazwę dewelopera, gdy jej
 *  brak w pliku, bierzemy z tytułu zbioru (parse.ts). */
export const REQUIRED: Field[] = ['city', 'unitRef', 'priceM2'];

export function missingRequired(map: ColumnMap): Field[] {
  const out: Field[] = [];
  if (map.city === undefined && map.address === undefined) out.push('city');
  if (map.unitRef === undefined) out.push('unitRef');
  if (map.priceM2 === undefined && !(map.priceTotal !== undefined && map.area !== undefined)) out.push('priceM2');
  return out;
}
