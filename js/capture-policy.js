'use strict';

/**
 * Horizontal keyframe spacing for dense visual overlap.
 *
 * 0.14 of the horizontal field, so consecutive photographs share 86% of their
 * width. It was 0.20, and 0.20 is not wrong — it is what you choose when frames
 * are expensive.
 *
 * They are not expensive here. This survey is run once for a fixed telescope
 * and then relied on for years, the operator is standing still while it
 * happens, and the whole capture takes minutes. Against that, the cost of a
 * sparse frame is a hole that cannot be filled without going back to the site.
 * The 2026-08-20 capture took 63 photographs in 224 seconds and the solver
 * could place 39 of them; the arc it lost was the one with the least redundancy
 * in it.
 *
 * At 0.14 a 38.7° lens steps 5.4° instead of 7.7°, so a lap costs about 66
 * photographs per elevation band instead of 46. That is the cheap direction to
 * be wrong in: extra frames cost seconds of walking and a little solver time,
 * and missing ones cost a return trip.
 */
/**
 * Spacing is spent where it buys something.
 *
 * MEASURED, 2026-08-25. That capture evaluated 872 candidate frames and
 * photographed 115 of them; 757 were refused for spacing. Meanwhile the arc the
 * stitcher lost was lost for want of frames, not for want of quality — a
 * contiguous block of 30 photographs came off the graph because the pairs
 * across it did not survive pruning. So the app was simultaneously refusing
 * frames it did not need and short of frames it did.
 *
 * A single fixed fraction of the field of view cannot express that. It spends
 * exactly as much on a stretch of horizon already seen eight times as on the
 * band above the roof nobody has photographed once. `demand` is what the maps
 * say is still wanted here, 0 to 1, and it slides the step between:
 *
 *   demand 1  DENSE, 0.10 of the field — 90% overlap. New ground, an unfilled
 *             band, a column the plan is still climbing. Frames are the thing
 *             this survey is short of and the cost of one is a fraction of a
 *             second.
 *   demand 0  SPARSE, 0.30 of the field — 70% overlap. Ground both maps call
 *             finished. Still well inside `MIN_PHOTO_OVERLAP`, so the chain
 *             cannot come apart; it simply stops taking the same photograph
 *             four times.
 *
 * The default is 1. Nothing that does not know about demand is quietly made
 * sparser by this change, and the dense end is where an unmeasured scene
 * belongs.
 */
const DENSE_FRACTION = 0.10;
const SPARSE_FRACTION = 0.30;

function spacingFraction(demand) {
  const d = Number(demand);
  const want = Number.isFinite(d) ? Math.min(1, Math.max(0, d)) : 1;
  return SPARSE_FRACTION + (DENSE_FRACTION - SPARSE_FRACTION) * want;
}

export function keyframeStepDeg(horizontalFovDeg, demand = 1) {
  // A non-finite field of view must not poison the step. `Math.max(3, NaN)` is
  // NaN, and a NaN step makes `keyframeSpacingReached` return false forever —
  // so the app would stop photographing entirely while logging
  // 'spacing-not-reached' at every frame, which looks exactly like a survey
  // going fine and produces nothing. Intrinsics are computed from a measured
  // rotation, so this is reachable, not theoretical.
  const fov = Number(horizontalFovDeg);
  if (!Number.isFinite(fov) || fov <= 0) return 3;
  return Math.max(3, Math.min(360, fov) * spacingFraction(demand));
}

/** Vertical keyframe spacing, on the same principle as the horizontal one. */
export function keyframeTiltStepDeg(verticalFovDeg, demand = 1) {
  const fov = Number(verticalFovDeg);
  if (!Number.isFinite(fov) || fov <= 0) return 2.5;
  return Math.max(2.5, Math.min(180, fov) * spacingFraction(demand));
}

/**
 * How much this pose is still worth photographing, 0 to 1.
 *
 * Asked of both maps, because they are short of different things and either one
 * being hungry is a reason to spend a frame. The ring's confidence answers "has
 * this bearing been looked at enough"; the column plan's band answers "has this
 * HEIGHT at this bearing been looked at at all", and it is the second question
 * that the 2026-08-25 capture kept getting wrong — the arcs it lost were high
 * ones.
 *
 * Deliberately generous. Half demand still steps at 0.20 of the field, which is
 * the density this app shipped with before any of this existed, so the sparse
 * end is only reached where both maps are satisfied.
 */
export function captureDemand({ coverage = null, plan = null, headingDeg = 0, elevationDeg = 0 } = {}) {
  let demand = 0;
  if (coverage) {
    // Ring confidence, inverted: an uncovered bearing wants everything.
    const score = Number(coverage.scoreAt?.(headingDeg));
    const covered = coverage.completeAt?.(headingDeg) === true;
    if (!covered) demand = Math.max(demand, 1 - (Number.isFinite(score) ? score : 0));
    if (coverage.needsLiftAt?.(headingDeg)) demand = 1;
  }
  if (plan) {
    const i = plan.indexOf(headingDeg);
    const band = plan.bandOf(elevationDeg);
    // Aimed between bands, or at a band this column still needs: full demand.
    // A frame between bands is the connective tissue of a climb, so it is the
    // last thing that should be refused.
    if (band < 0) demand = 1;
    else if (!plan._bandFilled(i, band)) demand = 1;
    else if (!plan.columnComplete(i)) demand = Math.max(demand, 0.5);
  }
  return Math.min(1, Math.max(0, demand));
}

/**
 * Has the camera moved far enough for the next photograph?
 *
 * MEASURED ON THE SPHERE, NOT IN YAW.
 *
 * This was `|angDiff(yaw, yawAtLastKeyframe)| >= stepDeg`, which is yaw and
 * nothing else — and the consequence was that tilting the camera did not count
 * as movement at all. An operator sweeping straight up a column at one bearing
 * changes their yaw by nothing, so after the first frame of that column every
 * single candidate was refused. The 2026-08-20 capture logged 1,734 rejections
 * for "spacing-not-reached" against 63 accepted photographs: 92% of everything
 * the operator did was thrown away, and the vertical work the guidance had just
 * asked for was precisely the part that could never be recorded.
 *
 * That made the serpentine structurally impossible. The dot would ask for a
 * band above the horizon, the operator would go there, and the app would
 * decline to photograph it.
 *
 * Both axes now count, each against its own field of view, combined as an
 * ellipse so that a diagonal move earns its share of both. Bearing is scaled by
 * the cosine of the elevation because a degree of yaw is a smaller angle the
 * higher the camera is pointed — at 55° it is worth barely half what it is
 * worth on the horizon, and treating them as equal is what let high rows go
 * sparse while the app believed they were dense.
 */
export function keyframeSpacingReached({
  yawDeltaDeg = 0, tiltDeltaDeg = 0, elevationDeg = 0,
  hfovDeg = 45, vfovDeg = 34, demand = 1
} = {}) {
  const across = Math.abs(Number(yawDeltaDeg) || 0)
    * Math.cos(Math.min(85, Math.abs(Number(elevationDeg) || 0)) * Math.PI / 180);
  const down = Math.abs(Number(tiltDeltaDeg) || 0);
  const stepAcross = keyframeStepDeg(hfovDeg, demand);
  const stepDown = keyframeTiltStepDeg(vfovDeg, demand);
  return Math.hypot(across / stepAcross, down / stepDown) >= 1;
}

/** Instantaneous yaw-rate ceiling at the exposure, not a smoothed later rate. */
export function maxKeyframeYawRate() {
  return 35;
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
