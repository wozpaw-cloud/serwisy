// Źródło XML zbioru (format harwestera dane.gov.pl, urn:otwarte-dane:harvester).
//
// Część deweloperów nie wysyła plików do dane.gov.pl, tylko wystawia plik XML
// z listą swoich cenników; portal codziennie go czyta i zakłada z niego zasoby.
// Od 27.10.2026 portal przestał zakładać nowe zasoby z tych plików, choć sam plik
// XML dewelopera ma cenniki z każdego dnia (sprawdzone na ATAL, Murapol, YIT).
// Dlatego czytamy ten sam publiczny plik XML co portal, gdy portal jest w tyle.

import { XMLParser } from 'fast-xml-parser';
import { fold } from './normalize.ts';

export interface XmlResource { date: string; url: string }

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, removeNSPrefix: true,
  isArray: (name) => ['dataset', 'resource'].includes(name),
});

type Node = Record<string, unknown>;
const text = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') { const o = v as Node; return text(o['#text'] ?? o.polish ?? ''); }
  return String(v).trim();
};

/**
 * Cenniki zbioru z pliku XML, od najstarszego. Plik bywa wspólny dla kilku zbiorów
 * (np. kilka spółek jednego dewelopera): wtedy zbiór wybieramy po tytule.
 * Adres użyty dla kilku dat (stały plik nadpisywany codziennie) zostaje tylko
 * z najnowszą datą: pod takim adresem jest zawsze dzisiejszy cennik.
 */
export function xmlResources(xml: string, datasetTitle: string, today = new Date().toISOString().slice(0, 10)): XmlResource[] {
  let doc: Node;
  try { doc = parser.parse(xml) as Node; } catch { return []; }
  const datasets = ((doc.datasets as Node | undefined)?.dataset as Node[] | undefined) ?? [];
  const published = datasets.filter((d) => !d['@_status'] || d['@_status'] === 'published');
  const want = fold(datasetTitle);
  const ds = published.length === 1 ? published[0] : published.find((d) => fold(text((d.title as Node | undefined)?.polish ?? d.title)) === want);
  if (!ds) return [];
  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  const byUrl = new Map<string, string>();
  for (const r of ((ds.resources as Node | undefined)?.resource as Node[] | undefined) ?? []) {
    if (r['@_status'] && r['@_status'] !== 'published') continue;
    const url = text(r.url);
    const date = text(r.dataDate).slice(0, 10);
    if (!/^https?:\/\//.test(url) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > tomorrow) continue;
    if ((byUrl.get(url) ?? '') < date) byUrl.set(url, date);
  }
  return [...byUrl].map(([url, date]) => ({ date, url })).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Które nowsze cenniki wczytać, żeby obecność lokali się nie urwała: kolejne
 * wybrane cenniki dzielą najwyżej maxGap dni (próg ciągłości obecności w imporcie),
 * zawsze z najnowszym. Starsze niż window dni przed najnowszym pomijamy.
 */
export function gapPicks<T extends { date: string }>(newer: T[], since: string | null, maxGap = 4, window = 30): T[] {
  const xs = [...newer].sort((a, b) => a.date.localeCompare(b.date));
  if (!xs.length) return [];
  const newest = xs.at(-1)!.date;
  const from = addDays(newest, -window);
  // Zbiór bez wczytanego cennika albo z bardzo starym: tylko najnowszy (historię uzupełnia backfill).
  if (!since || since < from) return [xs.at(-1)!];
  const pool = xs.filter((x) => x.date > since);
  const out: T[] = [];
  let kept = since;
  for (let i = 0; i < pool.length; i++) {
    const next = pool[i + 1];
    if (!next || next.date > addDays(kept, maxGap)) { out.push(pool[i]); kept = pool[i].date; }
  }
  return out;
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
