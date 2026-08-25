/* Every module must be busted by a version bump, not just main.js.
 *
 * `index.html` used to load `js/main.js?v=X` and nothing else, while main.js
 * imported thirty modules with no query on any of them. Bumping the version
 * busted exactly one file, so a device ran new markup and new main.js against
 * whichever copy of everything else the browser had kept. Observed twice: on
 * 2026-08-21 the header read v0.19.0 with v0.20.0 on disk, and on 2026-08-25 a
 * bump to 0.21.0 left a freshly reloaded page reading 0.20.2.
 *
 * The generated import map in index.html fixes it, and the only way that fix
 * fails is by being forgotten — a module added, or a version bumped, without
 * `node tools/build-importmap.mjs` being run. So the check is: the map on disk
 * must be exactly what the tool would generate right now.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BEGIN, END, moduleFiles, currentVersion, renderImportMap
} from '../tools/build-importmap.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

console.log('=== The import map covers the whole module graph ===');

const html = readFileSync(join(root, 'index.html'), 'utf8');
const version = currentVersion();
const files = moduleFiles();

const start = html.indexOf(BEGIN);
const end = html.indexOf(END);
check('index.html carries a generated import map', start >= 0 && end > start);

if (start >= 0 && end > start) {
  const found = html.slice(start, end + END.length);
  const want = renderImportMap(version, files);
  check('it is up to date — run `node tools/build-importmap.mjs` if not',
    found === want,
    found === want ? `${files.length} modules at v${version}`
      : 'the map on disk differs from what the tool generates');

  for (const f of files) {
    if (found.includes(`"./js/${f}": "./js/${f}?v=${version}"`)) continue;
    check(`js/${f} is versioned`, false);
  }
  check('every module in js/ appears in the map', true, `${files.length} modules`);
}

// The stale-build check in main.js compares the script tag's query against the
// VERSION the module graph loaded, and it can only work if the tag carries one.
check('the entry script still carries the version query',
  html.includes(`js/main.js?v=${version}`), `v${version}`);
check('and so does the stylesheet, for the same reason',
  html.includes(`styles.css?v=${version}`));

console.log(failures ? `\n${failures} FAILED` : '\nall import-map checks passed');
process.exitCode = failures ? 1 : 0;
