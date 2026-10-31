// Wersje bazy: zmiana wersji danych = historia od nowa; zmiana parsera = powrót
// zbiorów, z których nie wszedł żaden cennik.

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';

describe('wersje bazy', () => {
  it('stara baza bez wersji jest czyszczona, a zbiory bez lokali wracają po zmianie parsera', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wersje-'));
    const path = join(dir, 'm.sqlite');
    const db = openDb(path);
    db.prepare("INSERT INTO datasets(id, title, last_snapshot) VALUES ('1', 'a', '2026-10-01'), ('2', 'b', NULL)").run();
    db.prepare("INSERT INTO snapshots(dataset_id, data_date, status) VALUES ('1', '2026-10-01', 'ok'), ('2', '2026-10-01', 'odrzucony')").run();
    db.prepare("INSERT INTO backfill_done(dataset_id, finished) VALUES ('1', 'x'), ('2', 'x')").run();
    db.close();
    // Wersja danych nieustawiona: cała baza od nowa.
    const run = () => execFileSync('npx', ['tsx', 'src/cli.ts', 'backfill', '--limit', '0', '--minutes', '0'],
      { env: { ...process.env, MIESZKANIA_DB: path, DANE_API: 'http://127.0.0.1:9/api' }, stdio: 'pipe', encoding: 'utf8' });
    try { run(); } catch { /* kod 3 albo błąd sieci: interesuje nas stan bazy */ }
    const after = openDb(path);
    expect((after.prepare('SELECT count(*) AS n FROM snapshots').get() as { n: number }).n).toBe(0);
    expect((after.prepare("SELECT value FROM meta WHERE key = 'wersja_danych'").get() as { value: string }).value).toBe('2');

    // Zmiana parsera: zbiór 2 (bez przyjętego cennika) wraca, zbiór 1 zostaje.
    after.prepare("INSERT INTO datasets(id, title, last_snapshot) VALUES ('1', 'a', '2026-10-01'), ('2', 'b', NULL)").run();
    after.prepare("INSERT INTO snapshots(dataset_id, data_date, status) VALUES ('1', '2026-10-01', 'ok'), ('2', '2026-10-01', 'odrzucony')").run();
    after.prepare("INSERT INTO backfill_done(dataset_id, finished) VALUES ('1', 'x'), ('2', 'x')").run();
    after.prepare("UPDATE meta SET value = '0' WHERE key = 'wersja_parsera'").run();
    after.close();
    try { run(); } catch { /* jw. */ }
    const last = openDb(path);
    expect((last.prepare('SELECT dataset_id FROM backfill_done ORDER BY 1').all() as { dataset_id: string }[]).map((r) => r.dataset_id)).toEqual(['1']);
    expect((last.prepare('SELECT dataset_id FROM snapshots ORDER BY 1').all() as { dataset_id: string }[]).map((r) => r.dataset_id)).toEqual(['1']);
  }, 60000);
});
