'use strict';

import { extractFeatures, matchPair, verifyPair, refineRotations, overlappingPairs } from './bundle.js';
import { crossLapFocalCheck } from './focal-check.js';
import { keyframeQuat } from './panorama.js';
import { quatConj, quatMul, RAD } from './math3d.js';

const nextFrame = () => new Promise(resolve => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
  else setTimeout(resolve, 0);
});

function correctionComponentsDeg(before, after) {
  const rel = quatMul(after, quatConj(before));
  const w = Math.max(-1, Math.min(1, Math.abs(rel[0])));
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(Math.max(1e-12, 1 - w * w));
  const axis = [rel[1] / s, rel[2] / s, rel[3] / s];
  return {
    yaw: Math.abs(axis[2]) * angle * RAD,
    tilt: Math.hypot(axis[0], axis[1]) * angle * RAD
  };
}

/** Horizontal and vertical field of view a keyframe implies at a given scale. */
function fovDeg(kf, scale) {
  if (!kf || !(kf.tanHalfH > 0) || !(kf.tanHalfV > 0)) return null;
  return {
    horizontal: 2 * Math.atan(kf.tanHalfH * scale) * RAD,
    vertical: 2 * Math.atan(kf.tanHalfV * scale) * RAD
  };
}

function unchanged(keyframes, yawDatum, reason, extra = {}) {
  return {
    keyframes,
    yawDatum,
    diagnostics: { applied: false, reason, ...extra }
  };
}

/**
 * Use below-skyline visual features to refine only the relative rotations.
 * The sensor quaternions, including elevation from gravity, remain the prior;
 * tilt corrections are penalised 100x more strongly than yaw corrections and
 * an explicit sanity gate rejects any result that moves tilt materially.
 */
export async function optimisePanoramaRotations({
  keyframes, sources, yawDatum = 0, searchPx = 40, maxPairDegree = 6,
  onProgress = null, yieldFn = nextFrame,
  // Solving focal length inside the bundle adjustment is available and correct,
  // and it is OFF because it was measured against the 2026-08-15 capture and
  // does not work there. Sweeping focal across +/-14% and re-solving rotations
  // at each step moved the mean pairwise disagreement only from 1.147 to 1.183
  // degrees: the cost surface is flat because parallax from a nearby house
  // dominates it. The solver returned 0.99 where the truth was 1.07. Focal is
  // measured by `crossLapFocalCheck` instead, which observes it somewhere the
  // parallax cancels. See js/focal-check.js.
  solveFocal = false, focalStiffness = 40, maxFocalChange = 0.15,
  checkFocal = true
}) {
  const n = keyframes?.length || 0;
  const sourceCount = (sources || []).filter(Boolean).length;
  if (n < 2 || sourceCount < 2) {
    return unchanged(keyframes, yawDatum, 'not-enough-source-photos', { sourceCount });
  }

  const frames = keyframes.map(kf => ({ kf, q: keyframeQuat(kf, yawDatum).slice() }));
  const features = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (sources[i]) {
      // 220 rather than the extractFeatures default of 160. The rotation solve
      // is content with 160, but the focal check matches frames a whole lap
      // apart, where only the features common to two capped sets survive.
      // Measured on the reference capture: at 160 the fitted field of view came
      // out at 49.6-50.8 degrees and moved around with every threshold; at 220
      // and above every combination of settings lands between 48.1 and 48.8,
      // against an offline reference of 48.2. The density is not a nicety.
      try { features[i] = extractFeatures(sources[i], keyframes[i], { target: 220 }); }
      catch (_) { features[i] = null; }
    }
    if (i % 4 === 3) {
      onProgress?.({ stage: 'features', completed: i + 1, total: n });
      await yieldFn();
    }
  }

  const allCandidates = overlappingPairs(frames)
    .filter(pair => features[pair.i] && features[pair.j])
    .sort((a, b) => a.sep - b.sep);
  const degree = new Uint8Array(n);
  const candidates = [];
  for (const pair of allCandidates) {
    if (degree[pair.i] >= maxPairDegree || degree[pair.j] >= maxPairDegree) continue;
    candidates.push(pair);
    degree[pair.i]++; degree[pair.j]++;
  }
  if (!candidates.length) {
    return unchanged(keyframes, yawDatum, 'no-predicted-overlap', {
      sourceCount, candidatePairs: allCandidates.length
    });
  }

  // Loose verification first. The tight end of the schedule is deliberately
  // withheld until the lens is known, because a wrong lens makes edge matches
  // look like outliers and edge matches are the only ones that can correct it.
  const LOOSE = [4, 1.6, 0.8];
  const pairs = [];
  for (let p = 0; p < candidates.length; p++) {
    const pair = candidates[p];
    const raw = matchPair(
      features[pair.i], features[pair.j], keyframes[pair.i], keyframes[pair.j],
      frames[pair.i].q, frames[pair.j].q, { searchPx }
    );
    const matches = verifyPair(
      raw, keyframes[pair.i], keyframes[pair.j], frames[pair.i].q, frames[pair.j].q,
      solveFocal ? { schedule: LOOSE } : {}
    );
    if (matches.length >= 8) pairs.push({ ...pair, matches, rawMatchCount: raw.length });
    if (p % 4 === 3) {
      onProgress?.({ stage: 'matching', completed: p + 1, total: candidates.length, verifiedPairs: pairs.length });
      await yieldFn();
    }
  }

  const matchedFrames = new Set(pairs.flatMap(pair => [pair.i, pair.j]));
  const rawMatchCount = pairs.reduce((sum, pair) => sum + pair.rawMatchCount, 0);
  const verifiedMatchCount = pairs.reduce((sum, pair) => sum + pair.matches.length, 0);
  if (pairs.length < 2 || verifiedMatchCount < 20) {
    return unchanged(keyframes, yawDatum, 'too-few-verified-matches', {
      sourceCount,
      candidatePairs: candidates.length,
      verifiedPairs: pairs.length,
      rawMatchCount,
      verifiedMatchCount,
      matchedFrameCount: matchedFrames.size
    });
  }

  onProgress?.({ stage: 'solving', completed: 0, total: 1, verifiedPairs: pairs.length });
  await yieldFn();

  let solvePairs = pairs;
  let seedScale = 1;
  if (solveFocal) {
    // First solve: rough rotations and a first estimate of the lens, from the
    // loosely verified matches.
    const seed = refineRotations(frames, pairs, {
      iterations: 12, tiltStiffness: 50, yawStiffness: 0.5, huber: 0.01,
      solveFocal: true, focalStiffness
    });
    if (Number.isFinite(seed.focalScale) && Math.abs(seed.focalScale - 1) <= maxFocalChange) {
      seedScale = seed.focalScale;
    }
    // Second verification, now at a lens that is roughly right. Edge matches
    // stop looking like outliers, so the full tightening schedule can run and
    // the periodic-texture mismatches it exists to remove are removed.
    solvePairs = [];
    for (const pair of pairs) {
      const matches = verifyPair(
        pair.matches, keyframes[pair.i], keyframes[pair.j],
        seed.q[pair.i], seed.q[pair.j], { scale: seedScale }
      );
      if (matches.length >= 8) solvePairs.push({ ...pair, matches });
    }
    if (solvePairs.length < 2) solvePairs = pairs;
    await yieldFn();
  }

  const result = refineRotations(frames, solvePairs, {
    iterations: 24,
    tiltStiffness: 50,
    yawStiffness: 0.5,
    huber: 0.01,
    // The lens is the one thing in this pipeline that was never measured
    // against the scene it is being used on. A known-device table entry put the
    // 2026-08-15 iPad capture 6% out, which is about a degree of azimuth error
    // at the frame edges while the centre stays right — the exact signature of
    // seams that ghost worse the further you look from the middle of a frame.
    // The photographs can measure it, so let them.
    solveFocal,
    focalStiffness
  });
  const corrections = result.q.map((q, i) => correctionComponentsDeg(frames[i].q, q));
  const maxTiltMovedDeg = Math.max(0, ...corrections.map(c => c.tilt));
  const maxYawMovedDeg = Math.max(0, ...corrections.map(c => c.yaw));
  // A separate gate for the focal length, because it fails differently from the
  // rotations: a bad focal solve is not a big number, it is a plausible number
  // arrived at from too little evidence. Require both a believable magnitude
  // and enough frames to have actually constrained it.
  const focalScale = Number.isFinite(result.focalScale) ? result.focalScale : 1;
  const focalTrusted = solveFocal
    && Math.abs(focalScale - 1) <= maxFocalChange
    && matchedFrames.size >= 6
    && result.matchCount >= 200;
  // The measurement that actually works: repeat views of the same bearing from
  // different laps, where the vertical slide of the scenery against the
  // gravity-measured elevation change gives the focal length directly.
  const focal = checkFocal
    ? crossLapFocalCheck({
      keyframes, features, quats: frames.map(f => f.q), yawDatum, searchPx
    })
    : { measured: false, reason: 'not-requested', scale: 1, pairCount: 0 };
  const appliedFocalScale = focal.measured ? focal.scale
    : focalTrusted ? focalScale
    : 1;
  const sane = Number.isFinite(result.rmsDeg)
    && result.matchCount >= 20
    && result.maxMovedDeg <= 12
    && maxTiltMovedDeg <= 1;

  const diagnostics = {
    applied: sane,
    reason: sane ? 'gravity-constrained-visual-refinement' : 'visual-solution-failed-sanity-check',
    sourceCount,
    candidatePairs: candidates.length,
    verifiedPairs: pairs.length,
    rawMatchCount,
    verifiedMatchCount,
    solverMatchCount: result.matchCount,
    matchedFrameCount: matchedFrames.size,
    rmsDeg: result.rmsDeg,
    maxMovedDeg: result.maxMovedDeg,
    maxYawMovedDeg,
    maxTiltMovedDeg,
    movedDeg: result.movedDeg,
    focalSolved: solveFocal,
    focalScaleRaw: solveFocal ? focalScale : null,
    focalScaleApplied: appliedFocalScale,
    focalTrusted,
    focalSeedScale: solveFocal ? seedScale : null,
    solvePairCount: solvePairs.length,
    solveMatchCount: solvePairs.reduce((sum, pair) => sum + pair.matches.length, 0),
    focalReason: focal.measured ? focal.reason
      : !solveFocal ? focal.reason || 'not-requested'
      : focalTrusted ? 'bundle-adjustment'
      : Math.abs(focalScale - 1) > maxFocalChange ? 'implausible-magnitude'
      : 'too-little-evidence',
    focalCheck: {
      measured: focal.measured,
      reason: focal.reason,
      pairCount: focal.pairCount,
      candidateCount: focal.candidateCount ?? null,
      rejected: focal.rejected ?? null,
      correlation: focal.correlation ?? null,
      statedVfovDeg: focal.statedVfovDeg ?? null,
      fittedVfovDeg: focal.fittedVfovDeg ?? null,
      scale: focal.scale,
      rawScale: focal.rawScale ?? null,
      pairs: focal.pairs || []
    },
    fovBeforeDeg: fovDeg(keyframes[0], 1),
    fovAfterDeg: fovDeg(keyframes[0], appliedFocalScale)
  };
  // The two corrections are independent and fail independently. A rotation
  // solution that trips its sanity gate is no reason to throw away a focal
  // length that eleven repeat views agreed on, so apply the lens on its own.
  if (!sane) {
    if (appliedFocalScale === 1) return { keyframes, yawDatum, diagnostics };
    return {
      keyframes: keyframes.map(kf => ({
        ...kf,
        tanHalfH: kf.tanHalfH * appliedFocalScale,
        tanHalfV: kf.tanHalfV * appliedFocalScale,
        bundleFocalScale: appliedFocalScale
      })),
      yawDatum,
      diagnostics: { ...diagnostics, focalAppliedWithoutRotationFix: true }
    };
  }

  const corrected = keyframes.map((kf, i) => ({
    ...kf,
    quat: result.q[i],
    yawBase: 0,
    yawCorrection: 0,
    // Both tangents scale together, so this is a focal length and the pixels
    // stay square. Only the panorama render sees it; the survey's 720 profile
    // bins keep the intrinsics they were actually projected with.
    tanHalfH: kf.tanHalfH * appliedFocalScale,
    tanHalfV: kf.tanHalfV * appliedFocalScale,
    bundleQuaternion: result.q[i],
    bundleMovedDeg: result.movedDeg[i],
    bundleFocalScale: appliedFocalScale
  }));
  return { keyframes: corrected, yawDatum: 0, diagnostics };
}
