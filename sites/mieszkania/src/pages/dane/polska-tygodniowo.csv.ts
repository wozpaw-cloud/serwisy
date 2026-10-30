import { M, nationalSeries } from '../../lib/data';
import { csv } from '../../lib/csv';
export function GET() {
  const s = nationalSeries();
  return csv(['data', 'mediana_zl_m2', 'indeks_tych_samych_lokali', 'lokale_w_ofercie'],
    M.dates.map((d, i) => [d, s.median[i].value, s.index[i].value, s.count[i].value]));
}
