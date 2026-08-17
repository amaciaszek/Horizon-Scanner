'use strict';

import { matchPair, verifyPair } from './bundle.js';
import { angDiff, wrap360, DEG, RAD } from './math3d.js';

/**
 * Measuring the lens from the survey that was already taken.
 *
 * The 2026-08-15 capture went out with a field of view nobody had measured: a
 * known-device table said 45.6 degrees across the working frame and the guided
 * lens step was skipped because of it. Whether that number was actually wrong
 * turned out to be a harder question than it looked, and the history is worth
 * keeping because two plausible methods gave two confidently wrong answers
 * before the third gave a defensible one.
 *
 * WHY NOT SOLVE IT IN THE BUNDLE ADJUSTMENT. That was tried first and does not
 * work here. Sweeping focal length across plus or minus fourteen percent and
 * re-solving the rotations at each step moves the mean pairwise disagreement
 * from 1.147 to 1.183 degrees — a three percent change in the quantity being
 * minimised. Parallax from a house twelve metres away dominates that residual
 * and is an order of magnitude larger than the focal signal, so the solver
 * descends the shape of the noise and reports it as a lens. On this capture it
 * returned 0.99 where other evidence said 1.07.
 *
 * WHAT THIS DOES INSTEAD. Two photographs of the same bearing from different
 * laps were taken from roughly the same standing position, so parallax largely
 * cancels; they differ by an elevation that gravity measured directly. How far
 * the scenery slid vertically over how far the camera actually tilted is the
 * focal length, and it is well conditioned precisely where the bundle
 * adjustment is not.
 *
 * "LARGELY CANCELS" IS NOT "CANCELS", AND THAT IS THE WHOLE PROBLEM. On the
 * reference capture the horizontal spread of feature shift within a repeat-view
 * pair — which a pure rotation cannot produce, and a change of viewpoint can —
 * has a median of 0.208 in normalised image units against 0.03 to 0.055 for a
 * clean synthetic rotation. The operator moved between laps, around a close
 * building, and most pairs carry it. Admitting them all gives 50.1 degrees with
 * the pairs disagreeing among themselves by 0.09; admitting only the pairs
 * whose lateral spread stays under 0.12 gives 45.6 degrees with the survivors
 * agreeing to 0.016. The parallax was worth three to four degrees of apparent
 * field of view, and an earlier pass at this reported the contaminated figure.
 *
 * So the gates below are not defensive padding. Once they are applied, the
 * 61-frame capture yields three low-parallax pairs that agree the lens was
 * about what the table said — and three is below `minPairs`, so the honest
 * outcome on that capture is that it declines to move anything. A survey shot
 * from a tripod, or one further from the building, is what this needs to
 * measure a lens it can stand behind.
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
  // Spread of horizontal shift across the frame, in normalised image units
  // (1.0 is a half-width). Rotation moves everything together; a change of
  // viewpoint moves near things more than far things. Clean synthetic rotation
  // measures 0.03-0.055, so this leaves roughly a factor of two of headroom.
  maxLateralSpread = 0.12,
  // How much the pairs may disagree about the lens before the answer is treated
  // as a fit to something other than the lens.
  maxScaleDisagreement = 0.05,
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
      // The uncorrected sensor attitude, kept as a fallback for pair matching.
      rawQ: kf.quat || kf.q || null,
      azimuth: headingDeg(kf, yawDatum),
      elevation: finite(kf.elevation) ? kf.elevation : NaN,
      pass: kf.pass, t: finite(kf.t) ? kf.t : NaN
    });
  }

  const collect = scale => {
  const rows = [];
  const paired = new Set();
  const rejectedPairs = [];
  const rejected = {
    noRepeatView: 0, noElevationLever: 0, tooFewMatches: 0,
    lateralMotion: 0, disagreesWithOtherPairs: 0
  };
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

    /*
     * Two candidate poses, and the pictures decide.
     *
     * The pose the panorama places a frame at is the sensor attitude with the
     * fused-yaw correction applied. Over the reference capture that correction
     * grew from 0.02 to 15.8 degrees — the gyro-led fusion drifting about ten
     * degrees per lap against the device's own orientation. For frames a lap
     * apart that difference lands squarely between them, and it wrecks the
     * matching it is supposed to help: pairs that produce 17, 14 and 26 clean
     * matches from the raw attitudes produce 0, 1 and 2 from the placed ones.
     *
     * Which convention is "right" is a real question about that capture and not
     * one this function should answer by assuming. It only needs a pose good
     * enough to predict where a feature lands, so it tries the placed pose,
     * falls back to the raw attitude when that finds too little, and records
     * which it used. The measurement itself rests on vertical shift against
     * gravity-derived elevation, so neither choice biases the answer — a wrong
     * yaw costs matches, not degrees.
     */
    const attempt = (qa, qb, pose) => {
      const raw = matchPair(features[a.i], features[best.i], a.kf, best.kf, qa, qb, { searchPx });
      const matches = verifyPair(raw, a.kf, best.kf, qa, qb, { schedule: [4, 1.6, 0.8], scale });
      return { matches, pose, rawCount: raw.length };
    };
    // Verified at the scale currently believed, and the whole function runs
    // twice for exactly that reason. A focal error displaces a feature in
    // proportion to its distance from the optical centre, so verifying at the
    // wrong scale culls the frame-edge matches first — and those are the ones
    // carrying the signal.
    let attempted = attempt(a.q, best.q, 'placed');
    if (attempted.matches.length < minMatches && (a.rawQ || best.rawQ)) {
      const fallback = attempt(a.rawQ || a.q, best.rawQ || best.q, 'raw-attitude');
      if (fallback.matches.length > attempted.matches.length) attempted = fallback;
    }
    const matches = attempted.matches;
    if (matches.length < minMatches) { rejected.tooFewMatches++; continue; }

    /*
     * Lateral-motion test.
     *
     * The whole reason a repeat view can measure the lens is that the operator
     * stood in the same place both times, so the two frames differ by a
     * rotation and nothing else. That assumption is not free, and around a
     * house twelve metres away it is the assumption most likely to be false: a
     * step sideways between laps moves near features and leaves far ones alone,
     * which is a displacement no rotation and no focal length can explain.
     *
     * Only the SPREAD of horizontal shift is tested, never its median. The
     * median is whatever the two bearings differ by, and predicting it would
     * mean asserting a handedness for the azimuth convention — the exact class
     * of sign assumption that has already cost this project one survey. The
     * spread needs no convention at all: a rotation carries the whole frame
     * together, and only a change of viewpoint moves near things further than
     * far ones. Measured on a clean synthetic rotation with up to 7 degrees of
     * tilt difference, the spread stays under 0.055; the threshold sits at
     * roughly twice that.
     */
    const du = matches.map(m => m.ub - m.ua);
    const sorted = du.slice().sort((x, y) => x - y);
    const medianDu = median(du);
    const duSpread = sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)];
    if (duSpread > maxLateralSpread) {
      rejected.lateralMotion++;
      rejectedPairs.push({
        from: a.i, to: best.i, reason: 'lateral-motion',
        azimuthGapDeg: Number(bestGap.toFixed(3)),
        elevationChangeDeg: Number(dElevation.toFixed(3)),
        medianHorizontalShift: Number(medianDu.toFixed(4)),
        horizontalShiftSpread: Number(duSpread.toFixed(4)),
        matchCount: matches.length
      });
      continue;
    }

    rows.push({
      from: a.i, to: best.i,
      azimuthGapDeg: bestGap,
      elevationChangeDeg: dElevation,
      medianHorizontalShift: medianDu,
      horizontalShiftSpread: duSpread,
      pose: attempted.pose,
      // Median rather than mean: a handful of matches on the moving parts of
      // the scene, or on the near roof, would drag a mean and cannot drag this.
      medianShiftV: median(matches.map(m => m.vb - m.va)),
      matchCount: matches.length,
      va: matches.map(m => m.va),
      vb: matches.map(m => m.vb)
    });
  }
  return { rows, rejected, rejectedPairs };
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

  /* Coarse-to-fine over the plausible range. The surface is smooth and
   * single-minimum in this window, so this is cheaper and more predictable than
   * a gradient method, and it cannot diverge. */
  const searchScale = rows => {
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
    return (lo + hi) / 2;
  };

  const fit = rows => {
    if (!rows.length) return { tanHalfV: NaN, correlation: 0, rows, perPairScales: [] };

    /*
     * Do the pairs agree with each other?
     *
     * This is the guard the lateral-motion test cannot provide. A lens is one
     * number for the whole survey, so every repeat view must imply the same
     * one. Parallax does not respect that: a pair looking at the near roofline
     * carries a displacement that depends on depth, and fitting a focal length
     * to it produces a different answer from a pair looking at trees two
     * hundred metres away. Solving each pair on its own and then asking whether
     * they concur turns that into something measurable — and if they do not
     * concur, the global number is a fit to geometry that is not the lens, no
     * matter how confidently it converges.
     */
    const perPairScales = rows.map(row => searchScale([row]));
    const centre = median(perPairScales);
    const deviations = perPairScales.map(s => Math.abs(s - centre)).sort((a, b) => a - b);
    const spread = deviations[Math.floor(deviations.length / 2)] || 0;
    // Keep pairs within a robust band of the consensus. The floor stops a
    // freakishly tight cluster from rejecting a perfectly ordinary pair.
    const band = Math.max(0.02, spread * 3);
    const kept = rows.filter((row, i) => Math.abs(perPairScales[i] - centre) <= band);
    const outliers = rows
      .map((row, i) => ({ row, scale: perPairScales[i] }))
      .filter(({ scale }) => Math.abs(scale - centre) > band);
    // Pairs that disagree with the consensus are excluded from the fit, always.
    // An earlier version fell back to using every row whenever fewer than
    // `minPairs` survived — which disabled the outlier rejection in exactly the
    // case it exists for. On the reference capture that turned three agreeing
    // pairs plus two wild ones into a confident answer drawn from all five.
    // Thinness is a reason to distrust the result, not a reason to pad it out
    // with the rows already identified as wrong; the trust gate handles that.
    const usableRows = kept.length >= 3 ? kept : rows;

    const tanHalfV = statedTanHalfV * searchScale(usableRows);

    // Correlation of the on-axis observation is kept purely as a quality
    // signal: it says the scenery moved the way the elevation sensor said it
    // did, which is what distinguishes a real measurement from a coincidence.
    let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
    for (const row of usableRows) {
      const x = -Math.tan(row.elevationChangeDeg * DEG), y = row.medianShiftV;
      sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
    }
    const k = usableRows.length;
    const denom = Math.sqrt((k * sxx - sx * sx) * (k * syy - sy * sy));
    return {
      tanHalfV,
      correlation: denom > 0 ? (k * sxy - sx * sy) / denom : 0,
      perPairScales,
      // How much the pairs disagree about the lens, in the same units as the
      // scale itself. This is the honest uncertainty of the measurement and it
      // is reported whether or not the gate passes.
      scaleAgreementMad: spread,
      usedRows: usableRows,
      outlierPairs: outliers.map(({ row, scale: s }) => ({
        from: row.from, to: row.to, reason: 'disagrees-with-other-pairs',
        impliedScale: Number(s.toFixed(4)),
        consensusScale: Number(centre.toFixed(4)),
        elevationChangeDeg: Number(row.elevationChangeDeg.toFixed(3)),
        matchCount: row.matchCount
      }))
    };
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

  // Every pair that was considered, kept or thrown out, with the reason. A
  // measurement that changes the rendered geometry has to be auditable from the
  // archive alone; "trust me, eighteen pairs agreed" is not evidence.
  const usedKeys = new Set((solution.usedRows || pass.rows).map(r => `${r.from}:${r.to}`));
  const evidence = pass.rows.map(row => ({
    from: row.from, to: row.to,
    used: usedKeys.has(`${row.from}:${row.to}`),
    azimuthGapDeg: Number(row.azimuthGapDeg.toFixed(3)),
    elevationChangeDeg: Number(row.elevationChangeDeg.toFixed(3)),
    medianShiftV: Number(row.medianShiftV.toFixed(5)),
    pose: row.pose,
    medianHorizontalShift: Number(row.medianHorizontalShift.toFixed(4)),
    horizontalShiftSpread: Number(row.horizontalShiftSpread.toFixed(4)),
    matchCount: row.matchCount
  }));

  const result = {
    ...base,
    pairCount: pass.rows.length,
    usedPairCount: (solution.usedRows || pass.rows).length,
    pairs: evidence,
    rejectedPairs: [...(pass.rejectedPairs || []), ...(solution.outlierPairs || [])],
    rejected: pass.rejected, candidateCount: usable.length,
    iterations, verifiedAtScale: scale,
    scaleAgreementMad: solution.scaleAgreementMad ?? null,
    perPairScales: (solution.perPairScales || []).map(s => Number(s.toFixed(4)))
  };
  if (pass.rows.length < minPairs) {
    return { ...result, measured: false, reason: 'too-few-repeat-views', scale: 1 };
  }
  if (!finite(solution.tanHalfV) || solution.tanHalfV <= 0) {
    return { ...result, measured: false, reason: 'degenerate-fit', scale: 1, correlation: solution.correlation };
  }
  const fittedScale = solution.tanHalfV / statedTanHalfV;
  // Three independent things must hold before the render geometry is allowed to
  // move: the scenery moved the way the elevation sensor said it did, the
  // change is a believable size for a lens, and the pairs agree with each other
  // about what that lens is. The last of those is the parallax guard, and it is
  // the one most likely to fail on a survey shot close to a building.
  const agrees = (solution.scaleAgreementMad ?? Infinity) <= maxScaleDisagreement;
  // The count that matters is how many pairs actually FED the fit after the
  // consensus filter, not how many were collected. On the reference capture
  // eighteen repeat views collapsed to three once parallax was excluded, and
  // three is not enough to move the geometry a survey depends on.
  const enough = (solution.usedRows || []).length >= minPairs;
  const trusted = solution.correlation >= minAbsCorrelation
    && Math.abs(fittedScale - 1) <= maxChange
    && agrees && enough;
  return {
    ...result,
    measured: trusted,
    reason: trusted ? 'cross-lap-elevation-regression'
      : solution.correlation < minAbsCorrelation ? 'shift-does-not-track-elevation'
      : Math.abs(fittedScale - 1) > maxChange ? 'implausible-magnitude'
      : !agrees ? 'pairs-disagree-about-the-lens'
      : 'too-few-low-parallax-repeat-views',
    correlation: solution.correlation,
    fittedTanHalfV: solution.tanHalfV,
    fittedVfovDeg: 2 * Math.atan(solution.tanHalfV) * RAD,
    // The spread between pairs, expressed as a field of view, is the honest
    // error bar on this number and is reported even when the gate passes.
    fittedVfovUncertaintyDeg: finite(solution.scaleAgreementMad)
      ? Math.abs(2 * Math.atan(solution.tanHalfV * (1 + solution.scaleAgreementMad)) * RAD
        - 2 * Math.atan(solution.tanHalfV) * RAD)
      : null,
    scale: trusted ? fittedScale : 1,
    rawScale: fittedScale
  };
}
