'use strict';

/** Horizontal keyframe spacing for dense visual overlap. */
export function keyframeStepDeg(horizontalFovDeg) {
  return Math.max(3, Number(horizontalFovDeg) * 0.20);
}

/** Instantaneous yaw-rate ceiling at the exposure, not a smoothed later rate. */
export function maxKeyframeYawRate({ probe = false, mode = 'handheld' } = {}) {
  if (probe) return 3;
  return mode === 'tripod' ? 20 : 35;
}

export function keyframeMotionAccepted(yawRateDegPerSec, options) {
  return Number.isFinite(yawRateDegPerSec)
    && Math.abs(yawRateDegPerSec) <= maxKeyframeYawRate(options);
}

/**
 * The largest centre-to-centre step that still leaves usable overlap. Mirrors
 * `captureGapReport`'s `desiredMaximumStepDeg` so the live warning and the
 * end-of-pass gap report agree about what counts as a hole.
 */
export const MIN_PHOTO_OVERLAP = 0.35;

export function maxUsableStepDeg(horizontalFovDeg) {
  return Math.max(1, Number(horizontalFovDeg) || 0) * (1 - MIN_PHOTO_OVERLAP);
}

/**
 * Is the capture silently losing coverage right now?
 *
 * The 2026-08-15 field capture swept 68.9 degrees over 14.2 seconds without
 * accepting a single photograph, and said nothing at all while it happened. The
 * operator was looking at a screen that showed a normal frame-level complaint
 * and kept walking, so the same hole was cut into both laps and the visual
 * feature graph came apart at exactly that bearing.
 *
 * Every input here already existed — the time of the last accepted keyframe,
 * the yaw at that keyframe, the current yaw, and the audit reason for the most
 * recent rejection. Nothing new has to be measured to know that coverage is
 * being lost; it only had to be checked.
 */
export function captureStall({
  sinceMs = 0, travelDeg = 0, hfovDeg = 45, reason = null,
  hasAcceptedFrame = true, stallSeconds = 2.5
} = {}) {
  const swept = Math.abs(Number(travelDeg) || 0);
  const maxStep = maxUsableStepDeg(hfovDeg);
  const elapsedSec = Math.max(0, Number(sinceMs) || 0) / 1000;
  // Two independent triggers. Travel is the one that matters for the mosaic:
  // past this the next photo cannot overlap the last one enough to be matched.
  // Time catches the operator who has stopped, pointed at something the gates
  // refuse, and is waiting for a capture that is never going to come.
  const lostCoverage = hasAcceptedFrame && swept > maxStep;
  // Standing still between keyframes is the normal, correct state: the spacing
  // gate is supposed to refuse until the operator has turned far enough. Only a
  // refusal for an actual fault means the wait is going nowhere.
  const faulted = reason !== null && reason !== 'accepted' && reason !== 'spacing-not-reached';
  const waiting = faulted && elapsedSec > stallSeconds && swept < 1.5;
  if (!lostCoverage && !waiting) {
    return { stalled: false, sweptDeg: swept, elapsedSec, maxStepDeg: maxStep };
  }
  const uncoveredDeg = Math.max(0, swept - (Number(hfovDeg) || 0));
  return {
    stalled: true,
    kind: lostCoverage ? 'coverage-lost' : 'waiting',
    sweptDeg: swept,
    elapsedSec,
    maxStepDeg: maxStep,
    uncoveredDeg,
    // How far back the operator has to turn for the next photograph to still
    // overlap the last accepted one. Not the midpoint of the hole — the edge of
    // what is recoverable.
    returnDeg: lostCoverage ? Math.max(0, swept - maxStep) : 0,
    reason: reason || null,
    severity: uncoveredDeg > 0 ? 'missing-overlap' : 'weak-overlap'
  };
}

/** Pass 2 is normally a dense second lap. Targeted holds are only for a later
 * cleanup pass after some bins have already been verified. */
export function pass2CaptureAccepted({
  verificationSweep = false,
  angularTravelDeg = 0,
  stepDeg = 3,
  onTarget = false,
  stillness = 0,
  elapsedMs = 0
} = {}) {
  if (verificationSweep) return Math.abs(angularTravelDeg) >= stepDeg;
  return onTarget && stillness > 0.5 && elapsedMs > 380;
}
