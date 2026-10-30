import { M, liveGminas, gminaLink, gminaSeries } from '../../lib/data';
import { csv } from '../../lib/csv';
// Gminy, które mają stronę w serwisie (własną albo stronę jedynego miasta z ofertą).
export const csvGminas = () => liveGminas.filter((g) => gminaLink(g) !== null);
export function GET() {
  const rows = csvGminas().flatMap((g) => {
    const s = gminaSeries(g);
    return M.dates.map((d, i) => [d, g.name, g.urban ? 'miasto na prawach powiatu' : g.county, g.voivodeship, s.median[i].value, s.index[i].value, s.count[i].value]);
  });
  return csv(['data', 'gmina', 'powiat', 'wojewodztwo', 'mediana_zl_m2', 'indeks_tych_samych_lokali', 'lokale_w_ofercie'], rows);
}
