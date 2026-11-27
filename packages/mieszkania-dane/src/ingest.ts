// Wczytanie jednego cennika (jednego zbioru z jednego dnia) do bazy.

import type { DatabaseSync } from 'node:sqlite';
import { tx } from './db.ts';
import { fold, websiteHost } from './normalize.ts';
import type { ParseResult, PriceRecord } from './parse.ts';

/** Ile dni przerwy między cennikami nie przerywa obecności lokalu. Czytane przy każdym
 *  wczytaniu (nie przy starcie), żeby komendy mogły je ustawić. */
export const presenceGapDays = () => Number(process.env.PRESENCE_GAP_DAYS ?? 4);
/** Lokal, który był w poprzednim wczytanym cenniku tego samego zbioru, jest w ofercie
 *  bez przerwy, nawet gdy między cennikami minęło więcej dni (awaria API, brak zmian
 *  cen): nic nie wskazuje, że zniknął. Dłuższa przerwa niż tyle dni ją jednak przerywa. */
const MAX_BRIDGE_DAYS = 45;

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
    unitKeyUpd: db.prepare('UPDATE units SET key = ?, ref = ? WHERE id = ?'),
    unitsOfDataset: db.prepare(`SELECT u.id, u.ref, u.area, i.city, i.street, i.building_no AS b, (SELECT max(to_date) FROM presence p WHERE p.unit_id = u.id) AS t,
      (SELECT price_m2 FROM prices pr WHERE pr.unit_id = u.id ORDER BY from_date DESC LIMIT 1) AS m2
      FROM units u JOIN investments i ON i.id = u.investment_id WHERE u.dataset_id = ?`),
    presLast: db.prepare('SELECT from_date, to_date FROM presence WHERE unit_id = ? ORDER BY from_date DESC LIMIT 1'),
    presExt: db.prepare('UPDATE presence SET to_date = ? WHERE unit_id = ? AND from_date = ?'),
    presIns: db.prepare('INSERT INTO presence(unit_id, from_date, to_date) VALUES (?,?,?)'),
    priceLast: db.prepare('SELECT from_date, price_m2, price_total FROM prices WHERE unit_id = ? ORDER BY from_date DESC LIMIT 1'),
    priceIns: db.prepare('INSERT OR REPLACE INTO prices(unit_id, from_date, price_m2, price_total) VALUES (?,?,?,?)'),
    dsUpd: db.prepare('UPDATE datasets SET last_snapshot = ? WHERE id = ?'),
  };

  // Lokal, którego klucz się zmienił, obecny w poprzednim cenniku tego zbioru. Nowy wzór
  // cennika (od XI 2026) zmienia klucz: "Firma" zamiast nazwy dewelopera, brak nazwy
  // inwestycji, a wielu deweloperów nadało lokalom nowe identyfikatory ("6/2" → "8249").
  // Najpierw ten sam numer w tej samej miejscowości i przy tej samej ulicy; potem ta sama
  // powierzchnia i cena za m². Kilka takich lokali (to samo mieszkanie na kolejnych piętrach)
  // dostaje nowe numery po kolei według starej numeracji: ich historia cen jest ta sama.
  // Lokale dopasowane w pliku po kluczu są zajęte od początku, więc nowy lokal nie przejmie
  // historii lokalu, który nadal jest w cenniku.
  type Old = { id: number; ref: string; street: string; b: string; area: number | null; m2: number | null };
  let byRef: Map<string, Old[]> | null = null;
  let prevUnits: Old[] = [];
  const claimed = new Set<number>();
  for (const r of parsed.records) {
    const dev = q.devFind.get(r.devName, r.devNip) as { id: number } | undefined;
    const u = dev ? (q.unitFind.get(`${investmentKey(dev.id, r)}|${fold(r.unitRef)}`) as { id: number } | undefined) : undefined;
    if (u) claimed.add(u.id);
  }
  const refKey = (city: string, ref: string) => `${fold(city)}|${fold(ref)}`;
  const matchOld = (r: PriceRecord): number | null => {
    if (!ds.last_snapshot) return null;
    if (!byRef) {
      byRef = new Map();
      for (const u of q.unitsOfDataset.all(datasetId) as { id: number; ref: string; area: number | null; city: string; street: string | null; b: string | null; t: string | null; m2: number | null }[]) {
        if (u.t !== ds.last_snapshot) continue;
        const o: Old = { id: u.id, ref: u.ref, street: fold(u.street ?? ''), b: fold(u.b ?? ''), area: u.area, m2: u.m2 };
        const k = refKey(u.city, u.ref);
        const list = byRef.get(k) ?? [];
        list.push(o);
        byRef.set(k, list);
        prevUnits.push(o);
      }
      prevUnits.sort((a, b) => a.ref.localeCompare(b.ref, 'pl', { numeric: true }));
    }
    const street = fold(r.street ?? '');
    let c = (byRef.get(refKey(r.city, r.unitRef)) ?? []).filter((u) => !claimed.has(u.id) && (!u.street || !street || u.street === street));
    if (c.length > 1) c = c.filter((u) => u.b === fold(r.buildingNo ?? ''));
    if (c.length === 1) return c[0].id;
    if (c.length > 1 || r.area === null) return null;
    // Nowy identyfikator lokalu: ta sama powierzchnia i cena za m² (lokal bez zmiany ceny).
    const area = r.area;
    const same = prevUnits.find((u) => !claimed.has(u.id) && u.area !== null && u.m2 !== null && Math.abs(u.area - area) <= 0.02 && Math.abs(u.m2 - r.priceM2) <= 1);
    return same ? same.id : null;
  };

  const devCache = new Map<string, number>();
  const invCache = new Map<string, number>();
  const seen = new Set<number>();
  let newUnits = 0;
  let priceChanges = 0;
  const gapLimit = addDays(date, -presenceGapDays());
  // Poprzedni wczytany cennik tego zbioru (ds.last_snapshot, przed zapisem bieżącego).
  const prevList = ds.last_snapshot && ds.last_snapshot >= addDays(date, -MAX_BRIDGE_DAYS) ? ds.last_snapshot : null;

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
      const old = urow ? null : matchOld(r);
      if (urow) {
        unitId = urow.id;
        q.unitUpd.run(r.area, r.rooms, r.unitType, datasetId, unitId);
      } else if (old !== null) {
        // Ten sam lokal pod nowym kluczem: zachowuje historię cen i obecności.
        unitId = old;
        q.unitKeyUpd.run(uk, r.unitRef, unitId);
        q.unitUpd.run(r.area, r.rooms, r.unitType, datasetId, unitId);
      } else {
        unitId = Number(q.unitIns.run(uk, invId, datasetId, r.unitRef, r.unitType, r.area, r.rooms).lastInsertRowid);
        newUnits++;
      }
      claimed.add(unitId);
      if (seen.has(unitId)) continue; // ten sam lokal dwa razy w jednym pliku: liczy się pierwszy wiersz
      seen.add(unitId);

      // Ten sam lokal bywa w dwóch zbiorach (roczne zbiory 2025 i 2026). Informacji starszej
      // niż to, co już wiemy o lokalu, nie wpisujemy: historia musi iść do przodu.
      const p = q.presLast.get(unitId) as { from_date: string; to_date: string } | undefined;
      if (p && date <= p.to_date) continue;
      if (p && (p.to_date >= gapLimit || p.to_date === prevList)) q.presExt.run(date, unitId, p.from_date);
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
