// "Dziś" serwisu i lokale w ofercie przy cennikach publikowanych nie codziennie,
// literówki w datach i warianty nazw województw.

import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { ingestSnapshot } from '../src/ingest.ts';
import { Model } from '../src/analytics.ts';
import { cleanVoivodeship } from '../src/normalize.ts';
import { readCsv, toRecords } from '../src/parse.ts';

const H = 'Nazwa dewelopera;Województwo lokalizacji przedsięwzięcia;Miejscowość lokalizacji;Nr lokalu lub domu;Cena m 2 powierzchni użytkowej [zł];Powierzchnia użytkowa';
const file = (dev: string, voiv: string, refs: string[]) => toRecords(readCsv([H, ...refs.map((r) => `${dev};${voiv};Wrocław;${r};12000;50`)].join('\n')));

describe('oferta na dziś', () => {
  const db = openDb(':memory:');
  for (const d of ['2026-10-20', '2026-10-27', '2026-10-30']) ingestSnapshot(db, { datasetId: 'A', date: d }, file('Codzienny', 'dolnośląskie', ['A1', 'A2']));
  for (const d of ['2026-10-20', '2026-10-27']) ingestSnapshot(db, { datasetId: 'B', date: d }, file('Tygodniowy', 'Dolnośląskie', ['B1']));
  ingestSnapshot(db, { datasetId: 'C', date: '2026-10-10' }, file('Uśpiony', 'woj. dolnośląskie', ['C1']));
  ingestSnapshot(db, { datasetId: 'E', date: '2029-08-26' }, file('Literówka', 'dolnoslaskie', ['E1']));
  const m = new Model(db);

  it('pojedynczy cennik z datą z przyszłości nie zmienia "dziś"', () => expect(m.asOf).toBe('2026-10-30'));
  it('lokale ze świeżego cennika tygodniowego są w ofercie, ze starego nie', () => {
    const at = (ref: string) => m.inOffer(m.units.find((u) => u.ref === ref)!, m.asOf);
    expect(at('A1')).toBe(true);
    expect(at('B1')).toBe(true);
    expect(at('C1')).toBe(false);
  });
  it('jedno województwo i jedno miasto mimo różnych zapisów', () => {
    expect(m.voivodeships.map((v) => v.name)).toEqual(['dolnośląskie']);
    expect(m.cities.filter((c) => c.name === 'Wrocław')).toHaveLength(1);
  });
});

describe('nazwy województw', () => {
  it.each([
    ['woj. Wielkopolska', 'wielkopolskie'], ['warmińsko mazurskie', 'warmińsko-mazurskie'], ['WARMIŃSKO-MAZURSKIE', 'warmińsko-mazurskie'],
    ['slaskie', 'śląskie'], ['Województwo łódzkie', 'łódzkie'], ['Polska', null], ['X', null], ['zachodniopomorskie', 'zachodniopomorskie'],
  ])('%s -> %s', (v, want) => expect(cleanVoivodeship(v)).toBe(want));
});
