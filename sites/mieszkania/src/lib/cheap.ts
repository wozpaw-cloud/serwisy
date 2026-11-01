// Najtańsze oferty: najniższa cena całkowita lokalu w dzisiejszych cennikach.
// Odsiewamy pozycje, które nie są mieszkaniem ani domem, choć tak je wpisano
// (garaże, komórki, miejsca postojowe za 50 000 zł), i ceny niespójne z metrażem.
import { median, type Unit, type Voivodeship } from '@serwisy/mieszkania-dane/query';
import {
  M, href, invHasPage, unitRef, voivKey, voivSnap, powiatKey, powiatSnap, powiatLink, powiatLabel,
  gminaKey, gminaSnap, gminaLink, gminaLabel, cityKey, citySnap, placeLink,
} from './data';
import type { CheapArea, OfferRow } from './cheap-view';

export type Kind = 'mieszkanie' | 'dom';
export interface Cheap { unit: Unit; total: number; m2: number }

/** Najmniejszy metraż, od którego lokal uznajemy za mieszkanie albo dom. */
const MIN_AREA: Record<Kind, number> = { mieszkanie: 20, dom: 50 };
/** Cena za m² niższa niż tyle mediany tej samej inwestycji to zwykle garaż albo komórka. */
const MIN_VS_INVESTMENT = 0.65;
/** …a niższa niż tyle mediany województwa to błąd w cenniku. */
const MIN_VS_REGION = 0.5;
const MIN_M2 = 2500;

let groups: Map<string, Cheap[]> | null = null;

function build(): Map<string, Cheap[]> {
  const cur = M.units.filter((u) => M.currentM2(u) !== null);
  const med = (us: Unit[]) => median(us.map((u) => M.currentM2(u)!))!;
  const invMed = new Map([...Map.groupBy(cur, (u) => `${u.inv.id}|${u.type}`)].map(([k, us]) => [k, med(us)]));
  const regMed = new Map([...Map.groupBy(cur, (u) => `${u.inv.city.voivodeship ?? ''}|${u.type}`)].map(([k, us]) => [k, med(us)]));

  const all: Cheap[] = [];
  for (const u of cur) {
    const m2 = M.currentM2(u)!;
    const area = u.area;
    if (!area || area < MIN_AREA[u.type] || m2 < MIN_M2 || !invHasPage(u.inv)) continue;
    const total = M.priceAt(u, M.asOf)?.total ?? m2 * area;
    if (Math.abs(total / area - m2) > m2 * 0.25) continue;
    if (m2 < MIN_VS_INVESTMENT * invMed.get(`${u.inv.id}|${u.type}`)!) continue;
    if (m2 < MIN_VS_REGION * regMed.get(`${u.inv.city.voivodeship ?? ''}|${u.type}`)!) continue;
    all.push({ unit: u, total, m2 });
  }
  all.sort((a, b) => a.total - b.total || a.m2 - b.m2 || a.unit.id - b.unit.id);

  // Te same klucze co w M.snapshot (cityKey, gminaKey, powiatKey, voivKey).
  const out = new Map<string, Cheap[]>([['pl', all]]);
  const add = (k: string, c: Cheap) => { const xs = out.get(k); if (xs) xs.push(c); else out.set(k, [c]); };
  const voivSlug = new Map(M.voivodeships.map((v) => [v.name, v.slug]));
  for (const c of all) {
    const city = c.unit.inv.city;
    add(`c:${city.key}`, c);
    add(`g:${city.gmina.key}`, c);
    if (city.gmina.powiat) add(`p:${city.gmina.powiat.key}`, c);
    const vs = voivSlug.get(city.voivodeship ?? '');
    if (vs) add(`v:${vs}`, c);
  }
  return out;
}

/** Najtańsze oferty w obszarze (klucz jak w M.snapshot), najwyżej jedna z każdej inwestycji. */
export function cheapest(skey: string, kind: Kind, limit = 5, units?: Unit[]): Cheap[] {
  groups ??= build();
  let pool = groups.get(skey);
  if (!pool && units) { const set = new Set(units); pool = groups.get('pl')!.filter((c) => set.has(c.unit)); groups.set(skey, pool); }
  const out: Cheap[] = [];
  const seen = new Set<number>();
  for (const c of pool ?? []) {
    if (c.unit.type !== kind || seen.has(c.unit.inv.id)) continue;
    seen.add(c.unit.inv.id);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/** Oferta w postaci wiersza dla widoku (cheap-view.ts). */
export function rowOf(c: Cheap): OfferRow {
  const u = c.unit;
  return [Math.round(c.total), u.area!, u.rooms, Math.round(c.m2), u.inv.city.name, u.inv.name, href.inv(u.inv), unitRef(u), u.inv.brand.name];
}

/** Wspólna tabela ofert do plików JSON: obszary wskazują oferty numerami wierszy. */
export class Offers {
  rows: OfferRow[] = [];
  private index = new Map<Cheap, number>();
  ids(cs: Cheap[]): number[] {
    return cs.map((c) => {
      let i = this.index.get(c);
      if (i === undefined) {
        i = this.rows.push(rowOf(c)) - 1;
        this.index.set(c, i);
      }
      return i;
    });
  }
  area(skey: string, base: Omit<CheapArea, 'm' | 'd'>, n: number): CheapArea {
    return { ...base, m: this.ids(cheapest(skey, 'mieszkanie', n)), d: this.ids(cheapest(skey, 'dom', n)) };
  }
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, 'pl');
const r = (v: number | null) => (v === null ? null : Math.round(v));

/** Dane najtańszych ofert dla strony głównej: Polska i każde województwo. */
export function cheapNational(voivs: Voivodeship[]) {
  const t = new Offers();
  const pl = t.area('pl', { name: 'Polska', label: 'Polska', href: '/', units: 0, m2: null }, 5);
  const regions = [...voivs].sort(byName).map((v) => {
    const s = voivSnap(v);
    return { ...t.area(voivKey(v), { name: v.name, label: `woj. ${v.name}`, href: href.voiv(v), units: s.units, m2: r(s.medianM2) }, 5), slug: v.slug };
  });
  return { pl, regions, offers: t.rows };
}

/** Plik /obszary/<województwo>.json: powiaty, gminy i miejscowości z liczbami i najtańszymi ofertami. */
export function areaFile(v: Voivodeship) {
  const t = new Offers();
  const vs = voivSnap(v);
  const vHref = href.voiv(v);
  const pw = v.powiaty.filter((p) => powiatSnap(p).units > 0).sort(byName);
  const gm = v.gminas.filter((g) => gminaSnap(g).units > 0).sort(byName);
  const cs = v.cities.filter((c) => citySnap(c).units > 0).sort(byName);
  const pIdx = new Map(pw.map((p, i) => [p, i]));
  const gIdx = new Map(gm.map((g, i) => [g, i]));
  return {
    ...t.area(voivKey(v), { name: v.name, label: `woj. ${v.name}`, href: vHref, units: vs.units, m2: r(vs.medianM2) }, 5),
    powiaty: pw.map((p) => {
      const s = powiatSnap(p);
      return { ...t.area(powiatKey(p), { name: p.name, label: p.urban ? `${p.name} (miasto na prawach powiatu)` : powiatLabel(p), href: powiatLink(p) ?? vHref, units: s.units, m2: r(s.medianM2) }, 5), urban: p.urban };
    }),
    gminy: gm.map((g) => {
      const s = gminaSnap(g);
      const link = gminaLink(g) ?? (g.powiat ? powiatLink(g.powiat) : null) ?? vHref;
      return { ...t.area(gminaKey(g), { name: g.name, label: gminaLabel(g), href: link, units: s.units, m2: r(s.medianM2) }, 3), p: g.powiat ? (pIdx.get(g.powiat) ?? -1) : -1, urban: g.urban };
    }),
    miejscowosci: cs.map((c) => {
      const s = citySnap(c);
      return { ...t.area(cityKey(c), { name: c.name, label: c.name, href: placeLink(c) ?? vHref, units: s.units, m2: r(s.medianM2) }, 1), g: gIdx.get(c.gmina) ?? -1 };
    }),
    offers: t.rows,
  };
}
export type AreaFile = ReturnType<typeof areaFile>;
