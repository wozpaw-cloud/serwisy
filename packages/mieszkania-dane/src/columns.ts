// Rozpoznawanie kolumn cennika po treści nagłówka, a nie po jego pozycji.
// Deweloperzy korzystają z wzorcowego pliku Ministerstwa Cyfryzacji, ale część
// skraca nagłówki, zmienia kolejność albo dodaje własne kolumny. Każdą kolumnę
// opisujemy regułą na znormalizowanym tekście nagłówka (bez polskich znaków).

import { fold } from './normalize.ts';

export type Field =
  | 'devName' | 'devKrs' | 'devNip' | 'devWebsite'
  | 'voivodeship' | 'county' | 'gmina' | 'city' | 'street' | 'buildingNo' | 'postalCode'
  | 'investmentName' | 'unitType' | 'unitRef'
  | 'priceM2' | 'priceM2Date' | 'priceTotal' | 'priceTotalDate' | 'priceFull' | 'priceFullDate'
  | 'area' | 'rooms' | 'status' | 'prospectusUrl';

type Rule = (h: string) => boolean;
const has = (...parts: string[]): Rule => (h) => parts.every((p) => h.includes(p));
const not = (r: Rule, ...parts: string[]): Rule => (h) => r(h) && !parts.some((p) => h.includes(p));
const startsData = (h: string) => h.startsWith('data');

// Kolejność ma znaczenie: pierwsza pasująca reguła wygrywa, a każdy nagłówek
// przypisujemy do co najwyżej jednego pola.
const RULES: [Field, Rule][] = [
  ['devName', (h) => h.startsWith('nazwa dewelopera') || h === 'deweloper'],
  ['devKrs', (h) => /\bkrs\b/.test(h) && !h.includes('ceidg')],
  ['devNip', (h) => /\bnip\b/.test(h)],
  ['devWebsite', has('strony internetowej dewelopera')],
  ['prospectusUrl', has('prospekt')],

  ['voivodeship', has('wojewodztwo lokalizacji')],
  ['county', has('powiat lokalizacji')],
  ['gmina', has('gmina lokalizacji')],
  ['city', has('miejscowosc lokalizacji')],
  ['street', has('ulica lokalizacji')],
  ['buildingNo', has('nr nieruchomosci lokalizacji')],
  ['postalCode', has('kod pocztowy lokalizacji')],
  ['investmentName', (h) => /nazwa (inwestycji|przedsiewziecia|zadania|projektu)/.test(h)],

  ['unitType', has('rodzaj nieruchomosci')],
  ['unitRef', (h) =>
    (/^(nr|numer) (lokalu lub domu|lokalu|domu)/.test(h) || h.startsWith('oznaczenie lokalu')) &&
    !/adres|siedzib|sprzedaz|korespond/.test(h)],

  ['priceM2Date', (h) => startsData(h) && /cena (za )?m ?2/.test(h) && h.includes('powierzchni') && !h.includes('iloczyn')],
  ['priceTotalDate', (h) => startsData(h) && h.includes('iloczyn') && !h.includes('uwzgledn')],
  ['priceFullDate', (h) => startsData(h) && h.includes('uwzgledn') && h.includes('lokal')],
  ['priceM2', (h) =>
    !startsData(h) && /cena (za )?m ?2/.test(h) && h.includes('powierzchni') && !/iloczyn|uwzgledn/.test(h)],
  ['priceTotal', (h) => !startsData(h) && h.includes('iloczyn') && !h.includes('uwzgledn')],
  ['priceFull', (h) => !startsData(h) && h.includes('uwzgledn') && h.startsWith('cena lokalu')],

  ['area', not(has('powierzchnia uzytkowa'), 'cena')],
  ['rooms', (h) => h.includes('liczba pokoi') || h === 'pokoje'],
  ['status', (h) => h === 'status' || h.startsWith('status ')],
];

export type ColumnMap = Partial<Record<Field, number>>;

// Kolumny wzorcowego pliku, które znamy, ale do analiz nie potrzebujemy.
// Nie trafiają do listy "nieznanych nagłówków", więc nie wywołują alarmu.
const IGNORED: Rule[] = [
  (h) => /siedzib|glownego miejsca|sprzedaz|kontaktu/.test(h),
  (h) => /forma prawna|ceidg|regon|telefon|poczty elektronicznej|faks|fax/.test(h),
  (h) => /czesci nieruchomosci|pomieszczen przynaleznych|praw niezbednych|innych swiadczen/.test(h),
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
  return { map, unknown };
}

/** Minimalny zestaw pól, bez którego plik nie nadaje się do analizy. */
export const REQUIRED: Field[] = ['devName', 'city', 'unitRef', 'priceM2'];

export function missingRequired(map: ColumnMap): Field[] {
  return REQUIRED.filter((f) => map[f] === undefined);
}
