const PYODIDE_VERSION = '314.0.3';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
let pyodide = null;
let initialization = null;
let busy = false;

const post = message => self.postMessage(message);
const status = (text, progress) => post({ type: 'status', text, progress });

async function initialize() {
  if (pyodide) return;
  status('downloading the Python/WebAssembly runtime…', 0.05);
  const { loadPyodide } = await import(`${PYODIDE_BASE}pyodide.mjs`);
  pyodide = await loadPyodide({
    indexURL: PYODIDE_BASE,
    stdout: line => post({ type: 'log', line }),
    stderr: line => post({ type: 'log', line: `stderr: ${line}` })
  });
  status('loading NumPy and OpenCV…', 0.35);
  await pyodide.loadPackage(['numpy', 'opencv-python'], {
    messageCallback: message => status(message, 0.45)
  });
  status('loading the verified stitch pipeline…', 0.8);
  // The worker and Python CLI must be updated as one unit. Browsers otherwise
  // may reuse an older stitch_lab.py while loading a newer worker.js, leaving
  // new command-line options unrecognized.
  const response = await fetch('../stitch_lab.py?v=20260819-connectivity-2', {
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`could not load stitch_lab.py (${response.status})`);
  pyodide.FS.writeFile('/home/pyodide/stitch_lab.py', await response.text(), { encoding: 'utf8' });
  await pyodide.runPythonAsync(`
import importlib
import sys
sys.path.insert(0, '/home/pyodide')
importlib.invalidate_caches()
import stitch_lab
`);
  post({ type: 'ready', version: PYODIDE_VERSION });
}

async function runCapture(message) {
  if (busy) throw new Error('a reconstruction is already running');
  busy = true;
  try {
    await initialization;
    status('copying the capture into Python memory…', 0.02);
    pyodide.FS.writeFile('/tmp/capture.zip', new Uint8Array(message.buffer));
    const features = Math.max(100, Math.min(1500, Number(message.options?.features) || 500));
    const search = Math.max(24, Math.min(120, Number(message.options?.search) || 64));
    const render = message.options?.render !== false;
    status('running ORB, guided matching, and bundle adjustment…', 0.08);
    await pyodide.runPythonAsync(`
import gc
import shutil
import sys
from pathlib import Path

out = Path('/tmp/stitch-out')
if out.exists():
    shutil.rmtree(out)
old_argv = sys.argv
sys.argv = [
    'stitch_lab.py', '/tmp/capture.zip', '--out', str(out),
    '--detector', 'orb', '--max-features', '${features}',
    '--search-px', '${search}', '--max-degree', '24', '--blend', 'seam'
]
if not ${render ? 'True' : 'False'}:
    sys.argv.append('--no-render')
try:
    stitch_lab.main()
finally:
    sys.argv = old_argv
gc.collect()
`);
    const report = JSON.parse(pyodide.FS.readFile('/tmp/stitch-out/report.json', { encoding: 'utf8' }));
    // Detach a standalone copy, never a view that could share the WASM heap.
    const solution = pyodide.FS.readFile('/tmp/stitch-out/solution.npz').slice();
    const panorama = render ? pyodide.FS.readFile('/tmp/stitch-out/panorama-solved.png').slice() : null;
    const control = render ? pyodide.FS.readFile('/tmp/stitch-out/panorama-sensor.png').slice() : null;
    pyodide.FS.unlink('/tmp/capture.zip');
    const transfers = [solution.buffer];
    if (panorama) transfers.push(panorama.buffer, control.buffer);
    post({ type: 'result', report, solution, panorama, control }, transfers);
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
    post({ type: 'error', message: error?.message || String(error), stack: error?.stack || '' });
  }
});
