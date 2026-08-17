'use strict';

import { extractFeatures, matchPair, verifyPair, refineRotations, overlappingPairs, rayOf } from './bundle.js';
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

/**
 * Rebuild a frame's corrected pose keeping only the azimuth part of what the
 * solver asked for, discarding the tilt.
 *
 * This is the project's own principle applied per frame rather than globally:
 * down comes from an accelerometer and is the most reliable number the device
 * produces, azimuth comes from an integrated gyroscope and drifts. A frame at
 * the end of a lap with few overlapping neighbours is barely constrained, and
 * what an under-constrained frame does is tilt — it is the cheapest way for the
 * solver to explain a residual. Reverting such a frame entirely would throw away
 * its yaw correction too, and yaw drift runs to several degrees where the
 * unwanted tilt is barely one, so reverting costs more than it saves.
 */
function yawOnlyCorrection(before, after) {
  let rel = quatMul(after, quatConj(before));
  if (rel[0] < 0) rel = rel.map(v => -v);         // same rotation, positive scalar
  const w = Math.min(1, rel[0]);
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(Math.max(1e-12, 1 - w * w));
  const halfYaw = (rel[3] / s) * angle / 2;       // signed, about the yaw axis
  return quatMul([Math.cos(halfYaw), 0, 0, Math.sin(halfYaw)], before);
}

/** Horizontal and vertical field of view a keyframe implies at a given scale. */
function fovDeg(kf, scale) {
  if (!kf || !(kf.tanHalfH > 0) || !(kf.tanHalfV > 0)) return null;
  return {
    horizontal: 2 * Math.atan(kf.tanHalfH * scale) * RAD,
    vertical: 2 * Math.atan(kf.tanHalfV * scale) * RAD
  };
}

/**
 * Drop every match the converged solution disagrees with, so the second solve
 * sees only what the first one could explain.
 *
 * verifyPair already trims each pair against its own best rotation, but a pair
 * can be perfectly self-consistent and still wrong about where it sits on the
 * sphere — two frames of repeating siding agreeing with each other about an
 * offset that the other eleven frames around them contradict. Only the global
 * solution has seen that contradiction, which makes it a better judge of a match
 * than the pair it came from. The robust loss stops such matches steering the
 * answer but leaves them in, and they carry into the render where nothing
 * protects anything.
 */
function pruneMatches(frames, pairs, q, keepDeg, minKeep = 8) {
  const kept = [];
  let dropped = 0;
  for (const pr of pairs) {
    const matches = pr.matches.filter(m => {
      const a = rayOf(frames[pr.i].kf, m.ua, m.va, q[pr.i]);
      const b = rayOf(frames[pr.j].kf, m.ub, m.vb, q[pr.j]);
      const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      return Math.acos(dot) * RAD <= keepDeg;
    });
    dropped += pr.matches.length - matches.length;
    if (matches.length >= minKeep) kept.push({ ...pr, matches });
  }
  return { pairs: kept, dropped };
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
  pruneDeg = 0.8, tiltClampDeg = 1, onProgress = null, yieldFn = nextFrame,
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

  const solverOpts = {
    iterations: 24,
    tiltStiffness: 50,
    yawStiffness: 0.5,
    huber: 0.01
  };
  let result = refineRotations(frames, pairs, solverOpts);
  const firstPassRmsDeg = result.rmsDeg;

  // Prune against the converged solution and solve once more. Guarded rather
  // than unconditional: on a capture where the first solve went badly the prune
  // would be judging matches by a bad yardstick, and keeping the first answer is
  // better than confidently refining a wrong one.
  const prune = pruneMatches(frames, pairs, result.q, pruneDeg);
  const prunedMatchCount = prune.pairs.reduce((sum, pr) => sum + pr.matches.length, 0);
  let pruneApplied = false;
  if (prune.pairs.length >= 2 && prunedMatchCount >= 20 && prune.dropped > 0) {
    const second = refineRotations(frames, prune.pairs, solverOpts);
    if (Number.isFinite(second.rmsDeg) && second.rmsDeg <= result.rmsDeg) {
      result = second;
      pruneApplied = true;
    }
  }
  // Frames the solver wanted to tilt more than the gate allows keep their yaw
  // correction and give up their tilt, rather than the whole capture being
  // discarded because of them. On the reference capture this is 3 frames of 91:
  // the median frame moves tilt 0.28 degrees and the p90 is 0.64, so the old
  // max-over-all-frames test was rejecting 88 good corrections to veto 3.
  const clampedFrames = [];
  for (let i = 0; i < result.q.length; i++) {
    if (correctionComponentsDeg(frames[i].q, result.q[i]).tilt > tiltClampDeg) {
      result.q[i] = yawOnlyCorrection(frames[i].q, result.q[i]);
      clampedFrames.push(i);
    }
  }

  const corrections = result.q.map((q, i) => correctionComponentsDeg(frames[i].q, q));
  const maxTiltMovedDeg = Math.max(0, ...corrections.map(c => c.tilt));
  const maxYawMovedDeg = Math.max(0, ...corrections.map(c => c.yaw));
  // The gate this replaces asked whether ANY frame tilted. A leaning horizon is
  // a property of the solution as a whole, so ask that instead: if the typical
  // frame wants to tilt materially then the solve really has gone wrong and
  // clamping a few outliers would only be papering over it.
  const sortedTilt = corrections.map(c => c.tilt).sort((a, b) => a - b);
  const medianTiltMovedDeg = sortedTilt.length
    ? sortedTilt[Math.floor(sortedTilt.length / 2)] : 0;
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
    && medianTiltMovedDeg <= tiltClampDeg
    && clampedFrames.length <= result.q.length / 4;

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
    firstPassRmsDeg,
    pruneApplied,
    prunedMatchCount: pruneApplied ? prunedMatchCount : null,
    prunedDropped: prune.dropped,
    maxMovedDeg: result.maxMovedDeg,
    maxYawMovedDeg,
    maxTiltMovedDeg,
    medianTiltMovedDeg,
    clampedFrameCount: clampedFrames.length,
    clampedFrames,
    movedDeg: result.movedDeg,
    tiltMovedDeg: corrections.map(c => c.tilt),
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
