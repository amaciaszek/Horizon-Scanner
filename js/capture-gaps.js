'use strict';

import { angDiff, wrap360, RAD } from './math3d.js';

const finite = value => Number.isFinite(value);
const round = (value, digits = 3) => finite(value) ? Number(value.toFixed(digits)) : null;

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

/** The centre bearing used to place a captured image in the survey. */
export function captureHeadingDeg(kf, yawDatumDeg = 0) {
  const correction = finite(kf?.yawCorrection) ? kf.yawCorrection : 0;
  if (finite(kf?.yawFused)) return wrap360(kf.yawFused + yawDatumDeg + correction);
  return wrap360(
    (finite(kf?.yawRaw) ? kf.yawRaw : 0)
    + (finite(kf?.yawBase) ? kf.yawBase : 0)
    + yawDatumDeg + correction
  );
}

export function bearingLabel(deg) {
  const bearing = wrap360(deg);
  const compass = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const name = compass[Math.round(bearing / 22.5) % compass.length];
  return `${bearing.toFixed(1)}\u00b0 ${name}`;
}

function horizontalFovDeg(kf) {
  return finite(kf?.tanHalfH) && kf.tanHalfH > 0
    ? 2 * Math.atan(kf.tanHalfH) * RAD
    : null;
}

/**
 * Measure overlap between consecutive accepted photographs, separately for
 * each lap. This reports holes in the photo evidence itself; skyline-bin
 * coverage can look healthy even when two neighbouring source images never
 * overlap enough for a visual stitcher to connect them.
 */
export function captureGapReport(keyframes, yawDatumDeg = 0, {
  minOverlap = 0.35
} = {}) {
  // Every frame can bridge a gap, including targeted cleanup shots that are not
  // part of any chronological lap. Only the lap-ordering below is restricted to
  // sweeps.
  const usable = keyframes || [];
  const sweeps = usable.filter(kf => (kf.captureKind || 'sweep') === 'sweep');
  const grouped = new Map();
  for (const kf of sweeps) {
    const pass = finite(kf.pass) ? kf.pass : 1;
    if (!grouped.has(pass)) grouped.set(pass, []);
    grouped.get(pass).push(kf);
  }

  const passes = [];
  const allGaps = [];
  for (const [pass, frames] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    frames.sort((a, b) => (finite(a.t) ? a.t : a.index || 0) - (finite(b.t) ? b.t : b.index || 0));
    const steps = [];
    const gaps = [];
    let signedTravel = 0;

    for (let i = 1; i < frames.length; i++) {
      const from = frames[i - 1], to = frames[i];
      const fromAz = captureHeadingDeg(from, yawDatumDeg);
      const toAz = captureHeadingDeg(to, yawDatumDeg);
      const signedStep = angDiff(toAz, fromAz);
      const stepDeg = Math.abs(signedStep);
      const fromFov = horizontalFovDeg(from);
      const toFov = horizontalFovDeg(to);
      const meanFov = finite(fromFov) && finite(toFov) ? (fromFov + toFov) / 2 : null;
      signedTravel += signedStep;
      steps.push(stepDeg);
      if (!(meanFov > 0)) continue;

      const overlap = Math.max(0, Math.min(1, 1 - stepDeg / meanFov));
      if (overlap + 1e-9 >= minOverlap) continue;
      const uncoveredDeg = Math.max(0, stepDeg - (fromFov + toFov) / 2);
      const targetAz = wrap360(fromAz + signedStep / 2);
      const desiredMaxStepDeg = meanFov * (1 - minOverlap);
      const segmentCount = Math.max(2, Math.ceil(stepDeg / desiredMaxStepDeg));
      const recaptureAzimuths = [];
      for (let segment = 1; segment < segmentCount; segment++) {
        recaptureAzimuths.push(wrap360(fromAz + signedStep * segment / segmentCount));
      }
      // A cleanup photo is not part of the chronological lap, but it can bridge
      // a chronological gap. Remove the recommended bearings already supplied
      // by another pass or by targeted cleanup.
      const bridgeToleranceDeg = 3;
      const missingRecaptureAzimuths = recaptureAzimuths.filter(target => !usable.some(candidate => {
        if (candidate === from || candidate === to) return false;
        return Math.abs(angDiff(captureHeadingDeg(candidate, yawDatumDeg), target)) <= bridgeToleranceDeg;
      }));
      if (!missingRecaptureAzimuths.length) continue;
      const gap = {
        pass,
        fromFrame: from.index ?? i - 1,
        toFrame: to.index ?? i,
        fromAzimuthDeg: round(fromAz),
        toAzimuthDeg: round(toAz),
        stepDeg: round(stepDeg),
        horizontalFovDeg: round(meanFov),
        estimatedOverlap: round(overlap, 4),
        requiredOverlap: minOverlap,
        uncoveredDeg: round(uncoveredDeg),
        targetAzimuthDeg: round(targetAz),
        targetLabel: bearingLabel(targetAz),
        desiredMaximumStepDeg: round(desiredMaxStepDeg),
        recommendedPhotoCount: missingRecaptureAzimuths.length,
        recaptureAzimuthsDeg: missingRecaptureAzimuths.map(v => round(v)),
        recaptureLabels: missingRecaptureAzimuths.map(bearingLabel),
        revisitWidthDeg: round(Math.max(uncoveredDeg, stepDeg - desiredMaxStepDeg)),
        severity: uncoveredDeg > 0 ? 'missing-overlap' : 'weak-overlap'
      };
      gaps.push(gap);
      allGaps.push(gap);
    }

    passes.push({
      pass,
      frameCount: frames.length,
      signedTravelDeg: round(signedTravel),
      totalTravelDeg: round(Math.abs(signedTravel)),
      medianStepDeg: round(percentile(steps, 0.5)),
      p90StepDeg: round(percentile(steps, 0.9)),
      maxStepDeg: round(steps.length ? Math.max(...steps) : null),
      gapCount: gaps.length,
      gaps
    });
  }

  allGaps.sort((a, b) => b.stepDeg - a.stepDeg);
  return {
    minimumRequiredOverlap: minOverlap,
    keyframeCount: usable.length,
    sweepKeyframeCount: sweeps.length,
    passCount: passes.length,
    gapCount: allGaps.length,
    gaps: allGaps,
    passes
  };
}
