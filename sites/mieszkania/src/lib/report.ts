// Liczby do raportu miesięcznego: stan na ostatni pomiar miesiąca w porównaniu
// z ostatnim pomiarem poprzedniego miesiąca.
import type { Unit } from '@serwisy/mieszkania-dane/query';
import { M, citiesWithPage, cityKey } from './data';

export interface MonthStats {
  month: string; end: string; prevEnd: string;
  medianEnd: number | null; medianPrev: number | null;
  indexChange: number | null;
  units: number; newUnits: number; goneUnits: number;
  cutShare: number | null; raiseShare: number | null; base: number;
}

function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export const reportMonths = M.months().filter((m) => M.monthEnd(prevMonth(m)) !== null).reverse();

export function monthStats(month: string, key: string, unitsList: Unit[]): MonthStats | null {
  const end = M.monthEnd(month);
  const prevEnd = M.monthEnd(prevMonth(month));
  if (!end || !prevEnd) return null;
  const ser = M.series(key, unitsList);
  const a = M.pricesOn(prevEnd)!;
  const b = M.pricesOn(end)!;
  let n = 0, nw = 0, gone = 0, base = 0, cuts = 0, raises = 0;
  for (const u of unitsList) {
    const pa = a[u.i];
    const pb = b[u.i];
    const ina = !Number.isNaN(pa);
    const inb = !Number.isNaN(pb);
    if (inb) n++;
    if (inb && !ina) nw++;
    if (ina && !inb) gone++;
    if (ina && inb) { base++; if (pb < pa * 0.995) cuts++; else if (pb > pa * 1.005) raises++; }
  }
  const ie = M.valueAt(ser.index, end);
  const ip = M.valueAt(ser.index, prevEnd);
  return {
    month, end, prevEnd,
    medianEnd: M.valueAt(ser.median, end), medianPrev: M.valueAt(ser.median, prevEnd),
    indexChange: ie !== null && ip ? ie / ip - 1 : null,
    units: n, newUnits: nw, goneUnits: gone,
    cutShare: base ? cuts / base : null, raiseShare: base ? raises / base : null, base,
  };
}

export const nationalMonth = (m: string) => monthStats(m, 'pl', M.units);
export const cityMonths = (m: string) =>
  citiesWithPage.map((c) => ({ c, s: monthStats(m, cityKey(c), c.units) })).filter((x): x is { c: typeof x.c; s: MonthStats } => x.s !== null);
