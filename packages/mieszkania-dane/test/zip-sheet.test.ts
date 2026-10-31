// Zapasowy odczyt arkuszy: XLSX z nietypowymi ścieżkami (ExcelJS: "reading 'sheets'")
// i arkusze OpenDocument (.ods) z LibreOffice.

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../src/parse.ts';

const HEAD = ['Nazwa dewelopera', 'Miejscowość lokalizacji przedsięwzięcia deweloperskiego', 'Nr lokalu lub domu jednorodzinnego nadany przez dewelopera', 'Cena m 2 powierzchni użytkowej lokalu mieszkalnego / domu jednorodzinnego [zł]', 'Powierzchnia użytkowa'];
const ROW = ['Atrapa Sp. z o.o.', 'Gdańsk', 'A/1', 13450, 48.5];

async function oddXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  const strings = [...HEAD, 'Atrapa Sp. z o.o.', 'Gdańsk', 'A/1'];
  const col = (i: number) => String.fromCharCode(65 + i);
  const cells = (vals: (string | number)[], r: number) => vals.map((v, i) => typeof v === 'number'
    ? `<c r="${col(i)}${r}"><v>${v}</v></c>` : `<c r="${col(i)}${r}" t="s"><v>${strings.indexOf(v)}</v></c>`).join('');
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/arkusz/skoroszyt.xml"/></Relationships>');
  zip.file('arkusz/skoroszyt.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Pusty" sheetId="1" r:id="a1"/><sheet name="Cennik" sheetId="2" r:id="a2"/></sheets></workbook>');
  zip.file('arkusz/_rels/skoroszyt.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="a1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="pusty.xml"/><Relationship Id="a2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="dane/cennik.xml"/><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="teksty.xml"/></Relationships>');
  zip.file('arkusz/pusty.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>');
  zip.file('arkusz/teksty.xml', `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((t) => `<si><r><t>${t.slice(0, 3)}</t></r><r><t xml:space="preserve">${t.slice(3)}</t></r></si>`).join('')}</sst>`);
  zip.file('arkusz/dane/cennik.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cells(HEAD, 1)}</row><row r="2">${cells(ROW, 2)}</row></sheetData></worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function ods(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  const cell = (v: string | number) => typeof v === 'number'
    ? `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${String(v).replace('.', ',')}</text:p></table:table-cell>`
    : `<table:table-cell office:value-type="string"><text:p>${v}</text:p></table:table-cell>`;
  zip.file('content.xml', `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:spreadsheet><table:table table:name="Arkusz1">
<table:table-row>${HEAD.map(cell).join('')}<table:table-cell table:number-columns-repeated="16379"/></table:table-row>
<table:table-row>${ROW.map(cell).join('')}<table:table-cell table:number-columns-repeated="16379"/></table:table-row>
<table:table-row table:number-rows-repeated="1048574"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>
</table:table></office:spreadsheet></office:body></office:document-content>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('zapasowy odczyt arkuszy', () => {
  it('XLSX z nietypowymi ścieżkami i pustym pierwszym arkuszem', async () => {
    const p = await parseFile(await oddXlsx(), 'xlsx');
    expect(p.missingColumns).toEqual([]);
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({ city: 'Gdańsk', unitRef: 'A/1', priceM2: 13450, area: 48.5 });
  });
  it('arkusz OpenDocument (.ods)', async () => {
    const p = await parseFile(await ods(), 'csv');
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({ devName: 'Atrapa Sp. z o.o.', city: 'Gdańsk', priceM2: 13450, area: 48.5 });
  });
  it('obraz zamiast cennika', async () => {
    await expect(parseFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]), 'csv')).rejects.toThrow(/nie jest cennikiem/);
  });
});
