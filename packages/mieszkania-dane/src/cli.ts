// Komendy importu. Uruchamiane lokalnie albo w GitHub Actions.
//
//   tsx src/cli.ts sample                 dane przykładowe do data/sample-snapshots
//   tsx src/cli.ts ingest-dir <katalog>   wczytanie plików z manifest.json (świeża baza)
//   tsx src/cli.ts harvest [--dry-run] [--limit N]   codzienny import z dane.gov.pl
//   tsx src/cli.ts backfill [--limit N]   uzupełnienie historii, tydzień po tygodniu
//   tsx src/cli.ts stats                  podsumowanie bazy
//
// Po imporcie działa bramka jakości: jeśli liczba lokali w ofercie spadła o
// ponad 25% względem poprzedniego udanego importu, komenda kończy się kodem 2,
// a automat nie publikuje serwisu (alarm trafia do data/alarms.json).

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Model } from './analytics.ts';
import { dbPath, openDb } from './db.ts';
import { backfill, harvest, listDeveloperDatasets } from './harvest.ts';
import { ingestSnapshot, type IngestSummary } from './ingest.ts';
import { guessFormat, parseFile } from './parse.ts';
import { generateSample } from './sample.ts';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const DATA_DIR = dirname(dbPath());
const MAX_DROP = Number(process.env.MAX_OFFER_DROP ?? 0.25);

function report(summaries: IngestSummary[], errors: { datasetId: string; error: string }[] = []) {
  const by = (s: IngestSummary['status']) => summaries.filter((x) => x.status === s).length;
  return {
    files: summaries.length, ok: by('ok'), warnings: by('ostrzezenie'), rejected: by('odrzucony'), skipped: by('pominiety'),
    newUnits: summaries.reduce((a, s) => a + s.newUnits, 0),
    priceChanges: summaries.reduce((a, s) => a + s.priceChanges, 0),
    problems: [
      ...summaries.filter((s) => s.status === 'odrzucony' || s.status === 'ostrzezenie').map((s) => ({ datasetId: s.datasetId, date: s.date, status: s.status, note: s.note ?? null })),
      ...errors.map((e) => ({ datasetId: e.datasetId, date: null, status: 'blad', note: e.error })),
    ],
  };
}

/** Bramka jakości i zapis stanu dla panelu. Zwraca kod wyjścia. */
function finish(db: ReturnType<typeof openDb>, summary: ReturnType<typeof report>): number {
  const model = new Model(db);
  const snap = model.snapshot('pl', model.units);
  const prev = db.prepare("SELECT summary FROM runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() as { summary: string } | undefined;
  const prevUnits = prev ? (JSON.parse(prev.summary).unitsInOffer as number) : null;
  const drop = prevUnits ? 1 - snap.units / prevUnits : 0;
  const blocked = drop > MAX_DROP;
  const status = blocked ? 'zablokowany' : 'ok';
  const run = { ...summary, asOf: model.asOf, unitsInOffer: snap.units, previousUnitsInOffer: prevUnits, staleDatasets: model.staleDatasets.size, status };
  const now = new Date().toISOString();
  db.prepare('INSERT INTO runs(started, finished, status, summary) VALUES (?,?,?,?)').run(now, now, status, JSON.stringify(run));
  writeFileSync(join(DATA_DIR, 'last-run.json'), JSON.stringify(run, null, 1));
  const alarms = [
    ...(blocked ? [{ level: 'krytyczny', text: `Liczba lokali w ofercie spadła o ${(drop * 100).toFixed(0)}% (z ${prevUnits} do ${snap.units}). Publikacja wstrzymana.` }] : []),
    ...summary.problems.map((p) => ({ level: p.status === 'ostrzezenie' ? 'ostrzezenie' : 'blad', text: `${p.datasetId}: ${p.note ?? p.status}` })),
    ...(model.staleDatasets.size ? [{ level: 'informacja', text: `${model.staleDatasets.size} cenników nie aktualizowano od ponad 7 dni.` }] : []),
  ];
  writeFileSync(join(DATA_DIR, 'alarms.json'), JSON.stringify({ generated: now, alarms }, null, 1));
  console.log(JSON.stringify({ status, asOf: model.asOf, unitsInOffer: snap.units, files: summary.files, problems: summary.problems.length }, null, 1));
  return blocked ? 2 : 0;
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
      const res = await harvest(db, { dryRun: flag('dry-run'), limit: opt('limit') ? Number(opt('limit')) : undefined });
      if (flag('dry-run')) return 0;
      return finish(db, report(res.summaries, res.errors));
    }
    case 'backfill': {
      // Kod 0: historia kompletna. Kod 3: skończył się limit czasu, ciąg dalszy przy następnym uruchomieniu.
      const db = openDb();
      const ids = (await listDeveloperDatasets()).map((d) => d.id).slice(0, opt('limit') ? Number(opt('limit')) : undefined);
      const res = await backfill(db, { datasetIds: ids, minutes: opt('minutes') ? Number(opt('minutes')) : undefined });
      console.log(JSON.stringify({ historia: { zbiory: res.total, pozostalo: res.remaining, bledy: res.errors.length } }));
      if (res.remaining > res.errors.length) {
        const run = { ...report(res.summaries, res.errors), status: 'historia-niepelna', remaining: res.remaining };
        writeFileSync(join(DATA_DIR, 'last-run.json'), JSON.stringify(run, null, 1));
        return 3;
      }
      return finish(db, report(res.summaries, res.errors));
    }
    case 'stats': {
      const db = openDb(dbPath(), { readonly: true });
      const model = new Model(db);
      const s = model.snapshot('pl', model.units);
      console.log(JSON.stringify({ asOf: model.asOf, dates: model.dates.length, units: model.units.length, investments: model.investments.length, cities: model.cities.length, brands: model.brands.length, current: s }, null, 1));
      return 0;
    }
    default:
      console.log('Komendy: sample | ingest-dir <katalog> | harvest [--dry-run] [--limit N] | backfill | stats');
      return 1;
  }
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
