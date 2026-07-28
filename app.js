'use strict';

const SAMPLE_COUNT = 720;
const STEP_DEG = 0.5;
const INVALID = 255;
const profile = new Uint8Array(SAMPLE_COUNT).fill(INVALID);
const trace = [];

const el = id => document.getElementById(id);
const video = el('video');
const traceCanvas = el('traceCanvas');
const traceCtx = traceCanvas.getContext('2d');
const profileCanvas = el('profileCanvas');
const profileCtx = profileCanvas.getContext('2d');

let stream = null;
let tracing = false;
let editingProfile = false;
let orientation = { heading: null, pitch: 0, roll: 0, absolute: false };

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function wrap360(v) { return ((v % 360) + 360) % 360; }
function deg(v) { return `${v.toFixed(1)}°`; }

function setStatus(message, error = false) {
  el('statusLine').textContent = message;
  el('statusLine').style.color = error ? 'var(--danger)' : '';
}

function resizeTraceCanvas() {
  const rect = traceCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  traceCanvas.width = Math.round(rect.width * dpr);
  traceCanvas.height = Math.round(rect.height * dpr);
  traceCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTrace();
}

function drawTrace() {
  const rect = traceCanvas.getBoundingClientRect();
  traceCtx.clearRect(0, 0, rect.width, rect.height);
  if (trace.length < 2) return;
  traceCtx.lineWidth = 3;
  traceCtx.strokeStyle = '#36d7f0';
  traceCtx.shadowColor = '#021014';
  traceCtx.shadowBlur = 5;
  traceCtx.beginPath();
  traceCtx.moveTo(trace[0].x * rect.width, trace[0].y * rect.height);
  for (let i = 1; i < trace.length; i++) traceCtx.lineTo(trace[i].x * rect.width, trace[i].y * rect.height);
  traceCtx.stroke();
  traceCtx.shadowBlur = 0;
}

function tracePointer(e) {
  const rect = traceCanvas.getBoundingClientRect();
  const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
  if (!trace.length || Math.abs(x - trace[trace.length - 1].x) > 0.003) {
    trace.push({ x, y });
    trace.sort((a, b) => a.x - b.x);
    drawTrace();
    el('captureFrameButton').disabled = trace.length < 2;
  }
}

function interpolateTrace(x) {
  if (trace.length < 2) return null;
  if (x <= trace[0].x) return trace[0].y;
  if (x >= trace[trace.length - 1].x) return trace[trace.length - 1].y;
  for (let i = 1; i < trace.length; i++) {
    if (trace[i].x >= x) {
      const a = trace[i - 1], b = trace[i];
      const t = (x - a.x) / Math.max(1e-6, b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return null;
}

function screenAngle() {
  return (screen.orientation && Number.isFinite(screen.orientation.angle)) ? screen.orientation.angle : (window.orientation || 0);
}

function handleOrientation(event) {
  let heading = null;
  if (Number.isFinite(event.webkitCompassHeading)) heading = event.webkitCompassHeading;
  else if (Number.isFinite(event.alpha)) heading = wrap360(360 - event.alpha);

  const angle = screenAngle();
  const beta = Number.isFinite(event.beta) ? event.beta : 0;
  const gamma = Number.isFinite(event.gamma) ? event.gamma : 0;

  // First-pass display mapping. Final projection should use a full rotation matrix.
  let pitch = beta;
  let roll = gamma;
  if (angle === 90 || angle === -270) { pitch = -gamma; roll = beta; }
  else if (angle === 270 || angle === -90) { pitch = gamma; roll = -beta; }
  else if (angle === 180 || angle === -180) { pitch = -beta; roll = -gamma; }

  orientation = { heading, pitch, roll, absolute: !!event.absolute };
  el('headingValue').textContent = heading == null ? 'relative' : deg(heading);
  el('altitudeValue').textContent = deg(pitch);
  el('rollValue').textContent = deg(roll);
}

async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent === 'undefined') return;
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    const result = await DeviceOrientationEvent.requestPermission();
    if (result !== 'granted') throw new Error('Motion/orientation permission was not granted.');
  }
  window.addEventListener('deviceorientation', handleOrientation, true);
}

async function startCapture() {
  try {
    if (!window.isSecureContext) throw new Error('Camera capture requires HTTPS or localhost.');
    await requestOrientationPermission();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    el('cameraMessage').style.display = 'none';
    el('startButton').textContent = 'Camera active';
    el('startButton').disabled = true;
    resizeTraceCanvas();
    setStatus('Camera active. Trace one skyline section, then add the frame.');
  } catch (error) {
    setStatus(error.message || String(error), true);
    el('cameraMessage').textContent = error.message || 'Unable to start camera';
  }
}

function captureTracedFrame() {
  if (trace.length < 2) return;
  const heading = orientation.heading ?? 0;
  const centerAlt = orientation.pitch;
  const hfov = Number(el('fovInput').value);
  const rect = traceCanvas.getBoundingClientRect();
  const aspect = rect.width / Math.max(1, rect.height);
  const vfov = 2 * Math.atan(Math.tan(hfov * Math.PI / 360) / aspect) * 180 / Math.PI;

  let writes = 0;
  for (let i = 0; i < 360; i++) {
    const x = i / 359;
    const y = interpolateTrace(x);
    if (y == null) continue;
    const az = wrap360(heading + (x - 0.5) * hfov);
    const alt = clamp(centerAlt + (0.5 - y) * vfov, 0, 90);
    const idx = Math.round(az / STEP_DEG) % SAMPLE_COUNT;
    const encoded = Math.round(alt * 2);
    if (profile[idx] === INVALID) profile[idx] = encoded;
    else profile[idx] = Math.round((profile[idx] + encoded) / 2);
    writes++;
  }

  trace.length = 0;
  drawTrace();
  el('captureFrameButton').disabled = true;
  smoothShortGaps();
  drawProfile();
  setStatus(`Added frame centered near ${deg(heading)}. ${writes} projected samples merged.`);
}

function smoothShortGaps() {
  const maxGap = 16;
  for (let start = 0; start < SAMPLE_COUNT; start++) {
    if (profile[start] !== INVALID) continue;
    let end = start;
    while (end < SAMPLE_COUNT && profile[end] === INVALID && end - start <= maxGap) end++;
    if (end - start <= maxGap && start > 0 && end < SAMPLE_COUNT && profile[start - 1] !== INVALID && profile[end] !== INVALID) {
      const a = profile[start - 1], b = profile[end];
      for (let i = start; i < end; i++) {
        const t = (i - start + 1) / (end - start + 1);
        profile[i] = Math.round(a + (b - a) * t);
      }
    }
    start = end;
  }
}

function drawProfile() {
  const w = profileCanvas.width, h = profileCanvas.height;
  profileCtx.clearRect(0, 0, w, h);
  profileCtx.fillStyle = '#071014'; profileCtx.fillRect(0, 0, w, h);

  profileCtx.font = '22px system-ui';
  profileCtx.lineWidth = 1;
  for (let alt = 0; alt <= 90; alt += 15) {
    const y = h - alt / 90 * h;
    profileCtx.strokeStyle = alt === 0 ? '#4d6873' : '#20343d';
    profileCtx.beginPath(); profileCtx.moveTo(0, y); profileCtx.lineTo(w, y); profileCtx.stroke();
    profileCtx.fillStyle = '#78909a'; profileCtx.fillText(`${alt}°`, 6, Math.max(24, y - 5));
  }
  for (let az = 0; az <= 360; az += 45) {
    const x = az / 360 * w;
    profileCtx.strokeStyle = '#20343d'; profileCtx.beginPath(); profileCtx.moveTo(x, 0); profileCtx.lineTo(x, h); profileCtx.stroke();
    profileCtx.fillStyle = '#78909a';
    const labels = {0:'N',45:'NE',90:'E',135:'SE',180:'S',225:'SW',270:'W',315:'NW',360:'N'};
    profileCtx.fillText(labels[az], clamp(x + 5, 5, w - 35), h - 8);
  }

  profileCtx.beginPath();
  profileCtx.moveTo(0, h);
  let started = false;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    if (profile[i] === INVALID) continue;
    const x = i / (SAMPLE_COUNT - 1) * w;
    const y = h - (profile[i] / 2) / 90 * h;
    if (!started) { profileCtx.lineTo(x, h); profileCtx.lineTo(x, y); started = true; }
    else profileCtx.lineTo(x, y);
  }
  if (started) {
    profileCtx.lineTo(w, h); profileCtx.closePath();
    profileCtx.fillStyle = '#12242b'; profileCtx.fill();
  }

  profileCtx.strokeStyle = '#36d7f0'; profileCtx.lineWidth = 3; profileCtx.beginPath();
  let penDown = false;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    if (profile[i] === INVALID) { penDown = false; continue; }
    const x = i / (SAMPLE_COUNT - 1) * w;
    const y = h - (profile[i] / 2) / 90 * h;
    if (!penDown) { profileCtx.moveTo(x, y); penDown = true; } else profileCtx.lineTo(x, y);
  }
  profileCtx.stroke();

  const valid = profile.reduce((n, v) => n + (v !== INVALID), 0);
  el('coverageValue').textContent = `${Math.round(valid / SAMPLE_COUNT * 100)}%`;
}

function editProfileAt(e) {
  const rect = profileCanvas.getBoundingClientRect();
  const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
  const idx = Math.round(x * (SAMPLE_COUNT - 1));
  const alt = Math.round((1 - y) * 90 * 2);
  const radius = 4;
  for (let d = -radius; d <= radius; d++) {
    const j = (idx + d + SAMPLE_COUNT) % SAMPLE_COUNT;
    profile[j] = clamp(alt, 0, 180);
  }
  drawProfile();
}

function loadDemo() {
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const az = i * STEP_DEG;
    let alt = 10 + 3 * Math.sin(az * Math.PI / 55) + 2 * Math.sin(az * Math.PI / 13);
    if (az > 145 && az < 218) alt = 34 + 5 * Math.sin((az - 145) / 73 * Math.PI);
    if (az > 292 && az < 309) alt += 20 * Math.sin((az - 292) / 17 * Math.PI);
    profile[i] = Math.round(clamp(alt, 0, 90) * 2);
  }
  drawProfile();
  setStatus('Demo loaded: low ridge, southern house, and a western tree.');
}

function resetProfile() {
  profile.fill(INVALID);
  trace.length = 0;
  drawTrace(); drawProfile();
  setStatus('Profile cleared.');
}

function useLocation() {
  if (!navigator.geolocation) return setStatus('Geolocation is unavailable in this browser.', true);
  navigator.geolocation.getCurrentPosition(pos => {
    el('latitude').value = pos.coords.latitude.toFixed(7);
    el('longitude').value = pos.coords.longitude.toFixed(7);
    setStatus(`Location filled with ±${Math.round(pos.coords.accuracy)} m reported accuracy.`);
  }, err => setStatus(err.message, true), { enableHighAccuracy: true, timeout: 15000 });
}

function writeFixedUtf8(bytes, offset, length, text) {
  const encoded = new TextEncoder().encode(text);
  bytes.fill(0, offset, offset + length);
  bytes.set(encoded.slice(0, length - 1), offset);
}

function exportHzn() {
  const valid = profile.reduce((n, v) => n + (v !== INVALID), 0);
  if (!valid) return setStatus('Capture or draw at least part of a horizon before exporting.', true);

  const buffer = new ArrayBuffer(764);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set([0x48, 0x5a, 0x4e, 0x31], 0); // HZN1
  view.setUint16(4, SAMPLE_COUNT, true);
  view.setInt16(6, Math.round(Number(el('azOffset').value || 0) * 10), true);
  view.setFloat32(8, Number(el('latitude').value || 0), true);
  view.setFloat32(12, Number(el('longitude').value || 0), true);
  view.setUint32(16, Math.floor(Date.now() / 1000), true);
  writeFixedUtf8(bytes, 20, 24, el('siteName').value.trim() || 'Unnamed site');
  for (let i = 0; i < SAMPLE_COUNT; i++) bytes[44 + i] = profile[i] === INVALID ? 0 : profile[i];

  const safeName = (el('siteName').value || 'horizon').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${safeName || 'horizon'}.hzn`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Downloaded ${a.download} (${buffer.byteLength} bytes). Empty sectors were exported as 0°.`);
}

traceCanvas.addEventListener('pointerdown', e => { tracing = true; traceCanvas.setPointerCapture(e.pointerId); tracePointer(e); });
traceCanvas.addEventListener('pointermove', e => { if (tracing) tracePointer(e); });
traceCanvas.addEventListener('pointerup', () => { tracing = false; });
profileCanvas.addEventListener('pointerdown', e => { editingProfile = true; profileCanvas.setPointerCapture(e.pointerId); editProfileAt(e); });
profileCanvas.addEventListener('pointermove', e => { if (editingProfile) editProfileAt(e); });
profileCanvas.addEventListener('pointerup', () => { editingProfile = false; });

el('startButton').addEventListener('click', startCapture);
el('demoButton').addEventListener('click', loadDemo);
el('clearTraceButton').addEventListener('click', () => { trace.length = 0; drawTrace(); el('captureFrameButton').disabled = true; });
el('captureFrameButton').addEventListener('click', captureTracedFrame);
el('fovInput').addEventListener('input', e => { el('frameSpanValue').textContent = deg(Number(e.target.value)); });
el('locationButton').addEventListener('click', useLocation);
el('resetButton').addEventListener('click', resetProfile);
el('exportButton').addEventListener('click', exportHzn);
window.addEventListener('resize', resizeTraceCanvas);

el('secureBadge').textContent = window.isSecureContext ? 'Secure context' : 'HTTPS required for camera';
resizeTraceCanvas();
drawProfile();
