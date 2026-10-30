// Zdania składane z liczb. Program wybiera tylko gotowe sformułowania, więc
// tekst nie może "wymyślić" wartości: każda liczba pochodzi z analiz.
import type { Snapshot } from '@serwisy/mieszkania-dane/query';
import { investmentsLoc, pct, pctAbs, share, units, zlM2 } from './format';

export function moved(v: number | null, period: string): string {
  if (v === null) return `Za mało danych, żeby porównać ceny tych samych lokali z okresem ${period}.`;
  if (Math.abs(v) < 0.0015) return `Ceny tych samych lokali w ${period} prawie się nie zmieniły (${pct(v)}).`;
  return `Ceny tych samych lokali w ${period} ${v > 0 ? 'wzrosły' : 'spadły'} o ${pctAbs(v)}.`;
}

export function areaLead(s: Snapshot): string {
  const parts = [
    `Deweloperzy oferują tu ${units(s.units)} w ${investmentsLoc(s.investments)}.`,
    s.medianM2 !== null ? `Mediana ceny to ${zlM2(s.medianM2)}, a połowa lokali kosztuje od ${zlM2(s.p25M2)} do ${zlM2(s.p75M2)}.` : '',
    moved(s.change.index13w, 'ostatnich 13 tygodniach'),
    s.cuts.share !== null ? `W ciągu 4 tygodni potaniało ${share(s.cuts.share)} lokali obecnych w ofercie przez cały ten czas.` : '',
  ];
  return parts.filter(Boolean).join(' ');
}
