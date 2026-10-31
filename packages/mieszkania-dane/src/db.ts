// Baza SQLite z pełną historią ofert. Wbudowany moduł node:sqlite (Node >= 22.13),
// więc nie trzeba kompilować natywnych dodatków ani w CI, ani lokalnie.
//
// Zasada przechowywania: nie zapisujemy całego cennika co dzień. Zapisujemy
//  - przedziały obecności lokalu w ofercie (presence: od-do),
//  - wiersz ceny tylko wtedy, gdy cena się zmieniła (prices).
// Dzięki temu rok codziennych cenników całego kraju mieści się w kilkuset MB.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DB = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/mieszkania.sqlite');

export function dbPath(): string {
  return process.env.MIESZKANIA_DB ? resolve(process.env.MIESZKANIA_DB) : DEFAULT_DB;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS datasets (
  id            TEXT PRIMARY KEY,           -- identyfikator zbioru w dane.gov.pl
  title         TEXT,
  last_snapshot TEXT                        -- data ostatniego wczytanego cennika
);

CREATE TABLE IF NOT EXISTS snapshots (
  id              INTEGER PRIMARY KEY,
  dataset_id      TEXT NOT NULL REFERENCES datasets(id),
  data_date       TEXT NOT NULL,
  source_url      TEXT,
  format          TEXT,
  rows_read       INTEGER,
  records         INTEGER,
  rejected_json   TEXT,
  unknown_headers TEXT,
  status          TEXT NOT NULL,            -- ok | ostrzezenie | odrzucony
  note            TEXT,
  UNIQUE (dataset_id, data_date)
);

CREATE TABLE IF NOT EXISTS developers (
  id           INTEGER PRIMARY KEY,
  legal_name   TEXT NOT NULL,
  nip          TEXT,
  krs          TEXT,
  website_host TEXT,
  brand_key    TEXT NOT NULL,               -- spółki celowe jednej marki mają wspólny klucz
  UNIQUE (legal_name, nip)
);

CREATE TABLE IF NOT EXISTS investments (
  id             INTEGER PRIMARY KEY,
  key            TEXT NOT NULL UNIQUE,
  developer_id   INTEGER NOT NULL REFERENCES developers(id),
  name           TEXT,
  voivodeship    TEXT,
  county         TEXT,
  gmina          TEXT,
  city           TEXT NOT NULL,
  street         TEXT,
  building_no    TEXT,
  postal_code    TEXT,
  prospectus_url TEXT
);

CREATE TABLE IF NOT EXISTS units (
  id            INTEGER PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  investment_id INTEGER NOT NULL REFERENCES investments(id),
  dataset_id    TEXT NOT NULL,
  ref           TEXT NOT NULL,
  type          TEXT NOT NULL,              -- mieszkanie | dom
  area          REAL,
  rooms         INTEGER
);

CREATE TABLE IF NOT EXISTS presence (
  unit_id   INTEGER NOT NULL REFERENCES units(id),
  from_date TEXT NOT NULL,
  to_date   TEXT NOT NULL,
  PRIMARY KEY (unit_id, from_date)
);

CREATE TABLE IF NOT EXISTS prices (
  unit_id     INTEGER NOT NULL REFERENCES units(id),
  from_date   TEXT NOT NULL,
  price_m2    REAL NOT NULL,
  price_total INTEGER,
  PRIMARY KEY (unit_id, from_date)
);

-- Zbiory, których historia (cennik z każdego tygodnia) jest już wczytana.
CREATE TABLE IF NOT EXISTS backfill_done (
  dataset_id TEXT PRIMARY KEY,
  finished   TEXT NOT NULL
);

-- Wersje danych i parsera (zmiana wymusza ponowne wczytanie, zob. cli.ts).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id       INTEGER PRIMARY KEY,
  started  TEXT NOT NULL,
  finished TEXT,
  status   TEXT,                            -- ok | zablokowany | blad
  summary  TEXT
);

CREATE INDEX IF NOT EXISTS idx_units_inv ON units(investment_id);
CREATE INDEX IF NOT EXISTS idx_inv_city ON investments(city);
`;

export function openDb(path = dbPath(), { readonly = false } = {}): DatabaseSync {
  if (!readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: readonly });
  if (!readonly) db.exec(SCHEMA);
  return db;
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
