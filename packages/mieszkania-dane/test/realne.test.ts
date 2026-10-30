// Przypadki z prawdziwych cenników w dane.gov.pl (sprawdzenie z 30.10.2026).
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { devNameFromTitle, parseFile, readCsv, sniffFormat, toRecords } from '../src/parse.ts';
import { mapColumns } from '../src/columns.ts';

describe('format z zawartości pliku', () => {
  it('plik Excel opisany w portalu jako csv', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Cennik');
    ws.addRow(['Nazwa dewelopera', 'Miejscowość lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego', 'Nr lokalu lub domu jednorodzinnego nadany przez dewelopera', 'Cena m 2 powierzchni użytkowej lokalu mieszkalnego / domu jednorodzinnego [zł]']);
    ws.addRow(['Dev', 'Poznań', 'A1', 10000]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect(sniffFormat(buf)).toBe('xlsx');
    const p = await parseFile(buf, 'csv');
    expect(p.records).toHaveLength(1);
    expect(p.records[0].city).toBe('Poznań');
  });
  it('rozpoznaje xml, json i zostawia csv', () => {
    expect(sniffFormat(Buffer.from('﻿  <?xml version="1.0"?><a/>'))).toBe('xml');
    expect(sniffFormat(Buffer.from('[{"a":1}]'))).toBe('json');
    expect(sniffFormat(Buffer.from('Nazwa;Cena\nA;1'))).toBeNull();
  });
});

describe('warianty nagłówków', () => {
  it('"Lokalizacja przedsięwzięcia … - miejscowość" i literówka "iloczym"', () => {
    const { map } = mapColumns([
      'Nazwa dewelopera',
      'Województwo adresu siedziby/głównego miejsca wykonywania działalności gospodarczej dewelopera',
      'Miejscowość adresu siedziby/głównego miejsca wykonywania działalności gospodarczej dewelopera',
      'Lokalizacja przedsięwzięcia deweloperskiego lub zadania inwestycyjnego - województwo',
      'Lokalizacja przedsięwzięcia deweloperskiego lub zadania inwestycyjnego - powiat',
      'Lokalizacja przedsięwzięcia deweloperskiego lub zadania inwestycyjnego - gmina',
      'Lokalizacja przedsięwzięcia deweloperskiego lub zadania inwestycyjnego - miejscowość',
      'Lokalizacja przedsięwzięcia deweloperskiego lub zadania inwestycyjnego - ulica',
      'Lokalizacja przedsięwzięcia deweloperskiego lub zadania inwestycyjnego - nr nieruchomości',
      'Lokalizacja przedsięwzięcia deweloperskiego lub zadania inwestycyjnego - kod pocztowy',
      'Nr lokalu lub domu jednorodzinnego nadany przez dewelopera',
      'Cena m 2 powierzchni użytkowej lokalu mieszkalnego / domu jednorodzinnego [zł]',
      'Cena lokalu mieszkalnego lub domu jednorodzinnego przedmiotem umowy stanowiąca iloczym ceny m2 oraz powierzchni',
    ]);
    expect(map).toMatchObject({ devName: 0, voivodeship: 3, county: 4, gmina: 5, city: 6, street: 7, buildingNo: 8, postalCode: 9, unitRef: 10, priceM2: 11, priceTotal: 12 });
  });
  it('inny szablon: "Nr nieruchomości nadany przez dewelopera", "Cena za m2 nieruchomości"', () => {
    const { map, unknown } = mapColumns([
      'Id nieruchomości', 'Miejscowość', 'Adres strony internetowej inwestycji', 'Nr nieruchomości nadany przez dewelopera',
      'Powierzchnia', 'Piętro nieruchomości', 'Stawka VAT (%)', 'Waluta', 'Cena za m2 nieruchomości', 'Cena nieruchomości', 'Inne świadczenia pieniężne',
    ]);
    expect(map).toMatchObject({ city: 1, unitRef: 3, area: 4, priceM2: 8, priceTotal: 9 });
    expect(unknown).toEqual([]);
  });
  it('bez numeru lokalu bierze identyfikator nieruchomości', () => {
    const { map } = mapColumns(['Id nieruchomości', 'Miasto', 'Cena za m2 nieruchomości']);
    expect(map.unitRef).toBe(0);
  });
});

describe('nazwa dewelopera z tytułu zbioru', () => {
  it.each([
    ['Ceny ofertowe mieszkań dewelopera Osiedle Przy Lesie Sp. z o.o. w 2025 r.', 'Osiedle Przy Lesie Sp. z o.o.'],
    ['Ceny ofertowe mieszkań dewelopera TRU PROJEKT 3.0. Sp. z o.o. - inwestycja ReBa 1 w 2026 r.', 'TRU PROJEKT 3.0. Sp. z o.o.'],
    ['Ceny ofertowe mieszkań dewelopera Miernik Development sp. z o.o.  2026-10-26', 'Miernik Development sp. z o.o.'],
    ['Ceny ofertowe mieszkań dewelopera Osiedle w Dolinie Sp. z o.o. na dzień 24.10.2026 r.', 'Osiedle w Dolinie Sp. z o.o.'],
    ['Ceny ofertowe inwestycji Kwiatowa dewelopera EB INVEST SP. Z O.O.', 'EB INVEST SP. Z O.O.'],
    ['Ceny ofertowe nieruchomości dewelopera Maison Sp. z o.o. w 2026r.', 'Maison Sp. z o.o.'],
    ['Ceny ofertowe dewelopera Aldy Development Kręcigłowa&amp;Kozan sp. z o.o. - 2026-10-26', 'Aldy Development Kręcigłowa&Kozan sp. z o.o.'],
  ])('%s', (title, name) => {
    expect(devNameFromTitle(title)).toBe(name);
  });
  it('plik bez kolumny dewelopera dostaje nazwę z tytułu', () => {
    const t = readCsv('Miejscowość;Nr nieruchomości nadany przez dewelopera;Cena za m2 nieruchomości\nŁódź;M1;9000');
    expect(toRecords(t, 'csv', { devFallback: 'Arutim Sp. z o.o.' }).records[0].devName).toBe('Arutim Sp. z o.o.');
    expect(toRecords(t, 'csv').records).toHaveLength(0);
  });
});

describe('kolejne szablony z prawdziwych plików', () => {
  it('szablon z "Kategoria produktu": cena za m² lokalu, nie wykończenia; bez miejsc postojowych', () => {
    const t = readCsv([
      'Nazwa dewelopera;Lokalizacja przedsięwzięcia deweloperskiego lub zadania inwestycyjnego - miejscowość;Kategoria produktu;Nr produktu nadany przez dewelopera;Cena brutto/m2 powierzchni produktu [zł];Cena brutto produktu [zł];Data zmiany ceny;Wykończenie cena/m2 [zł];Wykończenie cena [zł]',
      'Archi;Wrocław;Mieszkanie;A.1.01;14500,00;725000,00;2026-10-01;900;45000',
      'Archi;Wrocław;Miejsce postojowe;P-12;4000;50000;2026-10-01;;',
    ].join('\n'));
    const p = toRecords(t);
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({ unitRef: 'A.1.01', priceM2: 14500, priceTotal: 725000, priceM2Date: '2026-10-01', city: 'Wrocław' });
    expect(p.rejected['nie lokal mieszkalny (parking, komórka, usługi)']).toBe(1);
  });
  it('cały adres w jednej kolumnie i cena za m² wyliczona z ceny i powierzchni', () => {
    const t = readCsv([
      'Deweloper;Lokalizacja przedsięwziecia deweloperskiego;Numer lokalu mieszkalnego;Powierzchnia użytkowa lokalu mieszkalnego (m2);Cena brutto lokalu mieszkalnego (zł)',
      'Fasolowa;ul. Fasolowa 12, 02-482 Warszawa;M3;50;750000',
    ].join('\n'));
    const r = toRecords(t).records[0];
    expect(r).toMatchObject({ city: 'Warszawa', unitRef: 'M3', area: 50, priceM2: 15000 });
  });
  it('arkusz z własnymi nazwami: "ID mieszkania", "Adres", "Cena m2 [PLN]", "Cena [PLN]"', () => {
    const { map } = mapColumns(['Nazwa dewelopera', 'ID mieszkania', 'Nazwa mieszkania', 'Status oferty', 'Rodzaj lokalu', 'Adres', 'Liczba pokoi', 'Powierzchnia [m2]', 'Cena [PLN]', 'Cena m2 [PLN]', 'Data od której obowiązuje cena']);
    expect(map).toMatchObject({ unitRef: 1, status: 3, unitType: 4, address: 5, rooms: 6, area: 7, priceTotal: 8, priceM2: 9, priceM2Date: 10 });
  });
  it('"Oznaczenie", "Cena Brutto/m² (ofertowa w zł)", "Całkowita cena Brutto", "Powierzchnia (proj. w m²)"', () => {
    const { map } = mapColumns(['Lp.', 'Nazwa dewelopera', 'Inwestycja', 'Produkt', 'Oznaczenie', 'Numer', 'Piętro', 'Status', 'Powierzchnia (proj. w m²)', 'Cena Brutto/m² (ofertowa w zł)', 'Całkowita cena Brutto (ofertowa w zł)', 'Miejscowość']);
    expect(map).toMatchObject({ unitType: 3, unitRef: 4, area: 8, priceM2: 9, priceTotal: 10, city: 11 });
  });
  it('miejscowość z adresu', async () => {
    const { cityFromAddress } = await import('../src/parse.ts');
    expect(cityFromAddress('ul. Polna 5, 62-002 Suchy Las')).toBe('Suchy Las');
    expect(cityFromAddress('Warszawa, ul. Okrzei 6')).toBe('Warszawa');
    expect(cityFromAddress('62-095 Murowana Goślina, ul. Długa 1')).toBe('Murowana Goślina');
  });
});
