// Jeden model danych na całą budowę serwisu i pochodne listy dla stron.
import { getModel, median, type Brand, type City, type Gmina, type Investment, type Powiat, type Unit, type Voivodeship } from '@serwisy/mieszkania-dane/query';
import { addDays, fold, VOIVODESHIPS } from '@serwisy/mieszkania-dane';
import { SITE } from '../config';

export const M = getModel();

/** Dane przykładowe rozpoznajemy po identyfikatorach zbiorów, nie po zmiennej środowiskowej. */
export const isSample = M.units.length > 0 && M.units.every((u) => u.dataset.startsWith('PRZYKLAD_'));

export const href = {
  home: () => '/',
  city: (c: City) => `/miasta/${c.slug}/`,
  gmina: (g: Gmina) => `/gminy/${g.slug}/`,
  powiat: (p: Powiat) => `/powiaty/${p.slug}/`,
  voiv: (v: Voivodeship) => `/wojewodztwa/${v.slug}/`,
  inv: (i: Investment) => `/inwestycje/${i.slug}/`,
  brand: (b: Brand) => `/deweloperzy/${b.slug}/`,
  report: (ym: string) => `/raporty/${ym}/`,
};

export const national = () => M.snapshot('pl', M.units);
export const nationalSeries = () => M.series('pl', M.units);

export const cityKey = (c: City) => `c:${c.key}`;
export const citySnap = (c: City) => M.snapshot(cityKey(c), c.units);
export const citySeries = (c: City) => M.series(cityKey(c), c.units);

// "Polska" albo nazwa województwa w kolumnie miejscowości to błąd w cenniku, nie miasto.
const NOT_A_CITY = new Set(['polska', ...VOIVODESHIPS.map((v) => fold(v))]);
export const citiesWithPage: City[] = M.cities
  .filter((c) => citySnap(c).units >= SITE.minCityUnits && !NOT_A_CITY.has(fold(c.name)))
  .sort((a, b) => citySnap(b).units - citySnap(a).units);
const pageCities = new Set(citiesWithPage);
export const hasPage = (c: City) => pageCities.has(c);

// Gminy. Własną stronę ma gmina z ofertą w więcej niż jednej miejscowości;
// gmina z ofertą w jednym mieście prowadzi do strony tego miasta (bez powielania treści).
export const gminaKey = (g: Gmina) => `g:${g.key}`;
export const gminaSnap = (g: Gmina) => M.snapshot(gminaKey(g), g.units);
export const gminaSeries = (g: Gmina) => M.series(gminaKey(g), g.units);
export const liveCities = (g: Gmina) => g.cities.filter((c) => citySnap(c).units > 0).sort((a, b) => citySnap(b).units - citySnap(a).units);
export const gminasWithPage: Gmina[] = M.gminas
  .filter((g) => gminaSnap(g).units >= SITE.minCityUnits && liveCities(g).length > 1)
  .sort((a, b) => gminaSnap(b).units - gminaSnap(a).units);
const pageGminas = new Set(gminasWithPage);
export const gminaHasPage = (g: Gmina) => pageGminas.has(g);
/** Adres strony opisującej gminę: własnej albo jedynego miasta z ofertą. */
export function gminaLink(g: Gmina): string | null {
  if (pageGminas.has(g)) return href.gmina(g);
  const lc = liveCities(g);
  return lc.length === 1 && hasPage(lc[0]) ? href.city(lc[0]) : null;
}
/** "gmina Komorniki", a dla miasta na prawach powiatu sama nazwa miasta. */
export const gminaLabel = (g: Gmina) => (g.urban ? g.name : `gmina ${g.name}`);
export const countyLabel = (g: Gmina) => (g.urban ? 'miasto na prawach powiatu' : g.county ? `powiat ${g.county}` : 'powiat nieznany');
/** Gminy z lokalami w ofercie, od największej oferty. */
export const liveGminas = M.gminas.filter((g) => gminaSnap(g).units > 0).sort((a, b) => gminaSnap(b).units - gminaSnap(a).units);
/** "Komorniki i Plewiska", "Dopiewo, Skórzewo i Dąbrowa". */
export const listPl = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} i ${xs.at(-1)}`);

export const voivKey = (v: Voivodeship) => `v:${v.slug}`;
export const voivSnap = (v: Voivodeship) => M.snapshot(voivKey(v), v.units);
export const voivodeships = M.voivodeships.filter((v) => voivSnap(v).units > 0);

// Powiaty. Własną stronę ma powiat ziemski z ofertą w więcej niż jednej gminie.
// Miasto na prawach powiatu i powiat z ofertą w jednej gminie prowadzą do strony tej gminy albo miasta.
export const powiatKey = (p: Powiat) => `p:${p.key}`;
export const powiatSnap = (p: Powiat) => M.snapshot(powiatKey(p), p.units);
export const powiatSeries = (p: Powiat) => M.series(powiatKey(p), p.units);
export const liveGminasOf = (p: Powiat) => p.gminas.filter((g) => gminaSnap(g).units > 0).sort((a, b) => gminaSnap(b).units - gminaSnap(a).units);
export const powiatyWithPage: Powiat[] = M.powiaty
  .filter((p) => !p.urban && powiatSnap(p).units >= SITE.minCityUnits && liveGminasOf(p).length > 1)
  .sort((a, b) => powiatSnap(b).units - powiatSnap(a).units);
const pagePowiaty = new Set(powiatyWithPage);
export const powiatHasPage = (p: Powiat) => pagePowiaty.has(p);
export function powiatLink(p: Powiat): string | null {
  if (pagePowiaty.has(p)) return href.powiat(p);
  const lg = liveGminasOf(p);
  return lg.length === 1 ? gminaLink(lg[0]) : null;
}
/** "powiat poznański", a dla miasta na prawach powiatu sama nazwa miasta. */
export const powiatLabel = (p: Powiat) => (p.urban ? p.name : `powiat ${p.name}`);
export const livePowiaty = M.powiaty.filter((p) => powiatSnap(p).units > 0).sort((a, b) => powiatSnap(b).units - powiatSnap(a).units);
export const voivLink = (name: string | null) => {
  const v = voivodeships.find((x) => x.name === name);
  return v ? href.voiv(v) : null;
};

// ---------- hierarchia: Polska › województwo › powiat › gmina › miejscowość ----------

export type Level = 'pl' | 'voiv' | 'powiat' | 'gmina' | 'city';
export interface AreaRef { level: Level; label: string; href: string | null; skey: string; units: Unit[] }

const plRef = (): AreaRef => ({ level: 'pl', label: 'Polska', href: '/', skey: 'pl', units: M.units });
const voivRef = (name: string | null): AreaRef | null => {
  const v = voivodeships.find((x) => x.name === name);
  return v ? { level: 'voiv', label: `woj. ${v.name}`, href: href.voiv(v), skey: voivKey(v), units: v.units } : null;
};
const powiatRef = (p: Powiat | null): AreaRef | null =>
  p ? { level: 'powiat', label: powiatLabel(p), href: powiatHasPage(p) ? href.powiat(p) : null, skey: powiatKey(p), units: p.units } : null;
const gminaRef = (g: Gmina): AreaRef => ({ level: 'gmina', label: gminaLabel(g), href: gminaHasPage(g) ? href.gmina(g) : null, skey: gminaKey(g), units: g.units });
const cityRef = (c: City): AreaRef => ({ level: 'city', label: c.name, href: hasPage(c) ? href.city(c) : null, skey: cityKey(c), units: c.units });

/** Te same lokale w ofercie: wyższy poziom nic nie dodaje (np. gmina z jednym miastem). */
function sameOffer(a: AreaRef, b: AreaRef): boolean {
  const sa = M.snapshot(a.skey, a.units);
  const sb = M.snapshot(b.skey, b.units);
  return sa.units === sb.units && sa.investments === sb.investments && sa.medianM2 === sb.medianM2;
}

/** Od Polski do obszaru, bez poziomów, które powtarzają niższy poziom. Ostatni element to sam obszar. */
function chain(levels: (AreaRef | null)[]): AreaRef[] {
  const xs = levels.filter((x): x is AreaRef => x !== null);
  const out: AreaRef[] = [xs.at(-1)!];
  for (let i = xs.length - 2; i >= 0; i--) if (!sameOffer(xs[i], out[0])) out.unshift(xs[i]);
  return out;
}
export const chainCity = (c: City) => chain([plRef(), voivRef(c.voivodeship), powiatRef(c.gmina.powiat), gminaRef(c.gmina), cityRef(c)]);
export const chainGmina = (g: Gmina) => chain([plRef(), voivRef(g.voivodeship), powiatRef(g.powiat), gminaRef(g)]);
export const chainPowiat = (p: Powiat) => chain([plRef(), voivRef(p.voivodeship), powiatRef(p)]);
export const chainVoiv = (v: Voivodeship) => chain([plRef(), voivRef(v.name)]);

/** Okruszki z łańcucha: bez Polski (to strona startowa) i bez samego obszaru. */
export const crumbsOf = (ch: AreaRef[]) => ch.slice(1, -1).map((a) => ({ label: a.label, href: a.href ?? undefined }));

/** Najlepsza strona dla miejscowości: jej własna, a gdy jej nie ma, gminy, powiatu albo województwa. */
export function placeLink(c: City): string | null {
  if (hasPage(c)) return href.city(c);
  if (gminaHasPage(c.gmina)) return href.gmina(c.gmina);
  if (c.gmina.powiat && powiatHasPage(c.gmina.powiat)) return href.powiat(c.gmina.powiat);
  return voivLink(c.voivodeship);
}

export const brandKey = (b: Brand) => `b:${b.key}`;
export const brandSnap = (b: Brand) => M.snapshot(brandKey(b), b.units);
// Strony inwestycji i deweloperów tylko dla aktualnych (lokale w cenniku w ostatnich 90 dniach):
// darmowy plan Cloudflare mieści 20 000 plików, a dawno wyprzedanych inwestycji mało kto szuka.
// Inwestycje bez strony pokazujemy w tabelach bez odnośnika.
export const invWithPage: Investment[] = M.investments.filter((inv) => inv.units.length > 0 && invIsCurrent(inv));
const invPageSet = new Set(invWithPage);
export const invHasPage = (inv: Investment) => invPageSet.has(inv);

export const brands = M.brands.filter((b) => b.investments.some(invHasPage)).sort((a, b) => brandSnap(b).units - brandSnap(a).units);
const brandPageSet = new Set(brands);
export const brandHasPage = (b: Brand) => brandPageSet.has(b);

export const houses = () => M.units.filter((u) => u.type === 'dom');
export const flats = () => M.units.filter((u) => u.type === 'mieszkanie');

export interface InvestmentStats {
  inv: Investment;
  inOffer: Unit[];
  medianM2: number | null;
  minTotal: number | null;
  maxTotal: number | null;
  medianArea: number | null;
  firstSeen: string | null;
  lastChange: string | null;
  cuts4w: number;
  changeSinceFirst: number | null;
  types: Set<'mieszkanie' | 'dom'>;
}

const invCache = new Map<number, InvestmentStats>();
export function invStats(inv: Investment): InvestmentStats {
  const hit = invCache.get(inv.id);
  if (hit) return hit;
  const inOffer = inv.units.filter((u) => M.currentM2(u) !== null);
  const totals = inOffer.map((u) => M.priceAt(u, M.asOf)?.total).filter((x): x is number => !!x);
  const then = M.pricesOn(M.dates[Math.max(0, M.dates.length - 5)]);
  let cuts = 0;
  const ratios: number[] = [];
  for (const u of inOffer) {
    const now = M.currentM2(u)!;
    const before = then ? then[u.i] : NaN;
    if (!Number.isNaN(before) && now < before * 0.995) cuts++;
    const first = u.prices[0]?.m2;
    if (first) ratios.push(now / first);
  }
  const changes = inv.units.flatMap((u) => u.prices.slice(1).map((p) => p.from)).sort();
  const s: InvestmentStats = {
    inv, inOffer,
    medianM2: median(inOffer.map((u) => M.currentM2(u)!)),
    minTotal: totals.length ? Math.min(...totals) : null,
    maxTotal: totals.length ? Math.max(...totals) : null,
    medianArea: median(inOffer.map((u) => u.area).filter((x): x is number => !!x)),
    firstSeen: inv.units.map((u) => M.firstSeen(u)).filter((x): x is string => !!x).sort()[0] ?? null,
    lastChange: changes.at(-1) ?? null,
    cuts4w: cuts,
    changeSinceFirst: ratios.length ? median(ratios)! - 1 : null,
    types: new Set(inOffer.map((u) => u.type)),
  };
  invCache.set(inv.id, s);
  return s;
}

/** Inwestycje, które warto indeksować: w ofercie dziś albo w ostatnich 90 dniach. */
export function invIsCurrent(inv: Investment): boolean {
  const limit = addDays(M.asOf, -90);
  return inv.units.some((u) => (M.lastSeen(u) ?? '') >= limit);
}

export const investmentsSorted = [...M.investments].sort((a, b) => invStats(b).inOffer.length - invStats(a).inOffer.length);

/** Opis lokalu do list: "M22, 49,2 m²". */
/** Oznaczenie lokalu: numer budynku (gdy inwestycja ma kilka budynków) i numer lokalu. */
export function unitRef(u: Unit): string {
  return u.building && !u.ref.includes(u.building) ? `${u.building} / ${u.ref}` : u.ref;
}

export function unitLabel(u: Unit): string {
  const a = u.area ? `${u.area.toFixed(1).replace('.', ',')} m²` : '';
  return [unitRef(u), a].filter(Boolean).join(', ');
}
