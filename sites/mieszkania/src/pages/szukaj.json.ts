// Indeks wyszukiwarki: [nazwa, rodzaj, adres, opis, waga]. Waga to liczba lokali
// w ofercie (większe miejsca wyżej w podpowiedziach). Pobierany dopiero przy pierwszym użyciu.
import {
  M, voivodeships, voivSnap, href, livePowiaty, powiatLink, powiatSnap, liveGminas, gminaLink, gminaSnap,
  citySnap, hasPage, placeLink, invStats, invIsCurrent, brands, brandSnap,
} from '../lib/data';
import { num, zlM2 } from '../lib/format';

type Entry = [string, string, string, string, number];

export function searchEntries(): Entry[] {
  const out: Entry[] = [];
  for (const v of voivodeships) {
    const s = voivSnap(v);
    out.push([`województwo ${v.name}`, 'województwo', href.voiv(v), `${zlM2(s.medianM2)}, ${num(s.units)} lokali w ofercie`, s.units]);
  }
  for (const p of livePowiaty) {
    const link = powiatLink(p);
    if (p.urban || !link) continue;
    const s = powiatSnap(p);
    out.push([`powiat ${p.name}`, 'powiat', link, `woj. ${p.voivodeship ?? 'nieznane'}, ${zlM2(s.medianM2)}`, s.units]);
  }
  for (const g of liveGminas) {
    const link = gminaLink(g);
    if (g.urban || !link) continue;
    const s = gminaSnap(g);
    out.push([`gmina ${g.name}`, 'gmina', link, `${g.powiat ? `powiat ${g.powiat.name}, ` : ''}${zlM2(s.medianM2)}`, s.units]);
  }
  for (const c of M.cities) {
    const s = citySnap(c);
    if (s.units === 0) continue;
    const link = placeLink(c);
    if (!link) continue;
    const detail = hasPage(c)
      ? `${c.gmina.urban || c.gmina.name === c.name ? `woj. ${c.voivodeship ?? 'nieznane'}` : `gmina ${c.gmina.name}`}, ${zlM2(s.medianM2)}`
      : `${c.gmina.name === c.name ? `woj. ${c.voivodeship ?? 'nieznane'}` : `gmina ${c.gmina.name}`}, ${num(s.units)} lokali w ofercie`;
    out.push([c.name, hasPage(c) ? 'miasto' : 'miejscowość', link, detail, s.units]);
  }
  for (const inv of M.investments) {
    const st = invStats(inv);
    if (!st.inOffer.length || !invIsCurrent(inv)) continue;
    out.push([inv.name, 'inwestycja', href.inv(inv), `${inv.city.name}, ${inv.brand.name}`, st.inOffer.length]);
  }
  for (const b of brands) {
    const s = brandSnap(b);
    if (!s.units) continue;
    out.push([b.name, 'deweloper', href.brand(b), `${num(s.investments)} inwestycji w ofercie`, s.units]);
  }
  return out;
}

export function GET() {
  return new Response(JSON.stringify(searchEntries()), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}
