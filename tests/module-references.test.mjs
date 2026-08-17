/* Every function a module calls must actually exist where it says it does.
 *
 * On 2026-08-17 a field session produced nothing at all — no skyline, no
 * coverage, no guidance dot, no keyframes — because `js/main.js` called
 * `exposureOf(...)` without importing it. Every frame threw a ReferenceError,
 * 1201 times, and the app went on presenting a normal interface the whole time.
 *
 * Nothing in the suite could have caught it. `node --check` parses one file and
 * says nothing about whether a name resolves; the unit tests exercise modules
 * that take plain data, and none of them touch main.js, which needs a DOM, a
 * camera and motion sensors to run a single line. A whole class of fatal,
 * trivially detectable mistakes had no net under it.
 *
 * So this is the net. It reads every module as text and checks two things:
 *
 *   1. Every name imported from a local module is actually exported by it.
 *   2. Every name used in CALL POSITION is declared locally, imported, or a
 *      known global.
 *
 * Call position specifically, because `foo(` is unambiguous enough to keep
 * false positives near zero without writing a real scope analyser. This is a
 * lint, not a compiler; it is meant to catch the careless mistake that costs a
 * field trip, and it did not need to be clever to do that.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = /\s/;
const VALUE_END = /[\w$)\]]/;
const LOWER = /[a-z]/;
const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles() {
  const out = [];
  for (const dir of ['js', 'workers']) {
    let names = [];
    try { names = readdirSync(join(root, dir)); } catch (_) { continue; }
    for (const name of names) {
      // Forward slashes throughout, so keys match what resolving an import
      // specifier produces. On Windows `join` yields backslashes and the two
      // sides silently never meet.
      if (name.endsWith('.js')) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

/** Comments only. Import and export clauses must keep their string literals —
 *  stripping those first was this checker's own first bug, and it made every
 *  module look like it imported nothing at all. */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Strip comments and string/template literals so their contents are not
 *  mistaken for code. Crude but sufficient: it only ever removes text. */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // A `/` begins a regex literal only where a value cannot already have ended.
  // Without this, the `"` inside a pattern like the CSV quoting test opens a
  // phantom string that swallows the next hundred lines of real code — which is
  // how an earlier version of this checker lost a function declaration and then
  // reported that same function as undefined.
  const regexCanStartHere = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const ch = out[k];
      if (WS.test(ch)) continue;
      return !VALUE_END.test(ch);
    }
    return true;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d !== '/' && d !== '*' && regexCanStartHere()) {
      let k = i + 1, inClass = false, closed = false;
      while (k < n) {
        const ch = src[k];
        if (ch === BACKSLASH) { k += 2; continue; }
        if (ch === NEWLINE) break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { closed = true; k++; break; }
        k++;
      }
      if (closed) { out += ' RE '; i = k; while (i < n && LOWER.test(src[i])) i++; continue; }
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        // Template substitutions hold real code and must be kept — but that
        // code routinely contains its own string literals, and copying it in
        // raw put phrases like 'gyroscope (devicemotion)' into the token
        // stream, where the checker read them as calls to gyroscope().
        // Recursing is the fix: a substitution is just more source.
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1; i += 2;
          let inner = '';
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth > 0) inner += src[i];
            i++;
          }
          out += ' ' + stripNonCode(inner) + ' ';
          continue;
        }
        i++;
      }
      out += ' "" ';
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** Names this file brings in from elsewhere, and where from. */
function importsOf(code) {
  const named = new Map();          // localName -> specifier
  const namespaces = new Set();
  const re = /import\s+([^'"]+?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const clause = m[1].trim(), from = m[2];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const piece of braces[1].split(',')) {
        const part = piece.trim();
        if (!part) continue;
        const as = part.split(/\s+as\s+/);
        named.set((as[1] || as[0]).trim(), { from, imported: as[0].trim() });
      }
    }
    const star = clause.match(/\*\s+as\s+(\w+)/);
    if (star) namespaces.add(star[1]);
    const dflt = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+\w+/, '').replace(/,/g, '').trim();
    if (dflt && /^\w+$/.test(dflt)) named.set(dflt, { from, imported: 'default' });
  }
  return { named, namespaces };
}

/** Names this file exports. */
function exportsOf(code) {
  const names = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([\w$]+)/g)) names.add(m[1]);
  // `export const A = 1, B = 2;` declares both, and reading only the first is
  // how this checker first accused camera.js of not exporting WORK_H.
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([^;\n]+)/g)) {
    for (const piece of m[1].split(',')) {
      const part = piece.trim().split('=')[0].trim();
      if (/^[\w$]+$/.test(part)) names.add(part);
    }
  }
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(',')) {
      const part = piece.trim();
      if (!part) continue;
      const as = part.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
}

/** Anything declared anywhere in the file, at any scope. Deliberately flat:
 *  a name declared in one function and used in another is not what this hunts. */
function declaredIn(code) {
  const names = new Set();
  for (const m of code.matchAll(/(?:function|class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  // Destructuring, parameters, catch bindings, for-of bindings.
  for (const m of code.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
    for (const piece of m[1].split(',')) {
      const part = piece.trim().split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^\w+$/.test(part)) names.add(part);
    }
  }
  for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const piece of m[1].split(',')) {
      const part = piece.trim().split('=')[0].trim()
        .replace(/^\.\.\./, '').replace(/^[({[]+/, '').replace(/[)}\]]+$/, '');
      if (/^[\w$]+$/.test(part)) names.add(part);
    }
  }
  // Single-parameter arrows without parentheses: `res => ...`
  for (const m of code.matchAll(/(?:^|[^\w.$])([a-zA-Z_$][\w$]*)\s*=>/g)) names.add(m[1]);
  for (const m of code.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)) {
    for (const piece of m[1].split(',')) {
      const part = piece.trim().split('=')[0].trim()
        .replace(/^\.\.\./, '').replace(/^[({[]+/, '').replace(/[)}\]]+$/, '');
      if (/^[\w$]+$/.test(part)) names.add(part);
    }
  }
  for (const m of code.matchAll(/([\w$]+)\s*\([^)]*\)\s*\{/g)) names.add(m[1]);   // class methods
  for (const m of code.matchAll(/catch\s*\(\s*(\w+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/for\s*\(\s*(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  return names;
}

const GLOBALS = new Set([
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'Error', 'TypeError',
  'RangeError', 'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Symbol', 'RegExp', 'Proxy', 'Reflect',
  'BigInt', 'Function', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'queueMicrotask', 'structuredClone', 'fetch', 'atob', 'btoa', 'alert', 'confirm',
  'requestAnimationFrame', 'cancelAnimationFrame', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array',
  'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'ArrayBuffer', 'DataView', 'Blob', 'File', 'FileReader', 'URL', 'URLSearchParams', 'Image',
  'ImageData', 'OffscreenCanvas', 'createImageBitmap', 'TextEncoder', 'TextDecoder', 'Worker',
  'CustomEvent', 'Event', 'EventTarget', 'AbortController', 'Intl', 'console', 'document', 'window',
  'navigator', 'screen', 'location', 'performance', 'history', 'localStorage', 'sessionStorage',
  'indexedDB', 'IDBKeyRange', 'DeviceOrientationEvent', 'DeviceMotionEvent', 'MediaStream',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'Accelerometer', 'Gyroscope',
  'LinearAccelerationSensor', 'AbsoluteOrientationSensor', 'RelativeOrientationSensor', 'Magnetometer', 'self', 'globalThis', 'postMessage',
  'importScripts', 'require', 'super', 'this', 'if', 'for', 'while', 'switch', 'catch', 'return',
  'typeof', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'finally', 'throw', 'await', 'async',
  'yield', 'function', 'class', 'const', 'let', 'var', 'export', 'import', 'default', 'extends'
]);

const files = sourceFiles();
const exportsByFile = new Map();
const codeByFile = new Map();      // comments gone, strings intact: for imports
const bodyByFile = new Map();      // strings gone too: for the call scan
for (const rel of files) {
  const raw = readFileSync(join(root, rel), 'utf8');
  const withStrings = stripComments(raw);
  codeByFile.set(rel, withStrings);
  bodyByFile.set(rel, stripNonCode(raw));
  exportsByFile.set(rel, exportsOf(withStrings));
}

console.log(`=== Imported names exist where they are imported from (${files.length} modules) ===`);
{
  const broken = [];
  for (const rel of files) {
    const { named } = importsOf(codeByFile.get(rel));
    for (const [local, info] of named) {
      if (!info.from.startsWith('.')) continue;              // node builtins etc.
      const target = join(dirname(rel), info.from).replace(/\\/g, '/');
      const exported = exportsByFile.get(target);
      if (!exported) { broken.push(`${rel}: cannot resolve ${info.from}`); continue; }
      if (info.imported !== 'default' && !exported.has(info.imported)) {
        broken.push(`${rel}: imports {${info.imported}} from ${info.from}, which does not export it`);
      }
    }
  }
  check('every named import resolves to a real export', broken.length === 0,
    broken.length ? '\n      ' + broken.join('\n      ') : `${files.length} modules clean`);
}

console.log('\n=== Every called function resolves to something ===');
{
  const unresolved = [];
  for (const rel of files) {
    const code = codeByFile.get(rel);
    const body = bodyByFile.get(rel);
    const { named, namespaces } = importsOf(code);
    const known = new Set([...declaredIn(body), ...named.keys(), ...namespaces, ...GLOBALS]);
    const seen = new Set();
    // Calls only, and not method calls: `foo(` but never `.foo(`.
    for (const m of body.matchAll(/(^|[^\w.$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (known.has(name) || seen.has(name)) continue;
      seen.add(name);
      unresolved.push(`${rel}: calls ${name}() — not imported, not declared, not a known global`);
    }
  }
  check('no call references an undefined name', unresolved.length === 0,
    unresolved.length ? '\n      ' + unresolved.join('\n      ') : 'all call targets resolve');
}

console.log('\n=== The check itself catches the bug that motivated it ===');
{
  // The exact shape of the 2026-08-17 failure: used, never imported.
  const sampleRaw = `
    import { CameraSource } from './camera.js';
    function processFrame() {
      const frame = camera.grab();
      const exposure = exposureOf(frame);
      return exposure;
    }
  `;
  const sample = stripNonCode(sampleRaw);
  const { named, namespaces } = importsOf(stripComments(sampleRaw));
  const known = new Set([...declaredIn(sample), ...named.keys(), ...namespaces, ...GLOBALS]);
  const missed = [];
  for (const m of sample.matchAll(/(^|[^\w.$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
    if (!known.has(m[2])) missed.push(m[2]);
  }
  check('an unimported call is detected', missed.includes('exposureOf'), missed.join(', ') || 'nothing found');
  check('a correctly imported name is not flagged', !missed.includes('CameraSource'));
  check('a method call is not flagged', !missed.includes('grab'));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
