// Normalizacja tekstu, liczb i dat z cenników deweloperów.
// Cenniki trafiają do dane.gov.pl w różnych formatach: przecinek albo kropka
// dziesiętna, spacje tysięcy, "zł", znak umowny "X" dla pól, które nie dotyczą.

const DIACRITICS: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
};

/** Małe litery, bez polskich znaków, pojedyncze spacje. Do porównywania nagłówków. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => DIACRITICS[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[²]/g, '2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Adres w URL: "Gorzów Wielkopolski" -> "gorzow-wielkopolski". */
/** Adres strony z nazwy: najwyżej 70 znaków, ucięty na granicy słowa (dłuższe nazwy
 *  plików nie mieszczą się w systemie plików, a długie adresy szkodzą w wynikach wyszukiwania). */
export function slugify(s: string, max = 70): string {
  let out = fold(s).replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
  if (out.length > max) out = out.slice(0, max + 1).replace(/-[^-]*$/, '') || out.slice(0, max);
  return out || 'brak';
}

const EMPTY = new Set(['', 'x', '-', '--', 'brak', 'nd', 'n d', 'nie dotyczy', 'null', 'none']);

/** Czy wartość oznacza brak danych (w tym znak umowny "X"). */
export function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  return EMPTY.has(fold(String(v)));
}

/** "723 240,00 zł" -> 723240; "14.700,50" -> 14700.5; "X" -> null. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (isEmpty(v)) return null;
  let s = String(v).replace(/[\s  ]/g, '').replace(/zł|pln|zl/gi, '');
  if (!/[0-9]/.test(s)) return null;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // Ostatni separator jest dziesiętny, drugi to separator tysięcy.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = s.replace(',', '.');
  } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ''); // "1.250.000" to tysiące, nie ułamek
  }
  const n = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Zwraca datę ISO "RRRR-MM-DD" albo null. Obsługuje też numer seryjny Excela. */
export function parseDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (isEmpty(v)) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "WARSZAWA" / "warszawa" -> "Warszawa"; "BIELSKO-BIAŁA" -> "Bielsko-Biała". */
export function titleCase(s: string): string {
  const small = new Set(['nad', 'pod', 'przy', 'na', 'w', 'i', 'z']);
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pl')
    .split(' ')
    .map((w, i) =>
      i > 0 && small.has(w)
        ? w
        : w.split('-').map((p) => p.charAt(0).toLocaleUpperCase('pl') + p.slice(1)).join('-'),
    )
    .join(' ');
}

/** Województwo bez przedrostka: "WOJ. MAZOWIECKIE" -> "mazowieckie". */
export function cleanVoivodeship(s: string | null): string | null {
  if (!s) return null;
  const f = s.toLocaleLowerCase('pl').replace(/woj(ewództwo|\.)?/g, '').trim();
  return f || null;
}

/** Nazwa domeny ze strony dewelopera: "https://www.Murapol.pl/oferta" -> "murapol.pl". */
export function websiteHost(v: string | null): string | null {
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v.trim()}`);
    return u.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

const LEGAL_SUFFIX =
  /\s*(sp[óo]łka z ograniczon[ąa] odpowiedzialno[śs]ci[ąa]|sp\.?\s*z\s*o\.?\s*o\.?|sp[óo]łka komandytowa|sp\.?\s*k\.?|sp[óo]łka akcyjna|s\.?\s*a\.?|sp[óo]łka jawna|sp\.?\s*j\.?)(?=[\s,.]|$).*$/iu;

/** Nazwa marki do wyświetlenia: bez formy prawnej, w normalnej wielkości liter. */
export function displayCompanyName(s: string): string {
  const base = s.replace(LEGAL_SUFFIX, '').replace(/[",]+$/g, '').trim();
  const name = base.length >= 2 ? base : s.trim();
  return name === name.toUpperCase() ? titleCase(name) : name;
}

/** Ulica z przedrostkiem: "Sobieskiego" -> "ul. Sobieskiego"; "ul. Sobieskiego", "al. Jana Pawła II",
 *  "os. Zielone" bez zmian (bez podwójnego "ul. ul."). */
export function streetLabel(street: string | null | undefined): string | null {
  const s = (street ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const m = /^(ul|ulica|al|aleja|aleje|os|osiedle|pl|plac|rondo|skwer|bulwar|bulw)\b\.?\s*/i.exec(s);
  if (!m) return `ul. ${s}`;
  const rest = s.slice(m[0].length);
  const k = m[1].toLowerCase();
  const prefix = k.startsWith('ul') ? 'ul.' : k.startsWith('al') ? 'al.' : k.startsWith('os') ? 'os.' : k === 'pl' || k === 'plac' ? 'pl.' : m[1].toLowerCase();
  return rest ? `${prefix} ${rest.replace(/^(ul|ulica)\b\.?\s*/i, '')}` : s;
}

