// Nowy urzędowy wzór cennika (od XI 2026, 48 kolumn): "Firma", "Identyfikator lokalu
// mieszkalnego albo domu jednorodzinnego", bez powierzchni i nazwy inwestycji. Lokale
// zbioru, który przeszedł na nowy wzór, zachowują historię cen.
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { ingestSnapshot } from '../src/ingest.ts';
import { readCsv, toRecords } from '../src/parse.ts';
import { mapColumns } from '../src/columns.ts';

const SEAT = 'adresu siedziby albo głównego miejsca wykonywania działalności gospodarczej';
const SALE = 'adresu lokalu, w którym jest prowadzona sprzedaż';
const LOC = 'lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego';
const ID = 'Identyfikator lokalu mieszkalnego albo domu jednorodzinnego';
const PRZ = 'pomieszczenia przynależnego, o którym mowa w art. 2 ust. 4 ustawy z dnia 24 czerwca 1994 r. o własności lokali';
const NEW = [
  'Firma', 'Numer identyfikacji podatkowej (NIP)',
  ...['Województwo', 'Powiat', 'Gmina', 'Miejscowość', 'Ulica', 'Numer nieruchomości', 'Numer lokalu', 'Kod pocztowy'].map((x) => `${x} ${SEAT}`),
  ...['Województwo', 'Powiat', 'Gmina', 'Miejscowość', 'Ulica', 'Numer nieruchomości', 'Numer lokalu', 'Kod pocztowy'].map((x) => `${x} ${SALE}`),
  'Dodatkowe lokalizacje, w których jest prowadzona sprzedaż', 'Sposób kontaktu nabywcy z podmiotem obowiązanym',
  ...['Województwo', 'Powiat', 'Gmina', 'Miejscowość', 'Ulica', 'Numer nieruchomości', 'Kod pocztowy'].map((x) => `${x} ${LOC}`),
  `Długość geograficzna punktu określającego lokalizację przestrzenną przedsięwzięcia deweloperskiego lub zadania inwestycyjnego`,
  `Szerokość geograficzna punktu określającego lokalizację przestrzenną przedsięwzięcia deweloperskiego lub zadania inwestycyjnego`,
  'Rodzaj nieruchomości', ID,
  'Cena 1 m2 powierzchni użytkowej lokalu mieszkalnego albo domu jednorodzinnego',
  'Data i czas, od których obowiązuje cena 1 m2 powierzchni użytkowej lokalu mieszkalnego albo domu jednorodzinnego',
  'Cena lokalu mieszkalnego albo domu jednorodzinnego lub ich części będących przedmiotem umowy',
  'Data i czas, od których obowiązuje cena lokalu mieszkalnego albo domu jednorodzinnego lub ich części',
  `Rodzaj ${PRZ}`, `Identyfikator ${PRZ}`, `Cena ${PRZ}`, `Data i czas, od których obowiązuje cena ${PRZ}`, ID,
  'Wyszczególnienie praw niezbędnych do korzystania z lokalu mieszkalnego albo domu jednorodzinnego',
  'Wartość praw niezbędnych do korzystania z lokalu mieszkalnego albo domu jednorodzinnego',
  'Data i czas, od których obowiązuje wartość praw niezbędnych do korzystania z lokalu mieszkalnego albo domu jednorodzinnego', ID,
  'Wyszczególnienie rodzaju innego świadczenia pieniężnego, które nabywca jest zobowiązany spełnić na rzecz podmiotu obowiązanego w wykonaniu umowy przenoszącej własność',
  'Wartość innego świadczenia pieniężnego, które nabywca jest zobowiązany spełnić na rzecz podmiotu obowiązanego w wykonaniu umowy przenoszącej własność',
  'Data i czas, od których obowiązuje wartość innego świadczenia pieniężnego, które nabywca jest zobowiązany spełnić na rzecz podmiotu obowiązanego w wykonaniu umowy przenoszącej własność', ID,
];
const blank = () => NEW.map(() => 'X');
function newRow(ref: string, m2: number, area: number, street = 'Lipowa') {
  const r = blank();
  r[0] = 'Atrapa Dom Sp. z o.o.'; r[1] = '7770001122';
  r[20] = 'wielkopolskie'; r[21] = 'poznański'; r[22] = 'Komorniki'; r[23] = 'Plewiska'; r[24] = street; r[25] = '5'; r[26] = '62-064';
  r[29] = 'lokal mieszkalny'; r[30] = ref; r[31] = String(m2); r[32] = '2026-11-20 08:00'; r[33] = String(Math.round(m2 * area)); r[34] = '2026-11-20 08:00';
  return r.join(';');
}
function accessoryRow(ref: string) {
  const r = blank();
  r[0] = 'Atrapa Dom Sp. z o.o.'; r[1] = '7770001122'; r[23] = 'Plewiska'; r[24] = 'Lipowa'; r[25] = '5';
  r[35] = 'komórka lokatorska'; r[36] = `K-${ref}`; r[37] = '15000'; r[39] = ref;
  return r.join(';');
}
const newFile = (rows: string[]) => toRecords(readCsv([NEW.join(';'), ...rows].join('\n')));

// Stary wzór (2025) dla tego samego zbioru.
const OLD_H = 'Nazwa dewelopera;Nr NIP;Miejscowość lokalizacji przedsięwzięcia deweloperskiego;Ulica lokalizacji przedsięwzięcia deweloperskiego;Nr nieruchomości lokalizacji przedsięwzięcia deweloperskiego;Nazwa przedsięwzięcia deweloperskiego;Nr lokalu lub domu jednorodzinnego nadany przez dewelopera;Cena m 2 powierzchni użytkowej lokalu mieszkalnego / domu jednorodzinnego [zł];Powierzchnia użytkowa';
const oldFile = (rows: string[]) => toRecords(readCsv([OLD_H, ...rows].join('\n')));
const oldRow = (ref: string, m2: number, area: number) => `ATRAPA DOM SPÓŁKA Z O.O.;7770001122;Plewiska;Lipowa;5;Osiedle Lipowe;${ref};${m2};${area}`;

describe('nowy wzór cennika', () => {
  it('rozpoznaje kolumny: numer lokalu z pierwszej kolumny "Identyfikator…", cena całkowita, firma', () => {
    const { map } = mapColumns(NEW);
    expect(map.unitRef).toBe(30);
    expect(map.priceM2).toBe(31);
    expect(map.priceTotal).toBe(33);
    expect(map.devName).toBe(0);
    expect(map.city).toBe(23);
    expect(map.street).toBe(24);
    expect(map.buildingNo).toBe(25);
  });
  it('wczytuje lokale, powierzchnię liczy z ceny całkowitej i ceny za m², pomija wiersze pomieszczeń', () => {
    const p = newFile([newRow('M1', 10000, 50), newRow('M2', 9000, 62.5), accessoryRow('M1')]);
    expect(p.missingColumns).toEqual([]);
    expect(p.records.map((r) => [r.unitRef, r.area, r.priceM2, r.city])).toEqual([['M1', 50, 10000, 'Plewiska'], ['M2', 62.5, 9000, 'Plewiska']]);
  });
  it('lokal ze zbioru, który przeszedł na nowy wzór, zachowuje historię cen', () => {
    const db = openDb(':memory:');
    ingestSnapshot(db, { datasetId: 'Z', date: '2026-11-09' }, oldFile([oldRow('M1', 10000, 50), oldRow('M2', 9000, 62.5)]));
    const s = ingestSnapshot(db, { datasetId: 'Z', date: '2026-11-27' }, newFile([newRow('M1', 9500, 50), newRow('M2', 9000, 62.5), newRow('M3', 11000, 40)]));
    expect(s.status).not.toBe('odrzucony');
    expect(s.newUnits).toBe(1); // tylko M3
    expect(s.priceChanges).toBe(1); // M1: 10 000 → 9 500
    const units = db.prepare('SELECT ref FROM units ORDER BY ref').all() as { ref: string }[];
    expect(units.map((u) => u.ref)).toEqual(['M1', 'M2', 'M3']);
    const pres = db.prepare("SELECT from_date, to_date FROM presence p JOIN units u ON u.id = p.unit_id WHERE u.ref = 'M1'").all();
    expect(pres).toEqual([{ from_date: '2026-11-09', to_date: '2026-11-27' }]);
  });
  it('nowy lokal o tym samym numerze przy innej ulicy nie przejmuje historii', () => {
    const db = openDb(':memory:');
    ingestSnapshot(db, { datasetId: 'Z', date: '2026-11-09' }, oldFile([oldRow('M1', 10000, 50)]));
    const s = ingestSnapshot(db, { datasetId: 'Z', date: '2026-11-27' }, newFile([newRow('M1', 12000, 50, 'Klonowa')]));
    expect(s.newUnits).toBe(1);
  });
  it('nowy identyfikator lokalu: dopasowanie po powierzchni i cenie za m², nowy numer zostaje', () => {
    const db = openDb(':memory:');
    ingestSnapshot(db, { datasetId: 'Z', date: '2026-11-09' }, oldFile([oldRow('6/2', 10000, 50), oldRow('6/3', 9000, 62.5), oldRow('6/4', 9000, 62.5)]));
    // 6/2 → 8249 (ta sama cena); 6/3 i 6/4 mają tę samą powierzchnię i cenę: po kolei.
    // 8252 (inna cena) to nowy lokal.
    const s = ingestSnapshot(db, { datasetId: 'Z', date: '2026-11-27' }, newFile([newRow('8249', 10000, 50), newRow('8250', 9000, 62.5), newRow('8251', 9000, 62.5), newRow('8252', 9900, 62.5)]));
    expect(s.newUnits).toBe(1);
    expect((db.prepare('SELECT ref FROM units ORDER BY id').all() as { ref: string }[]).map((x) => x.ref)).toEqual(['8249', '8250', '8251', '8252']);
    const u = db.prepare("SELECT u.ref, (SELECT min(from_date) FROM presence p WHERE p.unit_id = u.id) AS f FROM units u WHERE u.ref = '8249'").get() as { ref: string; f: string };
    expect(u.f).toBe('2026-11-09');
    expect((db.prepare("SELECT count(*) AS n FROM units WHERE ref = '6/2'").get() as { n: number }).n).toBe(0);
  });
});
