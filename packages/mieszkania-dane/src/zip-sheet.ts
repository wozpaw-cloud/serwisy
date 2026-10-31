// Zapasowy odczyt arkuszy z plików ZIP: XLSX zapisanych przez nietypowe programy
// (ExcelJS kończy się wtedy błędem "reading 'sheets'") oraz arkuszy OpenDocument (.ods),
// które deweloperzy wysyłają z LibreOffice. Zwraca wiersze każdego arkusza po kolei.

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

type Rows = unknown[][];
type Node = Record<string, unknown>;

const arr = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

const plain = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: false, removeNSPrefix: true });

/** Tekst węzła XML (z zagnieżdżeniami, np. <r><t>…</t></r> albo <text:span>). */
function textOf(n: unknown): string {
  if (n === undefined || n === null) return '';
  if (typeof n !== 'object') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  const o = n as Node;
  let out = '';
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('@_')) continue;
    if (k === 's') { out += ' '.repeat(Number((v as Node)?.['@_c'] ?? 1) || 1); continue; } // <text:s/> = spacje
    if (k === 'rPh' || k === 'phoneticPr') continue; // fonetyka w XLSX
    out += textOf(v);
  }
  return out;
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

const norm = (p: string) => p.replace(/^\/+/, '').replace(/\/[^/]+\/\.\.\//g, '/');

function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return norm(target);
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  const parts = (dir + target).split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
  return out.join('/');
}

/** Plik w archiwum bez względu na wielkość liter w ścieżce. */
function file(zip: JSZip, path: string) {
  const want = norm(path).toLowerCase();
  return Object.values(zip.files).find((f) => !f.dir && norm(f.name).toLowerCase() === want) ?? null;
}

async function xml(zip: JSZip, path: string): Promise<Node | null> {
  const f = file(zip, path);
  return f ? (plain.parse(await f.async('string')) as Node) : null;
}

async function readXlsxZip(zip: JSZip): Promise<Rows[]> {
  // Główny skoroszyt wskazuje _rels/.rels (zwykle xl/workbook.xml, ale bywa inaczej).
  const rootRels = await xml(zip, '_rels/.rels');
  const wbRel = arr((rootRels?.Relationships as Node)?.Relationship as Node[]).find((r) => String(r['@_Type'] ?? '').endsWith('/officeDocument'));
  const wbPath = wbRel ? norm(String(wbRel['@_Target'])) : (Object.keys(zip.files).find((n) => /workbook\d*\.xml$/i.test(n)) ?? 'xl/workbook.xml');
  const wb = await xml(zip, wbPath);
  if (!wb) return [];
  const relsPath = resolve(wbPath, `_rels/${wbPath.split('/').pop()}.rels`);
  const rels = arr(((await xml(zip, relsPath))?.Relationships as Node)?.Relationship as Node[]);
  const target = (id: string) => { const r = rels.find((x) => x['@_Id'] === id); return r ? resolve(wbPath, String(r['@_Target'])) : null; };

  const ssRel = rels.find((r) => String(r['@_Type'] ?? '').endsWith('/sharedStrings'));
  const ssDoc = ssRel ? await xml(zip, resolve(wbPath, String(ssRel['@_Target']))) : null;
  const shared = arr((ssDoc?.sst as Node)?.si as unknown[]).map(textOf);

  const sheets = arr(((wb.workbook as Node)?.sheets as Node)?.sheet as Node[]);
  const paths = sheets.map((s) => target(String(s['@_id'] ?? s['@_r:id'] ?? ''))).filter((p): p is string => !!p);
  if (!paths.length) paths.push(...Object.keys(zip.files).filter((n) => /worksheets\/sheet\d*\.xml$/i.test(n)).sort());

  const out: Rows[] = [];
  for (const p of paths) {
    const doc = await xml(zip, p);
    const rowsXml = arr(((doc?.worksheet as Node)?.sheetData as Node)?.row as Node[]);
    const rows: Rows = [];
    for (const r of rowsXml) {
      const vals: unknown[] = [];
      let next = 0;
      for (const c of arr(r.c as Node[])) {
        const ref = String(c['@_r'] ?? '');
        const i = ref ? colIndex(ref) : next;
        next = i + 1;
        const t = String(c['@_t'] ?? 'n');
        const v = textOf(c.v);
        let val: unknown;
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = textOf(c.is);
        else if (t === 'str' || t === 'e') val = t === 'e' ? null : v;
        else if (t === 'b') val = v === '1';
        else val = v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : v;
        vals[i] = val;
      }
      if (vals.some((x) => x !== undefined && x !== null && x !== '')) rows.push(Array.from(vals, (x) => x ?? null));
    }
    out.push(rows);
  }
  return out;
}

// OpenDocument: komórki i wiersze bywają "powtórzone" (number-columns-repeated), często
// tysiące pustych na końcu arkusza; puste powtórzenia przycinamy.
const odsParser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: false, removeNSPrefix: true,
  isArray: (name) => ['table', 'table-row', 'table-cell', 'covered-table-cell', 'p', 'table-row-group', 'table-header-rows'].includes(name),
});

async function readOdsZip(zip: JSZip): Promise<Rows[]> {
  const f = file(zip, 'content.xml');
  if (!f) return [];
  const doc = odsParser.parse(await f.async('string')) as Node;
  const sheet = ((doc['document-content'] as Node)?.body as Node)?.spreadsheet as Node;
  const out: Rows[] = [];
  for (const table of arr(sheet?.table as Node[])) {
    const rowNodes: Node[] = [...arr(table['table-header-rows'] as Node[]).flatMap((g) => arr(g['table-row'] as Node[])),
      ...arr(table['table-row'] as Node[]), ...arr(table['table-row-group'] as Node[]).flatMap((g) => arr(g['table-row'] as Node[]))];
    const rows: Rows = [];
    for (const r of rowNodes) {
      const vals: unknown[] = [];
      // Komórki scalone (covered) parser zwraca osobno; w cennikach prawie nie występują.
      for (const c of arr(r['table-cell'] as Node[])) {
        const type = String(c['@_value-type'] ?? '');
        let val: unknown = null;
        if (['float', 'percentage', 'currency'].includes(type)) val = Number(c['@_value']);
        else if (type === 'date') val = String(c['@_date-value'] ?? '').slice(0, 10);
        else if (type === 'boolean') val = String(c['@_boolean-value']) === 'true';
        else val = arr(c.p as unknown[]).map(textOf).join('\n') || null;
        const rep = Math.max(1, Number(c['@_number-columns-repeated'] ?? 1) || 1);
        const n = val === null || val === '' ? Math.min(rep, 64) : Math.min(rep, 1000);
        for (let k = 0; k < n; k++) vals.push(val);
      }
      while (vals.length && (vals.at(-1) === null || vals.at(-1) === '')) vals.pop();
      if (!vals.length) continue;
      const rep = Math.min(Math.max(1, Number(r['@_number-rows-repeated'] ?? 1) || 1), 1000);
      for (let k = 0; k < rep; k++) rows.push(vals);
    }
    out.push(rows);
  }
  return out;
}

/** Wszystkie arkusze pliku ZIP (XLSX albo ODS) jako tablice wierszy. */
export async function readZipSheets(buf: Buffer): Promise<Rows[]> {
  const zip = await JSZip.loadAsync(buf);
  const mime = file(zip, 'mimetype');
  if (mime && (await mime.async('string')).includes('opendocument')) return readOdsZip(zip);
  if (file(zip, 'content.xml') && !file(zip, '[Content_Types].xml')) return readOdsZip(zip);
  return readXlsxZip(zip);
}
