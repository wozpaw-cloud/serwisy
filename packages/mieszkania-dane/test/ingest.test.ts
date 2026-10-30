import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { ingestSnapshot } from '../src/ingest.ts';
import { Model } from '../src/analytics.ts';
import { readCsv, toRecords } from '../src/parse.ts';

const H = 'Nazwa dewelopera;Miejscowość lokalizacji;Nr lokalu lub domu;Cena m 2 powierzchni użytkowej [zł];Data od której obowiązuje cena m 2 powierzchni użytkowej;Cena lokalu stanowiąca iloczyn ceny m2 oraz powierzchni [zł]';
const file = (rows: string[]) => toRecords(readCsv([H, ...rows].join('\n')));
const row = (ref: string, m2: number, date = 'X') => `Dev;Poznań;${ref};${m2};${date};${m2 * 50}`;

describe('historia cen i obecność w ofercie', () => {
  const db = openDb(':memory:');
  ingestSnapshot(db, { datasetId: 'D', date: '2026-01-01' }, file([row('1', 10000), row('2', 10000), row('3', 12000), row('4', 11000)]));
  ingestSnapshot(db, { datasetId: 'D', date: '2026-01-08' }, file([row('1', 10000), row('2', 9500, '2026-01-06 08:00:00'), row('3', 12000), row('4', 11000)]));
  ingestSnapshot(db, { datasetId: 'D', date: '2026-01-15' }, file([row('1', 10000), row('2', 9500), row('4', 11000)]));

  it('zapisuje cenę tylko przy zmianie, z datą z cennika', () => {
    const p = db.prepare("SELECT p.from_date, p.price_m2 FROM prices p JOIN units u ON u.id = p.unit_id WHERE u.ref = '2' ORDER BY p.from_date").all();
    expect(p.map((x: any) => [x.from_date, x.price_m2])).toEqual([['2026-01-01', 10000], ['2026-01-06', 9500]]);
  });
  it('lokal znika z oferty, gdy nie ma go w cenniku', () => {
    const m = new Model(db);
    const u3 = m.units.find((u) => u.ref === '3')!;
    expect(m.inOffer(u3, '2026-01-08')).toBe(true);
    expect(m.inOffer(u3, '2026-01-15')).toBe(false);
  });
  it('nie wczytuje starszego cennika drugi raz', () => {
    const s = ingestSnapshot(db, { datasetId: 'D', date: '2026-01-08' }, file([row('1', 1)]));
    expect(s.status).toBe('pominiety');
  });
  it('indeks tych samych lokali ignoruje lokale, które zniknęły', () => {
    const m = new Model(db);
    const s = m.series('t', m.units, 1);
    // tydzień 2: lokal 2 potaniał o 5%, pozostałe trzy bez zmian -> średnia geometryczna
    const expected = 100 * Math.exp(Math.log(0.95) / 4);
    expect(s.index[1].value).toBeCloseTo(expected, 6);
    // tydzień 3: lokal 3 zniknął, ceny pozostałych bez zmian -> indeks stoi
    expect(s.index[2].value).toBeCloseTo(expected, 6);
    // a mediana spada tylko dlatego, że z oferty zniknął najdroższy lokal
    expect(s.median[1].value).toBe(10500);
    expect(s.median[2].value).toBe(10000);
  });
});

describe('indeks dla lokali, które weszły do oferty później', () => {
  const db = openDb(':memory:');
  ingestSnapshot(db, { datasetId: 'L', date: '2026-01-01' }, file([row('A', 10000), row('B', 10000)]));
  ingestSnapshot(db, { datasetId: 'L', date: '2026-01-08' }, file([row('A', 10000), row('B', 10000), row('C', 9000), row('D', 9000)]));
  ingestSnapshot(db, { datasetId: 'L', date: '2026-01-15' }, file([row('A', 10000), row('B', 10000), row('C', 8550), row('D', 9000)]));
  it('zaczyna się od 100 w tygodniu przed pierwszym porównaniem', () => {
    const m = new Model(db);
    const late = m.units.filter((u) => u.ref === 'C' || u.ref === 'D');
    const s = m.series('late', late, 1);
    expect(s.index.map((p) => p.value === null ? null : Math.round(p.value * 1000) / 1000))
      .toEqual([null, 100, Math.round(100 * Math.exp(Math.log(0.95) / 2) * 1000) / 1000]);
  });
});
