import { M, livePowiaty, powiatLink, powiatSeries } from '../../lib/data';
import { csv } from '../../lib/csv';
// Powiaty, które mają stronę w serwisie (własną albo stronę jedynej gminy lub miasta z ofertą).
export const csvPowiaty = () => livePowiaty.filter((p) => powiatLink(p) !== null);
export function GET() {
  const rows = csvPowiaty().flatMap((p) => {
    const s = powiatSeries(p);
    return M.dates.map((d, i) => [d, p.urban ? `${p.name} (miasto na prawach powiatu)` : p.name, p.voivodeship, s.median[i].value, s.index[i].value, s.count[i].value]);
  });
  return csv(['data', 'powiat', 'wojewodztwo', 'mediana_zl_m2', 'indeks_tych_samych_lokali', 'lokale_w_ofercie'], rows);
}
