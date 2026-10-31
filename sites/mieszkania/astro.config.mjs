// Serwis cen mieszkań i domów od deweloperów. Strony statyczne, budowane z bazy
// SQLite po każdym imporcie (zob. packages/mieszkania-dane).
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { fileURLToPath } from 'node:url';

// Baza z importu leży w katalogu data/ w korzeniu repozytorium.
process.env.MIESZKANIA_DB ??= fileURLToPath(new URL('../../data/mieszkania.sqlite', import.meta.url));

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://cenaoddewelopera.pl',
  trailingSlash: 'always',
  // Style i skrypty w osobnych plikach: przeglądarka pobiera je raz dla całego serwisu,
  // a strony z tabelami są kilkadziesiąt KB lżejsze.
  build: { format: 'directory', inlineStylesheets: 'never' },
  integrations: [sitemap({ filter: (page) => !page.includes('/404') })],
  vite: {
    server: { fs: { allow: ['../..'] } },
    ssr: { external: ['node:sqlite'] },
  },
});
