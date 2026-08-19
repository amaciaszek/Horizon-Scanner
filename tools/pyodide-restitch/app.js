const $ = id => document.getElementById(id);
let worker;
let runtimeReady = false;
let selectedFile = null;
let running = false;
let report = null;
let solution = null;
let panorama = null;
let control = null;
let panoramaUrl = null;
let elapsedTimer = null;
let startedAt = 0;

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

function appendLog(text) {
  $('log').textContent += `\n${text}`;
  $('log').scrollTop = $('log').scrollHeight;
}

function refreshRunButton() {
  $('run').disabled = !runtimeReady || !selectedFile || running;
  $('cancel').disabled = !running;
}

function createWorker() {
  runtimeReady = false;
  worker = new Worker('./worker.js?v=20260819-connectivity-2', { type: 'module' });
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', event => fail(event.message || 'worker failed'));
  worker.postMessage({ type: 'init' });
  refreshRunButton();
}

function onWorkerMessage({ data }) {
  if (data.type === 'status') {
    setStatus(data.text);
    if (data.progress != null) $('progress').style.width = `${Math.round(data.progress * 100)}%`;
  } else if (data.type === 'log') {
    appendLog(data.line);
  } else if (data.type === 'ready') {
    runtimeReady = true;
    setStatus('Python, NumPy, and OpenCV are ready', 'good');
    $('progress').style.width = '0%';
    refreshRunButton();
  } else if (data.type === 'result') {
    report = data.report;
    solution = data.solution;
    panorama = data.panorama || null;
    control = data.control || null;
    finish();
  } else if (data.type === 'error') {
    fail(data.message, data.stack);
  }
}

function fail(message, stack = '') {
  running = false;
  clearInterval(elapsedTimer);
  setStatus(`failed: ${message}`, 'bad');
  appendLog(stack || message);
  refreshRunButton();
}

function accept(file) {
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) return fail('choose a capture-debug ZIP');
  selectedFile = file;
  setStatus(`${file.name} · ${(file.size / 1048576).toFixed(1)} MB ready`);
  refreshRunButton();
}

async function run() {
  if (!selectedFile || !runtimeReady || running) return;
  running = true;
  report = null; solution = null; panorama = null; control = null;
  if (panoramaUrl) URL.revokeObjectURL(panoramaUrl);
  panoramaUrl = null;
  $('panorama').hidden = true;
  $('result').hidden = true;
  $('saveReport').disabled = true; $('saveSolution').disabled = true;
  $('savePanorama').disabled = true; $('saveControl').disabled = true;
  $('log').textContent = `${selectedFile.name}\n`;
  $('progress').style.width = '2%';
  startedAt = performance.now();
  elapsedTimer = setInterval(() => {
    const seconds = (performance.now() - startedAt) / 1000;
    setStatus(`calculating locally · ${seconds.toFixed(0)} s elapsed`);
  }, 1000);
  refreshRunButton();
  const buffer = await selectedFile.arrayBuffer();
  worker.postMessage({
    type: 'run', name: selectedFile.name, buffer,
    options: {
      features: Number($('features').value), search: Number($('search').value),
      render: $('render').checked
    }
  }, [buffer]);
}

function finish() {
  running = false;
  clearInterval(elapsedTimer);
  const seconds = (performance.now() - startedAt) / 1000;
  setStatus(`${panorama ? 'rebuild' : 'geometry'} complete in ${seconds.toFixed(1)} s`, 'good');
  $('progress').style.width = '100%';
  $('saveReport').disabled = false;
  $('saveSolution').disabled = false;
  $('savePanorama').disabled = !panorama;
  $('saveControl').disabled = !control;
  if (panorama) {
    panoramaUrl = URL.createObjectURL(new Blob([panorama], { type: 'image/png' }));
    $('panorama').src = panoramaUrl;
    $('panorama').hidden = false;
  }
  renderMetrics(report);
  refreshRunButton();
}

function renderMetrics(r) {
  const graph = r.graph || {};
  const values = [
    ['frames', r.frames], ['surviving pairs', r.pairs],
    ['correspondences', Number(r.matches).toLocaleString()],
    ['median residual', `${r.residualDeg.solvedMedian.toFixed(3)}°`],
    ['p90 residual', `${r.residualDeg.solvedP90.toFixed(3)}°`],
    ['focal scale', `×${r.focalScale.toFixed(4)}`],
    ['median correction', `${r.framesMovedDeg.median.toFixed(2)}°`],
    ['maximum correction', `${r.framesMovedDeg.max.toFixed(2)}°`],
    ['largest solved graph', `${graph.largestComponentFrames ?? r.frames}/${r.frames}`],
    ['graph components', graph.components ?? 1]
  ];
  $('metrics').innerHTML = values.map(([k, v]) => `<div class="metric"><span>${k}</span><b>${v}</b></div>`).join('');
  const excluded = graph.excludedFrameIndices || [];
  const fallback = graph.sensorFallbackFrameIndices || [];
  const omitted = Math.max(0, excluded.length - fallback.length);
  $('quality').textContent = excluded.length
    ? `${graph.largestComponentFrames}/${r.frames} frames were visually connected. ` +
      `${fallback.length} unique-coverage frame${fallback.length === 1 ? '' : 's'} used sensor placement; ` +
      `${omitted} overlapping disconnected frame${omitted === 1 ? '' : 's'} omitted to prevent ghosting.`
    : 'Every frame belongs to one visually connected solution.';
  $('result').hidden = false;
}

function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

$('file').addEventListener('change', event => accept(event.target.files[0]));
const drop = $('drop');
for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, event => {
  event.preventDefault(); drop.classList.add('hot');
});
for (const type of ['dragleave', 'drop']) drop.addEventListener(type, event => {
  event.preventDefault(); drop.classList.remove('hot');
});
drop.addEventListener('drop', event => accept(event.dataTransfer.files[0]));
$('run').addEventListener('click', run);
$('cancel').addEventListener('click', () => {
  if (!running) return;
  worker.terminate();
  running = false;
  clearInterval(elapsedTimer);
  appendLog('cancelled');
  setStatus('cancelled; restarting the Python runtime');
  createWorker();
});
$('saveReport').addEventListener('click', () => download(JSON.stringify(report, null, 2), 'stitch-report.json', 'application/json'));
$('saveSolution').addEventListener('click', () => download(solution, 'stitch-solution.npz', 'application/octet-stream'));
$('savePanorama').addEventListener('click', () => download(panorama, 'panorama-solved.png', 'image/png'));
$('saveControl').addEventListener('click', () => download(control, 'panorama-sensor.png', 'image/png'));

createWorker();
