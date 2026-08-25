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

  /** How long the dot will hold a bearing waiting for its column to gain a band
   *  before deciding the column cannot be finished from here and moving on.
   *  Generous, because climbing a column deliberately takes several seconds a
   *  band, and bounded, because an unfillable column must never pin the dot. */
  columnPatienceSec: 12,

  /** Once the operator is within this of the target and the sector is still
   *  hungry, the dot holds position rather than creeping away from them. */
  holdRadiusDeg: 10,

  /**
   * Fastest the dot may travel across the horizon.
   *
   * Lowered from 90 on 2026-08-25: "the dot is sometimes hard to keep up with".
   * 90°/s is faster than anyone turns deliberately, so when the target moved a
   * long way the dot arrived before the operator had finished registering that
   * it had left. 45°/s is still quicker than a comfortable sweep — the ramps in
   * `js/coverage.js` call 25°/s comfortable and stop crediting at 70 — so the
   * dot continues to lead rather than trail, while staying something a person
   * can follow with their body instead of chase.
   */
  maxSlewDegPerSec: 45,

  /** Exponential smoothing constant, in seconds, applied after the slew limit. */
  smoothingSec: 0.22,

  /**
   * How long the dot will sit on a sector that is earning nothing before it
   * gives up on it for a while and leads somewhere else.
   *
   * The dot used to re-pick only when ground somewhere became covered. Park the
   * operator in front of something the segmenter refuses — clear sky with no
   * skyline in frame, a dark corner, glare — and NOTHING changes: the target
   * stays wanted, no bin gets credited, the generation never ticks, and the dot
   * is frozen on a sector that cannot be satisfied from where they are. The
   * operator's own workaround was to walk away, which covered something else,
   * ticked the generation and released it. That is a bug wearing a workaround.
   */
  abandonAfterSec: 6,

  /** How long an abandoned sector is left alone before it may be offered again.
   *  Long enough that the dot does not oscillate between two impossible
   *  sectors, short enough that a genuinely fixable one comes back in the same
   *  lap. */
  deferCooldownSec: 45,

  /** Below this, a target that has been waiting is reported as `waiting` so the
   *  interface can say so. Degrees of operator movement while the dot did not
   *  advance. */
  stalledAfterSec: 2.0,

  /** How far above the camera's current aim the dot may be asked to sit before
   *  the interface starts saying "tilt up" in words as well as in position. */
  liftPromptDeg: 8,

  /**
   * Dead band on "the dot is asking for a tilt".
   *
   * Small on purpose, and NOT `liftPromptDeg`. The decision about whether a
   * vertical target is worth having is made upstream, where the target is
   * chosen: the ring only asks for a lift when a top has never been framed, and
   * only asks for a descent past `descentPromptDeg`. By the time there is a
   * target, the only question left is which way the dot moved, and reusing the
   * 8-degree prompt figure here silently swallowed real asks — a sector needing
   * 7.6 degrees of lift reported `wantsLift: false` and the words said nothing
   * while the dot sat above the camera.
   *
   * Two degrees is about the pose noise of a hand-held phone, which is the only
   * thing this is meant to reject.
   */
  tiltDeadbandDeg: 2,

  /** How far ABOVE this sector's skyline the camera has to be before the dot
   *  starts leading the operator back down. Larger than `liftPromptDeg` on
   *  purpose: being a little high costs a slightly cropped foreground, while
   *  being a little low costs the measurement itself, so the descent should be
   *  the less twitchy of the two. */
  descentPromptDeg: 12,

  /** Smoothing for the dot's vertical travel, in seconds. Slower than the
   *  horizontal: a target that bobs vertically while the operator is trying to
   *  frame a roofline is worse than one that arrives a moment late. */
  elevationSmoothingSec: 0.35,

  /**
   * Fastest the dot may travel vertically, in degrees per second.
   *
   * MEASURED, 2026-08-25 22:23. The horizontal target has had a slew limit
   * since the beginning, for the stated reason that a dot which teleports looks
   * random. The vertical target had exponential smoothing and nothing else, so
   * a change of desired height moved it 60% of the way in a single update. When
   * the ask jumped a full column — 55.9° to 0° — the dot crossed most of the
   * screen in about a third of a second, and the operator's verdict was that it
   * "was moving just a bit erratically, going from the top to the bottom
   * instantly".
   *
   * The cause of those jumps is fixed in `ColumnPlan.gapBand`, which no longer
   * asks for the far end of a column. This is the belt to that braces: whatever
   * the maps decide, the dot is a thing a person is watching and following with
   * their hands, and it must always look like it travelled there.
   *
   * 30°/s crosses one band (about 14°) in half a second — unmistakably moving,
   * comfortably followable, and slower than the tilt rate of an operator who is
   * paying attention, so the dot leads rather than races.
   */
  maxElevationSlewDegPerSec: 30,

  /** A stretch of swept-but-uncovered ground has to be at least this wide
   *  before the dot will turn the operator around for it. Every sweep leaves a
   *  thin under-exposed sliver at the trailing edge of wherever it began, and
   *  sending someone back for two degrees would be maddening — that sliver gets
   *  picked up for free when the lap closes.
   *
   *  Lowered from 8 to 4: the cost of going back is a few seconds and some
   *  frames, and frames are the thing the survey is short of. The only real
   *  floor is the width below which the operator cannot aim accurately enough
   *  for the trip to achieve anything, which is nearer 4 degrees than 8. */
  minFrontierRunDeg: 4
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
    /** binIndex -> performance-clock ms at which it may be offered again. */
    this.deferred = new Map();
    this.abandonedCount = 0;
    this._nowMs = 0;
    this.waitingSec = 0;
    this.complete = false;
    /** Where the dot sits vertically, smoothed. */
    this.elevationDeg = null;
    this.wantsLift = false;
    this.liftDeg = 0;
    /** Set by the caller. When present the dot finishes a column of elevation
     *  bands before it is allowed to move sideways. */
    this.columnPlan = this.columnPlan || null;
    this.holdingColumn = false;
    /** The column the dot is committed to, or -1. Held across frames on
     *  purpose: it is what lets the dot wait somewhere the operator is not. */
    this.heldColumn = -1;
    this._heldFilled = -1;
    this._heldForSec = 0;
    this.lastPlanGeneration = -1;
    /** The bin the waiting timer is measured on, and its last progress value.
     *  Waiting is a question about the ground under the dot, so it is measured
     *  there and reset whenever the dot moves to different ground. */
    this._progressIndex = -1;
    this._progressValue = null;
    /** Which band the dot is currently asking for, and how many the column
     *  needs. Reported so the interface can say "3 of 5" rather than nothing. */
    this.targetBand = -1;
    this.targetBands = 0;
    /** The band currently being asked for, held until it fills so the ask does
     *  not flip back and forth as the camera drifts over a band boundary. */
    this._askBand = -1;
    this.liftRemainingDeg = 0;
    this.dropRemainingDeg = 0;
    /** One elevation band, set by the caller from the working frame's vertical
     *  field of view. Infinity until told otherwise, which reproduces the old
     *  single-jump behaviour rather than inventing a step from a guess. */
    this.bandStepDeg = Infinity;
    this.beyondTilt = false;
  }

  /** Is this bearing currently being left alone? Expired entries are dropped as
   *  they are met, so the map never needs sweeping. */
  isDeferred(coverage, bearingDeg, nowMs = this._nowMs) {
    const i = coverage.indexOf(bearingDeg);
    const until = this.deferred.get(i);
    if (until === undefined) return false;
    if (nowMs >= until) { this.deferred.delete(i); return false; }
    return true;
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

    // A sector that has been given up on for now is not a candidate. Wrapping
    // the map's own test is enough: every candidate search below goes through
    // it, so deferral needs no other plumbing.
    const wanted = bearing => !coverage.completeAt(bearing) && !this.isDeferred(coverage, bearing);

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
      if (!wanted(bearing) || !coverage.visitedAt(bearing)) break;
      behind = bearing;
      runDeg += step;
    }
    if (runDeg < t.minFrontierRunDeg) behind = null;

    // AHEAD: the first uncovered bin in the sweep direction. This is the
    // ordinary case — the ground behind is done, so lead them onward.
    let ahead = null;
    for (let k = 0; k < n; k++) {
      const bearing = wrap360(headingDeg + dir * k * step);
      if (wanted(bearing)) { ahead = bearing; break; }
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
    this._nowMs = nowMs;
    const summary = coverage.completeness();

    /*
     * A ring covered at the horizon is not a finished survey.
     *
     * `coverage.completeness()` only ever knew about bearings, so the scan
     * declared itself done the moment the horizon row was painted all the way
     * round — with the columns over the house still missing most of their
     * bands. The guidance then returned 'complete' and stopped leading
     * anywhere, which is the other half of "the dot got stuck and I had to
     * cover places it wasn't telling me to": it was not stuck, it had quit.
     */
    const columnsDone = !this.columnPlan
      || this.columnPlan.completeness().fraction >= 1;
    summary.complete = summary.complete && columnsDone;
    summary.columnsComplete = columnsDone;
    summary.columnFraction = this.columnPlan
      ? this.columnPlan.completeness().fraction : 1;
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

    /*
     * HOLD THE BEARING UNTIL THE COLUMN IS FINISHED.
     *
     * The horizontal chooser below is a good frontier-finder and it has no idea
     * that height exists. Left to itself it leads the operator onward the moment
     * the bearing under them is covered at the horizon, which is exactly the
     * motion that leaves a column half done — and a half-done column is a set of
     * high frames with nothing beneath them, which is what the solver discards.
     *
     * So when a column plan is attached and the column here is unfinished, the
     * dot does not move sideways at all. It stays on this bearing and the
     * elevation half of update() walks it up or down a band at a time. Once the
     * column completes, the plan reverses the vertical direction and the
     * horizontal chooser is allowed to pick the next bearing — which is the
     * serpentine, enforced rather than hoped for.
     */
    /*
     * WHICH COLUMN IS BEING WORKED.
     *
     * Rewritten 2026-08-25 after the back-yard capture, where this file made
     * the dot useless. The old rule was:
     *
     *     columnHere = plan.indexOf(headingDeg)
     *     if (column under the operator is unfinished) raw = plan.bearingOf(columnHere)
     *
     * — the target was the operator's OWN bearing. It could not lead; it could
     * only shadow. The recorded trail of that capture shows it exactly: the dot
     * tracked the heading at an offset of a few tenths of a degree for most of
     * 157 seconds, walking 255 → 253 → 251 → 249 behind a phone that was
     * choosing its own path, and lurching 15-20° sideways whenever the patience
     * timer expired. The operator's report — "it almost never moves even when I
     * am centred in the circle, all of my movement was of my own decision" —
     * is that behaviour described from the other side of the screen.
     *
     * The hold is now anchored to a COLUMN INDEX that the guidance picks and
     * keeps. It is chosen by the plan's own serpentine walk, which is allowed
     * to name a column the operator is not standing on — that is what makes the
     * dot an instruction rather than a mirror. It survives the operator
     * wandering off, so the patience timer measures the column's progress and
     * not the operator's restlessness, and so the dot is still waiting where
     * the work is when they come back.
     */
    let raw;
    const plan = this.columnPlan;

    /*
     * What still counts as work at a bearing.
     *
     * Both halves, because the two maps grade differently: a band is filled at
     * 0.62 confidence over 2 frames and a ring bin is covered at 0.88 over 8,
     * so a column can be full while the horizon under it is still thin. Asking
     * only the plan would walk the dot past every one of those; asking only the
     * ring is what left columns half done in the first place.
     */
    const columnWanted = plan ? (i) => {
      const bearing = plan.bearingOf(i);
      if (this.isDeferred(coverage, bearing, nowMs)) return false;
      return !plan.columnComplete(i) || !coverage.completeAt(bearing);
    } : null;

    if (plan) {
      // Let go of a column that is finished, or that has been given up on.
      if (this.heldColumn >= 0 && !columnWanted(this.heldColumn)) {
        // A column that FINISHED turns the sweep around, so the camera comes
        // back down the next one instead of travelling through sky it has
        // already covered. One owner for the decision, called once.
        if (plan.columnComplete(this.heldColumn)) plan.advanceSerpentine();
        this.heldColumn = -1;
        this._heldForSec = 0;
      }

      /*
       * A held column must be able to give up.
       *
       * Holding until the column finishes is the whole point, and it is also
       * the most dangerous thing in this file: a column that CANNOT be finished
       * would pin the dot forever. So progress is measured, not assumed —
       * `bandsFilled` counts every filled band, where the old code derived
       * progress from `lowestGap` alone and therefore saw a band filled above
       * an open one as no progress at all. Deferral is a cooldown, not a
       * deletion: the dot offers the column again later.
       */
      if (this.heldColumn >= 0) {
        const filled = plan.bandsFilled(this.heldColumn);
        if (filled !== this._heldFilled) {
          this._heldFilled = filled;
          this._heldForSec = 0;
        } else {
          this._heldForSec = (this._heldForSec || 0) + dtSec;
        }
        if (this._heldForSec > t.columnPatienceSec) {
          this.deferred.set(coverage.indexOf(plan.bearingOf(this.heldColumn)),
            nowMs + t.deferCooldownSec * 1000);
          this.abandonedColumns = (this.abandonedColumns || 0) + 1;
          this.heldColumn = -1;
          this._heldForSec = 0;
        }
      }

      // Nothing held: ask the plan where the serpentine goes next. This is the
      // line that makes the dot lead — `nextTarget` prefers the column under
      // the operator when it still needs work, and otherwise names the next one
      // along the sweep, which may be somewhere they are not yet pointing.
      if (this.heldColumn < 0) {
        const next = plan.nextTarget(headingDeg, elevationDeg, {
          direction: t.sweepDirection, wanted: columnWanted
        });
        if (!next.complete) {
          this.heldColumn = plan.indexOf(next.bearingDeg);
          this._heldFilled = plan.bandsFilled(this.heldColumn);
          this._heldForSec = 0;
          /*
           * Which way to travel this column, decided from where the camera is
           * rather than from a flag that has to be flipped correctly at every
           * hand-off. That flag spent the whole 2026-08-25 22:23 survey stuck
           * on `true`, so every new column asked for its bottom band from
           * whatever height the operator was already at — the top-to-bottom
           * lurch they reported. Arriving at the top of one column, the next
           * band worth filling is at the top of the next one along.
           */
          plan.ascending = plan.directionFrom(this.heldColumn, elevationDeg);
          this._askBand = -1;
        }
      }
    }

    this.holdingColumn = plan !== null && this.heldColumn >= 0;
    if (this.holdingColumn) {
      raw = plan.bearingOf(this.heldColumn);
    } else {
      raw = this.chooseTarget(coverage, headingDeg, {
        suppressLead: hungryHere, hfovDeg
      });
    }
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
     * A held column has already made this decision and owns it, so the ring's
     * hysteresis only applies when nothing is held. Running both was how the
     * dot ended up re-picked on every frame: `mapChanged` ticks whenever any
     * bin anywhere gains coverage, which during an active sweep is constantly,
     * so the "keep what you have" half never actually kept anything.
     */
    if (!this.holdingColumn) {
      /*
       * Give up on a sector that is earning nothing, and come back to it later.
       *
       * `stillWanted` alone kept the dot on an impossible target forever. The
       * escape is deliberately generous because a sector that is merely slow to
       * fill should NOT be abandoned; the whole design depends on the dot
       * waiting rather than sliding along with the phone. What it must not do
       * is wait for something that cannot happen from where the operator is.
       */
      if (this.rawBearingDeg !== null && this.waitingSec > t.abandonAfterSec
          && !coverage.completeAt(this.rawBearingDeg)) {
        this.deferred.set(coverage.indexOf(this.rawBearingDeg),
          nowMs + t.deferCooldownSec * 1000);
        this.rawBearingDeg = null;
        this.waitingSec = 0;
        this.abandonedCount = (this.abandonedCount || 0) + 1;
      }

      const stillWanted = this.rawBearingDeg !== null
        && !coverage.completeAt(this.rawBearingDeg)
        && !this.isDeferred(coverage, this.rawBearingDeg, nowMs);
      if (!stillWanted) this.rawBearingDeg = raw;
    } else {
      this.rawBearingDeg = raw;
    }

    /*
     * IS THE GROUND UNDER THE DOT GAINING ANYTHING?
     *
     * Two wrong answers to this were tried before the right one.
     *
     * It first asked whether the TARGET had moved, which is a question about
     * the dot and not about the survey. While the dot was pinned to the
     * operator's own heading it moved constantly, so `waitingSec` never
     * accumulated, so the six-second escape below never fired and the interface
     * never once said "hold here" — the operator was told nothing while nothing
     * was being recorded.
     *
     * It then asked whether either MAP had gained anything anywhere, which is
     * worse in the opposite direction: during any sweep some bin somewhere is
     * always becoming covered, so the timer resets forever and a dot parked on
     * ground nobody is looking at is never given up. Measured on the clockwise
     * sweep case, the dot stuck at 342° while the operator walked to 119° and
     * the escape never fired once.
     *
     * The question is local, so the measurement must be: has the sector the dot
     * is standing on gained anything. Both halves, since either can be the
     * thing being waited for — the ring's confidence at that bearing, and the
     * bands filled in the column if one is held.
     */
    const targetIndex = coverage.indexOf(this.rawBearingDeg);
    const progressNow = (coverage.scoreAt(this.rawBearingDeg) || 0)
      + (this.holdingColumn && plan ? plan.bandsFilled(this.heldColumn) : 0);
    const sameTarget = targetIndex === this._progressIndex;
    const gained = !sameTarget || progressNow > (this._progressValue ?? -1) + 1e-4;
    this._progressIndex = targetIndex;
    this._progressValue = progressNow;
    this.lastGeneration = coverage.generation;
    this.lastPlanGeneration = plan ? plan.generation : 0;
    if (gained) {
      this.waitingSec = 0;
      this.lastAdvanceAt = nowMs;
    } else {
      this.waitingSec += dtSec;
    }
    this.lastRawBearing = this.rawBearingDeg;

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

    /*
     * WHERE THE DOT SITS VERTICALLY.
     *
     * Rewritten 2026-08-25, and this is the other half of why the dot was
     * useless in the back yard.
     *
     * The rule was: climb when `coverage.needsLiftAt` says the top of this
     * sector has never been framed, descend when the camera is well above the
     * sector's skyline, and OTHERWISE ride at the camera's own elevation. That
     * third case is not a default, it is a blind spot, and while a column was
     * being held it was the case that applied almost all the time — the top had
     * been seen, so no lift was wanted, so the dot sat at exactly the elevation
     * the camera was already at, on exactly the bearing the camera was already
     * on. Both axes mirrored the operator. The recorded trail shows six-second
     * stretches of it: camera at 6.8°, dot at 6.8°, required 15.2°, lift 0.0,
     * and the column quietly failing to gain the band at 14.9° that it needed.
     *
     * The plan knows exactly which band is missing. It always did — `gapBand`
     * has been there the whole time and nothing called it. So while a column is
     * held, the dot goes to the centre of the band being filled, and that is
     * the instruction: put the dot back in the middle of the picture and the
     * band fills. The coverage map's lift and descent still drive the dot when
     * no column is held, because then there is no band to name.
     */
    let aim = null;              // where the dot ultimately wants the camera
    let aimSource = 'camera';
    let columnTopDeg = null;
    this.targetBand = -1;
    this.targetBands = 0;

    if (this.holdingColumn && plan) {
      this.targetBands = plan.bandsRequired[this.heldColumn];
      /*
       * STICK TO THE BAND UNTIL IT IS FILLED.
       *
       * The band is chosen from where the camera is, which is exactly what
       * stops the dot lurching — and, left alone, would make it twitch instead.
       * The camera drifts across a band boundary, the nearest unfilled band
       * changes, and the ask flips back and forth over a boundary the operator
       * cannot see. So once a band is asked for it stays asked for until it
       * fills, the column is dropped, or it stops being one of the bands this
       * column still needs.
       */
      let band = this._askBand;
      const stale = band < 0
        || band >= this.targetBands
        || plan.bandFilled(this.heldColumn, band);
      if (stale) {
        band = plan.gapBand(this.heldColumn, { fromElevationDeg: elevationDeg });
        this._askBand = band;
      }
      if (band >= 0) {
        this.targetBand = band;
        aim = plan.elevationOf(band);
        aimSource = 'band';
        columnTopDeg = plan.elevationOf(Math.max(0, this.targetBands - 1));
      }
    } else {
      this._askBand = -1;
    }

    /*
     * No band to name — the column is full and the ring is still thin, or there
     * is no plan at all. Fall back to what the coverage map knows: climb to
     * frame a top nobody has measured, and come back down off one afterwards.
     *
     * The descent matters as much as the climb. Coming off a tall roof at 60
     * degrees and turning into open garden, every frame is sky and nothing
     * fills; without a target to descend to the dot would ride along at 60
     * waiting for a sector that can never fill.
     */
    const required = coverage.requiredElevationAt(this.rawBearingDeg);
    const rest = coverage.restElevationAt(this.rawBearingDeg);
    if (aim === null) {
      if (coverage.needsLiftAt(this.rawBearingDeg) && required > 0) {
        aim = required;
        aimSource = 'lift';
        columnTopDeg = required;
      } else if ((elevationDeg - rest) > t.descentPromptDeg) {
        aim = rest;
        aimSource = 'rest';
      } else {
        aim = elevationDeg;
      }
    }

    /*
     * CLIMB IN STEPS, NOT IN ONE JUMP.
     *
     * The dot never asks for more than one band at a time. `bandStepDeg` is
     * 0.40 of the vertical field, which leaves 60% of each frame overlapping
     * the one below it AND keeps the dot on the screen — at half the field it
     * lands off the top edge, and an instruction you cannot see is not an
     * instruction. On the 2026-08-19 capture a single 9°-to-47° jump cost 13 of
     * 80 photographs, because two elevations that share no pixels leave the
     * high frames in their own component. Reaching the top is not the goal;
     * arriving there with a connected chain behind you is.
     */
    const step = Number.isFinite(this.bandStepDeg) && this.bandStepDeg > 0
      ? this.bandStepDeg : Infinity;
    const desiredElevation = clamp(aim, elevationDeg - step, elevationDeg + step);

    const wantsLift = desiredElevation - elevationDeg > t.tiltDeadbandDeg;
    const wantsDrop = !wantsLift && elevationDeg - desiredElevation > t.tiltDeadbandDeg;

    /*
     * Slew limit, then smoothing — the same order the horizontal target has
     * used since the beginning, and for the same reason. Smoothing alone moves
     * the dot 60% of the way to a new target in one update; against a large
     * change that is a jump with soft edges, not a journey. The limit makes the
     * dot travel at a speed a person can follow with their hands, and the
     * smoothing then takes the corners off.
     */
    if (this.elevationDeg === null) {
      this.elevationDeg = desiredElevation;
    } else {
      const delta = desiredElevation - this.elevationDeg;
      const maxStep = t.maxElevationSlewDegPerSec * dtSec;
      const limited = clamp(delta, -maxStep, maxStep);
      const alpha = t.elevationSmoothingSec > 0
        ? 1 - Math.exp(-dtSec / t.elevationSmoothingSec) : 1;
      this.elevationDeg += limited * alpha;
    }
    this.aimElevationDeg = aim;
    this.aimSource = aimSource;
    this.wantsLift = wantsLift;
    // What is being asked for NOW, not the whole remaining climb. The operator
    // is led up one band three times rather than told "38°" once.
    this.liftDeg = wantsLift ? desiredElevation - elevationDeg : 0;
    /** How much climbing remains after this step, so the directive can say the
     *  column is not finished without asking for it all at once. */
    this.liftRemainingDeg = wantsLift && columnTopDeg !== null
      ? Math.max(0, columnTopDeg - elevationDeg) : this.liftDeg;
    this.wantsDrop = wantsDrop;
    this.dropDeg = wantsDrop ? elevationDeg - desiredElevation : 0;
    this.dropRemainingDeg = wantsDrop ? Math.max(0, elevationDeg - Math.min(aim, rest)) : 0;
    /*
     * Taller than anything that can be asked for. Recorded and reported rather
     * than repeated at the operator, since there is no instruction here that
     * could succeed. Both maps are asked, because they cap independently and
     * either one giving up is the thing the operator needs told.
     */
    this.beyondTilt = coverage.beyondTiltAt(this.rawBearingDeg)
      || (plan ? plan.beyondReach(plan.indexOf(this.rawBearingDeg)) : false);

    /*
     * "Behind" needs a dead band.
     *
     * The test was the sign of the sweep-relative distance alone, so a dot a
     * fifth of a degree the wrong side of the heading was reported as behind
     * the operator — and the interface said "Target is 0° right, sweep back
     * onto it" while they were already on it. In the recorded trail the state
     * flickered between `behind` and `advancing` on alternate frames for
     * minutes. Behind means far enough behind to be worth turning around for.
     */
    const away = Math.abs(angDiff(this.rawBearingDeg, headingDeg));
    const behindOperator = away > t.holdRadiusDeg
      && distanceAlong(headingDeg, this.rawBearingDeg, t.sweepDirection) > 180;
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
      holdingColumn: !!this.holdingColumn,
      /** Which band the dot is asking for and how many the column needs, so
       *  the interface can say "band 3 of 5" instead of leaving a climb with no
       *  visible end. -1 when no column is held. */
      targetBand: this.targetBand,
      targetBands: this.targetBands,
      /** Where the dot ultimately wants the camera, and which map asked for it:
       *  'band' (the column plan), 'lift'/'rest' (the coverage ring), or
       *  'camera' when nothing has an opinion. A session spent almost entirely
       *  in 'camera' is a dot that is not instructing anyone. */
      aimElevationDeg: Number.isFinite(this.aimElevationDeg)
        ? Number(this.aimElevationDeg.toFixed(1)) : null,
      aimSource: this.aimSource || 'camera',
      liftDeg: Number((this.liftDeg || 0).toFixed(1)),
      liftRemainingDeg: Number((this.liftRemainingDeg || 0).toFixed(1)),
      dropRemainingDeg: Number((this.dropRemainingDeg || 0).toFixed(1)),
      bandStepDeg: Number.isFinite(this.bandStepDeg) ? Number(this.bandStepDeg.toFixed(2)) : null,
      /** ...and how far below, coming off an obstruction. */
      wantsDrop: this.wantsDrop,
      dropDeg: Number((this.dropDeg || 0).toFixed(1)),
      beyondTilt: !!this.beyondTilt,
      state: this.state,
      complete: this.complete,
      /** Sectors currently being left alone, and how many have been given up on
       *  this lap. A rising count is the signal that something in the scene or
       *  the frame gates is refusing to cooperate. */
      deferredCount: this.deferred.size,
      abandonedColumns: this.abandonedColumns || 0,
      heldColumnForSec: Number((this._heldForSec || 0).toFixed(1)),
      abandonedCount: this.abandonedCount || 0,
      waitingSec: this.waitingSec,
      /** Confidence of the sector the camera is on now, for the "keep going
       *  here" feedback. */
      hereScore: this.lastHereScore ?? null,
      hungryHere: this.lastHungryHere ?? false,
      summary
    };
  }
}
