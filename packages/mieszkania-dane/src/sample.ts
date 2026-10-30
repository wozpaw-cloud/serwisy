// Generator DANYCH PRZYKŁADOWYCH do podglądu i testów.
//
// Pliki mają układ wzorcowego cennika (średnik, przecinek dziesiętny, "X" dla
// pól nie dotyczących, data z godziną), więc przechodzą przez ten sam importer
// co prawdziwe dane. Deweloperzy i inwestycje są fikcyjne, a strony mają domenę
// .example. Na serwisie zbudowanym z tych danych widać baner "dane przykładowe".

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { addDays } from './ingest.ts';

export const TEMPLATE_HEADERS = [
  'Nazwa dewelopera', 'Forma prawna dewelopera', 'Nr KRS', 'Nr wpisu do CEiDG', 'Nr NIP', 'Nr REGON',
  'Nr telefonu', 'Adres poczty elektronicznej', 'Nr faxu', 'Adres strony internetowej dewelopera',
  'Województwo adresu siedziby/głównego miejsca wykonywania działalności gospodarczej dewelopera',
  'Powiat adresu siedziby/głównego miejsca wykonywania działalności gospodarczej dewelopera',
  'Gmina adresu siedziby/głównego miejsca wykonywania działalności gospodarczej dewelopera',
  'Miejscowość adresu siedziby/głównego miejsca wykonywania działalności gospodarczej dewelopera',
  'Ulica adresu siedziby/głównego miejsca wykonywania działalności gospodarczej dewelopera',
  'Nr nieruchomości adresu siedziby/głównego miejsca wykonywania działalności gospodarczej dewelopera',
  'Nr lokalu adresu siedziby/głównego miejsca wykonywania działalności gospodarczej dewelopera',
  'Kod pocztowy adresu siedziby/głównego miejsca wykonywania działalności gospodarczej dewelopera',
  'Miejsca prowadzenia sprzedaży',
  'Województwo lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Powiat lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Gmina lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Miejscowość lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Ulica lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Nr nieruchomości lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Kod pocztowy lokalizacji przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Nazwa przedsięwzięcia deweloperskiego lub zadania inwestycyjnego',
  'Rodzaj nieruchomości: lokal mieszkalny, dom jednorodzinny',
  'Nr lokalu lub domu jednorodzinnego nadany przez dewelopera',
  'Powierzchnia użytkowa lokalu mieszkalnego / domu jednorodzinnego [m2]',
  'Cena m 2 powierzchni użytkowej lokalu mieszkalnego / domu jednorodzinnego [zł]',
  'Data od której obowiązuje cena m 2 powierzchni użytkowej lokalu mieszkalnego / domu jednorodzinnego',
  'Cena lokalu mieszkalnego lub domu jednorodzinnego będących przedmiotem umowy stanowiąca iloczyn ceny m2 oraz powierzchni [zł]',
  'Data od której obowiązuje cena lokalu mieszkalnego lub domu jednorodzinnego będących przedmiotem umowy stanowiąca iloczyn ceny m2 oraz powierzchni',
  'Cena lokalu mieszkalnego lub domu jednorodzinnego uwzględniająca cenę lokalu stanowiącą iloczyn powierzchni oraz metrażu i innych składowych ceny [zł]',
  'Data od której obowiązuje cena lokalu mieszkalnego lub domu jednorodzinnego uwzględniająca cenę lokalu stanowiącą iloczyn powierzchni oraz metrażu i innych składowych ceny',
  'Rodzaj części nieruchomości będących przedmiotem umowy',
  'Oznaczenie części nieruchomości nadane przez dewelopera',
  'Cena części nieruchomości, będących przedmiotem umowy [zł]',
  'Rodzaj pomieszczeń przynależnych',
  'Wyszczególnienie cen pomieszczeń przynależnych [zł]',
  'Wyszczególnienie praw niezbędnych do korzystania z lokalu mieszkalnego lub domu jednorodzinnego',
  'Wartość praw niezbędnych do korzystania z lokalu mieszkalnego lub domu jednorodzinnego [zł]',
  'Wyszczególnienie rodzajów innych świadczeń pieniężnych, które nabywca zobowiązany jest spełnić na rzecz dewelopera',
  'Wartość innych świadczeń pieniężnych [zł]',
  'Adres strony internetowej, pod którym dostępny jest prospekt informacyjny',
  'Status lokalu',
];

// ---------- losowość powtarzalna ----------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Każdy deweloper losuje ze swojego generatora (głównego albo własnego). Dzięki temu
// dopisanie nowego dewelopera nie zmienia danych pozostałych.
const mainRand = rng(20251111);
let current = mainRand;
const rand = () => current();
const between = (a: number, b: number) => a + (b - a) * rand();
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const normal = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());

interface City { name: string; voiv: string; county: string; gmina: string; postal: string; base: number; trend: number; houses: number }

// Poziomy i trendy cen są zmyślone. Służą tylko do pokazania, jak działają wykresy.
const CITIES: City[] = [
  { name: 'Warszawa', voiv: 'mazowieckie', county: 'Warszawa', gmina: 'Warszawa', postal: '02', base: 17200, trend: 0.0050, houses: 0 },
  { name: 'Kraków', voiv: 'małopolskie', county: 'Kraków', gmina: 'Kraków', postal: '30', base: 16300, trend: 0.0040, houses: 0 },
  { name: 'Wrocław', voiv: 'dolnośląskie', county: 'Wrocław', gmina: 'Wrocław', postal: '53', base: 13800, trend: 0.0010, houses: 0 },
  { name: 'Gdańsk', voiv: 'pomorskie', county: 'Gdańsk', gmina: 'Gdańsk', postal: '80', base: 14800, trend: 0.0045, houses: 0 },
  { name: 'Poznań', voiv: 'wielkopolskie', county: 'Poznań', gmina: 'Poznań', postal: '60', base: 11600, trend: 0.0025, houses: 0 },
  { name: 'Łódź', voiv: 'łódzkie', county: 'Łódź', gmina: 'Łódź', postal: '90', base: 9200, trend: -0.0030, houses: 0 },
  { name: 'Katowice', voiv: 'śląskie', county: 'Katowice', gmina: 'Katowice', postal: '40', base: 10100, trend: 0.0005, houses: 0 },
  { name: 'Lublin', voiv: 'lubelskie', county: 'Lublin', gmina: 'Lublin', postal: '20', base: 10600, trend: 0.0030, houses: 0 },
  { name: 'Szczecin', voiv: 'zachodniopomorskie', county: 'Szczecin', gmina: 'Szczecin', postal: '70', base: 10200, trend: -0.0020, houses: 0 },
  { name: 'Białystok', voiv: 'podlaskie', county: 'Białystok', gmina: 'Białystok', postal: '15', base: 9600, trend: 0.0025, houses: 0 },
  { name: 'Komorniki', voiv: 'wielkopolskie', county: 'poznański', gmina: 'Komorniki', postal: '62', base: 8300, trend: 0.0010, houses: 0.8 },
  { name: 'Ząbki', voiv: 'mazowieckie', county: 'wołomiński', gmina: 'Ząbki', postal: '05', base: 10900, trend: 0.0018, houses: 0.4 },
  { name: 'Wieliczka', voiv: 'małopolskie', county: 'wielicki', gmina: 'Wieliczka', postal: '32', base: 9900, trend: 0.0012, houses: 0.7 },
];

// Wsie podmiejskie i dzielnica Warszawy: różne zapisy gminy i powiatu, jak w prawdziwych cennikach.
const SUBURBS: City[] = [
  { name: 'Plewiska', voiv: 'wielkopolskie', county: 'Powiat poznański', gmina: 'Gmina Komorniki', postal: '62', base: 8700, trend: 0.0015, houses: 0.3 },
  { name: 'Skórzewo', voiv: 'wielkopolskie', county: 'poznański', gmina: 'Dopiewo', postal: '60', base: 9000, trend: 0.0020, houses: 0.35 },
  { name: 'Dąbrowa', voiv: 'wielkopolskie', county: 'POZNAŃSKI', gmina: 'gm. Dopiewo', postal: '62', base: 8100, trend: 0.0012, houses: 0.75 },
  { name: 'Warszawa', voiv: 'mazowieckie', county: 'm. st. Warszawa', gmina: 'Białołęka', postal: '03', base: 12900, trend: 0.0035, houses: 0 },
];

const BRANDS = ['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Jota', 'Kappa', 'Lambda', 'Omikron', 'Sigma', 'Tau'];
const INVESTMENT_NAMES = [
  'Osiedle Pod Klonami', 'Apartamenty Nadrzeczne', 'Zielone Tarasy', 'Kwartał Ceglany', 'Ogrody Wschodnie',
  'Lofty przy Torach', 'Dom przy Lesie', 'Osiedle Słoneczne Wzgórze', 'Nowa Przędzalnia', 'Park Jesionowy',
  'Willa Miejska', 'Rezydencja Lipowa', 'Brzozowy Zakątek', 'Kamienica Nowa', 'Osiedle Pod Sosnami',
  'Tarasy Zachodnie', 'Stara Garbarnia', 'Domy na Skraju', 'Port Mieszkalny', 'Ogrody Południowe',
  'Kwartał Zegarmistrzów', 'Wzgórze Lawendowe', 'Osiedle Przy Parku', 'Apartamenty Bulwarowe',
  'Zielony Dziedziniec', 'Sady Miejskie', 'Domy pod Lasem', 'Nadwiślańska Przystań', 'Fabryka Światła',
  'Osiedle Wrzosowe', 'Jasne Kamienice', 'Ogrody Klasztorne', 'Dębowe Siedlisko', 'Kwartał Bursztynowy',
  'Osiedle Grabowe', 'Apartamenty Kasztanowe', 'Nowe Błonia', 'Domy przy Stawach', 'Tarasy nad Parkiem',
  'Kwartał Tkaczy', 'Osiedle Modrzewiowe', 'Rezydencja Wiśniowa', 'Dziedziniec Zielony', 'Ogrody Północne',
  'Kamienica pod Zegarem', 'Osiedle Jaskółcze', 'Wzgórze Akacjowe', 'Domy w Sadzie', 'Bulwar Rzemieślniczy',
];
const STREETS = ['Klonowa', 'Rzeczna', 'Ogrodowa', 'Ceglana', 'Wschodnia', 'Kolejowa', 'Leśna', 'Słoneczna', 'Przędzalniana',
  'Jesionowa', 'Miejska', 'Lipowa', 'Brzozowa', 'Nowa', 'Sosnowa', 'Zachodnia', 'Garbarska', 'Polna', 'Portowa', 'Południowa'];

interface Unit { ref: string; type: 'lokal mieszkalny' | 'dom jednorodzinny'; area: number; priceM2: number; changed: string; status: 'dostępny' | 'zarezerwowany'; sold: boolean }
interface Investment { name: string; city: City; street: string; no: string; launchWeek: number; premium: number; units: Unit[]; lastRepriceWeek: number }
interface Developer { rng: () => number; legalName: string; nip: string; krs: string; website: string; datasetId: string; format: 'csv' | 'xlsx'; keepsSoldRows: boolean; missWeeks: Set<number>; investments: Investment[] }

function areaFor(type: Unit['type']): number {
  if (type === 'dom jednorodzinny') return Math.round(between(92, 175) * 100) / 100;
  const a = 52 * Math.exp(0.32 * normal());
  return Math.round(Math.min(118, Math.max(26, a)) * 100) / 100;
}

function stamp(iso: string, hour = 2): string {
  return `${iso} ${String(hour).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}`;
}

function buildWorld(start: string): Developer[] {
  const devs: Developer[] = [];
  let invNo = 0;
  BRANDS.forEach((brand, bi) => {
    // Dwie marki działają przez kilka spółek celowych ze wspólną stroną www.
    const spvCount = bi === 1 ? 2 : bi === 4 ? 3 : 1;
    for (let s = 0; s < spvCount; s++) {
      const legalName = spvCount > 1
        ? `${brand.toUpperCase()} PRZYKŁAD PROJEKT ${s + 1} SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ`
        : `${brand} Przykład Deweloper sp. z o.o.`;
      const dev: Developer = {
        rng: mainRand,
        legalName,
        nip: String(9000000000 + bi * 1000 + s),
        krs: String(900000 + bi * 10 + s).padStart(10, '0'),
        website: `https://www.${brand.toLowerCase()}.przyklad.example`,
        datasetId: `PRZYKLAD_${brand.toUpperCase()}_${s + 1}`,
        format: bi === 6 ? 'xlsx' : 'csv',
        keepsSoldRows: bi % 3 === 0,
        missWeeks: new Set(bi === 2 ? [17, 18] : bi === 7 ? [33] : []),
        investments: [],
      };
      const nInv = 2 + Math.floor(rand() * 3);
      for (let k = 0; k < nInv; k++) {
        const city = bi === 9 && k === 0 ? CITIES[10] : pick(CITIES);
        const name = INVESTMENT_NAMES[invNo++ % INVESTMENT_NAMES.length];
        const houses = name.startsWith('Dom') ? 1 : city.houses;
        dev.investments.push(makeInvestment(name, city, houses, start));
      }
      devs.push(dev);
    }
  });

  // Deweloper z inwestycjami we wsiach pod Poznaniem i w dzielnicy Warszawy. Pola
  // adresowe celowo zapisane różnie, jak w prawdziwych cennikach, żeby sprawdzić
  // łączenie w gminy. Własny generator: nie zmienia danych pozostałych deweloperów.
  current = rng(20261030);
  const ypsilon: Developer = {
    rng: current,
    legalName: 'YPSILON PRZYKŁAD DEWELOPER SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
    nip: String(9000000000 + BRANDS.length * 1000), krs: String(900000 + BRANDS.length * 10).padStart(10, '0'),
    website: 'https://www.ypsilon.przyklad.example', datasetId: 'PRZYKLAD_YPSILON_1', format: 'csv',
    keepsSoldRows: false, missWeeks: new Set(), investments: [],
  };
  const plan: [string, City][] = [
    ['Osiedle Wierzbowe', SUBURBS[0]], ['Łąki Zachodnie', SUBURBS[0]], ['Polana Sosnowa', SUBURBS[1]],
    ['Ogrody nad Stawem', SUBURBS[2]], ['Kwartał Rzemieślniczy', SUBURBS[3]],
  ];
  for (const [name, city] of plan) ypsilon.investments.push(makeInvestment(name, city, city.houses, start));
  devs.push(ypsilon);
  current = mainRand;
  return devs;
}

function makeInvestment(name: string, city: City, houses: number, start: string): Investment {
  const inv: Investment = {
    name, city, street: pick(STREETS), no: String(1 + Math.floor(rand() * 60)),
    launchWeek: rand() < 0.55 ? 0 : Math.floor(between(3, 57)),
    premium: between(0.86, 1.22), units: [], lastRepriceWeek: 0,
  };
  const n = houses >= 0.7 ? Math.floor(between(10, 26)) : Math.floor(between(30, 90));
  for (let u = 0; u < n; u++) {
    const type: Unit['type'] = rand() < houses ? 'dom jednorodzinny' : 'lokal mieszkalny';
    const area = areaFor(type);
    const sizeFactor = type === 'dom jednorodzinny' ? 0.92 : 1 + 0.22 * Math.max(-0.6, Math.min(0.6, (50 - area) / 50));
    const priceM2 = Math.round(city.base * inv.premium * sizeFactor * (1 + 0.035 * normal()) / 10) * 10;
    inv.units.push({
      ref: type === 'dom jednorodzinny' ? `D${u + 1}` : `${String.fromCharCode(65 + (u % 3))}${Math.floor(u / 3) + 1}`,
      type, area, priceM2, changed: stamp(addDays(start, -Math.floor(between(1, 40)))),
      status: 'dostępny', sold: false,
    });
  }
  return inv;
}

function step(devs: Developer[], week: number, date: string) {
  for (const dev of devs) {
    current = dev.rng;
    stepDeveloper(dev, week, date);
  }
  current = mainRand;
}

function stepDeveloper(dev: Developer, week: number, date: string) {
  for (const inv of dev.investments) {
    if (week < inv.launchWeek) continue;
    // Okresowe przecenienie całej inwestycji zgodnie z trendem miasta.
    if (week > inv.launchWeek && rand() < 0.09) {
      const weeks = week - Math.max(inv.lastRepriceWeek, inv.launchWeek);
      const factor = 1 + inv.city.trend * (weeks / 4.35) + 0.006 * normal();
      for (const u of inv.units) if (!u.sold) {
        u.priceM2 = Math.round((u.priceM2 * factor) / 10) * 10;
        u.changed = stamp(addDays(date, -Math.floor(rand() * 6)));
      }
      inv.lastRepriceWeek = week;
    }
    for (const u of inv.units) {
      if (u.sold) continue;
      const age = week - inv.launchWeek;
      const saleP = 0.0075 * (u.area < 45 ? 1.4 : u.area > 80 ? 0.7 : 1) * (u.status === 'zarezerwowany' ? 3 : 1);
      if (rand() < saleP) { u.sold = true; continue; }
      if (rand() < 0.03) u.status = u.status === 'dostępny' ? 'zarezerwowany' : 'dostępny';
      // Pojedyncze obniżki, częstsze przy lokalach długo wiszących w ofercie.
      if (rand() < 0.003 + age * 0.00008) {
        u.priceM2 = Math.round((u.priceM2 * (1 - between(0.025, 0.11))) / 10) * 10;
        u.changed = stamp(addDays(date, -Math.floor(rand() * 6)));
      }
    }
  }
}

function rowFor(dev: Developer, inv: Investment, u: Unit, week: number): string[] {
  const X = 'X';
  const total = Math.round(u.priceM2 * u.area);
  const parking = rand() < 0.5;
  const priceM2 = week === 23 && dev.datasetId.endsWith('ZETA_1') && u.ref.startsWith('A') ? X : u.priceM2.toFixed(2).replace('.', ',');
  return [
    dev.legalName, 'spółka z ograniczoną odpowiedzialnością', dev.krs, X, dev.nip, X,
    '+48 600 000 000', `biuro@${dev.website.replace('https://www.', '')}`, X, dev.website,
    inv.city.voiv, inv.city.county, inv.city.gmina, inv.city.name, 'Przykładowa', '1', X, `${inv.city.postal}-001`,
    `ul. ${inv.street} ${inv.no}, ${inv.city.name}`,
    inv.city.voiv.toUpperCase(), inv.city.county, inv.city.gmina, inv.city.name.toUpperCase(), inv.street, inv.no, `${inv.city.postal}-${String(100 + inv.no.length * 7).padStart(3, '0')}`,
    inv.name, u.type, u.ref, u.area.toFixed(2).replace('.', ','),
    priceM2, u.changed,
    String(total) + ',00', u.changed,
    String(total + (parking ? 45000 : 0)) + ',00', u.changed,
    parking ? 'miejsce postojowe' : X, parking ? `MP-${u.ref}` : X, parking ? '45000,00' : X,
    X, X, X, X, X, X,
    `${dev.website}/prospekt/${inv.name.toLowerCase().replace(/\s+/g, '-')}.pdf`,
    u.sold ? 'sprzedany' : u.status,
  ];
}

function csvLine(cells: string[]): string {
  return cells.map((c) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(';');
}

export async function generateSample(outDir: string, opts = { start: '2025-09-11', weeks: 60 }) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const devs = buildWorld(opts.start);
  const manifest: { datasetId: string; title: string; date: string; file: string; format: string }[] = [];
  for (let w = 0; w < opts.weeks; w++) {
    const date = addDays(opts.start, w * 7);
    step(devs, w, date);
    for (const dev of devs) {
      current = dev.rng;
      if (dev.missWeeks.has(w)) continue;
      const rows: string[][] = [];
      for (const inv of dev.investments) {
        if (w < inv.launchWeek) continue;
        for (const u of inv.units) if (!u.sold || (dev.keepsSoldRows && rand() < 0.5)) rows.push(rowFor(dev, inv, u, w));
      }
      if (!rows.length) continue;
      const dir = join(outDir, dev.datasetId);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${date}.${dev.format}`);
      if (dev.format === 'xlsx') {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Cennik');
        ws.addRow(TEMPLATE_HEADERS);
        rows.forEach((r) => ws.addRow(r));
        await wb.xlsx.writeFile(file);
      } else {
        writeFileSync(file, '﻿' + [TEMPLATE_HEADERS, ...rows].map(csvLine).join('\r\n'), 'utf8');
      }
      manifest.push({ datasetId: dev.datasetId, title: `Ceny ofertowe mieszkań dewelopera ${dev.legalName}`, date, file, format: dev.format });
    }
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}
