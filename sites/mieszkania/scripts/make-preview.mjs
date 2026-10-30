// Kopia zbudowanego serwisu jako podgląd w artefakcie Claude: linki względne
// zamiast absolutnych, strona główna bez własnego szkieletu dokumentu (artefakt
// dokłada go sam), pozostałe strony jako pełne dokumenty.
// Użycie: node scripts/make-preview.mjs dist preview
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';

const [src = 'dist', out = 'preview'] = process.argv.slice(2);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(src, p).split('\\').join('/'));
  }
})(src);

const keep = files.filter((f) => !/^sitemap|robots\.txt$/.test(f));
const META = '<meta name="claude:viewport-fit-sides" content="cover">';
// Artefakty nie przyjmują ścieżek zaczynających się od „_”, więc _astro/ -> pliki/.
const outPath = (p) => p.replace(/^_astro\//, 'pliki/');

for (const f of keep) {
  const target = join(out, outPath(f));
  mkdirSync(dirname(target), { recursive: true });
  if (f === 'szukaj.json') {
    // Indeks wyszukiwarki: adresy względem katalogu głównego, z index.html (artefakt nie dopisuje go sam).
    const rows = JSON.parse(readFileSync(join(src, f), 'utf8')).map((r) => {
      const u = r[2].replace(/^\//, '');
      return [r[0], r[1], u.endsWith('/') || u === '' ? `${u}index.html` : u, r[3], r[4]];
    });
    writeFileSync(target, JSON.stringify(rows));
    continue;
  }
  if (!f.endsWith('.html')) { cpSync(join(src, f), target); continue; }
  const dir = posix.dirname(f);
  const rel = (abs) => {
    const [path, hash = ''] = abs.split('#');
    let p = outPath(path.replace(/^\//, ''));
    if (p === '' || p.endsWith('/')) p += 'index.html';
    const r = posix.relative(dir === '.' ? '' : dir, p) || 'index.html';
    return r + (hash ? `#${hash}` : '');
  };
  let html = readFileSync(join(src, f), 'utf8')
    .replace(/(href|src|action)="(\/[^"]*)"/g, (_, a, v) => `${a}="${rel(v)}"`)
    .replace(/url\((\/_astro\/[^)]+)\)/g, (_, v) => `url(${rel(v)})`)
    .replace(/<title>/, `${META}<title>`);
  if (f === 'index.html') {
    const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
      .replace(/<meta charset[^>]*>/, '')
      .replace(/<meta name="viewport"[^>]*>/, '')
      .replace(/<title>[^<]*<\/title>/, '<title>Cena od dewelopera</title>');
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1];
    html = `${head}\n${body}`;
  }
  writeFileSync(target, html);
}
console.log(`podgląd: ${keep.length} plików w ${out}`);
