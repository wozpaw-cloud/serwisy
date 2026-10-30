// Polskie formaty liczb i dat. Twarda spacja w tysiącach, przecinek dziesiętny,
// znak minus U+2212, żeby liczby nie łamały się na końcu wiersza.

const int = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0, useGrouping: 'always' } as Intl.NumberFormatOptions);
const dec1 = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: 'always' } as Intl.NumberFormatOptions);

const fix = (s: string) => s.replace(/ | | /g, ' ').replace(/-/g, '−');

export const num = (v: number | null | undefined): string => (v === null || v === undefined || Number.isNaN(v) ? '—' : fix(int.format(v)));
export const zl = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${num(v)} zł`);
export const zlM2 = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${num(v)} zł/m²`);
export const m2 = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${fix(dec1.format(v))} m²`);
export const idx = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : fix(dec1.format(v)));

/** Zmiana względna ze znakiem: "+1,2%", "−0,4%", "0,0%". */
export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const p = v * 100;
  const s = Math.abs(p).toFixed(digits).replace('.', ',');
  if (Math.abs(p) < 0.5 * 10 ** -digits) return `${(0).toFixed(digits).replace('.', ',')}%`;
  return `${p > 0 ? '+' : '−'}${s}%`;
}

/** Wielkość zmiany bez znaku, do zdań typu "wzrosły o 1,2%". */
export const pctAbs = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : share(Math.abs(v), digits));

/** Udział bez znaku: "4,4%". */
export function share(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(digits).replace('.', ',')}%`;
}

const MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
const MONTHS_NOM = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

export const dateLong = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
export const dateShort = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
export const monthName = (ym: string) => `${MONTHS_NOM[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const monthShort = (iso: string) => MONTHS_SHORT[Number(iso.slice(5, 7)) - 1];

/** Odmiana: 1 lokal, 2 lokale, 5 lokali. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n);
  if (a === 1) return one;
  const d = a % 10;
  const t = a % 100;
  return d >= 2 && d <= 4 && (t < 12 || t > 14) ? few : many;
}
export const units = (n: number) => `${num(n)} ${plural(n, 'lokal', 'lokale', 'lokali')}`;
export const investments = (n: number) => `${num(n)} ${plural(n, 'inwestycja', 'inwestycje', 'inwestycji')}`;
/** Po przyimku "w": "w 1 inwestycji", "w 48 inwestycjach". */
export const investmentsLoc = (n: number) => `${num(n)} ${n === 1 ? 'inwestycji' : 'inwestycjach'}`;
/** Po przyimku "z": "z 1 lokalu", "z 1432 lokali". */
export const unitsGen = (n: number) => `${num(n)} ${n === 1 ? 'lokalu' : 'lokali'}`;

/** Kierunek zmiany słowami, do zdań generowanych z danych. */
export function trendWord(v: number | null, up = 'wzrosły', down = 'spadły', flat = 'się nie zmieniły'): string {
  if (v === null) return flat;
  if (v > 0.0005) return up;
  if (v < -0.0005) return down;
  return flat;
}
