// Widok najtańszych ofert. Te same funkcje składają HTML na serwerze (pierwszy widok,
// strony obszarów) i w przeglądarce (po wyborze rodzaju, województwa albo powiatu),
// więc oba widoki wyglądają tak samo. Bez importów z bazy: plik trafia do przeglądarki.
import { num, m2, plural } from './format';

/** [cena całkowita, metraż, pokoje, zł/m², miejscowość, inwestycja, adres strony inwestycji, nr lokalu, deweloper] */
export type OfferRow = [number, number, number | null, number, string, string, string, string, string];
export type Kind = 'm' | 'd';
/** Obszar z najtańszymi ofertami (numery wierszy w tabeli ofert): m = mieszkania, d = domy. */
export interface CheapArea { name: string; label: string; href: string | null; units: number; m2: number | null; m: number[]; d: number[] }

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const kindWord = (k: Kind) => (k === 'm' ? 'Najtańsze mieszkanie' : 'Najtańszy dom');
const rooms = (n: number | null) => (n ? `${n} ${plural(n, 'pokój', 'pokoje', 'pokoi')}` : '');

/** Duża karta: najtańsza oferta w obszarze. */
export function featured(o: OfferRow | undefined, kind: Kind): string {
  if (!o) return `<p class="cheap-empty">${kind === 'm' ? 'Brak mieszkań' : 'Brak domów'} w ofercie w tym obszarze.</p>`;
  const [total, area, rm, perM2, city, inv, link, ref, brand] = o;
  const facts = [m2(area), rooms(rm), `${num(perM2)} zł/m²`].filter(Boolean).join(' · ');
  return `<a class="cheap-top" href="${esc(link)}">`
    + `<span class="cheap-badge">Najniższa cena</span>`
    + `<span class="cheap-price">${num(total)}<small> zł</small></span>`
    + `<span class="cheap-facts">${facts}</span>`
    + `<span class="cheap-inv"><b>${esc(inv)}</b><span>${esc(city)} · ${esc(brand)}</span></span>`
    + `<span class="cheap-ref">lokal ${esc(ref)}<span class="cheap-go">Zobacz inwestycję</span></span>`
    + `</a>`;
}

/** Kolejne najtańsze oferty (z innych inwestycji). */
export function runners(rows: OfferRow[]): string {
  return rows.map(([total, area, , , city, inv, link]) =>
    `<li><a href="${esc(link)}"><span class="cl-price">${num(total)} zł</span><span class="cl-body"><b>${esc(inv)}</b><span>${esc(city)} · ${m2(area)}</span></span></a></li>`).join('');
}

/** Wiersze tabeli "najtańsze w każdym województwie / powiecie / gminie".
 *  drill: nazwa obszaru otwiera niższy poziom (w przeglądarce); bez JavaScriptu to zwykły odnośnik. */
export function breakdown(areas: CheapArea[], offers: OfferRow[], kind: Kind, drill: boolean, limit = Infinity): string {
  const rows = areas.map((a, i) => ({ a, i, o: offers[a[kind][0]] })).filter((x) => x.o).sort((x, y) => x.o[0] - y.o[0]);
  if (!rows.length) return `<tr><td colspan="4" class="muted">${kind === 'm' ? 'Brak mieszkań' : 'Brak domów'} w ofercie.</td></tr>`;
  return rows.map(({ a, i, o }, k) => {
    const name = a.href ? `<a href="${esc(a.href)}"${drill ? ` data-drill="${i}"` : ''}>${esc(a.name)}</a>` : esc(a.name);
    return `<tr${k >= limit ? ' hidden' : ''}><th scope="row">${name}</th><td class="r"><b>${num(o[0])} zł</b></td><td class="r">${m2(o[1])}</td>`
      + `<td><a href="${esc(o[6])}">${esc(o[5])}</a><span class="cheap-city">${esc(o[4])}</span></td></tr>`;
  }).join('');
}

/** "Bez mieszkań w ofercie: 3 powiaty" pod tabelą, gdy część obszarów nie ma tego rodzaju ofert. */
export function missingNote(areas: CheapArea[], kind: Kind, one: string, few: string, many: string): string {
  const n = areas.filter((a) => !a[kind].length).length;
  return n ? `Bez ${kind === 'm' ? 'mieszkań' : 'domów'} w ofercie: ${num(n)} ${plural(n, one, few, many)}.` : '';
}
