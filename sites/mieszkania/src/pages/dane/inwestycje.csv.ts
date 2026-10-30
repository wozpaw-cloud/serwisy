import { M, invStats } from '../../lib/data';
import { csv } from '../../lib/csv';
export function GET() {
  const rows = M.investments.map(invStats).filter((x) => x.inOffer.length > 0).map((x) => [
    x.inv.name, x.inv.brand.name, x.inv.city.name, x.inv.city.gmina.name, x.inv.city.gmina.urban ? 'miasto na prawach powiatu' : x.inv.city.gmina.county, x.inv.city.voivodeship, x.inOffer.length, x.medianM2, x.minTotal, x.maxTotal, x.medianArea, x.changeSinceFirst, x.firstSeen,
  ]);
  return csv(['inwestycja', 'deweloper', 'miejscowosc', 'gmina', 'powiat', 'wojewodztwo', 'lokale_w_ofercie', 'mediana_zl_m2', 'cena_od_zl', 'cena_do_zl', 'mediana_metrazu_m2', 'zmiana_od_wejscia', 'w_cennikach_od'], rows);
}
