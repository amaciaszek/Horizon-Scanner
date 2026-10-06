'use strict';
/* Turning a stitched panorama into sky-with-a-hole-in-it, and into a horizon.
 *
 * WHY THIS IS A MODULE. Two pages need it and they need it to agree. If
 * `sky/skyline-align.html` traced the skyline one way and `sky/planetarium.html`
 * traced it another, the offsets measured on the first page would not place the
 * horizon of the second, and the whole chain from capture to "does M33 clear my
 * roofline" would quietly come apart at the join. Same code, same answer.
 *
 * Nothing here touches the DOM beyond an offscreen canvas. The messages and the
 * notes belong to the pages, which word them for their own operator.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* The detector's cost is columns times rows, and a 3240-wide panorama is far
 * more columns than a skyline has detail. 1440 is one column per quarter
 * degree, finer than the 720-bin profile the app produces. */
const WORK_WIDTH = 1440;

/**
 * Detect the skyline in a panorama.
 *
 * The detector is `workers/segment.worker.js` -- the SAME one the capture app
 * runs on every frame at 10 Hz. Writing a second one would mean two different
 * answers to "where is the skyline", and the entire value of these pages is
 * that they show the app's own answer next to the real sky.
 *
 * Two things have to be done to a panorama that a camera frame does not need:
 *
 * WRAP. A panorama's left and right edges are the same bearing. The segmenter
 * works column by column with a continuity prior, so it has no idea, and the
 * skyline can step at the seam. The image is fed to it with a slice of each end
 * wrapped onto the other, and the padding is cut off the answer.
 *
 * UNPAINTED BLACK. A stitched panorama has black where no photograph reached.
 * The detector's sky cue is blueness and smoothness, and black is neither, so
 * it reads unpainted panel as GROUND and traces the boundary along the top of
 * the black instead of along the roofline. Those pixels are filled with the
 * column's own sky colour before detection, and punched out afterwards.
 */
export async function detectSkyline(img, { workerUrl = '../workers/segment.worker.js' } = {}) {
  const srcW = img.width, srcH = img.height;
  const workW = Math.min(WORK_WIDTH, srcW);
  const workH = Math.max(32, Math.round(srcH * workW / srcW));
  const pad = Math.round(workW * 0.04);

  const c = document.createElement('canvas');
  c.width = workW + pad * 2; c.height = workH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, srcW, srcH, pad, 0, workW, workH);
  // The wrap: right end onto the left margin, left end onto the right.
  ctx.drawImage(img, srcW - srcW * pad / workW, 0, srcW * pad / workW, srcH, 0, 0, pad, workH);
  ctx.drawImage(img, 0, 0, srcW * pad / workW, srcH, pad + workW, 0, pad, workH);

  const padded = ctx.getImageData(0, 0, c.width, c.height);
  const unpaintedFraction = fillUnpainted(padded);
  const result = await segment(padded, workerUrl);

  // Trim the wrap padding back off.
  const boundary = new Float32Array(workW);
  for (let x = 0; x < workW; x++) boundary[x] = result.boundary[x + pad];
  return {
    boundary, width: workW, height: workH,
    skyFraction: result.skyFraction, noSky: !!result.noSky, unpaintedFraction
  };
}

/** Paint unpainted black with a plausible sky, and report how much there was. */
function fillUnpainted(imageData) {
  const { width: w, height: h, data } = imageData;
  let black = 0;
  for (let x = 0; x < w; x++) {
    // Walk down from the top; everything black before the first real pixel is
    // panel that was never photographed.
    let firstReal = -1;
    for (let y = 0; y < h; y++) {
      const p = (y * w + x) * 4;
      if (data[p] + data[p + 1] + data[p + 2] > 24) { firstReal = y; break; }
    }
    if (firstReal <= 0) continue;
    const q = (firstReal * w + x) * 4;
    const r = data[q], g = data[q + 1], b = data[q + 2];
    for (let y = 0; y < firstReal; y++) {
      const p = (y * w + x) * 4;
      data[p] = r; data[p + 1] = g; data[p + 2] = b;
      black++;
    }
  }
  return black / (w * h);
}

let segWorker = null, segWorkerUrl = null, segSeq = 0;
function segment(imageData, workerUrl) {
  if (!segWorker || segWorkerUrl !== workerUrl) {
    try {
      segWorker = new Worker(workerUrl);
      segWorkerUrl = workerUrl;
    } catch (err) {
      segWorker = null;
      return Promise.reject(new Error(`cannot start ${workerUrl} (${err.message})`));
    }
    // A worker that dies later -- a parse error inside it, say -- rejects
    // nothing on its own, so the caller would wait for a message that is never
    // coming. Turn that into a failure the operator can read.
    segWorker.addEventListener('error', e => {
      const dead = segWorker;
      segWorker = null;
      dead.dispatchEvent(new CustomEvent('seg-dead', { detail: e.message || 'worker error' }));
    });
  }
  const id = ++segSeq;
  const worker = segWorker;
  return new Promise((resolve, reject) => {
    const done = fn => (...args) => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('seg-dead', onDead);
      fn(...args);
    };
    const onMessage = e => {
      if (e.data.id !== id) return;
      if (e.data.error) done(reject)(new Error(e.data.error)); else done(resolve)(e.data);
    };
    const onDead = e => done(reject)(new Error(e.detail));
    worker.addEventListener('message', onMessage);
    worker.addEventListener('seg-dead', onDead);
    const copy = new Uint8ClampedArray(imageData.data);
    worker.postMessage({ id, width: imageData.width, height: imageData.height, buffer: copy.buffer },
      [copy.buffer]);
  });
}

/**
 * Build the RGBA texture: the panorama with everything above the skyline made
 * transparent.
 *
 * THE SIZE IS ROUNDED UP TO A POWER OF TWO, AND THAT IS NOT AN OPTIMISATION.
 * WebGL 1 will not wrap a non-power-of-two texture: with `TEXTURE_WRAP_S` set
 * to `REPEAT` such a texture is INCOMPLETE, and an incomplete texture samples
 * as opaque black everywhere. Measured in the align page's own context: a 64x64
 * REPEAT texture returned rgba(255,0,0,255); the same content at 1440x388
 * returned rgba(0,0,0,255).
 *
 * The symptom is the reason this is written down. There is no GL error, no
 * console warning and no failed draw -- the panorama renders perfectly, in
 * black, over a black sky. It looks exactly like a draw that never happened.
 *
 * REPEAT is worth keeping rather than working around with CLAMP_TO_EDGE,
 * because a panorama's left and right edges are the same bearing and the
 * texture filter has to blend across that seam. Clamping puts a one-texel
 * stripe of stretched edge pixel at due-whatever-azimuth-zero-is, which is a
 * line in the sky exactly where someone is trying to judge an alignment.
 *
 * Resampling does not disturb the geometry: the fragment shader computes v from
 * ALTITUDE rather than from the image's aspect, so the mapping stays linear
 * whatever the texture's height.
 */
export function cutSkyTexture(img, opts) {
  const {
    boundary = null, boundaryWidth = 0, boundaryHeight = 0,
    topDeg, spanDeg, skyMarginDeg = 6,
    cutSky = true, markUnpainted = false, maxTexSize = 4096, canvas = null
  } = opts;

  const pot = n => Math.pow(2, Math.ceil(Math.log2(Math.max(1, n))));
  const w = Math.min(pot(img.width), maxTexSize);
  const h = Math.min(pot(img.height), maxTexSize);
  const c = canvas || document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const px = ctx.getImageData(0, 0, w, h);
  const d = px.data;

  /*
   * PANEL NOBODY PHOTOGRAPHED IS NOT SKY, AND SAYING SO MATTERS.
   *
   * A stitched panorama is full of holes: 13.6% of the 2026-09-23 render is
   * unpainted, and 6.4% of the rows below the top of the painted content are
   * gaps INSIDE the terrain, where the solver dropped a frame. Rendered
   * transparent they look exactly like an over-aggressive sky cut, and the cut
   * gets blamed for damage it did not do. The flag paints them instead, so the
   * two can be told apart in one glance.
   */
  for (let p = 0; p < d.length; p += 4) {
    if (d[p] + d[p + 1] + d[p + 2] > 24) continue;
    if (markUnpainted) { d[p] = 86; d[p + 1] = 32; d[p + 2] = 58; d[p + 3] = 190; }
    else d[p + 3] = 0;
  }

  let clampedColumns = 0;
  if (cutSky && boundary) {
    /*
     * THE CUT IS MADE ABOVE THE TRACED SKYLINE, NOT ON IT.
     *
     * The detector is tuned for 384x288 camera frames and on a panorama it errs
     * LOW -- it clips rooflines and treetops, and the operator's verdict on the
     * first version was blunt: it cut out so much that the skyline being
     * checked was itself damaged. Which is the wrong way round. A band of real
     * sky left in costs only the stars inside it; a bite taken out of a
     * roofline destroys the very edge the whole page exists to align.
     *
     * So the cut sits `skyMarginDeg` above the trace, and fades in across the
     * band rather than ending on a hard line -- a crisp horizontal edge in open
     * sky reads as a real object and is precisely the thing not to draw here.
     */
    const marginPx = Math.max(0, skyMarginDeg / Math.max(1, spanDeg) * h);
    const fade = Math.max(2, marginPx * 0.55);
    const horizonRow = clamp(topDeg / Math.max(1, spanDeg), 0, 1) * h;

    for (let x = 0; x < w; x++) {
      let traced = tracedRow(boundary, boundaryWidth, boundaryHeight, x / w) * h;
      // See `horizonProfile` for why a trace below the horizon is clamped.
      if (traced > horizonRow) { traced = horizonRow; clampedColumns++; }
      const cut = traced - marginPx;
      for (let y = 0; y < h; y++) {
        const p = (y * w + x) * 4;
        if (d[p + 3] === 0) continue;                       // already unpainted
        if (y < cut) d[p + 3] = 0;
        else if (y < cut + fade) {
          d[p + 3] = Math.min(d[p + 3], Math.round(255 * (y - cut) / fade));
        }
      }
    }
  }
  ctx.putImageData(px, 0, 0);
  return { canvas: c, width: w, height: h, clampedColumns };
}

/** The traced skyline at a fractional position across the panorama, 0..1, as a
 *  fraction of the image's height. Linear between the detector's columns. */
function tracedRow(boundary, bw, bh, u) {
  const bx = clamp(u, 0, 0.999999) * bw;
  const i0 = Math.min(bw - 1, Math.max(0, Math.floor(bx)));
  const i1 = Math.min(bw - 1, i0 + 1);
  const t = bx - i0;
  return (boundary[i0] * (1 - t) + boundary[i1] * t) / bh;
}

/**
 * The traced skyline as a horizon profile: altitude against azimuth, in the
 * same 720 half-degree bins `js/survey.js` uses.
 *
 * This is what makes `sky/planetarium.html` answer the question it exists for.
 * "M33 rises at 19:40" is an almanac's answer and it is useless standing in
 * this yard, where M33 is behind the barn until gone midnight. The REAL rise is
 * against this profile, so the profile has to exist as numbers and not only as
 * pixels in a texture.
 *
 * TRACES BELOW THE HORIZON ARE CLAMPED TO IT, matching the texture cut and
 * `js/survey.js`, which clamps every profile sample to `clamp(alt, 0, 90)`.
 * MEASURED on the 2026-09-23 dusk capture: between azimuth 105 and 135 the
 * detector declared the entire column sky, down to the bottom edge -- sunset
 * glow over a dark, low, distant treeline, where the blueness and texture cues
 * both collapse. The operator stands on the ground; an obstruction is above
 * them. A skyline below the horizon is not a hard case, it is a wrong answer.
 */
export function horizonProfile({ boundary, boundaryWidth, boundaryHeight, topDeg, spanDeg },
  bins = 720) {
  const out = new Float32Array(bins);
  if (!boundary) { out.fill(NaN); return out; }
  for (let i = 0; i < bins; i++) {
    // Bin centres, so a bin's altitude is the skyline in the middle of it
    // rather than at its left edge.
    const u = (i + 0.5) / bins;
    const alt = topDeg - tracedRow(boundary, boundaryWidth, boundaryHeight, u) * spanDeg;
    out[i] = Math.max(0, alt);
  }
  return out;
}

/**
 * The horizon's altitude at a bearing, with the page's two offsets applied.
 *
 * The offsets move the PICTURE, so a question asked about a SKY bearing has the
 * azimuth offset subtracted before the lookup and the elevation offset added to
 * the answer -- the same signs the dome shader uses, for the same reason. Any
 * other pairing would put the silhouette and the rise times in different places
 * and nobody would notice until a telescope hit a tree.
 *
 * A bin the detector never reached comes back null rather than 0. A missing bin
 * reported as a flat horizon would promise open sky where there is a wall, and
 * the whole point of the survey is that it refuses to do that -- `buildHzn2`
 * writes 255 for the same reason.
 */
/**
 * The profile as an opaque silhouette: triangles from the skyline down to the
 * pole, ready for a `mesh` layer.
 *
 * WHY THIS EXISTS WHEN THERE IS ALREADY A PANORAMA. A `.horizon-project` is a
 * few hundred kilobytes and lives in a phone's downloads; the panorama is a
 * multi-megabyte PNG that has to be found and dropped in. The profile IS the
 * product of the survey, so the planetarium works from it alone, and the
 * picture becomes a nicety rather than a prerequisite. When both are loaded
 * they draw the same edge, which is also a free check that they agree.
 *
 * BINS THE SURVEY NEVER REACHED ARE LEFT AS HOLES, not filled. A gap drawn as
 * ground invents a wall; drawn as sky it promises a view that may not be there.
 * `buildHzn2` writes 255 for the same reason, and the page counts them out
 * loud rather than letting a hole read as an answer.
 */
export function horizonMesh(profile, { azOffset = 0, altOffset = 0, floorDeg = -90 } = {}) {
  const v = [];
  if (!profile || !profile.length) return new Float32Array(0);
  const n = profile.length;
  const dir = (azDeg, altDeg) => {
    const ca = Math.cos(altDeg * Math.PI / 180);
    return [Math.sin(azDeg * Math.PI / 180) * ca, Math.sin(altDeg * Math.PI / 180),
      Math.cos(azDeg * Math.PI / 180) * ca];
  };
  for (let i = 0; i < n; i++) {
    const a = profile[i], b = profile[(i + 1) % n];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const az0 = azOffset + (i + 0.5) / n * 360;
    const az1 = azOffset + (i + 1.5) / n * 360;
    const p0 = dir(az0, a + altOffset), p1 = dir(az1, b + altOffset);
    const q0 = dir(az0, floorDeg), q1 = dir(az1, floorDeg);
    v.push(...p0, ...q0, ...p1, ...q0, ...q1, ...p1);
  }
  return new Float32Array(v);
}

export function sampleHorizon(profile, azDeg, { azOffset = 0, altOffset = 0 } = {}) {
  if (!profile || !profile.length) return null;
  const n = profile.length;
  const x = ((((azDeg - azOffset) / 360) % 1) + 1) % 1 * n - 0.5;
  const i0 = Math.floor(x), t = x - i0;
  const a = profile[((i0 % n) + n) % n];
  const b = profile[(((i0 + 1) % n) + n) % n];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a * (1 - t) + b * t + altOffset;
}
