'use strict';
/* Serpentine column scanning.
 *
 * WHY THIS EXISTS, AS A MEASUREMENT.
 *
 * The 2026-08-19 23:48 capture was a clean single lap — 80 frames, 360.7° of
 * travel, no gaps by the old measure, and the best overlap disagreement the
 * project has recorded (16.2 mean). The stitcher still threw away 13 of its 80
 * photographs. Those 13 had a median elevation of 46.5° and a median of 3
 * overlapping neighbours; the 67 it kept had a median elevation of 9.3° and 9
 * neighbours. Every dropped frame was a high one.
 *
 * The cause is arithmetic. The vertical field of view is 30.9°. The operator
 * scanned the horizon at about 9°, and when the guidance asked for height they
 * tilted up to about 47°, took a frame, and came back down. A 38° jump against
 * a 31° field leaves no overlap at all, so nothing visually connects the high
 * frames to the low ones, the solver puts them in their own component, and a
 * component with no verified path to the rest cannot be placed. The roof of the
 * house was photographed four times and appears in the panorama zero times.
 *
 * THE FIX IS TO NEVER LEAVE A COLUMN HALF DONE. Sweep the full height at one
 * bearing in one continuous motion, step sideways, sweep back down. Every frame
 * then has a neighbour directly above or below it, taken seconds earlier from
 * the same standing position — which also means the residual parallax between
 * them is same-lap parallax, the 0.084° kind, and not the 0.203° kind that
 * comes back with the operator on a second lap.
 *
 * This module owns the elevation half of that: which bands at which bearing
 * have been seen, and where the dot should go next. It deliberately does NOT
 * modify CoverageMap, which continues to own the horizon ring; a bearing is
 * finished when the ring is happy AND its column is filled.
 */

const wrap360 = value => ((value % 360) + 360) % 360;
const angDiff = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

export const COLUMN_TUNING = {
  /**
   * Vertical step between band centres, as a fraction of the vertical field of
   * view.
   *
   * TWO CONSTRAINTS, AND THE TIGHTER ONE IS THE DOT.
   *
   * The matcher needs the frames to overlap: any step below 1.0 achieves that,
   * and smaller is better. But the operator is led by the guidance dot, and the
   * dot is drawn at one step above where the camera is pointing — so a step of
   * half the vertical field or more puts the dot off the top of the screen at
   * the start of every climb. An instruction you cannot see is not an
   * instruction, and the whole reason this is a dot rather than a number of
   * degrees is that a person can act on a thing they can see.
   *
   * 0.40 puts the dot at 80% of the way to the top edge: unmistakably a request
   * to tilt up, and unmistakably still on the screen. It also leaves 60% of each
   * frame overlapping the one below, which is more than the horizontal sweep
   * asks for. At the measured 30.9° vertical field the step is 12.4°, so the
   * 9°-to-47° jump that cost the 2026-08-19 capture 13 photographs becomes
   * three ordinary movements, each one ending with the dot back in the middle
   * of the picture.
   */
  overlapFraction: 0.40,

  /** Never step less than this, whatever a very narrow lens claims. */
  minBandStepDeg: 6,

  /** Elevation the horizon row sits at. The bottom band is centred here. */
  restElevationDeg: 0,

  /** Bands above rest that the planner will ever ask for. Eight at a 17° step
   *  reaches 119°, well past the tilt limit, so this is a guard and not a
   *  policy. */
  maxBands: 8,

  /** Confidence a band needs before it counts as filled. Lower than the ring's
   *  0.88 because a band is one look at a patch of sky rather than a stretch of
   *  skyline being traced, and because the cost of a missing band is a dropped
   *  frame rather than an unmeasured horizon. */
  bandThreshold: 0.62,

  /** Independent frames a band needs regardless of quality. */
  minBandFrames: 2,

  /** How far off a band's centre a frame may be aimed and still credit it, as a
   *  fraction of the band step. Beyond this the frame is crediting the next
   *  band along instead. */
  centreTolerance: 0.75,

  /** Degrees of bearing the dot advances when a column is complete. Matches the
   *  horizontal sweep's own step so the two agree about what "a bit further
   *  round" means. */
  columnStepDeg: 9,

  /** Bearing tolerance for crediting a column. A frame taken half a step off
   *  the column centre still fills that column's band. */
  columnToleranceDeg: 7,

  /**
   * The highest elevation anything is allowed to ask the operator for.
   *
   * MEASURED, 2026-08-25. This existed nowhere, and its absence is the single
   * defect that broke the guidance dot in the field.
   *
   * `CoverageMap` will never ask for more than 60 degrees — that is its
   * `maxRequestedElevationDeg`, and past it `needsLift` gives up and marks the
   * bin `beyondTilt` so the ring stops blocking. The column plan had no such
   * ceiling. On the 2026-08-25 back-yard capture the house measured a top of
   * 75.1 degrees, so `requireHeight` asked for six bands, whose top band centre
   * is 74.4 degrees. Nothing in the app will ever aim the camera there, so that
   * band could not be filled, so `columnComplete` was false forever on 19
   * columns, so `ScanGuidance` held the bearing forever.
   *
   * 60 of the 180 bins finished the capture flagged `beyondTilt` — a third of
   * the ring in a state the ring had forgiven and the column plan had not.
   *
   * A requirement the operator cannot carry out is not a requirement, it is a
   * deadlock. Bands above this are recorded as wanted and not required.
   */
  maxAskElevationDeg: 60
};

export class ColumnPlan {
  /**
   * `vfovDeg` is the WORKING FRAME's vertical field of view — the analysis
   * frame, not the sensor's advertised figure. Getting this wrong is the whole
   * bug this module exists to prevent, so it is required rather than defaulted.
   */
  constructor({ vfovDeg, binCount = 180, tuning = {} } = {}) {
    this.tuning = { ...COLUMN_TUNING, ...tuning };
    this.binCount = Math.max(8, Math.round(binCount));
    this.binSizeDeg = 360 / this.binCount;
    this.setFieldOfView(vfovDeg);
    this.reset();
  }

  /** Recompute the band geometry when the lens is measured or changed. */
  setFieldOfView(vfovDeg) {
    const vfov = Number.isFinite(vfovDeg) && vfovDeg > 1 ? vfovDeg : 30;
    this.vfovDeg = vfov;
    this.bandStepDeg = Math.max(this.tuning.minBandStepDeg, vfov * this.tuning.overlapFraction);
    this.bandCount = this.tuning.maxBands + 1;      // band 0 is the horizon row
    this._recomputeReach();
  }

  /**
   * The highest band the operator will ever be asked to aim at, and therefore
   * the highest one that may be REQUIRED.
   *
   * Derived rather than configured, because the two figures that decide it —
   * the band step and the tilt ceiling — are both measured at runtime, and a
   * hand-set band count would go stale the moment the lens was measured. A band
   * is askable when its centre is at or below the ceiling; asking for the band
   * above and hoping the tolerance catches it is how a column becomes
   * unfinishable without anything looking wrong.
   */
  _recomputeReach() {
    const ceiling = Number(this.tuning.maxAskElevationDeg);
    const usable = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : Infinity;
    const reach = Number.isFinite(usable)
      ? Math.floor((usable - this.tuning.restElevationDeg) / this.bandStepDeg) + 1
      : this.bandCount;
    this.reachableBands = clamp(reach, 1, this.bandCount);
    // A change of lens or ceiling can make a standing requirement impossible.
    // Re-derive every column from what the scene asked for, capped by what can
    // be reached, so the two can never drift apart.
    if (this.bandsWanted && this.bandsRequired) {
      for (let i = 0; i < this.binCount; i++) {
        this.bandsRequired[i] = Math.min(this.bandsWanted[i], this.reachableBands);
      }
      this.generation++;
    }
  }

  /** The tilt ceiling, set from whatever the guidance is actually willing to
   *  ask for, so the two can never disagree. */
  setCeiling(maxAskElevationDeg) {
    const value = Number(maxAskElevationDeg);
    if (!Number.isFinite(value) || value <= 0) return;
    if (value === this.tuning.maxAskElevationDeg) return;
    this.tuning.maxAskElevationDeg = value;
    this._recomputeReach();
  }

  reset() {
    const cells = this.binCount * this.bandCount;
    this.score = new Float32Array(cells);
    this.frames = new Uint16Array(cells);
    /** How many bands this bearing needs, from the obstruction height. Band 0
     *  is always needed; the rest are added as the scene proves it is tall.
     *  This is the EFFECTIVE figure — already capped at what can be reached. */
    this.bandsRequired = new Uint8Array(this.binCount).fill(1);
    /** What the scene asked for before the tilt ceiling was applied. Kept so
     *  the archive can say "this obstruction is taller than we could ask for"
     *  instead of silently pretending it was never that tall. */
    this.bandsWanted = new Uint8Array(this.binCount).fill(1);
    /** Which way the serpentine is currently travelling in elevation. */
    this.ascending = true;
    this.generation = 0;
  }

  indexOf(headingDeg) {
    // A NaN index silently no-ops every typed-array write it is used for, so a
    // bad heading would look like a frame that simply earned nothing rather
    // than like an error. Fail to bin 0 instead, and visibly.
    const h = Number(headingDeg);
    if (!Number.isFinite(h)) return 0;
    return Math.floor(wrap360(h) / this.binSizeDeg) % this.binCount;
  }

  bearingOf(index) {
    return wrap360((index + 0.5) * this.binSizeDeg);
  }

  /** Centre elevation of a band. */
  elevationOf(band) {
    return this.tuning.restElevationDeg + band * this.bandStepDeg;
  }

  /** The band a camera elevation is aimed at, or -1 if it is between bands by
   *  more than the tolerance. */
  bandOf(elevationDeg) {
    const raw = (elevationDeg - this.tuning.restElevationDeg) / this.bandStepDeg;
    const band = Math.round(raw);
    if (band < 0 || band >= this.bandCount) return -1;
    if (Math.abs(raw - band) > this.tuning.centreTolerance) return -1;
    return band;
  }

  cell(index, band) { return index * this.bandCount + band; }

  /**
   * How tall does this bearing need to be scanned?
   *
   * Driven by the obstruction height the coverage map has measured. The top
   * band must be aimed high enough that the obstruction top falls inside a
   * frame, which means the CAMERA needs to reach the top minus half a field —
   * aiming at the top itself wastes half the frame on empty sky and, worse,
   * leaves the band below it unoverlapped.
   */
  requireHeight(index, obstructionTopDeg) {
    if (!Number.isFinite(obstructionTopDeg) || obstructionTopDeg <= 0) return;
    const aim = Math.max(0, obstructionTopDeg - this.vfovDeg * 0.4);
    const bands = clamp(Math.ceil(aim / this.bandStepDeg) + 1, 1, this.bandCount);
    if (bands > this.bandsWanted[index]) this.bandsWanted[index] = bands;
    // The cap is the whole point. Above the tilt ceiling the app will not ask
    // the operator to aim, so it must not demand the result either; the excess
    // survives in `bandsWanted` and is reported, not required.
    const effective = Math.min(this.bandsWanted[index], this.reachableBands);
    if (effective > this.bandsRequired[index]) {
      this.bandsRequired[index] = effective;
      this.generation++;
    }
  }

  /** Is this bearing taller than anything the operator can be asked to aim at?
   *  The column-plan twin of `CoverageMap.beyondTilt`, and reported for the
   *  same reason: an unmeasurable top should be recorded, never repeated at
   *  someone who cannot act on it. */
  beyondReach(index) {
    return this.bandsWanted[index] > this.reachableBands;
  }

  /** How many of this bearing's required bands are filled. The progress figure
   *  a hold is judged on. It counts EVERY filled band, not the run from the
   *  bottom: filling band 3 while band 1 is still open is progress, and judging
   *  it by `lowestGap` alone reported no progress and abandoned the column. */
  bandsFilled(index) {
    const need = this.bandsRequired[index];
    let filled = 0;
    for (let b = 0; b < need; b++) if (this._bandFilled(index, b)) filled++;
    return filled;
  }

  /** Apply a whole coverage map's measured obstruction heights at once. */
  syncRequirements(coverage) {
    if (!coverage?.obstructionTop) return;
    const n = Math.min(coverage.binCount, this.binCount);
    for (let i = 0; i < n; i++) {
      const top = Math.max(coverage.obstructionTop[i] || 0, coverage.measuredTop?.[i] || 0);
      this.requireHeight(i, top);
    }
  }

  /**
   * Credit a frame.
   *
   * `quality` is the same 0..1 the coverage map computes, so a frame that was
   * too fast or too rolled to count for the horizon does not count here either.
   * A frame credits the column it was taken in and the two either side, because
   * its horizontal field spans several bearing bins.
   */
  observe({ headingDeg, elevationDeg, quality = 1, hfovDeg = 40 }) {
    const band = this.bandOf(elevationDeg);
    if (band < 0 || !(quality > 0)) return false;
    const spread = Math.max(1, Math.round((hfovDeg * 0.4) / this.binSizeDeg));
    const centre = this.indexOf(headingDeg);
    let filled = false;
    for (let d = -spread; d <= spread; d++) {
      const i = (centre + d + this.binCount) % this.binCount;
      // Credit falls off away from the frame centre, the same shape the ring
      // coverage uses, so an edge-of-frame glimpse cannot complete a band.
      const w = 1 - Math.abs(d) / (spread + 1);
      const c = this.cell(i, band);
      const before = this._bandFilled(i, band);
      this.score[c] = Math.min(1, this.score[c] + quality * w * 0.5);
      if (this.frames[c] < 65535) this.frames[c]++;
      if (!before && this._bandFilled(i, band)) { filled = true; this.generation++; }
    }
    return filled;
  }

  _bandFilled(index, band) {
    const c = this.cell(index, band);
    return this.score[c] >= this.tuning.bandThreshold
      && this.frames[c] >= this.tuning.minBandFrames;
  }

  /** Is every band this bearing needs filled? */
  columnComplete(index) {
    const need = this.bandsRequired[index];
    for (let b = 0; b < need; b++) if (!this._bandFilled(index, b)) return false;
    return true;
  }

  /** The lowest unfilled band at a bearing, or -1 when the column is done. */
  lowestGap(index) {
    const need = this.bandsRequired[index];
    for (let b = 0; b < need; b++) if (!this._bandFilled(index, b)) return b;
    return -1;
  }

  /** The highest unfilled band at a bearing, or -1 when the column is done. */
  highestGap(index) {
    for (let b = this.bandsRequired[index] - 1; b >= 0; b--) {
      if (!this._bandFilled(index, b)) return b;
    }
    return -1;
  }

  /**
   * Where should the dot go next?
   *
   * The rule is: finish the column you are standing in before moving sideways.
   * That is the whole point — a column abandoned halfway is what produces a
   * frame with no vertical neighbour, and a frame with no vertical neighbour is
   * what the stitcher drops.
   *
   * Direction alternates. Having climbed to the top of one column, the next
   * band worth filling is the top of the next column along, so the dot steps
   * sideways and comes back down. That is the serpentine, and it means the
   * camera never travels through sky it has already covered to reach sky it
   * has not.
   */
  nextTarget(headingDeg, elevationDeg, { direction = -1, wanted = null } = {}) {
    const here = this.indexOf(headingDeg);
    // `wanted` lets the caller widen or narrow what counts as unfinished work
    // without this module having to know why. The guidance uses it for two
    // things it owns and the plan does not: a bearing it has given up on for
    // now, and a bearing whose column is full but whose horizon ring is still
    // short of confidence. Without it the dot would skip past ring gaps the
    // moment the bands above them were filled.
    const needsWork = typeof wanted === 'function'
      ? wanted : i => !this.columnComplete(i);

    // 1. Finish this column.
    if (needsWork(here)) return this._target(here, this.gapBand(here), 'fill-column');

    // 2. This column is done, so step sideways. The serpentine reversal is NOT
    //    applied here: this function is called on every frame to ask where the
    //    dot belongs, and a query that flips the sweep direction as a side
    //    effect would reverse it ten times a second. `advanceSerpentine()` is
    //    the one place the direction changes, and it is called once, by the
    //    owner of the decision, when a column actually completes.
    //    `direction` is -1 for the counter-clockwise sweep the app asks for.
    const step = Math.max(1, Math.round(this.tuning.columnStepDeg / this.binSizeDeg));
    for (let k = 1; k <= this.binCount; k++) {
      const i = (here + direction * step * k + this.binCount * 2) % this.binCount;
      if (!needsWork(i)) continue;
      return this._target(i, this.gapBand(i), k === 1 ? 'next-column' : 'skip-to-work');
    }
    return { complete: true, bearingDeg: null, elevationDeg: null, band: -1, action: 'complete' };
  }

  /** Which band this bearing should be asked for next, in the sense the
   *  serpentine is currently travelling. -1 when the column is finished. */
  gapBand(index) {
    return this.ascending ? this.lowestGap(index) : this.highestGap(index);
  }

  /** Turn the vertical sweep around. Called once, when a column completes, so
   *  the camera comes back down the next column instead of travelling through
   *  sky it has already covered. */
  advanceSerpentine() {
    this.ascending = !this.ascending;
    return this.ascending;
  }

  _target(index, band, action) {
    const safeBand = band < 0 ? 0 : band;
    return {
      complete: false,
      bearingDeg: this.bearingOf(index),
      elevationDeg: this.elevationOf(safeBand),
      band: safeBand,
      bandsRequired: this.bandsRequired[index],
      action
    };
  }

  /**
   * How far, and in which sense, the operator must tilt to reach the target.
   *
   * Returned separately from the bearing because the two are acted on with
   * different muscles and the directive shows them differently: turning is the
   * body, tilting is the wrists.
   */
  liftFor(target, elevationDeg) {
    if (!target || target.complete) return 0;
    return target.elevationDeg - elevationDeg;
  }

  /** Fraction of all required cells that are filled. The progress bar. */
  completeness() {
    let need = 0, have = 0;
    for (let i = 0; i < this.binCount; i++) {
      const bands = this.bandsRequired[i];
      need += bands;
      for (let b = 0; b < bands; b++) if (this._bandFilled(i, b)) have++;
    }
    return { need, have, fraction: need ? have / need : 1 };
  }

  /**
   * Bearings whose column is unfinished, as contiguous runs.
   *
   * Reported as runs rather than bins because an operator cannot act on "bin
   * 47"; they can act on "between 92° and 118°, you still need the top".
   */
  gaps() {
    const runs = [];
    let start = -1;
    for (let i = 0; i <= this.binCount; i++) {
      const bad = i < this.binCount && !this.columnComplete(i);
      if (bad && start < 0) start = i;
      if (!bad && start >= 0) {
        const highest = Math.max(...Array.from(
          { length: i - start }, (_, k) => this.bandsRequired[start + k]));
        runs.push({
          fromDeg: wrap360(start * this.binSizeDeg),
          toDeg: wrap360(i * this.binSizeDeg),
          widthDeg: (i - start) * this.binSizeDeg,
          bandsRequired: highest,
          topElevationDeg: this.elevationOf(highest - 1)
        });
        start = -1;
      }
    }
    // Join a run that wraps through zero.
    if (runs.length > 1) {
      const first = runs[0], last = runs[runs.length - 1];
      if (first.fromDeg === 0 && Math.abs(last.toDeg - 360) < 1e-6) {
        runs.pop(); runs.shift();
        runs.push({
          fromDeg: last.fromDeg,
          toDeg: first.toDeg,
          widthDeg: last.widthDeg + first.widthDeg,
          bandsRequired: Math.max(first.bandsRequired, last.bandsRequired),
          topElevationDeg: Math.max(first.topElevationDeg, last.topElevationDeg)
        });
      }
    }
    return runs.sort((a, b) => b.widthDeg - a.widthDeg);
  }

  /** Everything the archive should record about the vertical plan. */
  snapshot() {
    const c = this.completeness();
    return {
      binCount: this.binCount,
      binSizeDeg: this.binSizeDeg,
      bandCount: this.bandCount,
      bandStepDeg: this.bandStepDeg,
      vfovDeg: this.vfovDeg,
      overlapFraction: this.tuning.overlapFraction,
      ascending: this.ascending,
      cellsRequired: c.need,
      cellsFilled: c.have,
      fraction: c.fraction,
      tallestColumn: Math.max(...this.bandsRequired),
      reachableBands: this.reachableBands,
      maxAskElevationDeg: this.tuning.maxAskElevationDeg,
      columnsBeyondReach: Array.from({ length: this.binCount },
        (_, i) => (this.beyondReach(i) ? 1 : 0)).reduce((a, b) => a + b, 0),
      columns: Array.from({ length: this.binCount }, (_, i) => ({
        bearingDeg: Number(this.bearingOf(i).toFixed(2)),
        bandsRequired: this.bandsRequired[i],
        bandsWanted: this.bandsWanted[i],
        beyondReach: this.beyondReach(i),
        bandsFilled: Array.from({ length: this.bandsRequired[i] },
          (_, b) => this._bandFilled(i, b)).filter(Boolean).length,
        complete: this.columnComplete(i)
      })),
      gaps: this.gaps()
    };
  }
}

/**
 * Where to point to join a stranded group back onto the survey.
 *
 * The audit says a group of frames cannot be placed. That is a diagnosis, and a
 * diagnosis delivered to someone standing in a field is only worth as much as
 * the instruction that follows it. This turns it into somewhere to point.
 *
 * For every stranded frame, find the nearest frame that IS in the main
 * component and propose the midpoint between them. A frame taken there overlaps
 * both by construction, so it is precisely the missing link — and because the
 * bearing gap in these failures is usually small while the ELEVATION gap is
 * large, the proposal is nearly always "same direction, half way down", which
 * is the movement the operator never makes on their own.
 *
 * Measured on the 2026-08-20 capture: 24 of 63 frames stranded across 242°-340°,
 * every one of them recoverable by a handful of frames at intermediate heights.
 *
 * Proposals are merged when they land close together, because six prompts for
 * one hole is not guidance, and returned worst-first so the operator fixes the
 * biggest disconnection with the first frame they take.
 */
export function bridgeTargets(frames, audit, {
  hfovDeg = 40, vfovDeg = 31, mergeDeg = 10, limit = 6
} = {}) {
  if (!audit || !audit.atRisk?.length) return [];
  const stranded = audit.atRisk.filter(r => r.stranded);
  if (!stranded.length) return [];

  const strandedIds = new Set(stranded.map(r => r.index));
  const anchors = frames.filter(f => !strandedIds.has(f.index ?? -1));
  if (!anchors.length) return [];

  const proposals = [];
  for (const lost of stranded) {
    let best = null, bestGap = Infinity;
    for (const anchor of anchors) {
      const meanAlt = (lost.elevationDeg + anchor.elevationDeg) / 2;
      const daz = Math.abs(angDiff(lost.azimuthDeg, anchor.azimuthDeg))
        * Math.cos(clamp(meanAlt, -85, 85) * Math.PI / 180);
      const dalt = Math.abs(lost.elevationDeg - anchor.elevationDeg);
      const gap = Math.hypot(daz, dalt);
      if (gap < bestGap) { bestGap = gap; best = anchor; }
    }
    if (!best) continue;
    // The midpoint, in the sense that matters: half way in bearing the short
    // way round, half way in elevation.
    const half = angDiff(best.azimuthDeg, lost.azimuthDeg) / 2;
    proposals.push({
      bearingDeg: wrap360(lost.azimuthDeg + half),
      elevationDeg: (lost.elevationDeg + best.elevationDeg) / 2,
      gapDeg: bestGap,
      joins: lost.index,
      to: best.index ?? null
    });
  }

  const merged = [];
  for (const prop of proposals.sort((a, b) => b.gapDeg - a.gapDeg)) {
    const near = merged.find(m =>
      Math.abs(angDiff(m.bearingDeg, prop.bearingDeg)) < mergeDeg
      && Math.abs(m.elevationDeg - prop.elevationDeg) < mergeDeg);
    if (near) { near.frames.push(prop.joins); continue; }
    merged.push({
      bearingDeg: prop.bearingDeg,
      elevationDeg: prop.elevationDeg,
      gapDeg: prop.gapDeg,
      frames: [prop.joins],
      // A gap wider than a frame cannot be closed by one photograph, and
      // saying so stops the operator taking one and believing it is fixed.
      framesNeeded: Math.max(1, Math.ceil(prop.gapDeg / Math.min(hfovDeg, vfovDeg) * 2))
    });
  }
  return merged.slice(0, limit);
}

/**
 * What fraction of a frame's area two frames share.
 *
 * NOT centre-to-centre distance. The first version of this used the diagonal
 * half-angle as a reach, which counts two frames meeting at one corner as
 * neighbours — and when it was replayed against the real 2026-08-19 capture it
 * found only 4 of the 13 frames the stitcher actually dropped, while calling a
 * frame with a single corner-touch well connected. A feature matcher needs
 * shared texture, and shared texture is area.
 *
 * The bearing difference is scaled by the cosine of the mean elevation, because
 * a degree of bearing subtends a smaller angle the higher the camera looks: two
 * frames 20° apart in bearing at 50° elevation are only 12.9° apart on the sky.
 */
function sharedFraction(a, b, hfovDeg, vfovDeg) {
  const meanAlt = (a.elevationDeg + b.elevationDeg) / 2;
  const daz = Math.abs(angDiff(a.azimuthDeg, b.azimuthDeg))
    * Math.cos(clamp(meanAlt, -85, 85) * Math.PI / 180);
  const dalt = Math.abs(a.elevationDeg - b.elevationDeg);
  const across = Math.max(0, 1 - daz / hfovDeg);
  const down = Math.max(0, 1 - dalt / vfovDeg);
  return across * down;
}

/**
 * Would this set of frames survive a stitch?
 *
 * A cheap standalone check with no dependency on the solver, cheap enough to
 * re-run on every keyframe: build the overlap graph on geometry alone and find
 * its connected components. Anything outside the largest one cannot be placed,
 * however good the photographs are.
 *
 * CALIBRATION. Replayed against the 2026-08-19 23:48 capture, where the solver
 * dropped 13 of 80 frames, `minShared` 0.15 finds all 13 — and 6 more that the
 * matcher managed to rescue. It reports 2 components with a largest of 61 where
 * the solver found 3 with a largest of 67, so it is slightly pessimistic. That
 * is the correct direction for a warning given in the field: the cost of an
 * unnecessary extra frame is seconds, and the cost of a missing one is the roof
 * of the house not appearing in the panorama.
 *
 * It also answers usefully. On that capture it does not name 13 scattered
 * frames; it says one group of 19, spanning 171° to 284°, never reaches the
 * rest of the survey — which is a thing an operator can walk back and fix.
 *
 * `frames` is [{ azimuthDeg, elevationDeg }].
 */
export function overlapAudit(frames, {
  hfovDeg = 40, vfovDeg = 31, minShared = 0.15, lonely = 4
} = {}) {
  const n = frames.length;
  const counts = new Uint16Array(n);
  const adjacency = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sharedFraction(frames[i], frames[j], hfovDeg, vfovDeg) >= minShared) {
        counts[i]++; counts[j]++;
        adjacency[i].push(j); adjacency[j].push(i);
      }
    }
  }

  /* Connected components of the overlap graph — the same test the solver
   * applies, and the one that actually predicts an omission. Counting
   * neighbours alone misses the real failure: frames 47-50 of the 2026-08-19
   * capture each had two or three neighbours and were perfectly happy with each
   * other, but nothing joined that little chain at 47° to the horizon row at 9°,
   * so the whole chain was unplaceable. A frame is at risk when it is not in
   * the component that will become the panorama. */
  const component = new Int32Array(n).fill(-1);
  const sizes = [];
  for (let start = 0; start < n; start++) {
    if (component[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [start];
    component[start] = id;
    while (stack.length) {
      const i = stack.pop();
      size++;
      for (const j of adjacency[i]) {
        if (component[j] < 0) { component[j] = id; stack.push(j); }
      }
    }
    sizes.push(size);
  }
  const main = sizes.indexOf(Math.max(...sizes, 0));

  const risky = [];
  for (let i = 0; i < n; i++) {
    const stranded = component[i] !== main;
    if (!stranded && counts[i] >= lonely) continue;
    risky.push({
      index: frames[i].index ?? i,
      azimuthDeg: frames[i].azimuthDeg,
      elevationDeg: frames[i].elevationDeg,
      neighbours: counts[i],
      stranded,
      // Which way out. An operator can act on "tilt down and re-shoot"; they
      // cannot act on "component 3".
      reason: stranded
        ? (sizes[component[i]] > 1
          ? `in a group of ${sizes[component[i]]} frames that does not reach the rest of the survey`
          : 'shares no overlap with any other frame')
        : `only ${counts[i]} overlapping neighbour${counts[i] === 1 ? '' : 's'}`
    });
  }

  const sorted = Array.from(counts).sort((a, b) => a - b);
  const stranded = risky.filter(r => r.stranded);
  return {
    frames: n,
    components: sizes.length,
    largestComponent: sizes.length ? sizes[main] : 0,
    medianNeighbours: n ? sorted[n >> 1] : 0,
    atRisk: risky.sort((a, b) => (a.stranded === b.stranded)
      ? a.neighbours - b.neighbours : (a.stranded ? -1 : 1)),
    // The elevation band the survey is in danger of losing. This is the line
    // that would have said, in the field, "your 47° frames are going to be
    // thrown away" — while the operator was still standing there to fix it.
    riskiestElevationDeg: stranded.length
      ? stranded.reduce((a, b) => a.elevationDeg >= b.elevationDeg ? a : b).elevationDeg
      : (risky.length ? risky[0].elevationDeg : null)
  };
}
