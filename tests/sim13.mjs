/* Dense puffy cumulus over a treeline — the 2026-08-15 field complaint.
 *
 * "I have big dense puffy white clouds (not a whole sky of clouds) and it is
 * confusing them for the horizon."
 *
 * This is a different failure from the overcast and dark-storm cases already
 * covered by sim12. The scene has THREE bright modes, not two: near-white
 * cloud, mid-blue sky, dark trees. The sky score leans on brightness at 0.42
 * and gives a white cloud only the blueness FLOOR while blue sky gets full
 * marks, so cloud and sky separate almost as much as sky and ground do — and
 * Otsu, asked for one threshold, can put it between cloud and sky instead of
 * between sky and ground. Everything below the cloud is then "ground" and the
 * traced horizon climbs to the cloud's underside.
 *
 * Ground truth here is unambiguous: the horizon is the treeline, and every
 * column's answer is known exactly.
 */
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import path from 'path';

const root = fileURLToPath(new URL('../', import.meta.url));
const workerSrc = readFileSync(path.join(root, 'workers/segment.worker.js'), 'utf8');

/* The worker is written for a worker scope; run its body with a stub. */
function loadSegmenter() {
  const posts = [];
  const scope = {
    self: null,
    postMessage: m => posts.push(m),
    onmessage: null
  };
  scope.self = scope;
  const fn = new Function('self', 'postMessage', workerSrc + '\n;return { onmessage: self.onmessage };');
  const api = fn(scope, scope.postMessage);
  return {
    run(width, height, rgba) {
      posts.length = 0;
      (scope.onmessage || api.onmessage)({ data: { id: 1, width, height, buffer: rgba.buffer } });
      return posts[posts.length - 1];
    }
  };
}

const W = 192, H = 144;

/** Build the scene. `treeRow(x)` is the true skyline row for column x. */
function scene(cfg) {
  const { cloudBands = [], treeRow } = cfg;
  const d = new Uint8ClampedArray(W * H * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const horizon = treeRow(x);
      let r, g, b;
      if (y > horizon) {
        // Foliage. `lit` raises it toward sunlit mid-tones, which is the case
        // that actually matters: dark silhouetted trees are an easy edge, while
        // sunlit ones against hazy sky can be a WEAKER edge than a white cloud
        // against blue — and the detector picks edges by strength.
        const t = rnd();
        const lit = cfg.litFoliage || 0;
        r = (24 + t * 26) + lit * 96;
        g = (44 + t * 40) + lit * 104;
        b = (20 + t * 22) + lit * 70;
      } else {
        // Sky, unless a cloud covers this pixel.
        const inCloud = cloudBands.some(c => {
          const dx = (x - c.cx) / c.rx, dy = (y - c.cy) / c.ry;
          // Lumpy edge so it is not a clean ellipse.
          return dx * dx + dy * dy < 1 + 0.18 * Math.sin(x * 0.9) * Math.cos(y * 0.7);
        });
        if (inCloud) {
          // Dense white cumulus: very bright, almost no colour, smooth inside,
          // and slightly grey underneath as real ones are.
          const shade = 1 - 0.12 * Math.max(0, (y - (cloudBands[0].cy)) / 30);
          const v = (238 + rnd() * 10) * shade;
          r = v; g = v; b = v * 1.01;
        } else {
          const t = y / H, haze = cfg.haze || 0;
          r = (96 - t * 18) + haze * 110;
          g = (140 - t * 20) + haze * 82;
          b = (210 - t * 16) + haze * 34;      // blue, washing out toward white
        }
      }
      d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
    }
  }
  return d;
}

const seg = loadSegmenter();
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

function evaluate(label, cfg) {
  const rgba = scene(cfg);
  const out = seg.run(W, H, rgba);
  const b = out.boundary;
  let worst = 0, sumAbs = 0, n = 0;
  for (let x = 0; x < W; x++) {
    const truth = cfg.treeRow(x);
    const err = Math.abs(b[x] - truth);
    worst = Math.max(worst, err); sumAbs += err; n++;
  }
  const meanErr = sumAbs / n;
  const conf = out.confidence.reduce((a, v) => a + v, 0) / out.confidence.length;
  console.log(`\n${label}`);
  console.log(`   threshold ${out.threshold.toFixed(3)}, mean |error| ${meanErr.toFixed(1)} px, worst ${worst} px, confidence ${(conf * 100).toFixed(0)}%`);
  return { meanErr, worst, conf, out };
}

const flatTrees = x => 96 + Math.round(4 * Math.sin(x * 0.11));

console.log('=== The reported scene: dense cumulus above a treeline ===');
{
  // Three fat clouds well above the trees, blue sky visible between them.
  const r = evaluate('two-thirds sky, three dense clouds', {
    treeRow: flatTrees,
    cloudBands: [
      { cx: 40, cy: 34, rx: 30, ry: 20 },
      { cx: 108, cy: 26, rx: 26, ry: 17 },
      { cx: 168, cy: 40, rx: 24, ry: 16 }
    ]
  });
  check('the traced line follows the trees, not the cloud bottoms', r.meanErr < 4,
    `mean error ${r.meanErr.toFixed(1)} px (a cloud underside would be ~55 px high)`);
  check('no column is wildly wrong', r.worst < 12, `worst ${r.worst} px`);
}

console.log('\n=== A single very large cloud, worst case for a one-way threshold ===');
{
  const r = evaluate('one cloud covering most of the sky', {
    treeRow: flatTrees,
    cloudBands: [{ cx: 96, cy: 40, rx: 90, ry: 30 }]
  });
  check('still follows the trees', r.meanErr < 4, `mean error ${r.meanErr.toFixed(1)} px`);
}

console.log('\n=== Cloud sitting directly on a tall obstruction ===');
{
  // A roof rising into the frame with cloud immediately above it: the two
  // edges are close together and the wrong one is the brighter.
  const roof = x => (x > 60 && x < 140) ? 62 : flatTrees(x);
  const r = evaluate('roofline with cloud just above it', {
    treeRow: roof,
    cloudBands: [{ cx: 100, cy: 34, rx: 44, ry: 18 }]
  });
  check('takes the roof, not the cloud above it', r.meanErr < 5, `mean error ${r.meanErr.toFixed(1)} px`);
}

console.log('\n=== Clear blue sky must not regress ===');
{
  const r = evaluate('no clouds at all', { treeRow: flatTrees, cloudBands: [] });
  check('clear sky is still exact', r.meanErr < 2.5, `mean error ${r.meanErr.toFixed(1)} px`);
  check('and confident', r.conf > 0.5, `${(r.conf * 100).toFixed(0)}%`);
}


console.log('\n=== The hard version: sunlit foliage under a hazy sky ===');
{
  // Now the cloud/sky edge is the strongest gradient in the frame and the
  // treeline is the weakest. This is the combination a bright afternoon
  // actually produces, and the one the operator reported.
  const r = evaluate('bright trees, washed-out sky, dense cloud', {
    treeRow: flatTrees,
    litFoliage: 0.62,
    haze: 0.55,
    cloudBands: [
      { cx: 46, cy: 30, rx: 34, ry: 21 },
      { cx: 132, cy: 26, rx: 32, ry: 19 }
    ]
  });
  check('still finds the treeline', r.meanErr < 6, `mean error ${r.meanErr.toFixed(1)} px`);
  check('and does not climb to a cloud underside', r.worst < 20, `worst ${r.worst} px`);
}

console.log('\n=== Cloud below the treetops in the frame, the nastiest case ===');
{
  // A low cloud whose underside sits BELOW the top of the trees. Any rule that
  // simply takes the lowest sky-like pixel walks straight into this.
  const r = evaluate('low cloud overlapping the treeline height', {
    treeRow: x => 78 + Math.round(6 * Math.sin(x * 0.09)),
    litFoliage: 0.5,
    haze: 0.4,
    cloudBands: [{ cx: 96, cy: 58, rx: 70, ry: 26 }]
  });
  check('treeline still wins', r.meanErr < 8, `mean error ${r.meanErr.toFixed(1)} px`);
}

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exitCode = 1; }
else console.log('\nall cloud-vs-horizon checks passed');
