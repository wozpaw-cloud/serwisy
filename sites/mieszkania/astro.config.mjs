// Serwis cen mieszkań i domów od deweloperów. Strony statyczne, budowane z bazy
// SQLite po każdym imporcie (zob. packages/mieszkania-dane).
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { fileURLToPath } from 'node:url';

// Baza z importu leży w katalogu data/ w korzeniu repozytorium.
process.env.MIESZKANIA_DB ??= fileURLToPath(new URL('../../data/mieszkania.sqlite', import.meta.url));

// Po budowie: liczby w wykresach SVG zaokrąglone do jednego miejsca po przecinku
// (współrzędne z 15 cyframi po przecinku potrafiły ważyć połowę strony).
function roundSvgNumbers() {
  return {
    name: 'zaokraglanie-svg',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const { readdir, readFile, writeFile } = await import('node:fs/promises');
        const root = fileURLToPath(dir);
        const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.html'));
        let saved = 0;
        for (const f of files) {
          const path = `${root}/${f}`;
          const html = await readFile(path, 'utf8');
          const out = html.replace(/<svg[\s\S]*?<\/svg>/g, (svg) => svg.replace(/(\d+\.\d)\d+/g, '$1'));
          if (out.length !== html.length) { saved += html.length - out.length; await writeFile(path, out); }
        }
        console.log(`zaokrąglanie SVG: ${files.length} stron, ${(saved / 1048576).toFixed(1)} MB mniej`);
      },
    },
  };
}

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://cenaoddewelopera.pl',
  trailingSlash: 'always',
  // Style i skrypty w osobnych plikach: przeglądarka pobiera je raz dla całego serwisu,
  // a strony z tabelami są kilkadziesiąt KB lżejsze.
  build: { format: 'directory', inlineStylesheets: 'never' },
  integrations: [sitemap({ filter: (page) => !page.includes('/404') }), roundSvgNumbers()],
  vite: {
    server: { fs: { allow: ['../..'] } },
    ssr: { external: ['node:sqlite'] },
  },
});
