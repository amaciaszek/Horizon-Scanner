'use strict';

import { matchPair, verifyPair } from './bundle.js';
import { angDiff, wrap360, DEG, RAD } from './math3d.js';

/**
 * Measuring the lens from the survey that was already taken.
 *
 * The 2026-08-15 capture went out with a field of view nobody had measured: a
 * known-device table said 45.6 degrees across the working frame, the guided
 * lens step was skipped because of it, and the real answer was about 48.2. Six
 * percent of focal length. That error contributes nothing at the optical centre
 * and about a degree at the frame edge, which is exactly the overlap region
 * where neighbouring frames are supposed to agree.
 *
 * WHY NOT JUST SOLVE IT IN THE BUNDLE ADJUSTMENT. That was tried first, and
 * measured on this capture's own photographs it does not work. Sweeping the
 * focal length across plus or minus fourteen percent and re-solving the
 * rotations at each step moves the mean pairwise disagreement from 1.147 to
 * 1.183 degrees — a three percent change in the thing being minimised. The
 * residual is dominated by parallax from a house twelve metres away, and that
 * parallax is an order of magnitude larger than the focal signal. A solver
 * handed that cost surface returns a confident number that is simply the shape
 * of the noise; on this capture it returned 0.99 when the truth was 1.07.
 *
 * WHAT DOES WORK is a different observation entirely, and the survey already
 * collects it. Take two photographs of the SAME bearing from different laps.
 * The operator stood in the same place both times, so parallax largely cancels.
 * They did not hold the same elevation, so the two frames differ by a known
 * angle that gravity measured directly — the most trustworthy number the device
 * produces. How far the scenery slid vertically between those two frames, over
 * how far the camera actually tilted, IS the focal length.
 *
 * On the 61-frame capture this recovers 48.4 degrees against the offline
 * analysis's 48.2, from eleven pairs, with a correlation of 0.997 between the
 * measured shift and the sensor elevation change. The estimator is
 * well-conditioned precisely where the bundle adjustment is not.
 */

const finite = value => Number.isFinite(value);

/** Bearing a keyframe was captured at, in the same convention as capture-gaps. */
function headingDeg(kf, yawDatumDeg = 0) {
  const correction = finite(kf?.yawCorrection) ? kf.yawCorrection : 0;
  if (finite(kf?.yawFused)) return wrap360(kf.yawFused + yawDatumDeg + correction);
  return wrap360((finite(kf?.yawRaw) ? kf.yawRaw : 0)
    + (finite(kf?.yawBase) ? kf.yawBase : 0) + yawDatumDeg + correction);
}

function median(values) {
  if (!values.length) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Two frames count as a repeat view when they point the same way but were not
 * taken moments apart. Pass number is the obvious test and it is not sufficient:
 * the capture this was written for labelled two physical laps as pass 1, so a
 * pass-only rule would have found nothing. Time separation catches it either way.
 */
function isRepeatView(a, b, { maxAzimuthGapDeg, minSeparationMs }) {
  const differentPass = finite(a.pass) && finite(b.pass) && a.pass !== b.pass;
  const apart = finite(a.t) && finite(b.t) && Math.abs(a.t - b.t) >= minSeparationMs;
  return (differentPass || apart)
    && Math.abs(angDiff(a.azimuth, b.azimuth)) <= maxAzimuthGapDeg;
}

/**
 * Fit the vertical half-angle tangent from repeat-view pairs.
 *
 * `features` is the per-keyframe output of `extractFeatures`, indexed to match
 * `keyframes`; entries may be null where no photograph was available.
 */
export function crossLapFocalCheck({
  keyframes, features, quats = null, yawDatum = 0,
  maxAzimuthGapDeg = 6, minElevationChangeDeg = 1.5, minSeparationMs = 15000,
  // A dozen matches is plenty for a median, and the floor has to be reachable:
  // at 20 it rejected 31 of the 61 repeat views on the capture this was built
  // for, because a lap-apart pair only matches the features common to two
  // capped feature sets. Each pair is weighted by its match count anyway, so a
  // thin pair contributes in proportion to how much it actually knows.
  minMatches = 12, minPairs = 5, minAbsCorrelation = 0.9, maxChange = 0.25,
  searchPx = 40
} = {}) {
  const n = keyframes?.length || 0;
  const usable = [];
  for (let i = 0; i < n; i++) {
    const kf = keyframes[i];
    if (!features?.[i] || !finite(kf?.tanHalfV) || kf.tanHalfV <= 0) continue;
    if (kf.captureKind === 'obstruction-probe') continue;
    usable.push({
      i, kf,
      // Placed pose when the caller has one — the datum and loop correction are
      // per-frame, so raw sensor quaternions would predict the wrong overlap.
      q: quats?.[i] || kf.quat || kf.q,
      azimuth: headingDeg(kf, yawDatum),
      elevation: finite(kf.elevation) ? kf.elevation : NaN,
      pass: kf.pass, t: finite(kf.t) ? kf.t : NaN
    });
  }

  const collect = scale => {
  const rows = [];
  const paired = new Set();
  const rejected = { noRepeatView: 0, noElevationLever: 0, tooFewMatches: 0 };
  for (const a of usable) {
    if (!finite(a.elevation)) continue;
    // Candidates ordered by how closely they repeat this bearing, then taken in
    // that order until one has a usable elevation difference. Picking only the
    // single nearest bearing throws the pair away whenever the operator
    // happened to hold the same elevation on both laps, which on a real survey
    // is most of the flat sectors — and those are the easy, reliable pairs.
    const options = usable
      .filter(b => b.i !== a.i && finite(b.elevation)
        && !paired.has(`${b.i}:${a.i}`) && !paired.has(`${a.i}:${b.i}`)
        && isRepeatView(a, b, { maxAzimuthGapDeg, minSeparationMs }))
      .sort((x, y) => Math.abs(angDiff(x.azimuth, a.azimuth)) - Math.abs(angDiff(y.azimuth, a.azimuth)));
    if (!options.length) { rejected.noRepeatView++; continue; }
    // Without a lever arm there is no measurement. Two frames at the same
    // elevation say nothing at all about focal length, and including them only
    // adds points at the origin that flatter the correlation.
    const best = options.find(b => Math.abs(b.elevation - a.elevation) >= minElevationChangeDeg);
    if (!best) { rejected.noElevationLever++; continue; }
    const bestGap = Math.abs(angDiff(best.azimuth, a.azimuth));
    const dElevation = best.elevation - a.elevation;
    paired.add(`${a.i}:${best.i}`);

    const raw = matchPair(
      features[a.i], features[best.i], a.kf, best.kf, a.q, best.q, { searchPx }
    );
    // Verified at the scale currently believed, and the whole function is run
    // twice for exactly this reason. A focal error displaces a feature in
    // proportion to its distance from the optical centre, so verifying at the
    // wrong scale culls the frame-edge matches first — and those are the ones
    // carrying the signal. Verify at scale 1 only and the fit is biased toward
    // the centre matches, which is to say biased toward the wrong answer it
    // started with. On the reference capture that single effect was the
    // difference between 47.0 and 48.3 degrees.
    const matches = verifyPair(
      raw, a.kf, best.kf, a.q, best.q, { schedule: [4, 1.6, 0.8], scale }
    );
    if (matches.length < minMatches) { rejected.tooFewMatches++; continue; }
    rows.push({
      from: a.i, to: best.i,
      azimuthGapDeg: bestGap,
      elevationChangeDeg: dElevation,
      // Median rather than mean: a handful of matches on the moving parts of
      // the scene, or on the near roof, would drag a mean and cannot drag this.
      medianShiftV: median(matches.map(m => m.vb - m.va)),
      matchCount: matches.length,
      va: matches.map(m => m.va),
      vb: matches.map(m => m.vb)
    });
  }
  return { rows, rejected };
  };

  const statedTanHalfV = n ? keyframes[0].tanHalfV : null;
  const base = {
    statedTanHalfV,
    statedVfovDeg: statedTanHalfV > 0 ? 2 * Math.atan(statedTanHalfV) * RAD : null
  };

  /*
   * Fit tanHalfV from repeat-view rows, using the exact projection.
   *
   * A feature sits at v = tan(theta) / tanHalfV, where theta is its angle from
   * the optical axis. Tilt the camera up by dC and it moves to
   * tan(theta - dC) / tanHalfV. The obvious shortcut — treat the shift as
   * simply -tan(dC) / tanHalfV — is that expression evaluated at theta = 0, and
   * it is exact only for a feature dead on the axis. Real matches are spread
   * across the whole frame, the tangent is convex, so the average shift is
   * larger than the on-axis shortcut predicts and the fitted tangent comes out
   * too SMALL. Measured on the synthetic fixture, that bias alone reported
   * 47.2 degrees for a camera that genuinely had 48.26 — a 2% systematic error
   * that no amount of extra data would remove, because it is in the model
   * rather than in the noise.
   *
   * So the fit is done against the real expression by a one-dimensional search,
   * scoring each candidate by the MEDIAN absolute residual over every match in
   * every pair. Median rather than sum of squares because a nearby roof
   * genuinely does move between laps, and those matches must not be allowed to
   * buy influence in proportion to how wrong they are.
   */
  const residualAt = (rows, tanV) => {
    const residuals = [];
    for (const row of rows) {
      const dC = row.elevationChangeDeg * DEG;
      for (let m = 0; m < row.va.length; m++) {
        const theta = Math.atan(row.va[m] * tanV);
        residuals.push(Math.abs(Math.tan(theta - dC) / tanV - row.vb[m]));
      }
    }
    return median(residuals);
  };

  const fit = rows => {
    if (!rows.length) return { tanHalfV: NaN, correlation: 0 };
    // Coarse-to-fine over the plausible range. The surface is smooth and
    // single-minimum in this window, so this is cheaper and more predictable
    // than a gradient method, and it cannot diverge.
    let lo = 0.6, hi = 1.6;
    for (let round = 0; round < 4; round++) {
      let bestScale = lo, best = Infinity;
      const step = (hi - lo) / 40;
      for (let s = lo; s <= hi + 1e-9; s += step) {
        const score = residualAt(rows, statedTanHalfV * s);
        if (score < best) { best = score; bestScale = s; }
      }
      lo = Math.max(0.5, bestScale - step); hi = Math.min(2.0, bestScale + step);
    }
    const tanHalfV = statedTanHalfV * (lo + hi) / 2;

    // Correlation of the on-axis observation is kept purely as a quality
    // signal: it says the scenery moved the way the elevation sensor said it
    // did, which is what distinguishes a real measurement from a coincidence.
    let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
    for (const row of rows) {
      const x = -Math.tan(row.elevationChangeDeg * DEG), y = row.medianShiftV;
      sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
    }
    const k = rows.length;
    const denom = Math.sqrt((k * sxx - sx * sx) * (k * syy - sy * sy));
    return { tanHalfV, correlation: denom > 0 ? (k * sxy - sx * sy) / denom : 0 };
  };

  // Two passes. The first is done believing the stated lens, which biases the
  // verification against the very matches that would correct it; the second is
  // done believing the first pass's answer, and lands.
  let scale = 1;
  let pass = collect(scale);
  let solution = fit(pass.rows);
  let iterations = 1;
  if (pass.rows.length >= minPairs && finite(solution.tanHalfV) && solution.tanHalfV > 0) {
    const first = solution.tanHalfV / statedTanHalfV;
    if (Math.abs(first - 1) <= maxChange) {
      const second = collect(first);
      const refit = fit(second.rows);
      if (second.rows.length >= minPairs && finite(refit.tanHalfV) && refit.tanHalfV > 0) {
        scale = first; pass = second; solution = refit; iterations = 2;
      }
    }
  }

  const result = {
    ...base,
    pairCount: pass.rows.length, pairs: pass.rows,
    rejected: pass.rejected, candidateCount: usable.length,
    iterations, verifiedAtScale: scale
  };
  if (pass.rows.length < minPairs) {
    return { ...result, measured: false, reason: 'too-few-repeat-views', scale: 1 };
  }
  if (!finite(solution.tanHalfV) || solution.tanHalfV <= 0) {
    return { ...result, measured: false, reason: 'degenerate-fit', scale: 1, correlation: solution.correlation };
  }
  const fittedScale = solution.tanHalfV / statedTanHalfV;
  const trusted = solution.correlation >= minAbsCorrelation
    && Math.abs(fittedScale - 1) <= maxChange;
  return {
    ...result,
    measured: trusted,
    reason: trusted ? 'cross-lap-elevation-regression'
      : solution.correlation < minAbsCorrelation ? 'shift-does-not-track-elevation'
      : 'implausible-magnitude',
    correlation: solution.correlation,
    fittedTanHalfV: solution.tanHalfV,
    fittedVfovDeg: 2 * Math.atan(solution.tanHalfV) * RAD,
    scale: trusted ? fittedScale : 1,
    rawScale: fittedScale
  };
}
