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
  onProgress = null, yieldFn = nextFrame, checkFocal = true
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
      // out anywhere between 50.6 and 52.5 degrees depending on which
      // thresholds were used; at 220 and above every combination of settings
      // agrees within about a degree, at 49.3 to 50.4. The density is not a
      // nicety — below it the answer is whatever the thresholds happen to be.
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

  const pairs = [];
  for (let p = 0; p < candidates.length; p++) {
    const pair = candidates[p];
    const raw = matchPair(
      features[pair.i], features[pair.j], keyframes[pair.i], keyframes[pair.j],
      frames[pair.i].q, frames[pair.j].q, { searchPx }
    );
    const matches = verifyPair(
      raw, keyframes[pair.i], keyframes[pair.j], frames[pair.i].q, frames[pair.j].q
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

  const result = refineRotations(frames, pairs, {
    iterations: 24,
    tiltStiffness: 50,
    yawStiffness: 0.5,
    huber: 0.01
  });
  const corrections = result.q.map((q, i) => correctionComponentsDeg(frames[i].q, q));
  const maxTiltMovedDeg = Math.max(0, ...corrections.map(c => c.tilt));
  const maxYawMovedDeg = Math.max(0, ...corrections.map(c => c.yaw));
  // The lens, measured from repeat views of the same bearing on different laps,
  // where the vertical slide of the scenery against the gravity-measured
  // elevation change gives the focal length directly. This is a separate
  // observation from the rotation solve above and succeeds or fails on its own.
  const focal = checkFocal
    ? crossLapFocalCheck({
      keyframes, features, quats: frames.map(f => f.q), yawDatum, searchPx
    })
    : { measured: false, reason: 'not-requested', scale: 1, pairCount: 0 };
  const appliedFocalScale = focal.measured ? focal.scale : 1;
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
    focalScaleApplied: appliedFocalScale,
    focalReason: focal.reason,
    focalCheck: {
      measured: focal.measured,
      reason: focal.reason,
      pairCount: focal.pairCount,
      candidateCount: focal.candidateCount ?? null,
      rejected: focal.rejected ?? null,
      usedPairCount: focal.usedPairCount ?? null,
      correlation: focal.correlation ?? null,
      scaleAgreementMad: focal.scaleAgreementMad ?? null,
      perPairScales: focal.perPairScales ?? [],
      statedVfovDeg: focal.statedVfovDeg ?? null,
      fittedVfovDeg: focal.fittedVfovDeg ?? null,
      fittedVfovUncertaintyDeg: focal.fittedVfovUncertaintyDeg ?? null,
      scale: focal.scale,
      rawScale: focal.rawScale ?? null,
      iterations: focal.iterations ?? null,
      pairs: focal.pairs || [],
      rejectedPairs: focal.rejectedPairs || []
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
