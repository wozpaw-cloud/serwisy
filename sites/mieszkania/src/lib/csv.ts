// Pliki CSV do pobrania: średnik i przecinek dziesiętny, jak w polskim Excelu.
export function csv(header: string[], rows: (string | number | null)[][]): Response {
  const cell = (v: string | number | null) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : v;
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
  return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8' } });
}
