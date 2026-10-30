import { describe, expect, it } from 'vitest';
import { mapColumns, missingRequired } from '../src/columns.ts';
import { fold, parseDate, parseNumber, titleCase, displayCompanyName, websiteHost } from '../src/normalize.ts';
import { readCsv, readJson, readXml, toRecords } from '../src/parse.ts';
import { TEMPLATE_HEADERS } from '../src/sample.ts';

describe('liczby i daty', () => {
  it.each([
    ['14700,00', 14700], ['723 240,00 zł', 723240], ['1.250.000', 1250000], ['12.345,67', 12345.67],
    ['12,345.67', 12345.67], ['X', null], ['brak', null], ['', null], [15000, 15000], ['9 800 PLN', 9800],
  ])('%s -> %s', (v, want) => expect(parseNumber(v)).toBe(want));

  it.each([
    ['2025-09-10 15:57:23', '2025-09-10'], ['10.09.2025', '2025-09-10'], ['X', null], [45910, '2025-09-10'],
  ])('%s -> %s', (v, want) => expect(parseDate(v)).toBe(want));

  it('nazwy', () => {
    expect(titleCase('BIELSKO-BIAŁA')).toBe('Bielsko-Biała');
    expect(titleCase('GORZÓW WIELKOPOLSKI')).toBe('Gorzów Wielkopolski');
    expect(displayCompanyName('MURAPOL PROJEKT SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ')).toBe('Murapol Projekt');
    expect(websiteHost('https://www.Murapol.pl/oferta')).toBe('murapol.pl');
    expect(fold('Cena m² powierzchni')).toBe('cena m2 powierzchni');
  });
});

describe('rozpoznawanie kolumn wzorcowego pliku', () => {
  const { map, unknown } = mapColumns(TEMPLATE_HEADERS);
  it('znajduje wszystkie potrzebne pola', () => {
    expect(missingRequired(map)).toEqual([]);
    expect(TEMPLATE_HEADERS[map.priceM2!]).toMatch(/^Cena m 2/);
    expect(TEMPLATE_HEADERS[map.priceTotal!]).toMatch(/iloczyn ceny m2/);
    expect(TEMPLATE_HEADERS[map.priceFull!]).toMatch(/uwzględniająca/);
    expect(TEMPLATE_HEADERS[map.unitRef!]).toMatch(/nadany przez dewelopera/);
    expect(TEMPLATE_HEADERS[map.city!]).toMatch(/^Miejscowość lokalizacji/);
    expect(TEMPLATE_HEADERS[map.status!]).toBe('Status lokalu');
  });
  it('nie myli adresu siedziby z lokalizacją inwestycji', () => {
    expect(TEMPLATE_HEADERS[map.unitRef!]).not.toMatch(/siedziby/);
  });
  it('nie zgłasza znanych, pomijanych kolumn', () => expect(unknown).toEqual([]));
  it('kolejność kolumn nie ma znaczenia', () => {
    const rev = [...TEMPLATE_HEADERS].reverse();
    const m = mapColumns(rev).map;
    expect(rev[m.priceM2!]).toMatch(/^Cena m 2/);
    expect(rev[m.priceTotal!]).toMatch(/iloczyn ceny m2/);
  });
});

const header = 'Nazwa dewelopera;Miejscowość lokalizacji przedsięwzięcia deweloperskiego;Rodzaj nieruchomości: lokal mieszkalny, dom jednorodzinny;Nr lokalu lub domu jednorodzinnego nadany przez dewelopera;Cena m 2 powierzchni użytkowej lokalu mieszkalnego / domu jednorodzinnego [zł];Cena lokalu mieszkalnego lub domu jednorodzinnego będących przedmiotem umowy stanowiąca iloczyn ceny m2 oraz powierzchni [zł];Status';

describe('cennik CSV', () => {
  it('czyta średnik, przecinek dziesiętny i X', () => {
    const t = readCsv(`${header}\nBRYKSY SP. Z O.O.;WARSZAWA;lokal mieszkalny;M22;14700,00;723240,00;dostępny\nBRYKSY SP. Z O.O.;WARSZAWA;dom jednorodzinny;D1;X;980000,00;X`);
    const r = toRecords(t);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ city: 'Warszawa', unitRef: 'M22', priceM2: 14700, priceTotal: 723240, area: 49.2, unitType: 'mieszkanie' });
    expect(r.rejected['brak ceny za m²']).toBe(1);
  });
  it('pomija sprzedane bez traktowania ich jako błąd', () => {
    const r = toRecords(readCsv(`${header}\nA;Łódź;lokal mieszkalny;1;9000;450000;sprzedany`));
    expect(r.records).toHaveLength(0);
    expect(r.sold).toBe(1);
    expect(Object.keys(r.rejected)).toHaveLength(0);
  });
  it('odrzuca nierealne ceny', () => {
    const r = toRecords(readCsv(`${header}\nA;Łódź;lokal mieszkalny;1;90;450000;`));
    expect(r.rejected['cena za m² poza zakresem']).toBe(1);
  });
  it('rozpoznaje przecinek jako separator', () => {
    const t = readCsv('Nazwa dewelopera,Miejscowość lokalizacji,Nr lokalu lub domu,Cena m2 powierzchni użytkowej,Cena lokalu stanowiąca iloczyn\nA,Kraków,5,"15000,5",750000');
    expect(toRecords(t).records[0].priceM2).toBe(15000.5);
  });
});

describe('cenniki XML i JSON', () => {
  it('XML z kluczami bez polskich znaków', () => {
    const xml = '<cennik><lokal><nazwaDewelopera>A</nazwaDewelopera><miejscowosc>Gdańsk</miejscowosc><nrLokalu>7</nrLokalu><cenaM2>14 000,00</cenaM2><cenaCalkowita>700000</cenaCalkowita></lokal><lokal><nazwaDewelopera>A</nazwaDewelopera><miejscowosc>Gdańsk</miejscowosc><nrLokalu>8</nrLokalu><cenaM2>13000</cenaM2><cenaCalkowita>650000</cenaCalkowita></lokal></cennik>';
    const r = toRecords(readXml(xml));
    expect(r.records.map((x) => x.priceM2)).toEqual([14000, 13000]);
  });
  it('JSON', () => {
    const r = toRecords(readJson(JSON.stringify({ data: [{ deweloper: 'A', miasto: 'Lublin', nr_lokalu: '1', cena_m2: 10000, powierzchnia: 50 }] })));
    expect(r.records[0]).toMatchObject({ city: 'Lublin', priceM2: 10000, area: 50, priceTotal: null });
  });
});
