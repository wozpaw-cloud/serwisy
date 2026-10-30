// Pobieranie cenników z dane.gov.pl (API 1.4, format JSON:API).
//
// UWAGA: tego modułu nie dało się uruchomić w środowisku, w którym powstał kod
// (brak dostępu sieciowego do dane.gov.pl). Nazwy pól odpowiedzi czytamy
// defensywnie z kilku wariantów. Pierwsze uruchomienie w GitHub Actions trzeba
// obejrzeć w logu: komenda "harvest --dry-run" wypisuje surowe pola zasobu.

import type { DatabaseSync } from 'node:sqlite';
import { ingestSnapshot, type IngestSummary } from './ingest.ts';
import { guessFormat, parseFile } from './parse.ts';

export const API = process.env.DANE_API ?? 'https://api.dane.gov.pl/1.4';
const UA = 'prostedane.pl importer (kontakt@prostedane.pl)';
const TITLE_RE = /ceny ofertowe (mieszka[nń]|lokali|dom[óo]w)/i;

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
  const limitPages = opts.limitPages ?? 500;
  const started = Date.now();
  for (const q of ['ceny ofertowe mieszkań dewelopera', 'ceny ofertowe deweloper']) {
    for (let page = 1; page <= limitPages; page++) {
      const body = await getJson<ApiList>(`${API}/datasets?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
      const items = body.data ?? [];
      for (const it of items) {
        const title = String(it.attributes?.title ?? '');
        if (TITLE_RE.test(title)) out.set(String(it.id), { id: String(it.id), title });
      }
      if (page % 10 === 0) console.error(`lista zbiorów: "${q}", strona ${page}, trafień ${out.size}, ${Math.round((Date.now() - started) / 1000)} s`);
      if (opts.stopAfter && out.size >= opts.stopAfter) return [...out.values()].slice(0, opts.stopAfter);
      if (!items.length || !body.links?.next) break;
    }
  }
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
    await show('wyszukiwarka ogólna', `${API}/search?q=${enc('ceny ofertowe mieszkań dewelopera')}&per_page=10`),
  ];
  const hit = bodies.flatMap((b) => b?.data ?? []).find((it) => TITLE_RE.test(String(it.attributes?.title ?? '')));
  if (!hit) { console.log('\nŻaden wariant nie zwrócił zbioru z tytułem pasującym do', TITLE_RE); return; }
  const ds = await getJson<{ data?: ApiItem & { relationships?: unknown } }>(`${API}/datasets/${hit.id}`);
  console.log(`\n=== ZBIÓR ${hit.id}: atrybuty\n${JSON.stringify(ds.data?.attributes ?? null).slice(0, 4000)}`);
  console.log(`\n=== ZBIÓR ${hit.id}: powiązania\n${JSON.stringify((ds.data as { relationships?: unknown } | undefined)?.relationships ?? null).slice(0, 2000)}`);
  const rs = await getJson<ApiList>(`${API}/datasets/${hit.id}/resources?sort=-data_date&per_page=3`);
  console.log(`\n=== ZASOBY ZBIORU ${hit.id}: meta\n${JSON.stringify(rs.meta ?? null).slice(0, 600)}`);
  for (const r of (rs.data ?? []).slice(0, 2)) console.log(`\n--- zasób ${r.id}\n${JSON.stringify(r.attributes ?? null).slice(0, 4000)}`);
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
      const parsed = await parseFile(await download(res.url), res.format);
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
export async function backfill(db: DatabaseSync, opts: { datasetIds: string[]; perPage?: number; concurrency?: number; minutes?: number }) {
  const summaries: IngestSummary[] = [];
  const errors: HarvestError[] = [];
  const done = new Set((db.prepare('SELECT dataset_id FROM backfill_done').all() as { dataset_id: string }[]).map((r) => r.dataset_id));
  const todo = opts.datasetIds.filter((id) => !done.has(id));
  const markDone = db.prepare('INSERT OR REPLACE INTO backfill_done(dataset_id, finished) VALUES (?, ?)');
  const deadline = Date.now() + (opts.minutes ?? Infinity) * 60000;
  let finished = 0;
  await pool(todo, opts.concurrency ?? 6, async (id) => {
    if (Date.now() > deadline) return;
    try {
      const all = await listResources(id, opts.perPage ?? 500);
      const weekly = new Map<string, ResourceRef>();
      for (const r of all.sort((a, b) => a.date.localeCompare(b.date))) {
        const d = new Date(r.date + 'T00:00:00Z');
        const week = `${d.getUTCFullYear()}-${Math.floor((d.getTime() / 86400000 + 3) / 7)}`;
        weekly.set(week, r); // zostaje ostatni cennik tygodnia
      }
      for (const r of weekly.values()) {
        const parsed = await parseFile(await download(r.url), r.format);
        summaries.push(ingestSnapshot(db, { datasetId: id, date: r.date, sourceUrl: r.url }, parsed));
      }
      markDone.run(id, new Date().toISOString());
      finished++;
    } catch (e) {
      errors.push({ datasetId: id, error: String((e as Error).message ?? e) });
    }
  });
  return { summaries, errors, total: opts.datasetIds.length, remaining: todo.length - finished };
}
