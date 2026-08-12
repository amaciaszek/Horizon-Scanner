/* Cloud and wall stress test for the skyline detector, in image space.
 *
 * These are the two failure modes the DP path exists to fix:
 *   1. A bright cloud band with a sharp under-edge ABOVE the true horizon.
 *      The old topmost-gradient estimator fired on it, and independent
 *      per-column solving let isolated columns jump to it.
 *   2. A tall wall (vertical step). The old 7-tap median veto replaced the
 *      wall edge with the neighbourhood median, flattening real buildings.
 *
 * Ground truth is defined per COLUMN directly in pixel space, so there is no
 * shared projection code to cancel errors against (see handoff §3).
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const fs = require('fs');
let onmsg = null;
const fakeSelf = { set onmessage(f) { onmsg = f; }, postMessage: m => fakeSelf._last = m };
new Function('self', fs.readFileSync(ROOT + 'workers/segment.worker.js', 'utf8'))(fakeSelf);

const W = 384, H = 288;
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function segment(rgba) {
  onmsg({ data: { id: 1, width: W, height: H, buffer: rgba.buffer.slice(0) } });
  return fakeSelf._last;
}

/** Paint a frame from a per-column true boundary row, with an optional cloud. */
function renderFrame(truthRow, cloud) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      if (y < truthRow(x)) {
        // Sky: overcast-to-blue vertical gradient, low texture.
        const t = 1 - y / H;
        rgba[p]     = 150 + 20 * t + rnd() * 5;
        rgba[p + 1] = 172 + 16 * t + rnd() * 5;
        rgba[p + 2] = 205 + 20 * t + rnd() * 5;
        if (cloud && x >= cloud.x0 && x < cloud.x1 && y >= cloud.y0 && y < cloud.y1) {
          if (cloud.dark) {
            // Dark storm cloud: reads as "not sky" to every per-pixel cue, so
            // only the global continuity prior can refuse to call it horizon.
            rgba[p] = 84 + rnd() * 6; rgba[p + 1] = 87 + rnd() * 6; rgba[p + 2] = 94 + rnd() * 6;
          } else {
            // Bright, flat cloud with a hard under-edge — the decoy.
            rgba[p] = 216 + rnd() * 4; rgba[p + 1] = 216 + rnd() * 4; rgba[p + 2] = 220 + rnd() * 4;
          }
        }
      } else {
        // Obstruction: dark, textured.
        const n = rnd();
        rgba[p] = 52 + n * 34; rgba[p + 1] = 48 + n * 30; rgba[p + 2] = 42 + n * 26;
      }
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

let failures = 0;
function check(name, pass, detail) {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
}

function stats(seg, truthRow, cols) {
  let maxErr = 0, sumConf = 0, n = 0;
  for (const x of cols) {
    if (seg.flags[x] !== 0) continue;
    const err = Math.abs(seg.boundary[x] - truthRow(x));
    if (err > maxErr) maxErr = err;
    sumConf += seg.confidence[x]; n++;
  }
  return { maxErr, meanConf: n ? sumConf / n : 0, n };
}

const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

/* ---- scene 1: gentle horizon with a bright cloud band above it ---------- */
console.log('=== Cloud decoy above the horizon ===');
{
  const truthRow = x => 176 + Math.round(8 * Math.sin(x / 60));
  const cloud = { x0: 90, x1: 300, y0: 58, y1: 96 };
  const seg = segment(renderFrame(truthRow, cloud));
  const under = stats(seg, truthRow, range(cloud.x0, cloud.x1));
  const clear = stats(seg, truthRow, [...range(8, cloud.x0), ...range(cloud.x1, W - 8)]);
  check('boundary ignores the cloud under-edge', under.maxErr <= 4,
    `max err ${under.maxErr.toFixed(1)} px under the cloud (${under.n} cols)`);
  check('boundary accurate away from the cloud', clear.maxErr <= 4,
    `max err ${clear.maxErr.toFixed(1)} px`);
  check('confidence survives the cloud', under.meanConf >= 0.4,
    `mean conf ${(under.meanConf * 100).toFixed(0)}% under cloud`);
}

/* ---- scene 2: tall wall — a real vertical step must survive ------------- */
console.log('=== Tall wall: the step must survive, both edges sharp ===');
{
  const X0 = 150, X1 = 230, ROOF = 60, GROUND = 180;
  const truthRow = x => (x >= X0 && x < X1) ? ROOF : GROUND;
  const seg = segment(renderFrame(truthRow, null));
  const roof = stats(seg, truthRow, range(X0 + 6, X1 - 6));
  const flat = stats(seg, truthRow, [...range(8, X0 - 6), ...range(X1 + 6, W - 8)]);
  check('roof height is held, not flattened', roof.maxErr <= 4,
    `max err ${roof.maxErr.toFixed(1)} px along the roof (${roof.n} cols)`);
  check('ground level held away from the wall', flat.maxErr <= 4,
    `max err ${flat.maxErr.toFixed(1)} px`);
  // The step must be localised: within 6 columns each side of the true edge
  // the boundary must have completed the full transition.
  const leftDone = seg.boundary[X0 + 6] < ROOF + 8 && seg.boundary[X0 - 6] > GROUND - 8;
  const rightDone = seg.boundary[X1 - 6] < ROOF + 8 && seg.boundary[X1 + 6] > GROUND - 8;
  check('wall edges are sharp (within ±6 columns)', leftDone && rightDone,
    `rows at ${X0}±6: ${seg.boundary[X0 - 6].toFixed(0)}/${seg.boundary[X0 + 6].toFixed(0)}, ` +
    `at ${X1}∓6: ${seg.boundary[X1 - 6].toFixed(0)}/${seg.boundary[X1 + 6].toFixed(0)}`);
  check('confidence healthy on the roof', roof.meanConf >= 0.4,
    `mean conf ${(roof.meanConf * 100).toFixed(0)}%`);
}

/* ---- scene 2b: DARK cloud band — the decisive case ---------------------- */
/* A dark cloud breaks the top-connected sky component, so a detector without a
 * continuity prior puts the horizon at the CLOUD TOP, ~120 px above truth.
 * This is the "quietly wrong" failure the whole app exists to avoid. */
console.log('=== Dark storm cloud above clear sky ===');
{
  const truthRow = x => 176 + Math.round(8 * Math.sin(x / 60));
  const cloud = { x0: 60, x1: 330, y0: 58, y1: 92, dark: true };
  const seg = segment(renderFrame(truthRow, cloud));
  const under = stats(seg, truthRow, range(cloud.x0 + 4, cloud.x1 - 4));
  check('dark cloud is not called horizon', under.maxErr <= 6,
    `max err ${under.maxErr.toFixed(1)} px under the cloud (${under.n} cols)`);
}

/* ---- scene 3: cloud AND wall together, the compound case ---------------- */
console.log('=== Cloud and wall together ===');
{
  const X0 = 150, X1 = 230, ROOF = 100, GROUND = 190;
  const truthRow = x => (x >= X0 && x < X1) ? ROOF : GROUND;
  const cloud = { x0: 20, x1: 140, y0: 50, y1: 84 };
  const seg = segment(renderFrame(truthRow, cloud));
  const all = stats(seg, truthRow, [...range(8, X0 - 6), ...range(X0 + 6, X1 - 6), ...range(X1 + 6, W - 8)]);
  check('compound scene tracked', all.maxErr <= 4, `max err ${all.maxErr.toFixed(1)} px over ${all.n} cols`);
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exitCode = 1; }
else console.log('\nall skyline stress checks passed');
