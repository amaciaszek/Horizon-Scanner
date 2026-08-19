'use strict';
/* The offline-grade stitcher, in the app.
 *
 * This runs tools/stitch_lab.py — the same Python the desktop restitcher runs —
 * inside Pyodide with NumPy and OpenCV. It replaces the phone-budget optimiser
 * (js/bundle.js at 427 px and one descriptor scale) with the full pipeline:
 * multi-scale features, guided matching, a Gauss-Newton bundle adjustment over
 * every rotation and one shared focal length, outlier pruning, a second solve,
 * seam-cut compositing.
 *
 * WHY THE ARCHIVE IS THE INTERFACE. The worker is handed the same
 * capture-debug ZIP the Export card writes, built in memory. That is a deliberate
 * choice over marshalling live objects: the ZIP is a format stitch_lab.py already
 * reads and that has been checked against real captures, so an in-app build and a
 * desktop rebuild of the same session run identical code over identical bytes. If
 * they ever disagree, the difference is the runtime and nothing else.
 *
 * WHAT THIS COSTS. Pyodide, NumPy and OpenCV are ~25 MB from a CDN on first use
 * and are then cached by the browser. No capture data is uploaded — the ZIP never
 * leaves this worker, and the only network traffic is the runtime download. On a
 * 200-frame capture the solve holds every decoded frame in the WebAssembly heap;
 * see MEMORY_WARN_FRAMES below.
 */

const PYODIDE_VERSION = '314.0.3';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/* Above this frame count the decoded images alone approach what a mobile
 * WebAssembly heap will give us, and the failure mode is an abort with no
 * useful message. Warn while the operator can still choose a cheaper build. */
const MEMORY_WARN_FRAMES = 160;

let pyodide = null;
let initialization = null;
let busy = false;

const post = (message, transfer) => self.postMessage(message, transfer || []);
const status = (text, progress) => post({ type: 'status', text, progress });

async function initialize() {
  if (pyodide) return;
  status('downloading the Python runtime…', 0.04);
  const { loadPyodide } = await import(`${PYODIDE_BASE}pyodide.mjs`);
  pyodide = await loadPyodide({
    indexURL: PYODIDE_BASE,
    stdout: line => post({ type: 'log', line }),
    stderr: line => post({ type: 'log', line, stderr: true })
  });
  status('loading NumPy and OpenCV…', 0.16);
  await pyodide.loadPackage(['numpy', 'opencv-python'], {
    messageCallback: message => status(message, 0.22)
  });
  status('loading the stitch pipeline…', 0.30);
  // The worker and the Python must move as one unit. A browser that pairs a
  // cached stitch_lab.py with a newer worker fails on an unrecognised option,
  // which reads as a broken build rather than a stale one.
  const response = await fetch(`../tools/stitch_lab.py?v=${PYODIDE_VERSION}-app`, {
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`could not load tools/stitch_lab.py (HTTP ${response.status}). `
      + 'The page must be served over http, not opened as a file.');
  }
  pyodide.FS.writeFile('/home/pyodide/stitch_lab.py', await response.text(), { encoding: 'utf8' });
  await pyodide.runPythonAsync(`
import sys, importlib
sys.path.insert(0, '/home/pyodide')
importlib.invalidate_caches()
import stitch_lab
`);
  post({ type: 'ready', version: PYODIDE_VERSION });
}

function readIfPresent(path) {
  try { return pyodide.FS.readFile(path).slice(); }
  catch { return null; }
}

async function runCapture(message) {
  if (busy) throw new Error('a rebuild is already running');
  busy = true;
  try {
    await initialization;

    const options = message.options || {};
    const frames = Number(options.frameCount) || 0;
    if (frames > MEMORY_WARN_FRAMES) {
      post({
        type: 'log',
        line: `note: ${frames} frames is past the ${MEMORY_WARN_FRAMES}-frame point where the `
          + 'decoded images start to crowd the WebAssembly heap. If this build dies without an '
          + 'error, that is why — lower the feature count or rebuild on a desktop.'
      });
    }

    status('copying the capture into Python…', 0.34);
    pyodide.FS.writeFile('/tmp/capture.zip', new Uint8Array(message.buffer));

    // Clamped rather than trusted: these arrive from a <select> that a stale
    // cached page could be serving, and an out-of-range value fails deep inside
    // the solve where the message means nothing to an operator.
    const features = Math.max(100, Math.min(1500, Number(options.features) || 500));
    const search = Math.max(24, Math.min(120, Number(options.search) || 64));
    const degree = Math.max(6, Math.min(32, Number(options.degree) || 24));
    const pxPerDeg = Math.max(2, Math.min(12, Number(options.pxPerDeg) || 6));
    const detector = options.detector === 'sift' ? 'sift' : 'orb';
    const blend = ['seam', 'feather', 'best'].includes(options.blend) ? options.blend : 'seam';

    status('running features, matching and bundle adjustment…', 0.38);
    await pyodide.runPythonAsync(`
import gc, shutil, sys
from pathlib import Path

out = Path('/tmp/stitch-out')
if out.exists():
    shutil.rmtree(out)
old_argv = sys.argv
sys.argv = [
    'stitch_lab.py', '/tmp/capture.zip', '--out', str(out),
    '--detector', '${detector}', '--max-features', '${features}',
    '--search-px', '${search}', '--max-degree', '${degree}',
    '--blend', '${blend}', '--px-per-deg', '${pxPerDeg}',
]
try:
    stitch_lab.main()
finally:
    sys.argv = old_argv
gc.collect()
`);

    status('collecting the result…', 0.96);
    const report = JSON.parse(pyodide.FS.readFile('/tmp/stitch-out/report.json', { encoding: 'utf8' }));
    // Detached copies, never views onto the WASM heap: the heap can move under
    // us on the next allocation and the transfer would carry garbage.
    const panorama = readIfPresent('/tmp/stitch-out/panorama-solved.png');
    const control = readIfPresent('/tmp/stitch-out/panorama-sensor.png');
    const solution = readIfPresent('/tmp/stitch-out/solution.npz');

    try { pyodide.FS.unlink('/tmp/capture.zip'); } catch { /* already gone */ }
    await pyodide.runPythonAsync('import gc, shutil; shutil.rmtree("/tmp/stitch-out", ignore_errors=True); gc.collect()');

    const transfers = [panorama, control, solution]
      .filter(Boolean).map(b => b.buffer);
    post({ type: 'result', report, panorama, control, solution }, transfers);
  } finally {
    busy = false;
  }
}

self.addEventListener('message', async ({ data }) => {
  try {
    if (data.type === 'init') {
      if (!initialization) initialization = initialize();
      await initialization;
    } else if (data.type === 'run') {
      if (!initialization) initialization = initialize();
      await runCapture(data);
    }
  } catch (error) {
    // A failed init must not poison every later attempt with a rejected promise
    // that no longer describes anything true.
    if (!pyodide) initialization = null;
    post({
      type: 'error',
      message: (error && error.message) || String(error),
      stack: (error && error.stack) || ''
    });
  }
});
