// Wczytanie jednego cennika (jednego zbioru z jednego dnia) do bazy.

import type { DatabaseSync } from 'node:sqlite';
import { tx } from './db.ts';
import { fold, websiteHost } from './normalize.ts';
import type { ParseResult, PriceRecord } from './parse.ts';

/** Przerwa w publikacji cennika krótsza niż tyle dni nie przerywa obecności lokalu w ofercie. */
/** Ile dni przerwy między cennikami nie przerywa obecności lokalu. Czytane przy każdym
 *  wczytaniu (nie przy starcie), żeby komendy mogły je ustawić. */
export const presenceGapDays = () => Number(process.env.PRESENCE_GAP_DAYS ?? 4);

export interface IngestSummary {
  datasetId: string;
  date: string;
  status: 'ok' | 'ostrzezenie' | 'odrzucony' | 'pominiety';
  records: number;
  newUnits: number;
  priceChanges: number;
  note?: string;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function brandKey(r: PriceRecord): string {
  const host = websiteHost(r.devWebsite);
  if (host) return `www:${host}`;
  if (r.devNip) return `nip:${r.devNip}`;
  return `nazwa:${fold(r.devName)}`;
}

function investmentKey(devId: number, r: PriceRecord): string {
  return [devId, fold(r.city), fold(r.street ?? ''), fold(r.buildingNo ?? ''), fold(r.investmentName ?? '')].join('|');
}

export function ingestSnapshot(
  db: DatabaseSync,
  opts: { datasetId: string; title?: string; date: string; sourceUrl?: string },
  parsed: ParseResult,
): IngestSummary {
  const { datasetId, date } = opts;
  const base = { datasetId, date, records: parsed.records.length, newUnits: 0, priceChanges: 0 };

  db.prepare('INSERT INTO datasets(id, title) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET title = coalesce(excluded.title, title)')
    .run(datasetId, opts.title ?? null);
  const ds = db.prepare('SELECT last_snapshot FROM datasets WHERE id = ?').get(datasetId) as { last_snapshot: string | null };
  if (ds.last_snapshot && ds.last_snapshot >= date) {
    return { ...base, status: 'pominiety', note: `cennik z ${date} nie jest nowszy niż ostatni (${ds.last_snapshot})` };
  }

  const rejectedTotal = Object.values(parsed.rejected).reduce((a, b) => a + b, 0);
  const status: IngestSummary['status'] =
    parsed.records.length === 0 ? 'odrzucony' : rejectedTotal > (parsed.rowsRead - parsed.sold) * 0.2 ? 'ostrzezenie' : 'ok';
  const note = parsed.missingColumns.length
    ? `brak kolumn: ${parsed.missingColumns.join(', ')}`
    : status === 'ostrzezenie' ? `odrzucone wiersze: ${JSON.stringify(parsed.rejected)}`
    : parsed.unknownHeaders.length ? `nowe kolumny: ${parsed.unknownHeaders.slice(0, 5).join(' | ')}` : undefined;

  // Dwa pliki z jednego dnia (np. CSV i XLSX): przyjęty zastępuje wcześniej odrzucony.
  const saveSnapshot = db.prepare(`INSERT OR REPLACE INTO snapshots(dataset_id, data_date, source_url, format, rows_read, records, rejected_json, unknown_headers, status, note)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  if (status === 'odrzucony') {
    saveSnapshot.run(datasetId, date, opts.sourceUrl ?? null, parsed.format, parsed.rowsRead, 0,
      JSON.stringify(parsed.rejected), JSON.stringify(parsed.unknownHeaders), status, note ?? null);
    return { ...base, status, note };
  }

  const q = {
    devFind: db.prepare('SELECT id FROM developers WHERE legal_name = ? AND coalesce(nip, \'\') = coalesce(?, \'\')'),
    devIns: db.prepare('INSERT INTO developers(legal_name, nip, krs, website_host, brand_key) VALUES (?,?,?,?,?)'),
    invFind: db.prepare('SELECT id FROM investments WHERE key = ?'),
    invIns: db.prepare(`INSERT INTO investments(key, developer_id, name, voivodeship, county, gmina, city, street, building_no, postal_code, prospectus_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    invUpd: db.prepare('UPDATE investments SET name = coalesce(?, name), prospectus_url = coalesce(?, prospectus_url) WHERE id = ?'),
    unitFind: db.prepare('SELECT id FROM units WHERE key = ?'),
    unitIns: db.prepare('INSERT INTO units(key, investment_id, dataset_id, ref, type, area, rooms) VALUES (?,?,?,?,?,?,?)'),
    unitUpd: db.prepare('UPDATE units SET area = coalesce(?, area), rooms = coalesce(?, rooms), type = ?, dataset_id = ? WHERE id = ?'),
    presLast: db.prepare('SELECT from_date, to_date FROM presence WHERE unit_id = ? ORDER BY from_date DESC LIMIT 1'),
    presExt: db.prepare('UPDATE presence SET to_date = ? WHERE unit_id = ? AND from_date = ?'),
    presIns: db.prepare('INSERT INTO presence(unit_id, from_date, to_date) VALUES (?,?,?)'),
    priceLast: db.prepare('SELECT from_date, price_m2, price_total FROM prices WHERE unit_id = ? ORDER BY from_date DESC LIMIT 1'),
    priceIns: db.prepare('INSERT OR REPLACE INTO prices(unit_id, from_date, price_m2, price_total) VALUES (?,?,?,?)'),
    dsUpd: db.prepare('UPDATE datasets SET last_snapshot = ? WHERE id = ?'),
  };

  const devCache = new Map<string, number>();
  const invCache = new Map<string, number>();
  const seen = new Set<number>();
  let newUnits = 0;
  let priceChanges = 0;
  const gapLimit = addDays(date, -presenceGapDays());

  tx(db, () => {
    for (const r of parsed.records) {
      const devCacheKey = `${r.devName}|${r.devNip ?? ''}`;
      let devId = devCache.get(devCacheKey);
      if (devId === undefined) {
        const row = q.devFind.get(r.devName, r.devNip) as { id: number } | undefined;
        devId = row ? row.id : Number(q.devIns.run(r.devName, r.devNip, r.devKrs, websiteHost(r.devWebsite), brandKey(r)).lastInsertRowid);
        devCache.set(devCacheKey, devId);
      }

      const ik = investmentKey(devId, r);
      let invId = invCache.get(ik);
      if (invId === undefined) {
        const row = q.invFind.get(ik) as { id: number } | undefined;
        if (row) {
          invId = row.id;
          q.invUpd.run(r.investmentName, r.prospectusUrl, invId);
        } else {
          invId = Number(q.invIns.run(ik, devId, r.investmentName, r.voivodeship, r.county, r.gmina, r.city,
            r.street, r.buildingNo, r.postalCode, r.prospectusUrl).lastInsertRowid);
        }
        invCache.set(ik, invId);
      }

      // Bez numeru zbioru: deweloperzy zakładają nowy zbiór co rok ("… w 2026 r."), a lokal
      // ma zachować historię cen. Lokal rozpoznajemy po deweloperze, inwestycji i numerze.
      const uk = `${ik}|${fold(r.unitRef)}`;
      const urow = q.unitFind.get(uk) as { id: number } | undefined;
      let unitId: number;
      if (urow) {
        unitId = urow.id;
        q.unitUpd.run(r.area, r.rooms, r.unitType, datasetId, unitId);
      } else {
        unitId = Number(q.unitIns.run(uk, invId, datasetId, r.unitRef, r.unitType, r.area, r.rooms).lastInsertRowid);
        newUnits++;
      }
      if (seen.has(unitId)) continue; // ten sam lokal dwa razy w jednym pliku: liczy się pierwszy wiersz
      seen.add(unitId);

      // Ten sam lokal bywa w dwóch zbiorach (roczne zbiory 2025 i 2026). Informacji starszej
      // niż to, co już wiemy o lokalu, nie wpisujemy: historia musi iść do przodu.
      const p = q.presLast.get(unitId) as { from_date: string; to_date: string } | undefined;
      if (p && date <= p.to_date) continue;
      if (p && p.to_date >= gapLimit) q.presExt.run(date, unitId, p.from_date);
      else q.presIns.run(unitId, date, date);

      const last = q.priceLast.get(unitId) as { from_date: string; price_m2: number; price_total: number | null } | undefined;
      if (last && date < last.from_date) continue;
      const changed = !last
        || Math.abs(last.price_m2 - r.priceM2) >= 0.5
        || (last.price_total !== null && r.priceTotal !== null && Math.abs(last.price_total - r.priceTotal) > Math.max(1, last.price_total * 0.001));
      if (changed) {
        // Datę zmiany bierzemy z cennika, jeśli jest wiarygodna (po poprzedniej
        // zmianie i nie później niż dzień publikacji); inaczej dzień publikacji.
        let from = date;
        if (last && r.priceM2Date && r.priceM2Date > last.from_date && r.priceM2Date <= date) from = r.priceM2Date;
        q.priceIns.run(unitId, from, r.priceM2, r.priceTotal);
        if (last) priceChanges++;
      }
    }
    saveSnapshot.run(datasetId, date, opts.sourceUrl ?? null, parsed.format, parsed.rowsRead, parsed.records.length,
      JSON.stringify(parsed.rejected), JSON.stringify(parsed.unknownHeaders), status, note ?? null);
    q.dsUpd.run(date, datasetId);
  });

  return { ...base, status, newUnits, priceChanges, note };
}
