// Pobieranie cenników z dane.gov.pl (API 1.4, format JSON:API).
//
// Sprawdzone na prawdziwym API (30.10.2026, komenda "probe" w GitHub Actions):
//  - zbiory deweloperów mają tytuł "Ceny ofertowe mieszkań/domów …"; filtr
//    title[phrase]=ceny ofertowe zwraca tylko je (ok. 18,6 tys. zbiorów),
//    a wyszukiwanie pełnotekstowe (q=) zwraca dziesiątki tysięcy innych zbiorów;
//  - paginacja kończy się na 10 000 wyników, więc listę pobieramy dwa razy:
//    rosnąco i malejąco po id, i łączymy (wystarcza do 20 000 zbiorów);
//  - zasób (dzienny cennik) ma pola data_date (RRRR-MM-DD), download_url, format.

import type { DatabaseSync } from 'node:sqlite';
import { ingestSnapshot, type IngestSummary } from './ingest.ts';
import { devNameFromTitle, guessFormat, parseFile, readTable, sniffFormat } from './parse.ts';
import { mapColumns } from './columns.ts';

export const API = process.env.DANE_API ?? 'https://api.dane.gov.pl/1.4';
const UA = 'prostedane.pl importer (kontakt@prostedane.pl)';
// Tytuły bywają różne: "Ceny ofertowe mieszkań/domów/lokali …", "Ceny ofertowe inwestycji …",
// "Ceny ofertowe nieruchomości dewelopera …". Pliki bez kolumn cennika odrzuca import.
const TITLE_RE = /ceny ofertowe/i;
const TITLE_PHRASE = 'ceny ofertowe';
const WINDOW = 10000;

interface ApiItem { id: string | number; attributes?: Record<string, unknown>; links?: Record<string, unknown> }
interface ApiList { data?: ApiItem[]; links?: { next?: string | null }; meta?: Record<string, unknown> }

export interface DatasetRef { id: string; title: string }
export interface ResourceRef { id: string; date: string; url: string; format: string; raw: Record<string, unknown> }

async function getJson<T>(url: string, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

/**
 * Wszystkie zbiory z cenami ofertowymi. Szukamy po frazie i filtrujemy po tytule.
 * stopAfter: przerwij po tylu trafieniach (podgląd). Postęp idzie na stderr, żeby
 * w logu GitHub Actions było widać, że lista się pobiera.
 */
export async function listDeveloperDatasets(opts: { limitPages?: number; stopAfter?: number } = {}): Promise<DatasetRef[]> {
  const out = new Map<string, DatasetRef>();
  const limitPages = opts.limitPages ?? 120;
  const started = Date.now();
  let total = 0;
  for (const sort of ['id', '-id']) {
    for (let page = 1; page <= limitPages; page++) {
      const body = await getJson<ApiList>(`${API}/datasets?title[phrase]=${encodeURIComponent(TITLE_PHRASE)}&sort=${sort}&per_page=100&page=${page}`);
      total = Number(body.meta?.count ?? total);
      const items = body.data ?? [];
      for (const it of items) {
        const title = String(it.attributes?.title ?? '');
        if (TITLE_RE.test(title)) out.set(String(it.id), { id: String(it.id), title });
      }
      if (page % 20 === 0) console.error(`lista zbiorów (${sort}): strona ${page}, zbiorów ${out.size} z ${total}, ${Math.round((Date.now() - started) / 1000)} s`);
      if (opts.stopAfter && out.size >= opts.stopAfter) return [...out.values()].slice(0, opts.stopAfter);
      if (!items.length || !body.links?.next) break;
    }
    if (total <= WINDOW) break; // całość mieści się w jednym przebiegu
  }
  console.error(`lista zbiorów: ${out.size} zbiorów z cenami (portal podaje ${total} dla frazy w tytule)`);
  if (total > 2 * WINDOW) console.error(`UWAGA: zbiorów jest ponad ${2 * WINDOW}; część nie zmieściła się w dwóch przebiegach. Trzeba podzielić zapytanie.`);
  return [...out.values()];
}

/**
 * Diagnostyka API dane.gov.pl: kilka wariantów wyszukiwania (liczba wyników,
 * pierwsze tytuły, czas odpowiedzi) i surowe pola jednego zbioru i jego zasobów.
 * Wynik czytamy w logu GitHub Actions, żeby dopasować import do prawdziwego API.
 */
export async function probeApi(): Promise<void> {
  const show = async (label: string, url: string): Promise<ApiList | null> => {
    const t = Date.now();
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      console.log(`\n=== ${label}: HTTP ${res.status}, ${Date.now() - t} ms\n${url}`);
      let body: ApiList | null = null;
      try { body = JSON.parse(text) as ApiList; } catch { console.log(text.slice(0, 600)); return null; }
      console.log('meta:', JSON.stringify(body.meta ?? null).slice(0, 700));
      console.log('links:', JSON.stringify(body.links ?? null).slice(0, 500));
      for (const it of (body.data ?? []).slice(0, 8)) console.log(' -', it.id, '|', String(it.attributes?.title ?? '').slice(0, 140));
      return body;
    } catch (e) {
      console.log(`\n=== ${label}: BŁĄD ${(e as Error).message}\n${url}`);
      return null;
    }
  };
  const enc = encodeURIComponent;
  const bodies = [
    await show('fraza bez cudzysłowu', `${API}/datasets?q=${enc('ceny ofertowe mieszkań dewelopera')}&per_page=10`),
    await show('fraza w cudzysłowie', `${API}/datasets?q=${enc('"ceny ofertowe mieszkań"')}&per_page=10`),
    await show('filtr tytułu (phrase)', `${API}/datasets?title[phrase]=${enc('ceny ofertowe')}&per_page=10`),
    await show('filtr tytułu (match)', `${API}/datasets?title[match]=${enc('ceny ofertowe mieszkań')}&per_page=10`),
    await show('filtr tytułu, 100 na stronę, malejąco', `${API}/datasets?title[phrase]=${enc('ceny ofertowe')}&sort=-id&per_page=100`),
    await show('filtr tytułu, strona 100', `${API}/datasets?title[phrase]=${enc('ceny ofertowe')}&sort=id&per_page=100&page=100`),
  ];
  const hit = bodies.flatMap((b) => b?.data ?? []).find((it) => TITLE_RE.test(String(it.attributes?.title ?? '')));
  if (!hit) { console.log('\nŻaden wariant nie zwrócił zbioru z tytułem pasującym do', TITLE_RE); return; }
  const ds = await getJson<{ data?: ApiItem & { relationships?: unknown } }>(`${API}/datasets/${hit.id}`);
  console.log(`\n=== ZBIÓR ${hit.id}: atrybuty\n${JSON.stringify(ds.data?.attributes ?? null).slice(0, 4000)}`);
  console.log(`\n=== ZBIÓR ${hit.id}: powiązania\n${JSON.stringify((ds.data as { relationships?: unknown } | undefined)?.relationships ?? null).slice(0, 2000)}`);
  const rs = await getJson<ApiList>(`${API}/datasets/${hit.id}/resources?sort=-data_date&per_page=3`);
  console.log(`\n=== ZASOBY ZBIORU ${hit.id}: meta\n${JSON.stringify(rs.meta ?? null).slice(0, 600)}`);
  for (const r of (rs.data ?? []).slice(0, 2)) console.log(`\n--- zasób ${r.id}\n${JSON.stringify(r.attributes ?? null).slice(0, 4000)}`);
  await probeParse();
}

/**
 * Test czytania prawdziwych cenników: najnowszy plik z kilkunastu zbiorów
 * (różni deweloperzy, różne formaty), wynik importu i nierozpoznane kolumny.
 */
export async function probeParse(sample = 60): Promise<void> {
  // Zbiory z kilku miejsc listy (najnowsze, środek, najstarsze): różni deweloperzy i szablony.
  const pages = [
    `sort=-id&per_page=100`, `sort=id&per_page=100&page=40`, `sort=id&per_page=100&page=5`, `sort=-id&per_page=100&page=30`,
  ];
  const every = (xs: ApiItem[], n: number) => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / n)) === 0).slice(0, n);
  const picked: ApiItem[] = [];
  for (const q of pages) {
    const body = await getJson<ApiList>(`${API}/datasets?title[phrase]=${encodeURIComponent(TITLE_PHRASE)}&${q}`);
    picked.push(...every(body.data ?? [], sample / pages.length));
  }
  let units = 0, rowsAll = 0;
  const unknownAll = new Map<string, number>();
  let ok = 0;
  for (const it of picked) {
    const title = String(it.attributes?.title ?? '');
    try {
      const [res] = await listResources(String(it.id), 1);
      if (!res) { console.log(`\n### ${it.id} | ${title}\n   brak zasobu z plikiem`); continue; }
      const buf = await download(res.url);
      const p = await parseFile(buf, res.format, { devFallback: devNameFromTitle(title) });
      if (p.records.length) ok++;
      units += p.records.length;
      rowsAll += p.rowsRead;
      for (const h of p.unknownHeaders) unknownAll.set(h, (unknownAll.get(h) ?? 0) + 1);
      const r = p.records[0];
      console.log(`\n### ${it.id} | ${title}\n   ${res.date} ${res.format} | wierszy ${p.rowsRead}, lokali ${p.records.length}, sprzedanych ${p.sold}` +
        `\n   odrzucone: ${JSON.stringify(p.rejected)} | brak kolumn: ${p.missingColumns.join(', ') || '-'}` +
        (r ? `\n   przykład: ${JSON.stringify({ dew: r.devName, woj: r.voivodeship, pow: r.county, gm: r.gmina, m: r.city, inw: r.investmentName, nr: r.unitRef, typ: r.unitType, pow_m2: r.area, zl_m2: r.priceM2, zl: r.priceTotal, data: r.priceM2Date })}` : ''));
      for (const [why, row] of Object.entries(p.rejectedSample ?? {})) {
        if (why === 'brak wymaganych kolumn') continue;
        const t = await readTable(buf, sniffFormat(buf) ?? res.format);
        const { map } = mapColumns(t.headers);
        const pick = Object.fromEntries(Object.entries(map).filter(([f]) => /city|unitRef|unitType|price|area|status|address|devName/.test(f)).map(([f, i]) => [f, (row as unknown[])[i as number]]));
        console.log(`   odrzucony („${why}”): ${JSON.stringify(pick).slice(0, 400)}`);
      }
      if (!p.records.length) {
        const table = await readTable(buf, sniffFormat(buf) ?? res.format);
        const { map } = mapColumns(table.headers);
        console.log(`   nagłówki (${sniffFormat(buf) ?? res.format}): ${JSON.stringify(table.headers)}\n   rozpoznane: ${JSON.stringify(map)}\n   pierwszy wiersz: ${JSON.stringify(table.rows[0] ?? null)}`);
      }
    } catch (e) {
      console.log(`\n### ${it.id} | ${title}\n   BŁĄD: ${(e as Error).message}`);
    }
  }
  console.log(`\n=== Wczytane z lokalami: ${ok} z ${picked.length} plików; lokali ${units} z ${rowsAll} wierszy`);
  console.log('=== Nierozpoznane nagłówki (ile plików):');
  for (const [h, n] of [...unknownAll].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`   ${n} × ${h}`);
}

function pickUrl(a: Record<string, unknown>): string | null {
  for (const k of ['download_url', 'file_url', 'link', 'url']) {
    const v = a[k];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

/** Zasoby zbioru od najnowszego. Każdy dzienny cennik to osobny zasób. */
export async function listResources(datasetId: string, perPage = 10): Promise<ResourceRef[]> {
  const body = await getJson<ApiList>(`${API}/datasets/${datasetId}/resources?sort=-data_date&per_page=${perPage}`);
  return (body.data ?? []).flatMap((it) => {
    const a = it.attributes ?? {};
    const url = pickUrl(a);
    const date = String(a.data_date ?? a.created ?? a.modified ?? '').slice(0, 10);
    if (!url || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return [{ id: String(it.id), date, url, format: guessFormat(url, String(a.format ?? '')), raw: a }];
  });
}

async function download(url: string, maxBytes = 60 * 1024 * 1024): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(90000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} przy pobieraniu ${url}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error(`plik za duży (${len} B)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`plik za duży (${buf.length} B)`);
  return buf;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export interface HarvestError { datasetId: string; error: string }

/**
 * Codzienny import: dla każdego zbioru pobiera najnowszy cennik, jeśli jest
 * nowszy niż ostatnio wczytany. Wczytywanie do bazy odbywa się po kolei
 * (SQLite), pobieranie równolegle.
 */
export async function harvest(db: DatabaseSync, opts: { concurrency?: number; dryRun?: boolean; limit?: number } = {}) {
  const datasets = (await listDeveloperDatasets({ stopAfter: opts.limit })).slice(0, opts.limit ?? Infinity);
  const lastOf = db.prepare('SELECT last_snapshot FROM datasets WHERE id = ?');
  const summaries: IngestSummary[] = [];
  const errors: HarvestError[] = [];

  await pool(datasets, opts.concurrency ?? 6, async (ds) => {
    try {
      const [res] = await listResources(ds.id, 1);
      if (!res) return;
      if (opts.dryRun) { console.log(JSON.stringify({ dataset: ds, resource: res.raw }, null, 1)); return; }
      const last = (lastOf.get(ds.id) as { last_snapshot: string | null } | undefined)?.last_snapshot;
      if (last && last >= res.date) return;
      const parsed = await parseFile(await download(res.url), res.format, { devFallback: devNameFromTitle(ds.title) });
      summaries.push(ingestSnapshot(db, { datasetId: ds.id, title: ds.title, date: res.date, sourceUrl: res.url }, parsed));
    } catch (e) {
      errors.push({ datasetId: ds.id, error: String((e as Error).message ?? e) });
    }
  });
  return { datasets: datasets.length, summaries, errors };
}

/**
 * Uzupełnienie historii: z każdego zbioru bierze jeden cennik na tydzień, od
 * najstarszego. Zbiory pobiera równolegle, a w obrębie zbioru po kolei (historia
 * musi wchodzić chronologicznie). Zbiór z wczytaną historią trafia do
 * backfill_done i kolejne uruchomienia go pomijają. Limit czasu pozwala rozłożyć
 * pierwsze wczytanie na kilka nocy; nowe zbiory (nowi deweloperzy) dostają historię
 * przy najbliższym uruchomieniu.
 */
export async function backfill(db: DatabaseSync, opts: { datasets: DatasetRef[]; perPage?: number; concurrency?: number; minutes?: number; stepDays?: number }) {
  const summaries: IngestSummary[] = [];
  const errors: HarvestError[] = [];
  const done = new Set((db.prepare('SELECT dataset_id FROM backfill_done').all() as { dataset_id: string }[]).map((r) => r.dataset_id));
  const titles = new Map(opts.datasets.map((d) => [d.id, d.title]));
  const todo = opts.datasets.map((d) => d.id).filter((id) => !done.has(id));
  const markDone = db.prepare('INSERT OR REPLACE INTO backfill_done(dataset_id, finished) VALUES (?, ?)');
  const deadline = Date.now() + (opts.minutes ?? Infinity) * 60000;
  let finished = 0;
  let lastLog = Date.now();
  await pool(todo, opts.concurrency ?? 10, async (id) => {
    if (Date.now() > deadline) return;
    if (Date.now() - lastLog > 60000) { lastLog = Date.now(); console.error(`historia: ${finished} z ${todo.length} zbiorów, plików ${summaries.length}`); }
    try {
      const all = await listResources(id, opts.perPage ?? 500);
      // Jeden cennik na okres (domyślnie 28 dni): niemal każdy deweloper publikuje codziennie,
      // więc pełna historia dzień po dniu to ponad milion plików.
      const step = opts.stepDays ?? 28;
      const periodic = new Map<number, ResourceRef>();
      for (const r of all.sort((a, b) => a.date.localeCompare(b.date))) {
        const day = Math.floor(new Date(r.date + 'T00:00:00Z').getTime() / 86400000);
        periodic.set(Math.floor(day / step), r); // zostaje ostatni cennik okresu
      }
      const latest = all.at(-1);
      if (latest) periodic.set(Number.MAX_SAFE_INTEGER, latest); // i zawsze najnowszy
      for (const r of [...periodic.values()].filter((r, i, xs) => xs.indexOf(r) === i)) {
        const parsed = await parseFile(await download(r.url), r.format, { devFallback: devNameFromTitle(titles.get(id)) });
        summaries.push(ingestSnapshot(db, { datasetId: id, title: titles.get(id), date: r.date, sourceUrl: r.url }, parsed));
      }
      markDone.run(id, new Date().toISOString());
      finished++;
    } catch (e) {
      errors.push({ datasetId: id, error: String((e as Error).message ?? e) });
    }
  });
  return { summaries, errors, total: opts.datasets.length, remaining: todo.length - finished };
}
