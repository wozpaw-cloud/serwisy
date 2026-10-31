// Warianty plików z prawdziwych cenników (październik 2026): kodowanie, twarde spacje,
// nagłówki po angielsku, "nr mieszkania", najniższa cena z 30 dni, przyległości.

import { describe, expect, it } from 'vitest';
import { decode, parseFile, readCsv, repairMojibake, toRecords } from '../src/parse.ts';

const cp1250 = (s: string) => {
  const d = new TextDecoder('windows-1250');
  const map = new Map<string, number>();
  for (let b = 0; b < 256; b++) map.set(d.decode(Uint8Array.of(b)), b);
  return Buffer.from([...s].map((c) => map.get(c) ?? 63));
};

describe('kodowanie', () => {
  it('naprawia UTF-8 odczytany jako Windows-1250', () => {
    expect(repairMojibake('WojewĂłdztwo; uwzglÄ™dniajÄ…ca; dziaĹ‚alnoĹ›ci')).toBe('Województwo; uwzględniająca; działalności');
  });
  it('plik Windows-1250', () => {
    expect(decode(cp1250('Miejscowość;Cena za m2\nŁódź;12000'))).toBe('Miejscowość;Cena za m2\nŁódź;12000');
  });
  it('plik UTF-8 z jednym błędnym bajtem zostaje w UTF-8', () => {
    const buf = Buffer.concat([Buffer.from('Miejscowość;Województwo;Gdańsk;Kraków;Łódź '), Buffer.from([0xff]), Buffer.from(' żółć')]);
    expect(decode(buf)).toMatch(/^Miejscowość;Województwo;Gdańsk;Kraków;Łódź .* żółć$/);
  });
  it('poprawny polski tekst bez zmian', () => {
    const t = 'Zażółć gęślą jaźń. Ĺódź? Ăł'; // pojedyncze podobne znaki to nie krzaki
    expect(repairMojibake(t)).toBe(t);
  });
});

describe('nagłówki', () => {
  it('twarde spacje i kolumna "Number"', () => {
    const csv = ['Nazwa dewelopera;Miejscowość lokalizacji przedsięwzięcia deweloperskiego;Inwestycja;Number;Cena za dom;Cena za m2;Status',
      'Dom Sp. z o.o.;Kórnik;Osiedle;D1;850000;8500;dostępny'].join('\n');
    const p = toRecords(readCsv(csv));
    expect(p.missingColumns).toEqual([]);
    expect(p.records[0]).toMatchObject({ city: 'Kórnik', unitRef: 'D1', priceM2: 8500, priceTotal: 850000 });
  });
  it('"nr mieszkania", "m2" i najniższa cena z 30 dni', () => {
    const csv = ['lp.;inwestycja;miasto;ulica nr;nr mieszkania;Nr katalogowy;m2;Piętro;cena brutto z ostatnich 30 dni;cena brutto za m2 z ostatnich 30 dni;cena brutto;cena brutto za m2;status',
      '1;Park;Katowice;Medyków 34;M12;K-12;54,2;3;600000;11070;580000;10701;wolne'].join('\n');
    const p = toRecords(readCsv(csv), 'csv', { devFallback: 'Atrapa' });
    expect(p.missingColumns).toEqual([]);
    expect(p.records[0]).toMatchObject({ unitRef: 'M12', area: 54.2, priceTotal: 580000, priceM2: 10701 });
  });
  it('plik samych przyległości nie daje lokali', () => {
    const csv = ['lp.;inwestycja;miasto;ulica nr;Numer katalogowy;Rodzaj przyległości;m2;cena brutto;cena brutto za m2',
      '1;Park;Katowice;Medyków 34;0.R10;Boks rowerowy;4,17;15762;3780', '2;Park;Katowice;Medyków 34;G7;Miejsce postojowe w garażu;18;60000;3333'].join('\n');
    expect(toRecords(readCsv(csv), 'csv', { devFallback: 'Atrapa' }).records).toHaveLength(0);
  });
  it('eksport z kluczami po angielsku (JSON)', async () => {
    const json = JSON.stringify([
      { propertyId: 1, type: 'Flat', number: 'A/12', price: 650000, area: 50, pricePerMeter: 13000, fullAddress: 'ul. Długa 5, 61-001 Poznań', isSold: false, totalPrice: 650000 },
      { propertyId: 2, type: 'Flat', number: 'A/13', price: 700000, area: 52, pricePerMeter: 13461, fullAddress: 'ul. Długa 5, 61-001 Poznań', isSold: true, totalPrice: 700000 },
      { propertyId: 3, type: 'Garage', number: 'G1', price: 40000, area: 18, pricePerMeter: 2222, fullAddress: 'ul. Długa 5, 61-001 Poznań', isSold: false, totalPrice: 40000 },
    ]);
    const p = await parseFile(Buffer.from(json), 'json', { devFallback: 'Atrapa' });
    expect(p.missingColumns).toEqual([]);
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({ unitRef: 'A/12', priceM2: 13000, area: 50, city: 'Poznań' });
    expect(p.sold).toBe(1);
  });
});
