'use strict';
import { quatRotate, quatConj, quatMul, cameraRay, DEG } from './math3d.js';

/**
 * Making the panorama agree with itself.
 *
 * Every keyframe is placed by its own sensor attitude, and those attitudes are
 * individually good but not mutually consistent: a degree of gyro drift here, a
 * degree of fusion lag there, and neighbouring frames disagree about where the
 * same chimney is. The mosaic then shows that disagreement as a seam, and no
 * amount of blending hides it, because the two frames genuinely draw the
 * chimney in two places.
 *
 * The fix is to let the pictures vote. Features are matched between overlapping
 * frames, and each frame's rotation is nudged until matched features land on the
 * same world direction. This is rotation-only bundle adjustment, which for a
 * camera turning about a fixed point is the whole problem — there is no
 * translation to solve for.
 *
 * Two decisions matter more than the algebra:
 *
 * GRAVITY IS NOT NEGOTIABLE. The correction is split into a turn about world
 * vertical and a tilt away from it, and the tilt is held down hard while the
 * turn is left comparatively free. Which way is down comes from the
 * accelerometer and is the most reliable number in the device; azimuth comes
 * from an integrated gyroscope and is the one that drifts. So vision is
 * permitted to fix the azimuths and forbidden to tip the horizon over.
 *
 * CLOUDS DO NOT COUNT. Features are taken only from below each frame's own
 * detected skyline. Cloud moves between one frame and the next, so matching on
 * it would drag frames toward a fiction; everything below the skyline is
 * rooted to the ground and is exactly what should line up.
 */

/** Luminance at or above which a pixel is treated as a blown highlight rather
 *  than as scene detail. Bright overcast sits near 200-230 and must survive. */
const SATURATED = 250;

/** Normalised image coordinates: u right, v up, both -1..1 at the frame edges. */
const uOf = (px, w) => (px + 0.5) / w * 2 - 1;
const vOf = (py, h) => 1 - (py + 0.5) / h * 2;

/**
 * Interest points from one keyframe's thumbnail, below the skyline only.
 *
 * `src` is {w, h, data} RGBA. `kf` supplies `boundary` (one row per column of
 * the working frame) and `height` (that frame's row count), which together are
 * the sky mask this already computes for free during the survey.
 */
export function extractFeatures(src, kf, { target = 160, patch = 7, margin = 12 } = {}) {
  const { w, h, data } = src;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  // Skyline row for a given column, in thumbnail pixels. Anything above it is
  // sky or cloud and is not allowed to influence the alignment.
  const nb = kf.boundary ? kf.boundary.length : 0;
  const skyRow = px => {
    if (!nb) return 0;
    const bx = Math.min(nb - 1, Math.max(0, Math.floor(px / w * nb)));
    return (kf.boundary[bx] / (kf.height || 1)) * h;
  };

  // Corner strength: the smaller eigenvalue of the local gradient covariance,
  // which is high only where the texture runs in two directions and is
  // therefore matchable in two directions.
  const cand = [];
  const step = 2;
  for (let py = margin + patch; py < h - margin - patch; py += step) {
    for (let px = margin + patch; px < w - margin - patch; px += step) {
      if (py < skyRow(px) + 3) continue;                 // sky, cloud, or right on the edge
      let sxx = 0, syy = 0, sxy = 0, hot = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const i = (py + dy) * w + px + dx;
          if (lum[i] >= SATURATED) hot++;
          const gx = lum[i + 1] - lum[i - 1];
          const gy = lum[i + w] - lum[i - w];
          sxx += gx * gx; syy += gy * gy; sxy += gx * gy;
        }
      }
      // Anything touching a blown highlight is discarded. A low sun in the
      // frame produces beautifully corner-like structure — the clipped edge of
      // the disc, lens flare ghosts, the starburst off the aperture — and none
      // of it is attached to the ground. Flare ghosts in particular move with
      // the camera rather than with the scene, so matching on them tells the
      // solver the world rotated when it did not. This is exactly what the
      // 2026-08-15 capture was full of at 296 degrees.
      if (hot) continue;
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const smaller = tr / 2 - disc;
      if (smaller > 40) cand.push({ px, py, s: smaller });
    }
  }

  // Spread them out: a cluster of points on one gutter constrains one place
  // very well and the rest of the frame not at all.
  cand.sort((a, b) => b.s - a.s);
  const cell = Math.max(8, Math.floor(Math.sqrt(w * h / Math.max(1, target)) * 0.8));
  const taken = new Set();
  const feats = [];
  for (const c of cand) {
    const key = `${Math.floor(c.px / cell)},${Math.floor(c.py / cell)}`;
    if (taken.has(key)) continue;
    taken.add(key);
    feats.push({
      px: c.px, py: c.py,
      u: uOf(c.px, w), v: vOf(c.py, h),
      desc: descriptor(lum, w, h, c.px, c.py, patch)
    });
    if (feats.length >= target) break;
  }
  return { feats, w, h, lum };
}

/** Mean-removed, contrast-normalised patch. Robust to exposure changes between
 *  frames, which a phone makes constantly as it turns toward and away the sun. */
function descriptor(lum, w, h, px, py, r) {
  const n = (2 * r + 1) * (2 * r + 1);
  const d = new Float32Array(n);
  let mean = 0;
  for (let dy = -r, k = 0; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++, k++) { d[k] = lum[(py + dy) * w + px + dx]; mean += d[k]; }
  }
  mean /= n;
  let ss = 0;
  for (let k = 0; k < n; k++) { d[k] -= mean; ss += d[k] * d[k]; }
  const norm = Math.sqrt(ss) || 1;
  for (let k = 0; k < n; k++) d[k] /= norm;
  return d;
}

const ncc = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; return s; };

/** Patch radius implied by a descriptor's length. */
const patchOf = desc => (Math.sqrt(desc.length) - 1) / 2;

/** Normalised patch taken from a raw luminance plane at an integer position. */
function patchAt(lum, w, h, px, py, r) {
  if (px - r < 0 || py - r < 0 || px + r >= w || py + r >= h) return null;
  const n = (2 * r + 1) * (2 * r + 1);
  const d = new Float32Array(n);
  let mean = 0;
  for (let dy = -r, k = 0; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++, k++) { d[k] = lum[(py + dy) * w + px + dx]; mean += d[k]; }
  }
  mean /= n;
  let ss = 0;
  for (let k = 0; k < n; k++) { d[k] -= mean; ss += d[k] * d[k]; }
  const norm = Math.sqrt(ss) || 1;
  for (let k = 0; k < n; k++) d[k] /= norm;
  return d;
}

/**
 * Sub-pixel offset of the correlation peak, by fitting a parabola through the
 * scores one pixel either side. Clamped to half a pixel because a parabola
 * through three samples cannot honestly place a peak further than that, and an
 * unclamped fit on a flat correlation surface will happily invent one.
 */
function subpixel(desc, B, px, py, r) {
  const at = (x, y) => {
    const p = patchAt(B.lum, B.w, B.h, x, y, r);
    return p ? ncc(desc, p) : -2;
  };
  const c = at(px, py);
  const l = at(px - 1, py), rr = at(px + 1, py);
  const u = at(px, py - 1), d = at(px, py + 1);
  const par = (a, b, cc) => {
    const den = a - 2 * b + cc;
    if (!(Math.abs(den) > 1e-9)) return 0;
    return Math.max(-0.5, Math.min(0.5, 0.5 * (a - cc) / den));
  };
  return {
    dx: (l > -2 && rr > -2) ? par(l, c, rr) : 0,
    dy: (u > -2 && d > -2) ? par(u, c, d) : 0
  };
}

/**
 * World ray for a normalised image point under a keyframe's rotation.
 *
 * `scale` multiplies both half-angle tangents together, which is a change of
 * focal length and nothing else: the pixel aspect ratio is preserved, so the
 * camera stays a square-pixel pinhole. Scaling one axis alone would not be a
 * focal length at all, and would quietly put an azimuth error at the frame
 * edges that grows with distance from the optical centre.
 */
export function rayOf(kf, u, v, q, scale = 1) {
  return quatRotate(q, cameraRay(u, v, kf.tanHalfH * scale, kf.tanHalfV * scale));
}

/**
 * d(world ray)/d(log scale), for the focal-length unknown.
 *
 * Written out rather than differenced numerically because the whole point of
 * the sub-pixel matching upstream is that residuals here are a hundredth of a
 * degree, and a finite difference at that size is mostly rounding.
 */
function rayFocalDerivative(kf, u, v, q, scale) {
  const a = u * kf.tanHalfH, b = v * kf.tanHalfV;
  const x = a * scale, y = b * scale;
  const L = Math.hypot(x, y, 1);
  const dot = (a * x + b * y) / (L * L * L);      // p . dp/ds  over |p|^3
  // d(p/|p|)/ds, then chain through ds/d(lambda) = s.
  const d = [
    scale * (a / L - x * dot),
    scale * (b / L - y * dot),
    scale * (0 / L + 1 * dot)                      // p_z = -1, so -p_z*dot = +dot
  ];
  return quatRotate(q, d);
}

/** Project a world direction into a keyframe. Returns [u, v] or null. */
function project(world, qc, tanH, tanV) {
  const c = quatRotate(qc, world);
  const depth = -c[2];
  if (depth <= 1e-6) return null;
  const u = c[0] / depth / tanH, v = c[1] / depth / tanV;
  return (u < -1 || u > 1 || v < -1 || v > 1) ? null : [u, v];
}

/**
 * Match one keyframe's features into another, using the current rotations to
 * predict where each should land and searching only nearby.
 *
 * The prior does the heavy lifting: sensor attitudes are wrong by degrees, not
 * by tens of degrees, so a small search window is enough and the ambiguity that
 * makes wide-baseline matching hard never arises.
 */
export function matchPair(A, B, kfA, kfB, qA, qB, { searchPx = 26, minScore = 0.72, ratio = 0.86 } = {}) {
  const qcB = quatConj(qB);
  const out = [];
  for (const f of A.feats) {
    const world = rayOf(kfA, f.u, f.v, qA);
    const p = project(world, qcB, kfB.tanHalfH, kfB.tanHalfV);
    if (!p) continue;
    const cx = Math.round((p[0] + 1) / 2 * B.w - 0.5);
    const cy = Math.round((1 - p[1]) / 2 * B.h - 0.5);
    let best = -2, second = -2, bpx = -1, bpy = -1;
    for (const g of B.feats) {
      if (Math.abs(g.px - cx) > searchPx || Math.abs(g.py - cy) > searchPx) continue;
      const s = ncc(f.desc, g.desc);
      if (s > best) { second = best; best = s; bpx = g.px; bpy = g.py; }
      else if (s > second) second = s;
    }
    // A match must be good AND clearly better than the runner-up, or it is a
    // repeated texture — siding, brickwork, a row of fence posts — and those
    // are what quietly pull a panorama out of shape.
    if (best >= minScore && (second < 0 || second / best < ratio) && bpx >= 0) {
      // Refine to sub-pixel by fitting a parabola through the correlation
      // either side of the winner. Integer pixels are not good enough here: at
      // a 640-wide thumbnail across 45° one pixel is 0.07°, and that
      // quantisation alone was the entire residual left after everything else
      // had been fixed — a visible seam is about a pixel of disagreement.
      const off = subpixel(f.desc, B, bpx, bpy, patchOf(f.desc));
      out.push({
        ua: f.u, va: f.v,
        ub: uOf(bpx + off.dx, B.w), vb: vOf(bpy + off.dy, B.h),
        score: best
      });
    }
  }
  return out;
}

/**
 * The single rotation that best carries one set of directions onto another,
 * by Davenport's q-method: build the symmetric 4x4 whose dominant eigenvector
 * IS the quaternion, then find that eigenvector by power iteration. No SVD, no
 * matrix library, and it degrades gracefully when the directions are nearly
 * coplanar — which they are here, since a frame's rays all fall inside a cone.
 */
export function bestRotation(a, b, weights) {
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0;
  for (let i = 0; i < a.length; i++) {
    const w = weights ? weights[i] : 1;
    const p = a[i], q = b[i];
    sxx += w * q[0] * p[0]; sxy += w * q[0] * p[1]; sxz += w * q[0] * p[2];
    syx += w * q[1] * p[0]; syy += w * q[1] * p[1]; syz += w * q[1] * p[2];
    szx += w * q[2] * p[0]; szy += w * q[2] * p[1]; szz += w * q[2] * p[2];
  }
  const tr = sxx + syy + szz;
  const K = [
    [tr, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, syy - sxx - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, szz - sxx - syy]
  ];
  // Shift to make the dominant eigenvalue the largest in magnitude.
  const shift = Math.abs(tr) + 3;
  let v = [1, 0, 0, 0];
  for (let it = 0; it < 60; it++) {
    const nv = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      let s = shift * v[i];
      for (let j = 0; j < 4; j++) s += K[i][j] * v[j];
      nv[i] = s;
    }
    const n = Math.hypot(...nv) || 1;
    for (let i = 0; i < 4; i++) nv[i] /= n;
    let d = 0; for (let i = 0; i < 4; i++) d += Math.abs(nv[i] - v[i]);
    v = nv;
    if (d < 1e-12) break;
  }
  return v[0] < 0 ? v.map(x => -x) : v;
}

/**
 * Throw out the matches that do not agree with a single relative rotation.
 *
 * Descriptor similarity alone is not enough on the things this app photographs:
 * clapboard siding, fence palings, roof shingles and window rows are periodic,
 * so a patch can match its neighbour's neighbour with complete confidence. A
 * handful of such matches is all it takes to drag frames degrees out of place,
 * and in testing they held the solution at 1.7° of disagreement no matter how
 * many good matches surrounded them. Any pair of overlapping frames differs by
 * exactly ONE rotation, so fitting that rotation and discarding whatever
 * disagrees with it removes them wholesale.
 */
export function verifyPair(matches, kfA, kfB, qA, qB, {
  schedule = [4, 1.6, 0.8, 0.45, 0.3], minKeep = 8, scale = 1
} = {}) {
  if (matches.length < minKeep) return [];
  let keep = matches;
  // A TIGHTENING schedule, not an adaptive one. The first attempt used
  // max(tol, median * 3), which is backwards: when a pair is polluted the
  // median is large, so the cut grows and the pollution is kept. That single
  // sign error held the whole solution at a degree of disagreement no matter
  // what else was improved. Fixed thresholds that only ever shrink cannot do
  // that — each round removes what the previous round's fit exposed.
  // The tolerance schedule and the focal length interact, and it took a
  // synthetic capture with a deliberately wrong lens to see how. A focal error
  // displaces a feature by an amount that GROWS WITH ITS DISTANCE FROM THE
  // OPTICAL CENTRE — zero in the middle, about a degree at the edge for a 6%
  // error. Tighten to 0.3 degrees while still using the wrong lens and the only
  // matches that survive are the central ones, which are precisely the matches
  // that carry no information about focal length. The verifier quietly deletes
  // the evidence needed to fix the thing making it delete the evidence.
  //
  // So the scale in force is an input here. The caller verifies loosely first,
  // solves for the lens, then verifies again at the scale it found.
  for (const cut of schedule) {
    const A = keep.map(m => rayOf(kfA, m.ua, m.va, qA, scale));
    const B = keep.map(m => rayOf(kfB, m.ub, m.vb, qB, scale));
    const rot = bestRotation(A, B, keep.map(m => m.score || 1));
    const errs = keep.map((m, i) => {
      const p = quatRotate(rot, A[i]);
      const dot = Math.max(-1, Math.min(1, p[0] * B[i][0] + p[1] * B[i][1] + p[2] * B[i][2]));
      return Math.acos(dot) / DEG;
    });
    const next = keep.filter((m, i) => errs[i] <= cut);
    // Stop tightening rather than starve the pair; a pair with too few
    // survivors is dropped by the caller and contributes nothing, which is
    // the correct outcome for two frames that never really agreed.
    if (next.length < minKeep) break;
    keep = next;
  }
  return keep.length >= minKeep ? keep : [];
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Small-angle rotation vector to quaternion. */
function expQuat(w) {
  const t = Math.hypot(...w);
  if (t < 1e-12) return [1, 0, 0, 0];
  const h = t / 2, s = Math.sin(h) / t;
  return [Math.cos(h), w[0] * s, w[1] * s, w[2] * s];
}

/**
 * Nudge every keyframe's rotation until matched features agree, holding tilt to
 * what gravity says and letting azimuth move.
 *
 * `frames` is [{ kf, q }]; `pairs` is [{ i, j, matches }]. Returns one corrected
 * quaternion per frame, plus what it cost.
 *
 * tiltStiffness / yawStiffness are the prior weights. The default ratio is
 * deliberately lopsided: fifty to one. Tilting a frame is how a solver
 * "explains" a bad match cheaply, and letting it do that would put a lean in
 * the horizon that no operator could correct by dragging a line. Azimuth has no
 * such anchor and is exactly what needs freeing.
 */
export function refineRotations(frames, pairs, {
  iterations = 30, tiltStiffness = 50, yawStiffness = 0.5, huber = 0.01,
  solveFocal = false, focalStiffness = 40
} = {}) {
  const n = frames.length;
  const q = frames.map(f => f.q.slice());
  let lastCost = Infinity, matchCount = 0;
  // One focal unknown for the whole survey, held as log scale so the step is
  // symmetric in "6% wider" and "6% narrower". Per-frame focal was considered
  // and rejected: the lens does not change during a lap, and n free focal
  // lengths would let the solver absorb genuine misalignment into fake zoom.
  let lambda = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const scale = Math.exp(lambda);
    const fi = 3 * n;                       // index of the focal unknown
    const N = 3 * n + (solveFocal ? 1 : 0);
    const H = new Float64Array(N * N);
    const g = new Float64Array(N);
    let cost = 0; matchCount = 0;

    for (const pr of pairs) {
      const { i, j } = pr;
      for (const m of pr.matches) {
        const da = rayOf(frames[i].kf, m.ua, m.va, q[i], scale);
        const db = rayOf(frames[j].kf, m.ub, m.vb, q[j], scale);
        const r = [da[0] - db[0], da[1] - db[1], da[2] - db[2]];
        const rn = Math.hypot(...r);
        // Huber: a handful of wrong matches always survive the ratio test, and
        // squared error would let them steer the whole solution.
        const wgt = (rn <= huber ? 1 : huber / rn) * (m.score || 1);
        cost += wgt * rn * rn; matchCount++;

        // d(residual)/d(omega_i) = -[da]x ,  d/d(omega_j) = +[db]x
        const Ja = [[0, da[2], -da[1]], [-da[2], 0, da[0]], [da[1], -da[0], 0]];
        const Jb = [[0, -db[2], db[1]], [db[2], 0, -db[0]], [-db[1], db[0], 0]];
        const bi = 3 * i, bj = 3 * j;
        for (let a = 0; a < 3; a++) {
          for (let b = 0; b < 3; b++) {
            let hij = 0, hii = 0, hjj = 0;
            for (let k = 0; k < 3; k++) {
              hii += Ja[k][a] * Ja[k][b];
              hjj += Jb[k][a] * Jb[k][b];
              hij += Ja[k][a] * Jb[k][b];
            }
            H[(bi + a) * N + bi + b] += wgt * hii;
            H[(bj + a) * N + bj + b] += wgt * hjj;
            H[(bi + a) * N + bj + b] += wgt * hij;
            H[(bj + a) * N + bi + b] += wgt * hij;
          }
          let ga = 0, gb = 0;
          for (let k = 0; k < 3; k++) { ga += Ja[k][a] * r[k]; gb += Jb[k][a] * r[k]; }
          g[bi + a] -= wgt * ga;
          g[bj + a] -= wgt * gb;
        }

        if (!solveFocal) continue;
        // Both frames share the one focal length, so the two derivatives
        // subtract. A pair whose matches all sit at the same image radius
        // contributes almost nothing here, which is correct: such a pair
        // genuinely cannot tell you the focal length.
        const fa = rayFocalDerivative(frames[i].kf, m.ua, m.va, q[i], scale);
        const fb = rayFocalDerivative(frames[j].kf, m.ub, m.vb, q[j], scale);
        const Jf = [fa[0] - fb[0], fa[1] - fb[1], fa[2] - fb[2]];
        let ff = 0, gf = 0;
        for (let k = 0; k < 3; k++) { ff += Jf[k] * Jf[k]; gf += Jf[k] * r[k]; }
        H[fi * N + fi] += wgt * ff;
        g[fi] -= wgt * gf;
        for (let a = 0; a < 3; a++) {
          let cia = 0, cja = 0;
          for (let k = 0; k < 3; k++) { cia += Ja[k][a] * Jf[k]; cja += Jb[k][a] * Jf[k]; }
          H[(bi + a) * N + fi] += wgt * cia;
          H[fi * N + bi + a] += wgt * cia;
          H[(bj + a) * N + fi] += wgt * cja;
          H[fi * N + bj + a] += wgt * cja;
        }
      }
    }

    // Prior. World vertical expressed as a direction in the correction space is
    // simply world z, because these corrections are applied in the world frame.
    for (let i = 0; i < n; i++) {
      const b = 3 * i;
      // Split the penalty: about z is yaw, the other two are tilt.
      H[(b + 0) * N + b + 0] += tiltStiffness;
      H[(b + 1) * N + b + 1] += tiltStiffness;
      H[(b + 2) * N + b + 2] += yawStiffness;
    }

    // The focal prior is a real prior, not the step damping used above: it
    // carries a gradient that pulls the accumulated scale back toward the
    // measured lens. The rotations are each anchored by their own sensor
    // attitude, but the focal length is one unknown shared by every frame with
    // nothing else holding it, and an unanchored global scale on a nearly
    // planar match set will wander. Also: this keeps H positive definite when
    // the matches happen to be uninformative about focal length, so a
    // degenerate capture returns "no change" instead of failing the solve.
    if (solveFocal) {
      H[fi * N + fi] += focalStiffness;
      g[fi] -= focalStiffness * lambda;
    }

    const delta = solveSPD(H, g, N);
    if (!delta) break;

    let maxStep = 0;
    for (let i = 0; i < n; i++) {
      const w = [delta[3 * i], delta[3 * i + 1], delta[3 * i + 2]];
      maxStep = Math.max(maxStep, Math.hypot(...w));
      q[i] = quatMul(expQuat(w), q[i]);        // correction is in the WORLD frame
      const nq = Math.hypot(...q[i]);
      for (let k = 0; k < 4; k++) q[i][k] /= nq;
    }
    if (solveFocal && Number.isFinite(delta[fi])) {
      // Clamp the per-iteration focal step. Gauss-Newton on a scale parameter
      // can overshoot hard on the first iteration, and a wild scale poisons the
      // rotation Jacobians for every iteration after it.
      lambda += Math.max(-0.05, Math.min(0.05, delta[fi]));
      maxStep = Math.max(maxStep, Math.abs(delta[fi]));
    }
    lastCost = cost;
    if (maxStep < 1e-6) break;
  }

  // How far each frame ended up from where its sensors put it.
  const moved = frames.map((f, i) => {
    const rel = quatMul(q[i], quatConj(f.q));
    return 2 * Math.acos(Math.min(1, Math.abs(rel[0]))) / DEG;
  });
  return {
    q,
    matchCount,
    cost: lastCost,
    rmsDeg: matchCount ? Math.sqrt(lastCost / matchCount) / DEG : null,
    movedDeg: moved,
    maxMovedDeg: moved.length ? Math.max(...moved) : 0,
    focalScale: Math.exp(lambda)
  };
}

/** Cholesky solve for a symmetric positive-definite system. */
function solveSPD(H, g, N) {
  const L = new Float64Array(N * N);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j <= i; j++) {
      let s = H[i * N + j];
      for (let k = 0; k < j; k++) s -= L[i * N + k] * L[j * N + k];
      if (i === j) {
        if (s <= 1e-12) return null;
        L[i * N + i] = Math.sqrt(s);
      } else {
        L[i * N + j] = s / L[j * N + j];
      }
    }
  }
  const y = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = g[i];
    for (let k = 0; k < i; k++) s -= L[i * N + k] * y[k];
    y[i] = s / L[i * N + i];
  }
  const x = new Float64Array(N);
  for (let i = N - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < N; k++) s -= L[k * N + i] * x[k];
    x[i] = s / L[i * N + i];
  }
  return x;
}

/** Which keyframe pairs overlap enough to be worth matching. */
export function overlappingPairs(frames, { minSepDeg = 1.5 } = {}) {
  const axes = frames.map(f => quatRotate(f.q, [0, 0, -1]));
  const halfDiag = frames.map(f => Math.atan(Math.hypot(f.kf.tanHalfH, f.kf.tanHalfV)) / DEG);
  const pairs = [];
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const dot = axes[i][0] * axes[j][0] + axes[i][1] * axes[j][1] + axes[i][2] * axes[j][2];
      const sep = Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
      // Overlapping, but not so nearly identical that the pair says nothing.
      if (sep < (halfDiag[i] + halfDiag[j]) * 0.8 && sep > minSepDeg) pairs.push({ i, j, sep });
    }
  }
  return pairs;
}

void cross;
