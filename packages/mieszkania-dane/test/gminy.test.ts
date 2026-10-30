import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { ingestSnapshot } from '../src/ingest.ts';
import { Model } from '../src/analytics.ts';
import { readCsv, toRecords } from '../src/parse.ts';

const H = [
  'Nazwa dewelopera', 'Województwo lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Powiat lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego', 'Gmina lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Miejscowość lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego', 'Nazwa przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Nr lokalu lub domu', 'Cena m 2 powierzchni użytkowej [zł]', 'Cena lokalu stanowiąca iloczyn ceny m2 oraz powierzchni [zł]',
].join(';');
const row = (voiv: string, county: string, gmina: string, city: string, inv: string, ref: string) => `Dev;${voiv};${county};${gmina};${city};${inv};${ref};10000;500000`;

describe('gminy w modelu danych', () => {
  const db = openDb(':memory:');
  ingestSnapshot(db, { datasetId: 'G', date: '2026-01-01' }, toRecords(readCsv([H,
    row('mazowieckie', 'Warszawa', 'Warszawa', 'Warszawa', 'Osiedle A', '1'),
    row('MAZOWIECKIE', 'm. st. Warszawa', 'Białołęka', 'WARSZAWA', 'Osiedle B', '1'),
    row('wielkopolskie', 'poznański', 'Komorniki', 'Komorniki', 'Osiedle C', '1'),
    row('wielkopolskie', 'Powiat poznański', 'GMINA KOMORNIKI', 'Plewiska', 'Osiedle D', '1'),
    row('wielkopolskie', 'poznański', 'X', 'Komorniki', 'Osiedle E', '1'),
    row('wielkopolskie', 'poznański', 'X', 'Dąbrowa', 'Osiedle F', '1'),
    row('lubelskie', 'Chełm', 'Chełm', 'Chełm', 'Osiedle G', '1'),
    row('lubelskie', 'chełmski', 'Chełm', 'Pokrówka', 'Osiedle H', '1'),
  ].join('\n'))));
  const m = new Model(db);
  const g = (slug: string) => m.gminas.find((x) => x.slug === slug);

  it('dzielnica w polu gminy nie rozbija Warszawy', () => {
    expect(m.cities.filter((c) => c.name === 'Warszawa')).toHaveLength(1);
    expect(g('warszawa')?.urban).toBe(true);
    expect(g('warszawa')?.investments).toHaveLength(2);
  });

  it('gmina łączy miejscowości, różne zapisy i uzupełnia brakującą gminę', () => {
    const k = g('komorniki')!;
    expect(k.cities.map((c) => c.name).sort()).toEqual(['Komorniki', 'Plewiska']);
    expect(k.investments).toHaveLength(3);
    expect(k.county).toBe('poznański');
    expect(k.guessed).toBe(0);
  });

  it('bez gminy w żadnym cenniku przyjmuje nazwę miejscowości i to zaznacza', () => {
    expect(g('dabrowa')?.guessed).toBe(1);
  });

  it('gmina wiejska o nazwie miasta na prawach powiatu dostaje osobny adres', () => {
    expect(g('chelm')?.urban).toBe(true);
    expect(g('chelm-chelmski')?.cities.map((c) => c.name)).toEqual(['Pokrówka']);
  });

  it('województwa znają swoje gminy', () => {
    expect(m.voivodeships.find((v) => v.name === 'wielkopolskie')?.gminas.map((x) => x.name).sort()).toEqual(['Dąbrowa', 'Komorniki']);
  });
});

describe('powiaty w modelu danych', () => {
  const db = openDb(':memory:');
  ingestSnapshot(db, { datasetId: 'P', date: '2026-01-01' }, toRecords(readCsv([H,
    row('wielkopolskie', 'poznański', 'Komorniki', 'Komorniki', 'Osiedle A', '1'),
    row('wielkopolskie', 'Powiat POZNAŃSKI', 'Dopiewo', 'Skórzewo', 'Osiedle B', '1'),
    row('wielkopolskie', 'Poznań', 'Poznań', 'Poznań', 'Osiedle C', '1'),
    row('dolnośląskie', 'średzki', 'Środa Śląska', 'Środa Śląska', 'Osiedle D', '1'),
    row('wielkopolskie', 'średzki', 'Środa Wielkopolska', 'Środa Wielkopolska', 'Osiedle E', '1'),
    row('wielkopolskie', 'X', 'Murowana Goślina', 'Murowana Goślina', 'Osiedle F', '1'),
  ].join('\n'))));
  const m = new Model(db);
  const p = (slug: string) => m.powiaty.find((x) => x.slug === slug);

  it('łączy gminy w powiat mimo różnych zapisów nazwy powiatu', () => {
    expect(p('poznanski')?.gminas.map((g) => g.name).sort()).toEqual(['Dopiewo', 'Komorniki']);
    expect(p('poznanski')?.urban).toBe(false);
  });
  it('miasto na prawach powiatu jest osobnym powiatem', () => {
    expect(p('poznan')?.urban).toBe(true);
    expect(p('poznan')?.gminas.map((g) => g.name)).toEqual(['Poznań']);
  });
  it('powtarzająca się nazwa powiatu dostaje województwo w adresie', () => {
    expect(m.powiaty.filter((x) => x.name === 'średzki').map((x) => x.slug).sort()).toEqual(['sredzki-dolnoslaskie', 'sredzki-wielkopolskie']);
  });
  it('gmina bez powiatu w cenniku nie trafia do żadnego powiatu', () => {
    expect(m.gminas.find((g) => g.name === 'Murowana Goślina')?.powiat).toBeNull();
  });
  it('województwo zna swoje powiaty', () => {
    expect(m.voivodeships.find((v) => v.name === 'wielkopolskie')?.powiaty.map((x) => x.slug).sort()).toEqual(['poznan', 'poznanski', 'sredzki-wielkopolskie']);
  });
});
