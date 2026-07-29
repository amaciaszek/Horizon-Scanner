'use strict';
import { wrap360, angDiff, clamp } from './math3d.js';
import { BIN_STEP, BIN_COUNT, STATUS } from './survey.js';

export const PHASE = {
  IDLE: 'idle',
  CALIBRATING: 'calibrating',
  PASS1: 'pass1',
  ANALYSING: 'analysing',
  PASS2: 'pass2',
  VALIDATING: 'validating',
  COMPLETE: 'complete'
};

const IDEAL_RATE = 7;      // deg/s
const MAX_RATE = 14;       // above this, frames blur and overlap collapses

/**
 * Capture modes.
 *
 * handheld: the operator pivots their body around the phone. The optical centre
 *   wanders by a few centimetres per frame, which is harmless for distant trees
 *   and matters for a house at 12 m, so the roll and rate gates stay loose
 *   enough to be achievable and the overlap requirement absorbs the rest.
 *
 * tripod: the phone is clamped to the mount or a tripod head and the head is
 *   rotated. The optical centre is genuinely fixed, so there is no parallax to
 *   absorb and the geometry is only limited by how carefully the operator turns
 *   the head. Everything tightens accordingly.
 */
export const MODES = {
  handheld: {
    id: 'handheld',
    label: 'Handheld',
    idealRate: IDEAL_RATE,
    maxRate: MAX_RATE,
    rollLimitCal: 12,
    rollLimitScan: 18,
    minOverlap: 0.30,
    targetOverlap: 0.45,
    setupDetail: 'Stand where the telescope sits and hold the phone at the optical height. Rotate your body around the phone, not the phone around you.',
    calDetail: 'Keep the phone upright and steady.'
  },
  tripod: {
    id: 'tripod',
    label: 'Tripod / mount',
    idealRate: 4,
    maxRate: 9,
    rollLimitCal: 5,
    rollLimitScan: 8,
    minOverlap: 0.45,
    targetOverlap: 0.60,
    setupDetail: 'Clamp the phone so its rear camera sits on the mount azimuth axis at the optical height. Rotate the head only — do not move the tripod between passes.',
    calDetail: 'Lock the altitude axis and leave the head untouched while the sensors settle.'
  }
};

/**
 * Turns survey state into one instruction at a time. Everything the operator is
 * told comes from a measured quantity, not a timer.
 */
export class ScanDirector {
  constructor(survey) {
    this.survey = survey;
    this.mode = MODES.handheld;
    this.phase = PHASE.IDLE;
    this.phaseStarted = 0;
    this.calibrationProgress = 0;
    this.pass1Start = null;
    this.pass1Travel = 0;
    this.target = null;         // {fromDeg, toDeg} sector being rescanned
    this.targets = [];
    this.lastDirective = null;
    this.blockedReason = null;
  }

  /** Refused once capture has started: the acceptance thresholds that already
   *  admitted pass-1 samples cannot be retroactively changed. */
  setMode(id) {
    const m = MODES[id];
    if (!m) return false;
    if (this.phase !== PHASE.IDLE) return false;
    this.mode = m;
    return true;
  }

  setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseStarted = performance.now();
  }

  beginCalibration() { this.setPhase(PHASE.CALIBRATING); this.calibrationProgress = 0; }

  beginPass1(headingDeg) {
    this.setPhase(PHASE.PASS1);
    this.pass1Start = headingDeg;
    this.pass1Travel = 0;
    this.survey.pass = 1;
  }

  notePass1Travel(deltaDeg) { this.pass1Travel += deltaDeg; }

  beginPass2() {
    this.setPhase(PHASE.PASS2);
    this.survey.pass = 2;
    this.refreshTargets();
  }

  refreshTargets() {
    this.targets = this.survey.weakSectors(1.0).slice(0, 24);
    this.target = this.targets[0] || null;
    return this.targets;
  }

  /** Choose the nearest unresolved sector to where the operator is standing. */
  pickNearestTarget(headingDeg) {
    if (!this.targets.length) { this.target = null; return null; }
    let best = null, bestDist = Infinity;
    for (const t of this.targets) {
      const centre = wrap360(t.fromDeg + t.widthDeg / 2);
      const d = Math.abs(angDiff(centre, headingDeg));
      if (d < bestDist) { bestDist = d; best = t; }
    }
    this.target = best;
    return best;
  }

  /**
   * Produce the current instruction.
   * ctx: { heading, elevation, roll, rotationRate, stillness, overlap,
   *        frameStatus, visualQuality, sensor }
   */
  directive(ctx) {
    const d = this._directive(ctx);
    this.lastDirective = d;
    return d;
  }

  _directive(ctx) {
    const say = (tone, headline, detail, arrow = null, progress = null) =>
      ({ tone, headline, detail, arrow, progress, phase: this.phase });

    const M = this.mode;

    if (this.phase === PHASE.IDLE) {
      return say('idle', 'Ready to survey', M.setupDetail);
    }

    if (this.phase === PHASE.CALIBRATING) {
      if (Math.abs(ctx.roll) > M.rollLimitCal) return say('fix', 'Level the phone', `Roll is ${ctx.roll.toFixed(0)}°. Bring it within ±${M.rollLimitCal}°.`);
      if (ctx.stillness < 0.6) {
        // Distinguish "you are moving" from "the sensor is noisy". Telling a
        // person to hold still when they are already on a tripod is useless.
        if (ctx.jitterDeg > 1.2) {
          return say('warn', 'Sensor noise, not you',
            `The orientation stream is scattering ±${(ctx.jitterDeg / 2).toFixed(1)}°. Move away from steel, magnets, and motors. The survey will start on a relative azimuth in a few seconds regardless — the mount supplies the real azimuth later.`);
        }
        return say('fix', 'Hold still', 'Sensor calibration needs a few seconds of stillness.');
      }
      return say('work', 'Calibrating sensors', M.calDetail, null, this.calibrationProgress);
    }

    if (this.phase === PHASE.PASS1) {
      const blocking = this._frameProblem(ctx);
      if (blocking) return blocking;
      if (Math.abs(ctx.roll) > M.rollLimitScan) return say('fix', 'Level the phone', `Roll ${ctx.roll.toFixed(0)}°. Keep the horizon square in the frame.`);

      if (ctx.overlap != null && ctx.overlap < M.minOverlap) {
        const back = Math.max(4, Math.round((M.targetOverlap - ctx.overlap) * ctx.hfovDeg));
        return say('fix', `Return ${back}° counter-clockwise`, 'Insufficient overlap with the last accepted frame.', -back);
      }
      if (ctx.rotationRate > M.maxRate) return say('fix', 'Slow down', `${ctx.rotationRate.toFixed(0)}°/s is too fast to keep frames sharp. Aim for ${M.idealRate}°/s.`, +1);
      if (ctx.visualQuality != null && ctx.visualQuality < 0.25 && ctx.stillness > 0.7) {
        return say('warn', 'Not enough texture here', 'Tilt down slightly to include more of the skyline edge, or pause while more frames are collected.');
      }
      const progress = clamp(Math.abs(this.pass1Travel) / 360, 0, 1);
      if (Math.abs(this.pass1Travel) >= 358) {
        return say('good', 'Loop nearly closed', 'Keep turning until the view matches where you started.', +1, progress);
      }
      if (Math.abs(ctx.rotationRate) < 1.5) {
        return say('work', 'Rotate slowly clockwise', `${Math.abs(this.pass1Travel).toFixed(0)}° of 360° covered.`, +1, progress);
      }
      return say('good', 'Collecting', `${Math.abs(this.pass1Travel).toFixed(0)}° of 360° covered at ${Math.abs(ctx.rotationRate).toFixed(0)}°/s.`, +1, progress);
    }

    if (this.phase === PHASE.ANALYSING) {
      return say('work', 'Building the profile', 'Optimising the camera path, closing the loop, and merging observations.');
    }

    if (this.phase === PHASE.PASS2) {
      if (!this.targets.length) return say('good', 'All sectors verified', 'Finish the survey to generate the report.');
      const t = this.pickNearestTarget(ctx.heading);
      const centre = wrap360(t.fromDeg + t.widthDeg / 2);
      const delta = angDiff(centre, ctx.heading);
      const remaining = this.targets.length;

      const blocking = this._frameProblem(ctx);
      if (blocking && Math.abs(delta) < 20) return blocking;

      if (Math.abs(delta) > 12) {
        return say('work', `Turn ${delta > 0 ? 'right' : 'left'} ${Math.abs(delta).toFixed(0)}°`,
          `${remaining} sector${remaining > 1 ? 's' : ''} still unverified. Next: ${t.fromDeg.toFixed(1)}°–${t.toDeg.toFixed(1)}°.`,
          delta > 0 ? +Math.abs(delta) : -Math.abs(delta));
      }
      if (Math.abs(delta) > 3) {
        return say('work', `Nudge ${delta > 0 ? 'right' : 'left'} ${Math.abs(delta).toFixed(0)}°`, 'Centre the highlighted sector in the frame.', delta > 0 ? +1 : -1);
      }
      if (ctx.stillness < 0.5) return say('fix', 'Hold still', 'Collecting confirmation frames for this sector.');
      return say('good', 'Holding on target', `Confirming ${t.fromDeg.toFixed(1)}°–${t.toDeg.toFixed(1)}°.`, 0);
    }

    if (this.phase === PHASE.VALIDATING) return say('work', 'Validating', 'Checking coverage, spread, and loop closure.');
    return say('good', 'Survey complete', 'Review the report, then export.');
  }

  /** Frame-level problems that make the current view unusable. */
  _frameProblem(ctx) {
    if (ctx.frameStatus === 'tooDark') {
      return { tone: 'fix', headline: 'Too dark to survey', detail: 'Sky segmentation needs daylight. At night the sky is the dark region and the ground carries the bright lights, so every cue inverts and the traced line is meaningless. Come back in daylight — flat overcast is ideal.', arrow: null, tilt: null, phase: this.phase };
    }
    if (ctx.frameStatus === 'noSky') {
      const how = this.mode.id === 'tripod'
        ? 'Raise the altitude axis without moving the tripod.'
        : 'Tilt the camera upward without stepping forward.';
      return { tone: 'fix', headline: 'No sky visible', detail: `${how} The sky boundary has to be inside the frame.`, arrow: null, tilt: +1, phase: this.phase };
    }
    if (ctx.frameStatus === 'allSky') {
      return { tone: 'fix', headline: 'No obstruction visible', detail: 'Tilt downward until the skyline enters the frame.', arrow: null, tilt: -1, phase: this.phase };
    }
    if (ctx.frameStatus === 'clippedTop') {
      return { tone: 'fix', headline: 'Tilt up', detail: 'The obstruction reaches the top edge, so its true height is outside the frame.', arrow: null, tilt: +1, phase: this.phase };
    }
    return null;
  }

  /** Percentage of the circle currently verified, for the phase readouts. */
  verifiedFraction() {
    let n = 0;
    for (const b of this.survey.bins) if (b.status === STATUS.VERIFIED) n++;
    return n / BIN_COUNT;
  }
}

export { BIN_STEP };
