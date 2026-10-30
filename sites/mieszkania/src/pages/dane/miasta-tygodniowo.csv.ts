import { M, citiesWithPage, citySeries } from '../../lib/data';
import { csv } from '../../lib/csv';
export function GET() {
  const rows = citiesWithPage.flatMap((c) => {
    const s = citySeries(c);
    return M.dates.map((d, i) => [d, c.name, c.voivodeship, s.median[i].value, s.index[i].value, s.count[i].value]);
  });
  return csv(['data', 'miasto', 'wojewodztwo', 'mediana_zl_m2', 'indeks_tych_samych_lokali', 'lokale_w_ofercie'], rows);
}
