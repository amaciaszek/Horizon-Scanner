'use strict';
/* Visual registration worker.
 *
 * Estimates the pixel translation between two frames using a coarse-to-fine
 * mean-normalised cross-correlation pyramid, with a parabolic subpixel fit on
 * the correlation peak. Under near-pure rotation about the optical centre this
 * translation maps directly to a camera rotation, which is what lets the app
 * treat the compass as optional and the gyro as merely a prior.
 *
 * Limitation, stated plainly: this is translational registration, not a full
 * feature-matched homography. It does not recover roll or scale between frames.
 * Roll is taken from the accelerometer instead, and frames with large roll
 * change are rejected by the caller rather than registered.
 */

const BASE_W = 160, BASE_H = 120;
const LEVELS = 3;   // 160x120, 80x60, 40x30

let prev = null;   // {pyr, id}

function buildPyramid(luma, w, h) {
  const pyr = [{ data: luma, w, h }];
  let cur = luma, cw = w, ch = h;
  for (let l = 1; l < LEVELS; l++) {
    const nw = cw >> 1, nh = ch >> 1;
    const next = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const i = (y * 2) * cw + x * 2;
        next[y * nw + x] = (cur[i] + cur[i + 1] + cur[i + cw] + cur[i + cw + 1]) * 0.25;
      }
    }
    pyr.push({ data: next, w: nw, h: nh });
    cur = next; cw = nw; ch = nh;
  }
  return pyr; // pyr[0] finest
}

/** Mean-normalised correlation of ref against cur shifted by (dx, dy). */
function ncc(ref, cur, w, h, dx, dy, margin, step) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  const x0 = margin, x1 = w - margin, y0 = margin, y1 = h - margin;
  const possible = Math.ceil((x1 - x0) / step) * Math.ceil((y1 - y0) / step);
  for (let y = y0; y < y1; y += step) {
    const sy = y + dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = x0; x < x1; x += step) {
      const sx = x + dx;
      if (sx < 0 || sx >= w) continue;
      const a = ref[y * w + x], b = cur[sy * w + sx];
      sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
    }
  }
  // Refuse a match that only overlaps a sliver of the frame.
  if (n < 60 || n < possible * 0.45) return -1;
  const ma = sa / n, mb = sb / n;
  const va = saa / n - ma * ma, vb = sbb / n - mb * mb;
  if (va < 1e-4 || vb < 1e-4) return -1;   // featureless — refuse to guess
  return (sab / n - ma * mb) / Math.sqrt(va * vb);
}

function parabolic(m, l, r) {
  const d = (l - 2 * m + r);
  if (Math.abs(d) < 1e-9) return 0;
  return Math.max(-1, Math.min(1, 0.5 * (l - r) / d));
}

function register(prevPyr, curPyr, hintX, hintY) {
  const top = LEVELS - 1;
  const scale = 1 << top;
  let dx = Math.round((hintX || 0) / scale);
  let dy = Math.round((hintY || 0) / scale);
  let peak = -1, second = -1;

  for (let l = top; l >= 0; l--) {
    const a = prevPyr[l], b = curPyr[l];
    if (l < top) { dx *= 2; dy *= 2; }
    const range = (l === top) ? 10 : 2;
    const margin = Math.max(4, Math.round(a.w * 0.14));
    const step = (l === 0) ? 2 : 1;
    // Soft prior: with an equal-quality match, stay near where the inertial
    // estimate says we should be. This is what keeps a repetitive scene (a
    // fence, a row of windows) from locking onto the wrong period.
    const priorX = (hintX || 0) / (1 << l), priorY = (hintY || 0) / (1 << l);
    const priorWeight = (l === top && Number.isFinite(hintX)) ? 0.0035 : 0;

    let bestScore = -2, bx = dx, by = dy;
    const grid = [];
    for (let oy = -range; oy <= range; oy++) {
      for (let ox = -range; ox <= range; ox++) {
        const cx = dx + ox, cy = dy + oy;
        let s = ncc(a.data, b.data, a.w, a.h, cx, cy, margin, step);
        grid.push(s);
        if (s <= -1) continue;
        const penalised = s - priorWeight * Math.hypot(cx - priorX, cy - priorY);
        if (penalised > bestScore) { bestScore = penalised; bx = cx; by = cy; peak = s; }
      }
    }
    if (bestScore <= -1.5) return null;
    // A level that cannot find a convincing peak should not move the estimate.
    if (peak < 0.35 && l > 0) continue;
    dx = bx; dy = by;

    if (l === 0) {
      const sorted = grid.filter(v => v > -1).sort((p, q) => q - p);
      second = sorted.length > 1 ? sorted[1] : -1;
      const m = ncc(a.data, b.data, a.w, a.h, dx, dy, margin, 1);
      const lx = ncc(a.data, b.data, a.w, a.h, dx - 1, dy, margin, 1);
      const rx = ncc(a.data, b.data, a.w, a.h, dx + 1, dy, margin, 1);
      const ly = ncc(a.data, b.data, a.w, a.h, dx, dy - 1, margin, 1);
      const ry = ncc(a.data, b.data, a.w, a.h, dx, dy + 1, margin, 1);
      peak = m;
      if (lx > -1 && rx > -1) dx += parabolic(m, lx, rx);
      if (ly > -1 && ry > -1) dy += parabolic(m, ly, ry);
    }
  }
  if (peak < 0) return null;
  const sharpness = second > -1 ? Math.max(0, peak - second) : 0;
  const quality = Math.max(0, Math.min(1, (peak - 0.45) / 0.5)) * Math.max(0.25, Math.min(1, sharpness * 12));
  return { dx, dy, peak, sharpness, quality };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.cmd === 'reset') { prev = null; return; }
  if (msg.cmd === 'anchor') { // remember a frame for later loop-closure matching
    self.anchor = { pyr: buildPyramid(new Float32Array(msg.buffer), msg.w, msg.h) };
    return;
  }

  const luma = new Float32Array(msg.buffer);
  const pyr = buildPyramid(luma, msg.w, msg.h);

  if (msg.cmd === 'closeLoop') {
    const res = self.anchor ? register(self.anchor.pyr, pyr, msg.hintX, msg.hintY) : null;
    self.postMessage({ id: msg.id, loop: true, result: res });
    return;
  }

  let result = null;
  if (prev) result = register(prev.pyr, pyr, msg.hintX, msg.hintY);
  prev = { pyr };
  self.postMessage({ id: msg.id, result, baseW: msg.w, baseH: msg.h });
};

self.BASE_W = BASE_W;
self.BASE_H = BASE_H;
