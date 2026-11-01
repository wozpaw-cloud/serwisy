// /obszary/<województwo>.json: powiaty, gminy i miejscowości województwa z liczbą lokali,
// medianą ceny za m² i najtańszymi ofertami. Czytają go wyszukiwarka obszarów i sekcja
// "Najtańsze oferty" na stronie głównej, dopiero gdy ktoś wybierze województwo.
import type { Voivodeship } from '@serwisy/mieszkania-dane/query';
import { voivodeships } from '../../lib/data';
import { areaFile } from '../../lib/cheap';

export function getStaticPaths() {
  return voivodeships.map((v) => ({ params: { slug: v.slug }, props: { v } }));
}

export function GET({ props }: { props: { v: Voivodeship } }) {
  return new Response(JSON.stringify(areaFile(props.v)), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}
