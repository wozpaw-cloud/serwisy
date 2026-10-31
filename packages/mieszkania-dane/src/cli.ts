// Komendy importu. Uruchamiane lokalnie albo w GitHub Actions.
//
//   tsx src/cli.ts sample                 dane przykładowe do data/sample-snapshots
//   tsx src/cli.ts ingest-dir <katalog>   wczytanie plików z manifest.json (świeża baza)
//   tsx src/cli.ts harvest [--dry-run] [--limit N] [--minutes N]   codzienny import z dane.gov.pl
//   tsx src/cli.ts backfill [--limit N] [--minutes N]   uzupełnienie historii, cennik co 28 dni
//   tsx src/cli.ts stats                  podsumowanie bazy
//
// Po imporcie działa bramka jakości: jeśli liczba lokali w ofercie spadła o
// ponad 25% względem poprzedniego udanego importu, komenda kończy się kodem 2,
// a automat nie publikuje serwisu (alarm trafia do data/alarms.json).

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Model } from './analytics.ts';
import { dbPath, openDb } from './db.ts';
import { backfill, harvest, listDeveloperDatasets, probeApi, rejectedReport, type DatasetRef } from './harvest.ts';
import { ingestSnapshot, type IngestSummary } from './ingest.ts';
import { guessFormat, parseFile } from './parse.ts';
import { generateSample } from './sample.ts';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const DATA_DIR = dirname(dbPath());
const MAX_DROP = Number(process.env.MAX_OFFER_DROP ?? 0.25);

// W raporcie i alarmach najwyżej tyle pojedynczych problemów; resztę opisuje zestawienie przyczyn.
const MAX_PROBLEMS = 300;

/** Przyczyna problemu bez numerów i adresów, do zestawienia ("HTTP 404 przy pobieraniu"). */
const reason = (note: string | null) => (note ?? 'brak opisu').replace(/https?:\/\/\S+/g, '').replace(/\d{4}-\d{2}-\d{2}:?/g, '').replace(/\(\d+ B\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

function report(summaries: IngestSummary[], errors: { datasetId: string; error: string }[] = []) {
  const by = (s: IngestSummary['status']) => summaries.filter((x) => x.status === s).length;
  const problems = [
    ...summaries.filter((s) => s.status === 'odrzucony' || s.status === 'ostrzezenie').map((s) => ({ datasetId: s.datasetId, date: s.date as string | null, status: s.status as string, note: s.note ?? null })),
    ...errors.map((e) => ({ datasetId: e.datasetId, date: null, status: 'blad', note: e.error })),
  ];
  const reasons = new Map<string, number>();
  for (const p of problems) { const k = `${p.status}: ${reason(p.note)}`; reasons.set(k, (reasons.get(k) ?? 0) + 1); }
  return {
    files: summaries.length, ok: by('ok'), warnings: by('ostrzezenie'), rejected: by('odrzucony'), skipped: by('pominiety'),
    newUnits: summaries.reduce((a, s) => a + s.newUnits, 0),
    priceChanges: summaries.reduce((a, s) => a + s.priceChanges, 0),
    problemCount: problems.length,
    problemReasons: Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1]).slice(0, 30)),
    // Po kilka przykładów z każdej przyczyny, żeby rzadkie błędy nie ginęły pod częstymi.
    problems: (() => {
      const per = new Map<string, number>();
      return problems.filter((p) => { const k = `${p.status}: ${reason(p.note)}`; const c = per.get(k) ?? 0; per.set(k, c + 1); return c < 10; }).slice(0, MAX_PROBLEMS);
    })(),
  };
}

/** Lista zbiorów z pliku, jeśli świeża (historia i import w jednym przebiegu
 *  korzystają z tej samej listy; jej pobranie trwa kilkanaście minut). */
async function datasetList(limit?: number): Promise<DatasetRef[]> {
  const file = join(DATA_DIR, 'zbiory.json');
  const maxAgeH = Number(process.env.DATASET_LIST_MAX_AGE_H ?? 12);
  if (!limit && existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAgeH * 3600000) {
    const list = JSON.parse(readFileSync(file, 'utf8')) as DatasetRef[];
    if (list.length) { console.error(`lista zbiorów z pliku: ${list.length}`); return list; }
  }
  const list = (await listDeveloperDatasets({ stopAfter: limit })).slice(0, limit);
  if (!limit) writeFileSync(file, JSON.stringify(list));
  return list;
}

/** Bramka jakości i zapis stanu dla panelu. Zwraca kod wyjścia. */
function finish(db: ReturnType<typeof openDb>, summary: ReturnType<typeof report>): number {
  const model = new Model(db);
  const snap = model.snapshot('pl', model.units);
  const prev = db.prepare("SELECT summary FROM runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() as { summary: string } | undefined;
  const prevUnits = prev ? (JSON.parse(prev.summary).unitsInOffer as number) : null;
  const drop = prevUnits ? 1 - snap.units / prevUnits : 0;
  const empty = snap.units === 0;
  const blocked = drop > MAX_DROP || empty;
  const status = blocked ? 'zablokowany' : 'ok';
  const run = { ...summary, asOf: model.asOf, unitsInOffer: snap.units, previousUnitsInOffer: prevUnits, staleDatasets: model.staleDatasets.size, status };
  const now = new Date().toISOString();
  db.prepare('INSERT INTO runs(started, finished, status, summary) VALUES (?,?,?,?)').run(now, now, status, JSON.stringify(run));
  writeFileSync(join(DATA_DIR, 'last-run.json'), JSON.stringify(run, null, 1));
  const alarms = [
    ...(empty ? [{ level: 'krytyczny', text: 'W bazie nie ma żadnego lokalu w ofercie. Publikacja wstrzymana.' }]
      : blocked ? [{ level: 'krytyczny', text: `Liczba lokali w ofercie spadła o ${(drop * 100).toFixed(0)}% (z ${prevUnits} do ${snap.units}). Publikacja wstrzymana.` }] : []),
    ...Object.entries(summary.problemReasons).map(([why, n]) => ({ level: 'informacja', text: `${n} × ${why}` })),
    ...summary.problems.map((p) => ({ level: p.status === 'ostrzezenie' ? 'ostrzezenie' : 'blad', text: `${p.datasetId}: ${p.note ?? p.status}` })),
    ...(model.staleDatasets.size ? [{ level: 'informacja', text: `${model.staleDatasets.size} cenników nie aktualizowano od ponad 7 dni.` }] : []),
  ];
  writeFileSync(join(DATA_DIR, 'alarms.json'), JSON.stringify({ generated: now, alarms }, null, 1));
  console.log(JSON.stringify({ status, asOf: model.asOf, unitsInOffer: snap.units, files: summary.files, problems: summary.problemCount, przyczyny: summary.problemReasons }, null, 1));
  return blocked ? 2 : 0;
}

// Wersja danych: zmiana oznacza wczytanie całej historii od nowa (np. zmiana sposobu zapisu).
// 2 (31.10.2026): historia wczytywana dzień po dniu dla wszystkich zbiorów naraz.
const DATA_VERSION = '2';
// Wersja rozpoznawania plików: po zmianie zbiory, z których nie wszedł żaden cennik,
// wracają do wczytania historii.
const PARSER_VERSION = '4';

function getMeta(db: ReturnType<typeof openDb>, key: string): string | null {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

/** Baza w bieżącej wersji: przy zmianie wersji danych zaczynamy od zera, przy zmianie
 *  parsera wracamy do zbiorów bez żadnego przyjętego cennika. */
function openCurrentDb() {
  let db = openDb();
  const hasData = (db.prepare('SELECT count(*) AS n FROM snapshots').get() as { n: number }).n > 0;
  if (hasData && getMeta(db, 'wersja_danych') !== DATA_VERSION) {
    console.error(`Baza w wersji ${getMeta(db, 'wersja_danych') ?? '1'}, wymagana ${DATA_VERSION}: wczytuję całą historię od nowa.`);
    db.close();
    rmSync(dbPath());
    db = openDb();
  }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('wersja_danych', ?)").run(DATA_VERSION);
  const pv = getMeta(db, 'wersja_parsera');
  if (pv !== null && pv !== PARSER_VERSION) {
    const ids = (db.prepare(`SELECT dataset_id AS id FROM backfill_done
      WHERE dataset_id NOT IN (SELECT id FROM datasets WHERE last_snapshot IS NOT NULL)`).all() as { id: string }[]).map((r) => r.id);
    const delSnap = db.prepare('DELETE FROM snapshots WHERE dataset_id = ?');
    const delDone = db.prepare('DELETE FROM backfill_done WHERE dataset_id = ?');
    db.exec('BEGIN');
    for (const id of ids) { delSnap.run(id); delDone.run(id); }
    db.exec('COMMIT');
    console.error(`Nowa wersja rozpoznawania plików (${pv} -> ${PARSER_VERSION}): ${ids.length} zbiorów bez przyjętego cennika wraca do wczytania.`);
  }
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('wersja_parsera', ?)").run(PARSER_VERSION);
  return db;
}

/** Odrzucone pliki pogrupowane po nagłówkach (do ulepszania rozpoznawania kolumn). */
function saveRejected() {
  const list = rejectedReport();
  if (list.length) writeFileSync(join(DATA_DIR, 'odrzucone.json'), JSON.stringify(list, null, 1));
}

async function main(): Promise<number> {
  switch (cmd) {
    case 'sample': {
      const out = resolve(DATA_DIR, 'sample-snapshots');
      const m = await generateSample(out);
      console.log(`Zapisano ${m.length} cenników przykładowych w ${out}`);
      return 0;
    }
    case 'ingest-dir': {
      const dir = resolve(args[0] ?? join(DATA_DIR, 'sample-snapshots'));
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { datasetId: string; title: string; date: string; file: string; format?: string }[];
      if (!flag('keep') && existsSync(dbPath())) rmSync(dbPath());
      process.env.PRESENCE_GAP_DAYS ??= '8'; // dane przykładowe są tygodniowe
      const db = openDb();
      const summaries: IngestSummary[] = [];
      for (const f of manifest.sort((a, b) => a.date.localeCompare(b.date) || a.datasetId.localeCompare(b.datasetId))) {
        const parsed = await parseFile(readFileSync(f.file), f.format ?? guessFormat(f.file));
        summaries.push(ingestSnapshot(db, { datasetId: f.datasetId, title: f.title, date: f.date, sourceUrl: `plik://${f.file}` }, parsed));
      }
      return finish(db, report(summaries));
    }
    case 'harvest': {
      const db = openDb();
      const limit = opt('limit') ? Number(opt('limit')) : undefined;
      const datasets = flag('dry-run') ? undefined : await datasetList(limit);
      const res = await harvest(db, { dryRun: flag('dry-run'), limit, datasets, minutes: opt('minutes') ? Number(opt('minutes')) : undefined });
      if (flag('dry-run')) return 0;
      saveRejected();
      return finish(db, report(res.summaries, res.errors));
    }
    case 'backfill': {
      // Kod 0: historia kompletna. Kod 3: skończył się limit czasu, ciąg dalszy przy następnym uruchomieniu.
      const db = openCurrentDb();
      const lim = opt('limit') ? Number(opt('limit')) : undefined;
      // Historia co 28 dni: obecność lokalu nie może się urywać między kolejnymi cennikami.
      process.env.PRESENCE_GAP_DAYS ??= '35';
      const datasets = await datasetList(lim);
      const res = await backfill(db, { datasets, minutes: opt('minutes') ? Number(opt('minutes')) : undefined });
      const all = [...res.errors, ...res.fileErrors];
      saveRejected();
      console.log(JSON.stringify({ historia: { zbiory: res.total, doWczytania: res.todo, pozostalo: res.remaining, bledyApi: res.errors.length, bledyPlikow: res.fileErrors.length, limitCzasu: res.timedOut } }));
      // Niepełna: skończył się czas albo API odrzuciło wiele zbiorów (wtedy nie publikujemy
      // i nie zaczynamy codziennego importu). Pojedyncze błędy API nie blokują: te zbiory
      // wrócą przy następnym uruchomieniu.
      const apiTrouble = res.errors.length > Math.max(25, 0.02 * res.todo);
      if (res.remaining > 0 && (res.timedOut || apiTrouble)) {
        const run = { ...report(res.summaries, all), status: 'historia-niepelna', powod: res.timedOut ? 'limit czasu' : 'błędy API', remaining: res.remaining };
        writeFileSync(join(DATA_DIR, 'last-run.json'), JSON.stringify(run, null, 1));
        writeFileSync(join(DATA_DIR, 'alarms.json'), JSON.stringify({ generated: new Date().toISOString(), alarms: [
          { level: apiTrouble ? 'blad' : 'informacja', text: `Historia niepełna (${run.powod}): zostało ${res.remaining} z ${res.todo} zbiorów.` },
          ...Object.entries(run.problemReasons).map(([why, n]) => ({ level: 'informacja', text: `${n} × ${why}` })),
        ] }, null, 1));
        return 3;
      }
      return finish(db, report(res.summaries, all));
    }
    case 'probe': {
      await probeApi();
      return 0;
    }
    case 'stats': {
      const db = openDb(dbPath(), { readonly: true });
      const model = new Model(db);
      const s = model.snapshot('pl', model.units);
      console.log(JSON.stringify({ asOf: model.asOf, dates: model.dates.length, units: model.units.length, investments: model.investments.length, cities: model.cities.length, brands: model.brands.length, current: s }, null, 1));
      return 0;
    }
    default:
      console.log('Komendy: sample | ingest-dir <katalog> | harvest [--dry-run] [--limit N] | backfill [--minutes N] | probe | stats');
      return 1;
  }
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
