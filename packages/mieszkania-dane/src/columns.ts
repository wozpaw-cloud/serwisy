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
// Kolumna adresu inwestycji: "Miejscowość lokalizacji…" albo "Lokalizacja … - miejscowość".
// Adres siedziby dewelopera i biura sprzedaży pomijamy.
const NOT_INVESTMENT = /siedzib|glownego miejsca|sprzedaz|korespond|kontakt/;
const loc = (word: RegExp, bare: string[] = []): Rule => (h) =>
  !NOT_INVESTMENT.test(h) && ((h.includes('lokalizacj') && word.test(h)) || bare.includes(h));
// "iloczyn" bywa z literówką ("iloczym").
const ILOCZYN = /iloczy/;

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
  ['city', loc(/miejscowosc|miasto/, ['miejscowosc', 'miasto', 'miejscowosc inwestycji', 'lokalizacja miejscowosc'])],
  ['street', loc(/\bulic/, ['ulica'])],
  ['buildingNo', loc(/\b(nr|numer) (nieruchomosci|budynku|domu)\b/, ['nr budynku', 'numer budynku'])],
  ['postalCode', loc(/kod pocztow/, ['kod pocztowy'])],
  ['investmentName', (h) => /nazwa (inwestycji|przedsiewziecia|zadania|projektu)/.test(h)],

  ['unitType', has('rodzaj nieruchomosci')],
  ['unitRef', (h) =>
    (/^(nr|numer) (lokalu lub domu|lokalu|domu|nieruchomosci nadany)/.test(h) || /^oznaczenie (lokalu|nieruchomosci|domu)/.test(h)) &&
    !/adres|siedzib|sprzedaz|korespond|lokalizacj/.test(h)],

  ['priceM2Date', (h) => startsData(h) && /cena (za )?(1 )?m ?2/.test(h) && !ILOCZYN.test(h)],
  ['priceTotalDate', (h) => startsData(h) && ILOCZYN.test(h) && !h.includes('uwzgledn')],
  ['priceFullDate', (h) => startsData(h) && h.includes('uwzgledn') && h.includes('lokal')],
  ['priceM2', (h) =>
    !startsData(h) && /cena (za )?(1 )?m ?2|cena za metr/.test(h) && !/iloczy|uwzgledn|calkowit|razem/.test(h)],
  ['priceTotal', (h) => !startsData(h) && !h.includes('uwzgledn') &&
    (ILOCZYN.test(h) || (/^cena (lokalu|domu|nieruchomosci|calkowita|brutto)/.test(h) && !/m ?2|metr/.test(h)))],
  ['priceFull', (h) => !startsData(h) && h.includes('uwzgledn') && h.startsWith('cena lokalu')],

  ['area', (h) => !h.includes('cena') &&
    (h === 'powierzchnia' || h === 'metraz' || /^powierzchnia (uzytkowa|lokalu|domu|nieruchomosci|m ?2)/.test(h) || h.includes('powierzchnia uzytkowa'))],
  ['rooms', (h) => h.includes('liczba pokoi') || h === 'pokoje'],
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
  // Brak numeru lokalu: wewnętrzny identyfikator też jednoznacznie wskazuje lokal.
  if (map.unitRef === undefined) {
    const i = headers.findIndex((raw) => /^id (lokalu|nieruchomosci|domu)$/.test(fold(raw ?? '')));
    if (i >= 0) map.unitRef = i;
  }
  return { map, unknown };
}

/** Minimalny zestaw pól, bez którego plik nie nadaje się do analizy. Nazwę dewelopera,
 *  gdy jej brak w pliku, bierzemy z tytułu zbioru (parse.ts). */
export const REQUIRED: Field[] = ['city', 'unitRef', 'priceM2'];

export function missingRequired(map: ColumnMap): Field[] {
  return REQUIRED.filter((f) => map[f] === undefined);
}
