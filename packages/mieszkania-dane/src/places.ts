// Miejscowość, gmina i powiat z cenników. Deweloperzy wpisują je różnie
// ("Gmina Komorniki", "gm. Komorniki", "KOMORNIKI", dzielnica Warszawy zamiast
// gminy), więc sprowadzamy je do jednej postaci przed grupowaniem.
//
// Zasady:
//  - Miasto na prawach powiatu jest jednocześnie gminą i powiatem. Jeśli miejscowość
//    (albo powiat) to takie miasto, gminą jest to miasto, niezależnie od tego, co
//    wpisano w polu "gmina" (np. "Mokotów" w Warszawie, "Kraków-Podgórze").
//  - W pozostałych przypadkach gmina to pole "gmina" bez przedrostków i dopisków.
//  - Gdy deweloper nie podał gminy, model danych bierze ją z innych inwestycji
//    w tej samej miejscowości, a w ostateczności przyjmuje nazwę miejscowości.

import { fold, isEmpty, titleCase } from './normalize.ts';

/** 66 miast na prawach powiatu według województw. */
export const POWIAT_CITIES: Record<string, string[]> = {
  'dolnośląskie': ['Jelenia Góra', 'Legnica', 'Wałbrzych', 'Wrocław'],
  'kujawsko-pomorskie': ['Bydgoszcz', 'Grudziądz', 'Toruń', 'Włocławek'],
  'lubelskie': ['Biała Podlaska', 'Chełm', 'Lublin', 'Zamość'],
  'lubuskie': ['Gorzów Wielkopolski', 'Zielona Góra'],
  'łódzkie': ['Łódź', 'Piotrków Trybunalski', 'Skierniewice'],
  'małopolskie': ['Kraków', 'Nowy Sącz', 'Tarnów'],
  'mazowieckie': ['Ostrołęka', 'Płock', 'Radom', 'Siedlce', 'Warszawa'],
  'opolskie': ['Opole'],
  'podkarpackie': ['Krosno', 'Przemyśl', 'Rzeszów', 'Tarnobrzeg'],
  'podlaskie': ['Białystok', 'Łomża', 'Suwałki'],
  'pomorskie': ['Gdańsk', 'Gdynia', 'Słupsk', 'Sopot'],
  'śląskie': ['Bielsko-Biała', 'Bytom', 'Chorzów', 'Częstochowa', 'Dąbrowa Górnicza', 'Gliwice', 'Jastrzębie-Zdrój',
    'Jaworzno', 'Katowice', 'Mysłowice', 'Piekary Śląskie', 'Ruda Śląska', 'Rybnik', 'Siemianowice Śląskie',
    'Sosnowiec', 'Świętochłowice', 'Tychy', 'Zabrze', 'Żory'],
  'świętokrzyskie': ['Kielce'],
  'warmińsko-mazurskie': ['Elbląg', 'Olsztyn'],
  'wielkopolskie': ['Kalisz', 'Konin', 'Leszno', 'Poznań'],
  'zachodniopomorskie': ['Koszalin', 'Szczecin', 'Świnoujście'],
};

const CITY_BY_FOLD = new Map<string, { name: string; voiv: string }>();
for (const [voiv, names] of Object.entries(POWIAT_CITIES)) {
  for (const name of names) CITY_BY_FOLD.set(fold(name), { name, voiv: fold(voiv) });
}

// Przedrostki i dopiski spotykane w polach adresowych cenników.
const PREFIX = /^\s*(gmina\s+miejsko\s*-\s*wiejska|gmina\s+miejska|gmina\s+wiejska|gmina|gm\.?|miasto\s+stołeczne|m\.\s*st\.?|miasto\s+na\s+prawach\s+powiatu|miasto|m\.|powiat\s+grodzki|powiat\s+ziemski|powiat|pow\.)(?=[\s.]|$)\s*\.?\s*/iu;
const SUFFIX = /\s*(\((gmina|gm\.?|miasto|obszar|m\.|powiat)[^)]*\)|\s-\s*(miasto|obszar\s+wiejski)|,\s*(gmina|gm\.)\s+(miejska|wiejska|miejsko-wiejska))\s*$/iu;

/** Nazwa bez przedrostków ("gm.", "Gmina", "m. st.") i dopisków ("- miasto", "(gmina wiejska)"). */
export function stripPlace(s: string): string {
  let out = s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(PREFIX, '').replace(SUFFIX, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Nazwa własna w normalnej wielkości liter. Zapis mieszany zostawiamy, bo zwykle jest poprawny. */
export function properName(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t === t.toLocaleUpperCase('pl') || t === t.toLocaleLowerCase('pl') ? titleCase(t) : t;
}

/** Powiat: "Powiat POZNAŃSKI" -> "poznański", "m. st. Warszawa" -> "Warszawa". */
export function cleanCounty(s: string | null): string | null {
  if (!s || isEmpty(s)) return null;
  const t = stripPlace(s);
  if (!t) return null;
  return /(sk|ck|dzk)i( |$)/.test(fold(t)) ? t.toLocaleLowerCase('pl') : properName(t);
}

/**
 * Miasto na prawach powiatu, jeśli nazwa nim jest albo się od niego zaczyna
 * ("Warszawa-Mokotów", "Kraków Podgórze"). Dla dopasowania po początku nazwy
 * wymagamy zgodnego województwa, żeby "Opole Lubelskie" nie stało się Opolem.
 */
export function powiatCity(name: string | null, voivodeship: string | null): string | null {
  if (!name || isEmpty(name)) return null;
  const words = fold(stripPlace(name)).split(' ').filter(Boolean);
  const v = voivodeship ? fold(voivodeship) : null;
  for (let n = words.length; n >= 1; n--) {
    const hit = CITY_BY_FOLD.get(words.slice(0, n).join(' '));
    if (!hit) continue;
    if (v ? hit.voiv === v : n === words.length) return hit.name;
    return null;
  }
  return null;
}

export interface Place {
  city: string;
  /** null, gdy cennik nie podaje gminy; model uzupełnia ją później. */
  gmina: string | null;
  county: string | null;
  /** Miasto na prawach powiatu: miasto, gmina i powiat to ten sam obszar. */
  urban: boolean;
}

/** Ujednolica miejscowość, gminę i powiat z jednego wiersza cennika. */
export function resolvePlace(raw: { voivodeship: string | null; county: string | null; gmina: string | null; city: string }): Place {
  const voiv = raw.voivodeship;
  const g = raw.gmina && !isEmpty(raw.gmina) ? properName(stripPlace(raw.gmina)) : '';
  // Powiat wskazujący miasto ("m. st. Warszawa") rozstrzyga tylko wtedy, gdy gmina temu
  // nie przeczy. Inaczej pomyłka w polu "powiat" (np. "Poznań" zamiast "poznański")
  // przeniosłaby inwestycję z Komornik do Poznania.
  const byCounty = powiatCity(raw.county, voiv);
  const urbanCity = powiatCity(raw.city, voiv) ?? (byCounty && (!g || powiatCity(g, voiv) === byCounty) ? byCounty : null);
  if (urbanCity) return { city: urbanCity, gmina: urbanCity, county: urbanCity, urban: true };
  const city = properName(stripPlace(raw.city)) || properName(raw.city);
  return { city, gmina: g || null, county: cleanCounty(raw.county), urban: false };
}
