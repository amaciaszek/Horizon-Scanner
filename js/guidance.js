'use strict';

import { wrap360, angDiff, clamp } from './math3d.js';

/**
 * Where to ask the operator to point next.
 *
 * This is the user-interface half of coverage-guided scanning. `CoverageMap`
 * owns what has actually been observed; this owns nothing but an opinion about
 * where to put a dot, derived from that map. The split is the point: the
 * scoring can be retuned or replaced and this file does not change, and the
 * dot's feel can be adjusted without touching what counts as observed.
 *
 * THE DOT IS NOT A COMPASS HAND. It does not advance because the phone turned;
 * it advances because the horizon behind it got covered. If the operator races
 * through a sector without depositing usable observations, the frontier stays
 * where it was and the dot is simply left behind them — which is the whole
 * interaction. They turn back, the sector fills in, and the dot moves on.
 *
 * WHAT STOPS IT LOOKING BROKEN. A raw "nearest uncovered bin" would flicker
 * between candidates as scores cross the threshold, and would teleport across
 * the circle the moment a distant gap became marginally more attractive. Three
 * things prevent that:
 *
 *   - hysteresis, so an established target is kept until a rival is clearly
 *     better rather than trivially better;
 *   - a slew limit, so the dot always travels to a new target at a visible
 *     speed instead of jumping;
 *   - exponential smoothing on top, so it settles rather than snaps.
 *
 * The result is a target that moves with apparent intent. It is allowed to be
 * slightly wrong for a moment; it is not allowed to look random.
 */

export const GUIDANCE_TUNING = {
  /** Sweep direction the app asks for: -1 counter-clockwise, +1 clockwise. */
  sweepDirection: -1,

  /** How far into an uncovered run to place the dot. Sitting exactly on the
   *  boundary reads as "you are already there"; a little way in reads as
   *  "come this way", which is what makes the operator sweep rather than hold. */
  leadDeg: 7,

  /** The dot is never asked for further ahead than this, so it stays findable
   *  on screen and the instruction stays local. */
  maxLeadDeg: 55,

  /** A rival target must beat the current one by this much, in degrees of
   *  distance, before the dot will switch to it. */
  hysteresisDeg: 12,

  /** Once the operator is within this of the target and the sector is still
   *  hungry, the dot holds position rather than creeping away from them. */
  holdRadiusDeg: 10,

  /** Fastest the dot may travel across the horizon. Slow enough to follow with
   *  the eye, fast enough not to feel stuck when a target legitimately moves. */
  maxSlewDegPerSec: 90,

  /** Exponential smoothing constant, in seconds, applied after the slew limit. */
  smoothingSec: 0.22,

  /** Below this, a target that has been waiting is reported as `waiting` so the
   *  interface can say so. Degrees of operator movement while the dot did not
   *  advance. */
  stalledAfterSec: 2.0,

  /** How far above the camera's current aim the dot may be asked to sit before
   *  the interface starts saying "tilt up" in words as well as in position. */
  liftPromptDeg: 8,

  /** Smoothing for the dot's vertical travel, in seconds. Slower than the
   *  horizontal: a target that bobs vertically while the operator is trying to
   *  frame a roofline is worse than one that arrives a moment late. */
  elevationSmoothingSec: 0.35,

  /** A stretch of swept-but-uncovered ground has to be at least this wide
   *  before the dot will turn the operator around for it. Every sweep leaves a
   *  thin under-exposed sliver at the trailing edge of wherever it began, and
   *  sending someone back for two degrees would be maddening — that sliver gets
   *  picked up for free when the lap closes. */
  minFrontierRunDeg: 8
};

/** Signed angular distance from `from` to `to` measured the sweep way round. */
function distanceAlong(from, to, direction) {
  const signed = angDiff(to, from);              // -180..180
  const along = direction < 0 ? -signed : signed;
  return along < 0 ? along + 360 : along;        // 0..360, always forwards
}

export class ScanGuidance {
  constructor(tuning = {}) {
    this.tuning = { ...GUIDANCE_TUNING, ...tuning };
    this.reset();
  }

  reset() {
    /** Where the dot is drawn. Smoothed; this is the only value the UI reads. */
    this.bearingDeg = null;
    /** Where the algorithm currently wants it. */
    this.rawBearingDeg = null;
    this.state = 'idle';            // idle | advancing | waiting | behind | complete
    this.lastAdvanceAt = null;
    this.lastRawBearing = null;
    this.lastHereScore = null;
    this.lastHungryHere = false;
    this.lastGeneration = -1;
    this.waitingSec = 0;
    this.complete = false;
    /** Where the dot sits vertically, smoothed. */
    this.elevationDeg = null;
    this.wantsLift = false;
    this.liftDeg = 0;
  }

  /**
   * Choose the raw target from the coverage map.
   *
   * Two candidates are considered and the nearer wins, which is what produces
   * both halves of the intended behaviour:
   *
   *   BEHIND — if the operator is standing in, or has just run past, an
   *   uncovered run, the start of that run is a candidate. This is the case
   *   that makes the dot wait for them.
   *
   *   AHEAD — the first uncovered bin in the sweep direction. This is the case
   *   that makes the dot lead them onward once a sector is done.
   *
   * Distance is measured the sweep way round for the ahead candidate and the
   * short way for the behind candidate, because turning back a little is a
   * natural motion and turning back 350 degrees is not.
   */
  chooseTarget(coverage, headingDeg, { suppressLead = false, hfovDeg = 45 } = {}) {
    const t = this.tuning;
    const dir = t.sweepDirection;
    const step = coverage.binSizeDeg;
    const n = coverage.binCount;
    // Ground still inside the camera's field is not "missed" — it is being
    // worked on this instant. Only what has passed out the trailing edge can be
    // said to have been swept past. Without this the frontier walk finds the
    // trailing half of the current frame on the very first update, and the dot
    // opens every scan pointing backwards at ground the operator is looking at.
    const trailingEdgeDeg = hfovDeg * coverage.tuning.usableFovFraction / 2;
    const skip = Math.max(1, Math.ceil(trailingEdgeDeg / step));

    if (coverage.completeness().complete) return null;

    // THE FRONTIER, looking back. Walk against the sweep while the ground is
    // uncovered BUT HAS BEEN VISITED, which is the signature of a sector the
    // operator swept through without capturing anything usable. The walk stops
    // at ground never visited, so a scan that has only just started — where
    // nothing is covered anywhere — does not open by pointing backwards.
    //
    // The far end of that run is where coverage was actually lost, and that is
    // where the dot belongs: the operator pushes it forward again by filling
    // the run in, which is the whole feel of the interaction.
    let behind = null;
    let runDeg = 0;
    const maxLookBack = skip + Math.round(t.maxLeadDeg / step);
    for (let k = skip; k <= maxLookBack; k++) {
      const bearing = wrap360(headingDeg - dir * k * step);
      if (coverage.completeAt(bearing) || !coverage.visitedAt(bearing)) break;
      behind = bearing;
      runDeg += step;
    }
    if (runDeg < t.minFrontierRunDeg) behind = null;

    // AHEAD: the first uncovered bin in the sweep direction. This is the
    // ordinary case — the ground behind is done, so lead them onward.
    let ahead = null;
    for (let k = 0; k < n; k++) {
      const bearing = wrap360(headingDeg + dir * k * step);
      if (!coverage.completeAt(bearing)) { ahead = bearing; break; }
    }

    if (ahead === null && behind === null) return null;

    // Unfinished ground already swept outranks new ground, always. Leaving a
    // trail of half-done sectors behind an operator who keeps moving forward is
    // exactly the failure this feature exists to prevent, and it is what the
    // old travel-based scan did.
    const chosen = behind !== null ? behind : ahead;

    // Lead: push the dot a little further into the uncovered run so following
    // it produces a sweep rather than a stare. Never past the far end of the
    // run, and never past the point where it stops being local.
    //
    // Suppressed while the operator is parked on an uncovered sector doing
    // exactly what was asked. Leading in that moment walks the dot away from
    // someone who is already right, which reads as a scanner that cannot be
    // satisfied — the one failure mode that would make people give up on it.
    let lead = 0;
    while (!suppressLead && lead + step <= t.leadDeg) {
      const probe = wrap360(chosen + dir * (lead + step));
      if (coverage.completeAt(probe)) break;
      lead += step;
    }
    let target = wrap360(chosen + dir * lead);

    // Keep it reachable. If the chosen point is miles away the operator needs a
    // direction, not a destination, so clamp toward them along the sweep.
    const forward = distanceAlong(headingDeg, target, dir);
    if (forward > t.maxLeadDeg && forward < 360 - t.maxLeadDeg) {
      target = wrap360(headingDeg + dir * t.maxLeadDeg);
    }
    return target;
  }

  /**
   * Advance the dot one frame.
   *
   * `coverage` is a CoverageMap, `headingDeg` where the camera points now,
   * `dtSec` since the last call. Returns the current guidance state, which is
   * everything the renderer and the director need and nothing else.
   */
  update({
    coverage, headingDeg, dtSec = 1 / 30, nowMs = 0, hfovDeg = 45, elevationDeg = 0
  } = {}) {
    const t = this.tuning;
    const summary = coverage.completeness();
    this.complete = summary.complete;

    if (summary.complete) {
      this.state = 'complete';
      this.rawBearingDeg = null;
      this.waitingSec = 0;
      return this.snapshot(headingDeg, summary);
    }

    // Is the sector the camera is on right now still hungry? This decides both
    // whether to lead the dot onward and what the interface says.
    const hereScore = coverage.scoreAt(headingDeg);
    const hungryHere = !coverage.completeAt(headingDeg);
    this.lastHereScore = hereScore;
    this.lastHungryHere = hungryHere;

    const raw = this.chooseTarget(coverage, headingDeg, {
      suppressLead: hungryHere, hfovDeg
    });
    if (raw === null) return this.snapshot(headingDeg, summary);

    /*
     * The target holds its ground until that ground is covered.
     *
     * This is the hysteresis, and it is absolute rather than a margin. An
     * earlier version re-picked whenever a new candidate was more than a few
     * degrees better, which looked reasonable and was wrong: when every sector
     * has been swept through but none of it captured, the frontier candidate
     * sits a fixed distance behind the operator and therefore SLIDES ALONG WITH
     * THEM. The dot then follows the phone around the circle, which is the one
     * behaviour this whole feature exists to avoid, and it did it while every
     * individual rule looked sensible.
     *
     * Holding position until the target is genuinely covered is also simply
     * what was asked for: the dot waits there until that region has been
     * adequately covered. An operator who wanders off to work elsewhere leaves
     * the dot behind on purpose — that sector still needs them, and when they
     * finish where they are, the dot is still exactly where they must go next.
     */
    const stillWanted = this.rawBearingDeg !== null
      && !coverage.completeAt(this.rawBearingDeg);
    // The second half of the same rule: even a target that is still wanted may
    // be reconsidered, but ONLY when some ground actually became covered since
    // the last decision. Turning the phone changes nothing here; covering the
    // horizon changes everything.
    const mapChanged = coverage.generation !== this.lastGeneration;
    if (!stillWanted || mapChanged) this.rawBearingDeg = raw;
    this.lastGeneration = coverage.generation;

    // Slew limit then smoothing, so the dot travels rather than teleports.
    if (this.bearingDeg === null) {
      this.bearingDeg = this.rawBearingDeg;
    } else {
      const delta = angDiff(this.rawBearingDeg, this.bearingDeg);
      const maxStep = t.maxSlewDegPerSec * dtSec;
      const limited = clamp(delta, -maxStep, maxStep);
      const alpha = t.smoothingSec > 0 ? 1 - Math.exp(-dtSec / t.smoothingSec) : 1;
      this.bearingDeg = wrap360(this.bearingDeg + limited * alpha);
    }

    // Is it moving? Used only to describe the situation in words.
    const advanced = this.lastRawBearing === null
      || Math.abs(angDiff(this.rawBearingDeg, this.lastRawBearing)) > 0.5;
    if (advanced) {
      this.waitingSec = 0;
      this.lastAdvanceAt = nowMs;
    } else {
      this.waitingSec += dtSec;
    }
    this.lastRawBearing = this.rawBearingDeg;

    /*
     * Where the dot sits vertically.
     *
     * By default it rides at whatever elevation the camera already holds, so it
     * asks for a turn and nothing else — two instructions at once is one too
     * many. But where the map has recorded that something stands above a sector
     * whose top nobody has measured, the dot climbs to the elevation needed to
     * see it, and following the dot becomes "tilt up" without a word being said.
     */
    const required = coverage.requiredElevationAt(this.rawBearingDeg);
    const wantsLift = coverage.needsLiftAt(this.rawBearingDeg) && required > 0;
    const desiredElevation = wantsLift ? required : elevationDeg;
    if (this.elevationDeg === null) {
      this.elevationDeg = desiredElevation;
    } else {
      const alpha = t.elevationSmoothingSec > 0
        ? 1 - Math.exp(-dtSec / t.elevationSmoothingSec) : 1;
      this.elevationDeg += (desiredElevation - this.elevationDeg) * alpha;
    }
    this.wantsLift = wantsLift;
    this.liftDeg = wantsLift ? Math.max(0, required - elevationDeg) : 0;

    const behindOperator = distanceAlong(headingDeg, this.rawBearingDeg, t.sweepDirection) > 180;
    this.state = behindOperator ? 'behind'
      : this.waitingSec > t.stalledAfterSec ? 'waiting'
        : 'advancing';

    return this.snapshot(headingDeg, summary);
  }

  snapshot(headingDeg, summary) {
    const off = this.bearingDeg === null || !Number.isFinite(headingDeg)
      ? null
      : angDiff(this.bearingDeg, headingDeg);
    return {
      bearingDeg: this.bearingDeg,
      rawBearingDeg: this.rawBearingDeg,
      offsetDeg: off,
      /** Vertical aim for the dot, and how far above the camera it is asking. */
      elevationDeg: this.elevationDeg,
      wantsLift: this.wantsLift,
      liftDeg: Number((this.liftDeg || 0).toFixed(1)),
      state: this.state,
      complete: this.complete,
      waitingSec: this.waitingSec,
      /** Confidence of the sector the camera is on now, for the "keep going
       *  here" feedback. */
      hereScore: this.lastHereScore ?? null,
      hungryHere: this.lastHungryHere ?? false,
      summary
    };
  }
}
