'use strict';

/** Horizontal keyframe spacing for dense visual overlap. */
export function keyframeStepDeg(horizontalFovDeg) {
  return Math.max(3, Number(horizontalFovDeg) * 0.20);
}

/** Instantaneous yaw-rate ceiling at the exposure, not a smoothed later rate. */
export function maxKeyframeYawRate({ mode = 'handheld' } = {}) {
  return mode === 'tripod' ? 20 : 35;
}

export function keyframeMotionAccepted(yawRateDegPerSec, options) {
  return Number.isFinite(yawRateDegPerSec)
    && Math.abs(yawRateDegPerSec) <= maxKeyframeYawRate(options);
}

/**
 * The one overlap policy.
 *
 * Three things used to have opinions about what "enough overlap" means: the
 * capture modes carried `minOverlap` (0.30 handheld, 0.45 tripod) for the live
 * "return N degrees" nudge, `captureGapReport` hardcoded 0.35 for the
 * end-of-pass hole list, and the stall warning was about to add a third. That
 * is three different definitions of a hole shown to one operator, and on a
 * tripod the strictest of them would have gone unwarned until well past its own
 * limit. Everything now asks this, parameterised by the active mode, so the
 * live warning, the recovery bearings and the gap report describe one world.
 */
export const MIN_PHOTO_OVERLAP = 0.35;

export function overlapFloor(mode = null) {
  const value = Number(mode?.minOverlap);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : MIN_PHOTO_OVERLAP;
}

/** The largest centre-to-centre step that still leaves usable overlap. */
export function maxUsableStepDeg(horizontalFovDeg, minOverlap = MIN_PHOTO_OVERLAP) {
  return Math.max(1, Number(horizontalFovDeg) || 0) * (1 - minOverlap);
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
  hasAcceptedFrame = true, stallSeconds = 2.5, minOverlap = MIN_PHOTO_OVERLAP
} = {}) {
  const swept = Math.abs(Number(travelDeg) || 0);
  const maxStep = maxUsableStepDeg(hfovDeg, minOverlap);
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
    return { stalled: false, sweptDeg: swept, elapsedSec, maxStepDeg: maxStep, minOverlap };
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
    minOverlap,
    severity: uncoveredDeg > 0 ? 'missing-overlap' : 'weak-overlap'
  };
}

/**
 * When pass 1 has gone so far that more of it cannot help.
 *
 * Two thresholds, and the gap between them is deliberate. At 400 degrees the
 * operator is told to stop — a prompt, not a stop, because they may be mid-turn
 * and because the number being tested is integrated gyro yaw, which has a
 * measured but not infallible scale. A gyro over-reporting by 15% would reach
 * "400" at a real 348, and truncating a legitimate lap on that basis would be a
 * new failure mode traded for an old one.
 *
 * At 500 degrees no scale error explains it. The ring has been covered once and
 * a good part of a second time, every further pass-1 frame lands on a bearing
 * that already has one, and the survey still has no independent verification
 * because none of it is labelled pass 2. Past that point new pass-1 sweep frames
 * are refused and the refusal is recorded, so the operator sees the count stop
 * rising and the archive says why. Pressing the button remains the only way on,
 * and it was already the right move a hundred degrees earlier.
 */
/*
 * The refusal moved from 500 to 900 on 2026-08-17.
 *
 * The reasoning above still holds for the PROMPT: past 400 degrees the operator
 * should be told to close the lap, because verification needs frames labelled
 * pass 2 and they are not getting any. But refusing to record was the wrong
 * remedy. A frame that lands on a bearing which already has one is not waste —
 * it is a second look from a slightly different pose, which is precisely what
 * the bundle adjustment lives on, and the field experience of the counter
 * silently stopping is indistinguishable from the app having broken.
 *
 * So the prompt stays where it was and the refusal moves out to two and a half
 * laps, where continued turning genuinely means the operator has lost track of
 * what they are doing rather than deliberately gathering more.
 */
export const PASS1_PROMPT_DEG = 400;
export const PASS1_REFUSE_DEG = 900;

export function pass1OverTravel(travelDeg) {
  const travelled = Math.abs(Number(travelDeg) || 0);
  return {
    travelledDeg: travelled,
    prompt: travelled > PASS1_PROMPT_DEG,
    refuseNewSweeps: travelled > PASS1_REFUSE_DEG
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

  // Holding on a target is the fast path: stand on the sector that needs help,
  // keep still, and frames accrue without having to turn for them.
  if (onTarget && stillness > 0.5 && elapsedMs > 380) return true;

  // But a cleanup lap must also just WORK anywhere. Requiring `onTarget` was
  // the only rule here, which meant that on the second lap the operator could
  // turn to something they could see needed another look and get nothing at all
  // for it — the app silently declining to photograph what it was being shown.
  // Ordinary sweep spacing is the floor everywhere, so turning always captures
  // and lingering captures faster.
  return Math.abs(angularTravelDeg) >= stepDeg;
}
