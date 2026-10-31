// Analizy liczone z bazy przy budowie serwisu. Wszystkie liczby na stronach
// pochodzą stąd: AI nie wpisuje żadnej wartości ręcznie.
//
// Definicje (opisane też na stronie Metodologia):
//  - Lokal "w ofercie" w dniu d: występuje w cenniku z tego dnia. Krótkie przerwy
//    w publikacji (do 21 dni, gdy lokal wraca) traktujemy jako obecność.
//  - Mediana ceny za m²: mediana cen ofertowych za m² lokali w ofercie (każdy lokal raz).
//  - Indeks cen tych samych lokali: co tydzień porównujemy ceny lokali obecnych
//    w ofercie w obu tygodniach; średnia geometryczna zmian, łańcuchowo, start = 100.
//    Nie rośnie tylko dlatego, że do oferty weszły droższe inwestycje.
//  - Obniżka: cena za m² niższa o co najmniej 0,5% niż 4 tygodnie wcześniej.
//  - "Zniknął z oferty" nie znaczy "sprzedany": deweloper mógł też wycofać lokal.

import type { DatabaseSync } from 'node:sqlite';
import { addDays } from './ingest.ts';
import { displayCompanyName, fold, slugify, streetLabel } from './normalize.ts';
import { resolvePlace } from './places.ts';

export const BRIDGE_DAYS = 21;
export const STALE_DAYS = 7;

export interface Unit {
  i: number; id: number; ref: string; type: 'mieszkanie' | 'dom'; area: number | null; rooms: number | null;
  inv: Investment; dataset: string;
  presence: [string, string][];
  prices: { from: string; m2: number; total: number | null }[];
}
export interface Investment {
  id: number; slug: string; name: string; named: boolean; devId: number; brand: Brand;
  city: City; street: string | null; buildingNo: string | null; postalCode: string | null; prospectusUrl: string | null;
  units: Unit[];
}
export interface City { key: string; slug: string; name: string; voivodeship: string | null; gmina: Gmina; units: Unit[]; investments: Investment[] }
/**
 * Gmina według pól adresowych cenników (places.ts). Miasto na prawach powiatu
 * (urban) jest jednocześnie gminą i ma tę samą nazwę co miasto.
 */
export interface Gmina {
  key: string; slug: string; name: string; urban: boolean; voivodeship: string | null; county: string | null;
  /** Ile inwestycji nie miało gminy w cenniku i dostało ją z nazwy miejscowości. */
  guessed: number;
  /** null, gdy żaden cennik z tej gminy nie podaje powiatu. */
  powiat: Powiat | null;
  cities: City[]; units: Unit[]; investments: Investment[];
}
/** Powiat ziemski ("poznański") albo miasto na prawach powiatu (urban, nazwa miasta). */
export interface Powiat {
  key: string; slug: string; name: string; urban: boolean; voivodeship: string | null;
  gminas: Gmina[]; units: Unit[]; investments: Investment[];
}
export interface Voivodeship { slug: string; name: string; units: Unit[]; cities: City[]; gminas: Gmina[]; powiaty: Powiat[] }
export interface Brand { key: string; slug: string; name: string; legalNames: string[]; host: string | null; units: Unit[]; investments: Investment[] }

export interface Point { date: string; value: number | null; n: number }
export interface Series { median: Point[]; index: Point[]; count: Point[] }

export interface Snapshot {
  asOf: string; units: number; investments: number;
  medianM2: number | null; p25M2: number | null; p75M2: number | null;
  medianTotal: number | null; medianArea: number | null;
  cuts: { share: number | null; count: number; base: number; avgDepth: number | null };
  raises: { share: number | null; count: number };
  newUnits: number; goneUnits: number;
  change: { median4w: number | null; median13w: number | null; median52w: number | null; index4w: number | null; index13w: number | null; indexAll: number | null };
}

// ---------- pomocnicze ----------

export function median(xs: ArrayLike<number>): number | null { return quantile(xs, 0.5); }

export function quantile(xs: ArrayLike<number>, q: number): number | null {
  const a = Float64Array.from(xs as ArrayLike<number>).sort();
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function uniqueSlug(base: string, used: Set<string>): string {
  let s = base;
  let n = 2;
  while (used.has(s)) s = `${base}-${n++}`;
  used.add(s);
  return s;
}

function rel(a: number | null, b: number | null): number | null {
  return a === null || b === null || b === 0 ? null : a / b - 1;
}

// ---------- model ----------

export class Model {
  readonly units: Unit[] = [];
  readonly investments: Investment[] = [];
  readonly cities: City[] = [];
  readonly gminas: Gmina[] = [];
  readonly powiaty: Powiat[] = [];
  readonly voivodeships: Voivodeship[] = [];
  readonly brands: Brand[] = [];
  readonly dates: string[] = [];          // daty pomiaru co 7 dni, od najstarszej
  readonly asOf: string;
  readonly firstDate: string;
  readonly staleDatasets = new Set<string>();
  /** prices[k][i] = cena za m² lokalu i w dacie dates[k], NaN gdy poza ofertą */
  private grid: Float32Array[] = [];
  private seriesCache = new Map<string, Series>();

  constructor(db: DatabaseSync) {
    const devs = db.prepare('SELECT id, legal_name, website_host, brand_key FROM developers').all() as
      { id: number; legal_name: string; website_host: string | null; brand_key: string }[];
    const brandByKey = new Map<string, Brand>();
    const devBrand = new Map<number, Brand>();
    for (const d of devs) {
      let b = brandByKey.get(d.brand_key);
      if (!b) {
        b = { key: d.brand_key, slug: '', name: '', legalNames: [], host: d.website_host, units: [], investments: [] };
        brandByKey.set(d.brand_key, b);
        this.brands.push(b);
      }
      b.legalNames.push(d.legal_name);
      devBrand.set(d.id, b);
    }

    const invRows = db.prepare('SELECT * FROM investments ORDER BY id').all() as Record<string, any>[];
    const places = invRows.map((r) => resolvePlace({ voivodeship: r.voivodeship, county: r.county, gmina: r.gmina, city: r.city }));
    // Brak województwa w cenniku: bierzemy najczęstsze województwo tej miejscowości
    // z innych cenników (inaczej np. Wrocław rozpadłby się na dwie strony).
    const voivVotes = new Map<string, Map<string, number>>();
    places.forEach((p, i) => {
      const v = invRows[i].voivodeship as string | null;
      if (!v) return;
      const votes = voivVotes.get(fold(p.city)) ?? new Map<string, number>();
      votes.set(v, (votes.get(v) ?? 0) + 1);
      voivVotes.set(fold(p.city), votes);
    });
    for (const [i, r] of invRows.entries()) {
      if (r.voivodeship) continue;
      const votes = voivVotes.get(fold(places[i].city));
      if (votes) r.voivodeship = [...votes].sort((a, b) => b[1] - a[1])[0][0];
    }
    // Brak gminy w cenniku: bierzemy najczęstszą gminę tej miejscowości z innych cenników.
    const placeKey = (voiv: string | null, city: string) => `${voiv ?? ''}|${fold(city)}`;
    const gminaVotes = new Map<string, Map<string, number>>();
    places.forEach((p, i) => {
      if (!p.gmina) return;
      const k = placeKey(invRows[i].voivodeship, p.city);
      const votes = gminaVotes.get(k) ?? new Map<string, number>();
      votes.set(p.gmina, (votes.get(p.gmina) ?? 0) + 1);
      gminaVotes.set(k, votes);
    });
    const topVote = (votes: Map<string, number> | undefined) => (votes ? [...votes].sort((a, b) => b[1] - a[1])[0][0] : null);
    const gminaByKey = new Map<string, Gmina>();
    const countyVotes = new Map<Gmina, Map<string, number>>();
    const cityByKey = new Map<string, City>();
    const invById = new Map<number, Investment>();
    invRows.forEach((r, i) => {
      const p = places[i];
      const inferred = p.gmina ?? topVote(gminaVotes.get(placeKey(r.voivodeship, p.city)));
      const gName = inferred ?? p.city;
      const gk = `${r.voivodeship ?? ''}|${p.urban ? 'm' : 'g'}|${fold(gName)}`;
      let gmina = gminaByKey.get(gk);
      if (!gmina) {
        gmina = { key: gk, slug: '', name: gName, urban: p.urban, voivodeship: r.voivodeship, county: null, guessed: 0, powiat: null, cities: [], units: [], investments: [] };
        gminaByKey.set(gk, gmina);
        this.gminas.push(gmina);
      }
      if (!inferred) gmina.guessed++;
      if (p.county) {
        const votes = countyVotes.get(gmina) ?? new Map<string, number>();
        votes.set(p.county, (votes.get(p.county) ?? 0) + 1);
        countyVotes.set(gmina, votes);
      }
      const ck = `${gk}|${fold(p.city)}`;
      let city = cityByKey.get(ck);
      if (!city) {
        city = { key: ck, slug: '', name: p.city, voivodeship: r.voivodeship, gmina, units: [], investments: [] };
        cityByKey.set(ck, city);
        this.cities.push(city);
        gmina.cities.push(city);
      }
      const named = !!r.name;
      const inv: Investment = {
        id: r.id, slug: '', name: r.name ?? [streetLabel(r.street), r.building_no].filter(Boolean).join(' ') ?? r.city,
        named, devId: r.developer_id, brand: devBrand.get(r.developer_id)!, city,
        street: r.street, buildingNo: r.building_no, postalCode: r.postal_code, prospectusUrl: r.prospectus_url, units: [],
      };
      if (!inv.name) inv.name = city.name;
      invById.set(inv.id, inv);
      this.investments.push(inv);
      city.investments.push(inv);
      gmina.investments.push(inv);
      inv.brand.investments.push(inv);
    });
    for (const [g, votes] of countyVotes) g.county = topVote(votes);

    const unitRows = db.prepare('SELECT id, investment_id, dataset_id, ref, type, area, rooms FROM units ORDER BY id').all() as Record<string, any>[];
    const unitById = new Map<number, Unit>();
    for (const r of unitRows) {
      const inv = invById.get(r.investment_id)!;
      const u: Unit = { i: this.units.length, id: r.id, ref: r.ref, type: r.type, area: r.area, rooms: r.rooms, inv, dataset: r.dataset_id, presence: [], prices: [] };
      this.units.push(u);
      unitById.set(u.id, u);
      inv.units.push(u);
      inv.city.units.push(u);
      inv.city.gmina.units.push(u);
      inv.brand.units.push(u);
    }
    for (const r of db.prepare('SELECT unit_id, from_date, to_date FROM presence ORDER BY unit_id, from_date').iterate() as Iterable<any>) {
      unitById.get(r.unit_id)?.presence.push([r.from_date, r.to_date]);
    }
    for (const r of db.prepare('SELECT unit_id, from_date, price_m2, price_total FROM prices ORDER BY unit_id, from_date').iterate() as Iterable<any>) {
      unitById.get(r.unit_id)?.prices.push({ from: r.from_date, m2: r.price_m2, total: r.price_total });
    }

    const last = this.units.flatMap((u) => u.presence.map((p) => p[1])).sort().at(-1);
    const first = this.units.flatMap((u) => u.presence.map((p) => p[0])).sort()[0];
    this.asOf = last ?? new Date().toISOString().slice(0, 10);
    this.firstDate = first ?? this.asOf;
    for (let d = this.asOf; d >= this.firstDate; d = addDays(d, -7)) this.dates.unshift(d);

    for (const r of db.prepare('SELECT id, last_snapshot FROM datasets').all() as { id: string; last_snapshot: string | null }[]) {
      if (!r.last_snapshot || r.last_snapshot < addDays(this.asOf, -STALE_DAYS)) this.staleDatasets.add(r.id);
    }

    // Siatka cen: jedna tablica na datę pomiaru.
    for (const d of this.dates) {
      const row = new Float32Array(this.units.length).fill(NaN);
      for (const u of this.units) if (this.inOffer(u, d)) {
        const p = this.priceAt(u, d);
        if (p) row[u.i] = p.m2;
      }
      this.grid.push(row);
    }

    this.buildPowiaty();
    this.assignNames();
  }

  /** Powiaty z gmin: powiat gminy to najczęstszy powiat w jej cennikach. */
  private buildPowiaty() {
    const byKey = new Map<string, Powiat>();
    for (const g of this.gminas) {
      if (!g.county) continue;
      const k = `${g.voivodeship ?? ''}|${g.urban ? 'm' : 'p'}|${fold(g.county)}`;
      let p = byKey.get(k);
      if (!p) {
        p = { key: k, slug: '', name: g.county, urban: g.urban, voivodeship: g.voivodeship, gminas: [], units: [], investments: [] };
        byKey.set(k, p);
        this.powiaty.push(p);
      }
      g.powiat = p;
      p.gminas.push(g);
      p.units.push(...g.units);
      p.investments.push(...g.investments);
    }
  }

  inOffer(u: Unit, d: string): boolean {
    const ps = u.presence;
    for (let k = 0; k < ps.length; k++) {
      const [f, t] = ps[k];
      if (f > d) return false;
      if (d <= t) return true;
      const next = ps[k + 1];
      if (next && next[0] > d && next[0] <= addDays(t, BRIDGE_DAYS)) return true;
    }
    return false;
  }

  priceAt(u: Unit, d: string) {
    let p: Unit['prices'][number] | null = null;
    for (const x of u.prices) { if (x.from <= d) p = x; else break; }
    return p ?? u.prices[0] ?? null;
  }

  private assignNames() {
    const usedCity = new Set<string>();
    const nameCount = new Map<string, number>();
    for (const c of this.cities) nameCount.set(slugify(c.name), (nameCount.get(slugify(c.name)) ?? 0) + 1);
    for (const c of [...this.cities].sort((a, b) => b.units.length - a.units.length)) {
      const base = slugify(c.name);
      c.slug = uniqueSlug(nameCount.get(base)! > 1 ? `${base}-${slugify(c.voivodeship ?? c.gmina.name)}` : base, usedCity);
    }
    // Gminy: przy powtórzonej nazwie miasto na prawach powiatu zostaje przy samej nazwie,
    // a pozostałe dostają powiat (np. gmina Chełm wokół miasta Chełm).
    const usedGmina = new Set<string>();
    const gCount = new Map<string, number>();
    for (const g of this.gminas) gCount.set(slugify(g.name), (gCount.get(slugify(g.name)) ?? 0) + 1);
    const byUrbanThenSize = (a: Gmina, b: Gmina) => Number(b.urban) - Number(a.urban) || b.units.length - a.units.length;
    for (const g of [...this.gminas].sort(byUrbanThenSize)) {
      const base = slugify(g.name);
      g.slug = uniqueSlug(gCount.get(base)! > 1 && !g.urban ? `${base}-${slugify(g.county ?? g.voivodeship ?? '')}` : base, usedGmina);
    }
    const usedInv = new Set<string>();
    for (const inv of [...this.investments].sort((a, b) => a.id - b.id)) inv.slug = uniqueSlug(`${inv.city.slug}-${slugify(inv.name)}`, usedInv);
    const usedBrand = new Set<string>();
    for (const b of [...this.brands].sort((a, z) => z.units.length - a.units.length)) {
      const shortest = [...b.legalNames].map(displayCompanyName).sort((x, y) => x.length - y.length)[0];
      b.name = shortest.replace(/\s+projekt\s+\d+$/i, '').trim() || shortest;
      b.slug = uniqueSlug(slugify(b.name), usedBrand);
    }
    // Powiaty: nazwy powtarzają się między województwami (np. powiat średzki), wtedy dopisujemy województwo.
    const usedPowiat = new Set<string>();
    const pCount = new Map<string, number>();
    for (const p of this.powiaty) pCount.set(slugify(p.name), (pCount.get(slugify(p.name)) ?? 0) + 1);
    for (const p of [...this.powiaty].sort((a, b) => Number(b.urban) - Number(a.urban) || b.units.length - a.units.length)) {
      const base = slugify(p.name);
      p.slug = uniqueSlug(pCount.get(base)! > 1 && !p.urban ? `${base}-${slugify(p.voivodeship ?? '')}` : base, usedPowiat);
    }
    const byVoiv = new Map<string, Voivodeship>();
    for (const c of this.cities) {
      if (!c.voivodeship) continue;
      let v = byVoiv.get(c.voivodeship);
      if (!v) { v = { slug: slugify(c.voivodeship), name: c.voivodeship, units: [], cities: [], gminas: [], powiaty: [] }; byVoiv.set(c.voivodeship, v); this.voivodeships.push(v); }
      v.cities.push(c);
      if (!v.gminas.includes(c.gmina)) v.gminas.push(c.gmina);
      if (c.gmina.powiat && !v.powiaty.includes(c.gmina.powiat)) v.powiaty.push(c.gmina.powiat);
      v.units.push(...c.units);
    }
    this.voivodeships.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
  }

  // ---------- szeregi czasowe ----------

  /** Mediana, indeks tych samych lokali i liczba lokali w czasie dla zbioru lokali. */
  series(key: string, units: Unit[], minOverlap = 10): Series {
    const hit = this.seriesCache.get(key);
    if (hit) return hit;
    const idx = units.map((u) => u.i);
    const median_: Point[] = [];
    const index: Point[] = [];
    const count: Point[] = [];
    let level = 100;
    this.dates.forEach((d, k) => {
      const row = this.grid[k];
      const vals: number[] = [];
      for (const i of idx) if (!Number.isNaN(row[i])) vals.push(row[i]);
      median_.push({ date: d, value: vals.length >= 3 ? median(vals) : null, n: vals.length });
      count.push({ date: d, value: vals.length, n: vals.length });
      if (k === 0) { index.push({ date: d, value: vals.length ? 100 : null, n: vals.length }); return; }
      const prev = this.grid[k - 1];
      let sumLog = 0;
      let n = 0;
      for (const i of idx) {
        const a = prev[i];
        const b = row[i];
        if (!Number.isNaN(a) && !Number.isNaN(b) && a > 0) { sumLog += Math.log(b / a); n++; }
      }
      // Szereg, który startuje później (nowa gmina, nowe osiedle), zaczyna się od 100
      // w tygodniu poprzedzającym pierwsze porównanie.
      if (n >= minOverlap && !index.some((p) => p.value !== null)) index[k - 1] = { ...index[k - 1], value: 100 };
      if (n >= minOverlap) level *= Math.exp(sumLog / n);
      index.push({ date: d, value: index.some((p) => p.value !== null) || n >= minOverlap ? level : null, n });
    });
    const s = { median: median_, index, count };
    this.seriesCache.set(key, s);
    return s;
  }

  private dateIndex(weeksBack: number): number { return Math.max(0, this.dates.length - 1 - weeksBack); }

  /** Stan na ostatni dzień i zmiany w czasie dla zbioru lokali. */
  snapshot(key: string, units: Unit[]): Snapshot {
    const s = this.series(key, units);
    const k = this.dates.length - 1;
    const k4 = this.dateIndex(4);
    const now = this.grid[k];
    const then = this.grid[k4];
    const cur: Unit[] = units.filter((u) => !Number.isNaN(now[u.i]));
    const m2 = cur.map((u) => now[u.i]);
    const totals = cur.map((u) => this.priceAt(u, this.asOf)?.total).filter((x): x is number => !!x);
    const areas = cur.map((u) => u.area).filter((x): x is number => !!x);

    let base = 0, cuts = 0, raises = 0, depth = 0;
    for (const u of cur) {
      const a = then[u.i];
      if (Number.isNaN(a)) continue;
      base++;
      const r = now[u.i] / a;
      if (r < 0.995) { cuts++; depth += 1 - r; } else if (r > 1.005) raises++;
    }
    let newU = 0, gone = 0;
    for (const u of units) {
      const inNow = !Number.isNaN(now[u.i]);
      const inThen = !Number.isNaN(then[u.i]);
      if (inNow && !inThen) newU++;
      if (!inNow && inThen && !this.staleDatasets.has(u.dataset)) gone++;
    }
    const at = (pts: Point[], back: number) => pts[this.dateIndex(back)]?.value ?? null;
    const last = (pts: Point[]) => pts[k]?.value ?? null;
    const firstIdx = s.index.find((p) => p.value !== null)?.value ?? null;
    return {
      asOf: this.asOf,
      units: cur.length,
      investments: new Set(cur.map((u) => u.inv.id)).size,
      medianM2: median(m2), p25M2: quantile(m2, 0.25), p75M2: quantile(m2, 0.75),
      medianTotal: median(totals), medianArea: median(areas),
      cuts: { share: base ? cuts / base : null, count: cuts, base, avgDepth: cuts ? depth / cuts : null },
      raises: { share: base ? raises / base : null, count: raises },
      newUnits: newU, goneUnits: gone,
      change: {
        median4w: rel(last(s.median), at(s.median, 4)),
        median13w: rel(last(s.median), at(s.median, 13)),
        median52w: this.dates.length > 52 ? rel(last(s.median), at(s.median, 52)) : null,
        index4w: rel(last(s.index), at(s.index, 4)),
        index13w: rel(last(s.index), at(s.index, 13)),
        indexAll: rel(last(s.index), firstIdx),
      },
    };
  }

  /** Udział lokali tańszych niż 4 tygodnie wcześniej, tydzień po tygodniu. */
  cutsSeries(units: Unit[], minBase = 10): Point[] {
    return this.dates.map((d, k) => {
      if (k < 4) return { date: d, value: null, n: 0 };
      const now = this.grid[k];
      const then = this.grid[k - 4];
      let base = 0, cuts = 0;
      for (const u of units) {
        const a = then[u.i];
        const b = now[u.i];
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        base++;
        if (b < a * 0.995) cuts++;
      }
      return { date: d, value: base >= minBase ? (cuts / base) * 100 : null, n: base };
    });
  }

  /** Mediana dowolnej wartości lokali w ofercie (np. ceny całkowitej) na ostatni dzień. */
  currentMedian(units: Unit[], value: (u: Unit) => number | null | undefined): number | null {
    const vals: number[] = [];
    for (const u of units) {
      if (this.currentM2(u) === null) continue;
      const v = value(u);
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    }
    return median(vals);
  }

  /** Rozkład cen za m² lokali w ofercie: przedziały o stałej szerokości. */
  histogram(units: Unit[], width = 1000) {
    const now = this.grid[this.dates.length - 1];
    const vals = units.map((u) => now[u.i]).filter((v) => !Number.isNaN(v));
    if (!vals.length) return [];
    const lo = Math.floor(Math.min(...vals) / width) * width;
    const hi = Math.floor(Math.max(...vals) / width) * width;
    const bins: { from: number; to: number; n: number }[] = [];
    for (let x = lo; x <= hi; x += width) bins.push({ from: x, to: x + width, n: 0 });
    for (const v of vals) bins[Math.floor((v - lo) / width)].n++;
    return bins;
  }

  /** Metraż: liczba lokali i mediana ceny za m² w przedziałach powierzchni. */
  areaBuckets(units: Unit[]) {
    const edges = [0, 35, 50, 70, 90, Infinity];
    const label = ['do 35 m²', '35–50 m²', '50–70 m²', '70–90 m²', 'ponad 90 m²'];
    const now = this.grid[this.dates.length - 1];
    return label.map((l, b) => {
      const vals = units.filter((u) => u.area !== null && u.area >= edges[b] && u.area < edges[b + 1] && !Number.isNaN(now[u.i])).map((u) => now[u.i]);
      return { label: l, n: vals.length, medianM2: vals.length >= 3 ? median(vals) : null };
    });
  }

  /** Największe obniżki z ostatnich 4 tygodni. */
  topCuts(units: Unit[], limit = 20) {
    const k = this.dates.length - 1;
    const now = this.grid[k];
    const then = this.grid[this.dateIndex(4)];
    const out: { unit: Unit; before: number; after: number; change: number; date: string; totalBefore: number | null; totalAfter: number | null }[] = [];
    for (const u of units) {
      const a = then[u.i];
      const b = now[u.i];
      if (Number.isNaN(a) || Number.isNaN(b) || b >= a * 0.995) continue;
      const lastChange = [...u.prices].reverse().find((p) => p.from <= this.asOf);
      const before = this.priceAt(u, this.dates[this.dateIndex(4)]);
      out.push({ unit: u, before: a, after: b, change: b / a - 1, date: lastChange?.from ?? this.asOf, totalBefore: before?.total ?? null, totalAfter: lastChange?.total ?? null });
    }
    return out.sort((x, y) => x.change - y.change).slice(0, limit);
  }

  currentM2(u: Unit): number | null {
    const v = this.grid[this.dates.length - 1][u.i];
    return Number.isNaN(v) ? null : v;
  }

  /** Data ostatniej obecności lokalu w ofercie. */
  lastSeen(u: Unit): string | null { return u.presence.at(-1)?.[1] ?? null; }
  firstSeen(u: Unit): string | null { return u.presence[0]?.[0] ?? null; }

  /** Lista zmian cen w zbiorze lokali, od najnowszych. */
  priceChanges(units: Unit[], limit = 50) {
    const out: { unit: Unit; date: string; before: number; after: number; change: number }[] = [];
    for (const u of units) for (let j = 1; j < u.prices.length; j++) {
      const a = u.prices[j - 1];
      const b = u.prices[j];
      out.push({ unit: u, date: b.from, before: a.m2, after: b.m2, change: b.m2 / a.m2 - 1 });
    }
    return out.sort((x, y) => y.date.localeCompare(x.date) || x.change - y.change).slice(0, limit);
  }

  /** Miesiące, dla których mamy pomiar na koniec miesiąca. */
  months(): string[] {
    const m = new Set(this.dates.map((d) => d.slice(0, 7)));
    return [...m].sort();
  }

  /** Ostatnia data pomiaru w miesiącu. */
  monthEnd(month: string): string | null {
    return [...this.dates].reverse().find((d) => d.startsWith(month)) ?? null;
  }

  /** Wartość szeregu w danej dacie pomiaru. */
  valueAt(pts: Point[], date: string): number | null {
    return pts.find((p) => p.date === date)?.value ?? null;
  }

  /** Wiersz siatki cen w dacie pomiaru, do porównań między datami. */
  pricesOn(date: string): Float32Array | null {
    const k = this.dates.indexOf(date);
    return k < 0 ? null : this.grid[k];
  }
}

export const MIN_CITY_UNITS = Number(process.env.MIN_CITY_UNITS ?? 30);
export const MIN_INVESTMENT_UNITS = 1;
