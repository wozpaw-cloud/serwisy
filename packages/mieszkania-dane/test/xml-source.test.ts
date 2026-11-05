// Plik XML dewelopera (format harwestera dane.gov.pl): wybór zbioru, dat i adresów.
import { describe, expect, it } from 'vitest';
import { gapPicks, xmlResources } from '../src/xml-source.ts';

const res = (date: string, url: string, status = 'published') => `
      <resource status="${status}"><extIdent>x_${date}</extIdent><url>${url}</url>
        <title><polish>Ceny ${date}</polish></title><dataDate>${date}</dataDate></resource>`;
const ds = (title: string, resources: string) => `
  <dataset status="published" xmlns=""><extIdent>0x1</extIdent><title><polish>${title}</polish><english>x</english></title>
    <resources>${resources}</resources></dataset>`;
const xml = (...datasets: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<datasets xmlns="urn:otwarte-dane:harvester:1.13">${datasets.join('')}</datasets>`;

describe('xmlResources', () => {
  it('jeden zbiór w pliku: wszystkie opublikowane cenniki od najstarszego', () => {
    const x = xml(ds('Ceny ofertowe mieszkań dewelopera A w 2026 r.', res('2026-11-02', 'https://a.pl/2.xlsx') + res('2026-11-01', 'https://a.pl/1.xlsx') + res('2026-11-03', 'https://a.pl/3.xlsx', 'draft')));
    expect(xmlResources(x, 'cokolwiek', '2026-11-05')).toEqual([{ date: '2026-11-01', url: 'https://a.pl/1.xlsx' }, { date: '2026-11-02', url: 'https://a.pl/2.xlsx' }]);
  });
  it('kilka zbiorów w pliku: wybiera po tytule', () => {
    const x = xml(ds('Ceny ofertowe mieszkań dewelopera A Sp. z o.o.', res('2026-11-01', 'https://a.pl/a.csv')),
      ds('Ceny ofertowe mieszkań dewelopera B Sp. z o.o.', res('2026-11-02', 'https://a.pl/b.csv')));
    expect(xmlResources(x, 'Ceny ofertowe mieszkań dewelopera B Sp. z o.o.', '2026-11-05').map((r) => r.url)).toEqual(['https://a.pl/b.csv']);
    expect(xmlResources(x, 'Ceny ofertowe mieszkań dewelopera C', '2026-11-05')).toEqual([]);
  });
  it('stały adres nadpisywany codziennie: tylko z najnowszą datą; bez dat z przyszłości', () => {
    const x = xml(ds('A', res('2026-11-01', 'https://a.pl/ceny.csv') + res('2026-11-04', 'https://a.pl/ceny.csv') + res('2029-01-01', 'https://a.pl/x.csv')));
    expect(xmlResources(x, 'A', '2026-11-05')).toEqual([{ date: '2026-11-04', url: 'https://a.pl/ceny.csv' }]);
  });
  it('uszkodzony plik nie wywraca importu', () => {
    expect(xmlResources('<datasets><dataset>', 'A')).toEqual([]);
    expect(xmlResources('to nie jest xml', 'A')).toEqual([]);
  });
});

describe('gapPicks', () => {
  const daily = (from: string, n: number) => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10) }));
  it('przerwa od 26.10: cenniki co najwyżej co 4 dni, zawsze z najnowszym', () => {
    expect(gapPicks(daily('2026-10-27', 10), '2026-10-26').map((x) => x.date)).toEqual(['2026-10-30', '2026-11-03', '2026-11-05']);
  });
  it('jeden dzień przerwy: tylko najnowszy', () => {
    expect(gapPicks(daily('2026-11-05', 1), '2026-11-04').map((x) => x.date)).toEqual(['2026-11-05']);
  });
  it('zbiór bez historii albo z bardzo starą: tylko najnowszy', () => {
    expect(gapPicks(daily('2026-10-27', 10), null).map((x) => x.date)).toEqual(['2026-11-05']);
    expect(gapPicks(daily('2026-10-27', 10), '2026-08-01').map((x) => x.date)).toEqual(['2026-11-05']);
  });
  it('nieregularne daty: przerwy nie dłuższe niż to konieczne', () => {
    const xs = ['2026-10-28', '2026-11-04', '2026-11-05'].map((date) => ({ date }));
    expect(gapPicks(xs, '2026-10-26').map((x) => x.date)).toEqual(['2026-10-28', '2026-11-04', '2026-11-05']);
  });
});
