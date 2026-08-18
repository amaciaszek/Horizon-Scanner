'use strict';

/**
 * Progress and a time estimate for the panorama build.
 *
 * The estimate is MEASURED, never assumed. Nothing here carries a table of how
 * long a stage "should" take, because that number would be wrong on the first
 * device that is faster or slower than the one it was written on, and a
 * confidently wrong countdown is worse than no countdown — it teaches the
 * operator to distrust the whole panel.
 *
 * Instead each stage times its own units as they complete and projects the
 * remainder from the rate it is actually achieving. Two consequences worth
 * knowing:
 *
 *  - There is no estimate at all until a stage has done enough units to have a
 *    rate worth quoting. Until then the caller is told `null` and should say
 *    something honest like "estimating…" rather than guess.
 *  - The estimate is smoothed and only ever shown to a coarse resolution.
 *    A figure that jitters between 40 and 70 seconds reads as broken even when
 *    its average is perfectly good.
 *
 * Stage weights are the one piece of prior knowledge, and they are only used to
 * turn several stages into one bar. They come from the reference capture: on 91
 * frames, feature extraction and matching dominate and the solve is a rounding
 * error. Getting them somewhat wrong makes the bar travel unevenly; it cannot
 * make the time estimate wrong, because that is measured per stage.
 */

/** Fraction of total build time each stage typically occupies. */
const STAGE_WEIGHT = {
  decoding: 0.18,
  features: 0.34,
  matching: 0.36,
  solving: 0.06,
  rendering: 0.06
};

const STAGE_ORDER = ['decoding', 'features', 'matching', 'solving', 'rendering'];

/** Units completed before a rate is trustworthy enough to project from. */
const MIN_UNITS_FOR_ESTIMATE = 4;

/** Seconds of smoothing on the remaining-time figure. */
const SMOOTHING = 0.35;

export class BuildProgress {
  constructor(onUpdate, now = () => performance.now()) {
    this.onUpdate = onUpdate;
    this.now = now;
    this.startedAt = this.now();
    this.stage = null;
    this.stageStartedAt = this.startedAt;
    this.completed = 0;
    this.total = 0;
    this.label = '';
    this.smoothedRemainingSec = null;
    /** Stages already finished, so their weight counts as done. */
    this.done = new Set();
  }

  /**
   * Report progress within a stage.
   *
   * `completed` and `total` are in whatever unit the stage counts — photos,
   * pairs, rows. They never have to be comparable between stages.
   */
  update(stage, completed, total, label) {
    if (stage !== this.stage) {
      if (this.stage) this.done.add(this.stage);
      this.stage = stage;
      this.stageStartedAt = this.now();
      this.smoothedRemainingSec = null;
    }
    this.completed = Math.max(0, completed || 0);
    this.total = Math.max(0, total || 0);
    if (label) this.label = label;
    this.onUpdate?.(this.snapshot());
  }

  /** Weighted fraction of the whole build, across all stages. */
  fraction() {
    let done = 0;
    for (const s of STAGE_ORDER) {
      if (this.done.has(s)) done += STAGE_WEIGHT[s] || 0;
    }
    if (this.stage && this.total > 0) {
      done += (STAGE_WEIGHT[this.stage] || 0) * Math.min(1, this.completed / this.total);
    }
    return Math.max(0, Math.min(1, done));
  }

  /**
   * Seconds still to go, or null while there is not yet enough evidence.
   *
   * Measured twice over: the current stage from its own observed rate, and the
   * stages after it by scaling that stage's total cost by their weights. The
   * second half is the weaker inference, which is exactly why the whole figure
   * is presented as an estimate and rounded hard.
   */
  remainingSec() {
    if (!this.stage || this.completed < MIN_UNITS_FOR_ESTIMATE || this.total <= 0) return null;
    const elapsed = (this.now() - this.stageStartedAt) / 1000;
    if (!(elapsed > 0)) return null;

    const perUnit = elapsed / this.completed;
    const stageRemaining = Math.max(0, this.total - this.completed) * perUnit;

    const stageWeight = STAGE_WEIGHT[this.stage] || 0;
    const stageTotalCost = elapsed + stageRemaining;
    let laterWeight = 0;
    let seen = false;
    for (const s of STAGE_ORDER) {
      if (s === this.stage) { seen = true; continue; }
      if (seen && !this.done.has(s)) laterWeight += STAGE_WEIGHT[s] || 0;
    }
    const laterRemaining = stageWeight > 0 ? stageTotalCost * (laterWeight / stageWeight) : 0;

    const raw = stageRemaining + laterRemaining;
    this.smoothedRemainingSec = this.smoothedRemainingSec === null
      ? raw
      : this.smoothedRemainingSec + (raw - this.smoothedRemainingSec) * SMOOTHING;
    return this.smoothedRemainingSec;
  }

  snapshot() {
    const remaining = this.remainingSec();
    return {
      stage: this.stage,
      label: this.label,
      completed: this.completed,
      total: this.total,
      fraction: this.fraction(),
      remainingSec: remaining,
      elapsedSec: (this.now() - this.startedAt) / 1000,
      etaText: formatEta(remaining)
    };
  }

  finish() {
    if (this.stage) this.done.add(this.stage);
    this.stage = null;
    this.onUpdate?.({
      ...this.snapshot(),
      fraction: 1,
      remainingSec: 0,
      etaText: 'done'
    });
  }
}

/**
 * Coarse on purpose. Nobody waiting on a progress bar wants to watch a seconds
 * counter tick, and quoting "1 min 47 s" implies a precision this does not have.
 */
export function formatEta(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return 'estimating…';
  if (seconds < 5) return 'a few seconds left';
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} seconds left`;
  const mins = seconds / 60;
  if (mins < 2) return 'about a minute left';
  if (mins < 10) return `about ${Math.round(mins)} minutes left`;
  return `over ${Math.floor(mins)} minutes left`;
}
