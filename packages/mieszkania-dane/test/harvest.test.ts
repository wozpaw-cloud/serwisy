// Pobieranie z API na atrapie serwera dane.gov.pl: stronicowanie zasobów
// (API odrzuca per_page > 100 kodem 422), brak ponawiania błędów 4xx,
// uzupełnianie historii mimo uszkodzonych plików, limit czasu importu.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';

const HEADERS = [
  'Nazwa dewelopera', 'Miejscowość lokalizacji przedsięwzięcia deweloperskiego',
  'Nr lokalu lub domu jednorodzinnego nadany przez dewelopera', 'Rodzaj nieruchomości',
  'Cena m 2 powierzchni użytkowej lokalu mieszkalnego / domu jednorodzinnego [zł]', 'Powierzchnia użytkowa',
];
const csv = (price: number) => [HEADERS.join(';'), `Atrapa Dom;Poznań;M1;lokal mieszkalny;${price};50`, `Atrapa Dom;Poznań;M2;lokal mieszkalny;${price + 500};62`].join('\n');

function days(from: string, n: number): string[] {
  const d = new Date(from + 'T00:00:00Z');
  return Array.from({ length: n }, (_, i) => new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10));
}

const RESOURCES: Record<string, string[]> = {
  A: days('2026-01-01', 250), C: ['2026-09-01', '2026-10-01', '2026-10-29'],
  // D: download_url zwraca 404, działa kopia file_url. E: tylko link do serwera dewelopera.
  D: ['2026-06-01', '2026-10-29'], E: ['2026-03-01', '2026-06-01', '2026-10-29'],
};
const BROKEN = new Set(['C/2026-10-01']);
const hits: string[] = [];
let server: Server;
let base = '';
let mod: typeof import('../src/harvest.ts');

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    hits.push(url.pathname + url.search);
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const m = url.pathname.match(/^\/api\/datasets\/(\w+)\/resources$/);
    if (m) {
      const perPage = Number(url.searchParams.get('per_page') ?? 20);
      if (perPage > 100 || m[1] === 'B') return json(422, { errors: [{ detail: 'per_page' }] });
      const page = Number(url.searchParams.get('page') ?? 1);
      const all = [...(RESOURCES[m[1]] ?? [])].sort().reverse();
      const slice = all.slice((page - 1) * perPage, page * perPage);
      return json(200, {
        data: slice.map((date) => ({ id: `${m[1]}-${date}`, attributes:
          m[1] === 'D' ? { data_date: date, format: 'csv', download_url: `${base}/brak/${date}/file`, file_url: `${base}/plik/D/${date}.csv` }
          : m[1] === 'E' ? { data_date: date, format: 'csv', link: `${base.replace('127.0.0.1', 'localhost')}/plik/E/${date}.csv` }
          : { data_date: date, format: 'csv', download_url: `${base}/plik/${m[1]}/${date}.csv` } })),
        links: { next: page * perPage < all.length ? `${base}/next` : null },
        meta: { count: all.length },
      });
    }
    const f = url.pathname.match(/^\/plik\/(\w+)\/([\d-]+)\.csv$/);
    if (f && !BROKEN.has(`${f[1]}/${f[2]}`)) {
      res.writeHead(200, { 'content-type': 'text/csv' });
      return res.end(csv(10000 + Number(f[2].slice(5, 7)) * 100));
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.DANE_API = `${base}/api`;
  process.env.PRESENCE_GAP_DAYS = '35';
  mod = await import('../src/harvest.ts');
});
afterAll(() => server.close());

const datasets = [{ id: 'A', title: 'Ceny ofertowe mieszkań dewelopera Atrapa Dom w 2026 r.' }, { id: 'B', title: 'Ceny ofertowe mieszkań B' }, { id: 'C', title: 'Ceny ofertowe mieszkań C' }];

describe('zasoby zbioru', () => {
  it('pobiera wszystkie strony po 100', async () => {
    const all = await mod.listAllResources('A');
    expect(all).toHaveLength(250);
    expect(all[0].date).toBe('2026-09-07');
    expect(hits.filter((h) => h.startsWith('/api/datasets/A/')).length).toBe(3);
  });
  it('nie prosi o więcej niż 100 na stronę', async () => {
    const [r] = await mod.listResources('A', 500);
    expect(r.date).toBe('2026-09-07');
  });
  it('nie ponawia błędu 422', async () => {
    const before = hits.length;
    await expect(mod.listAllResources('B')).rejects.toThrow(/HTTP 422/);
    expect(hits.length - before).toBe(1);
  });
});

describe('uzupełnianie historii', () => {
  it('wczytuje cennik co 28 dni i najnowszy, mimo uszkodzonego pliku', async () => {
    const db = openDb(':memory:');
    const res = await mod.backfill(db, { datasets, concurrency: 3 });
    const a = res.summaries.filter((s) => s.datasetId === 'A');
    expect(a.length).toBeGreaterThanOrEqual(9);
    expect(a.at(-1)?.date).toBe('2026-09-07');
    expect(a.every((s) => s.status === 'ok')).toBe(true);
    expect(res.errors.map((e) => e.datasetId)).toEqual(['B']);
    expect(res.fileErrors).toHaveLength(1);
    expect(res.fileErrors[0].error).toMatch(/2026-10-01: HTTP 404/);
    expect(res.remaining).toBe(1);
    expect(res.timedOut).toBe(false);
    const done = (db.prepare('SELECT dataset_id FROM backfill_done ORDER BY 1').all() as { dataset_id: string }[]).map((r) => r.dataset_id);
    expect(done).toEqual(['A', 'C']);

    // Drugie uruchomienie: wczytane zbiory pomija, do błędnego wraca.
    const again = await mod.backfill(db, { datasets, concurrency: 3 });
    expect(again.todo).toBe(1);
    expect(again.summaries).toHaveLength(0);
  });

  it('po limicie czasu nie zaczyna nowych zbiorów', async () => {
    const db = openDb(':memory:');
    const res = await mod.backfill(db, { datasets, minutes: 0 });
    expect(res.timedOut).toBe(true);
    expect(res.remaining).toBe(3);
  });
});

describe('codzienny import', () => {
  it('bierze tylko nowszy cennik', async () => {
    const db = openDb(':memory:');
    await mod.backfill(db, { datasets: [datasets[0]] });
    RESOURCES.A.push('2026-09-08');
    const res = await mod.harvest(db, { datasets: [datasets[0]] });
    expect(res.summaries.map((s) => s.date)).toEqual(['2026-09-08']);
    const again = await mod.harvest(db, { datasets: [datasets[0]] });
    expect(again.summaries).toHaveLength(0);
    RESOURCES.A.pop();
  });
  it('limit czasu pomija resztę zbiorów', async () => {
    const res = await mod.harvest(openDb(':memory:'), { datasets, minutes: 0 });
    expect(res.skippedForTime).toBe(3);
  });
});

describe('zbiory uśpione', () => {
  it('zbiór bez nowego cennika od ponad 45 dni sprawdza raz w tygodniu', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO datasets(id, last_snapshot) VALUES ('C', '2026-01-10')").run();
    const runs = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(Date.UTC(2026, 9, 26 + d, 12));
      vi.setSystemTime(day);
      runs.push((await mod.harvest(db, { datasets: [datasets[2]] })).skippedDormant);
      db.prepare("UPDATE datasets SET last_snapshot = '2026-01-10' WHERE id = 'C'").run();
    }
    vi.useRealTimers();
    expect(runs.filter((n) => n === 0)).toHaveLength(1);
  });
});

describe('adresy plików', () => {
  it('przy 404 bierze kopię file_url', async () => {
    const db = openDb(':memory:');
    const res = await mod.backfill(db, { datasets: [{ id: 'D', title: 'Ceny ofertowe D' }] });
    expect(res.fileErrors).toHaveLength(0);
    expect(res.summaries.map((s) => s.date)).toEqual(['2026-06-01', '2026-10-29']);
  });
  it('do historii nie bierze linków do serwera dewelopera, tylko najnowszy cennik', async () => {
    const db = openDb(':memory:');
    const res = await mod.backfill(db, { datasets: [{ id: 'E', title: 'Ceny ofertowe E' }] });
    expect(res.summaries.map((s) => s.date)).toEqual(['2026-10-29']);
  });
  it('zbiera odrzucone pliki po nagłówkach', () => {
    const rep = mod.rejectedReport();
    expect(Array.isArray(rep)).toBe(true);
  });
});
