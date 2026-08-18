'use strict';
import { wrap360, angDiff, clamp } from './math3d.js';
import { BIN_STEP, BIN_COUNT, STATUS } from './survey.js';
import { captureGapReport, bearingLabel } from './capture-gaps.js';
import { captureStall, overlapFloor, pass1OverTravel, PASS1_REFUSE_DEG } from './capture-policy.js';

export const PHASE = {
  IDLE: 'idle',
  CALIBRATING: 'calibrating',
  PASS1: 'pass1',
  ANALYSING: 'analysing',
  PASS2: 'pass2',
  VALIDATING: 'validating',
  COMPLETE: 'complete'
};

/*
 * Speed limits, derived rather than guessed.
 *
 * The old 7 deg/s target was invented, and it was wrong by most of an order of
 * magnitude. Two things actually bind. Frame-to-frame overlap: at ~10 Hz
 * processing through a 52 deg horizontal field, even 90 deg/s leaves 83% overlap
 * between consecutive frames. Motion blur: in daylight the exposure is around
 * 1/500 s, so 90 deg/s smears a feature by about half a pixel in the 160 px
 * registration frame. Neither is remotely threatened at 7 deg/s, and a limit
 * that forces a five-minute lap for no measurable benefit is a limit that makes
 * the tool unusable.
 *
 * The honest gate is measured registration quality, which the pipeline already
 * reports per frame. Rate is only a hint now, and the hard stop sits where
 * blur genuinely begins to matter.
 */
const IDEAL_RATE = 25;     // deg/s — a lap in about 15 s
const MAX_RATE = 70;       // beyond this, blur starts to cost real precision

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
    idealRate: 15,
    maxRate: 45,
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
    this.pass2Travel = 0;
    this.verificationSweep = false;
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
    this.pass2Travel = 0;
    this.verificationSweep = false;
    this.survey.pass = 1;
  }

  notePass1Travel(deltaDeg) { this.pass1Travel += deltaDeg; }
  notePass2Travel(deltaDeg) { this.pass2Travel += deltaDeg; }

  beginPass2() {
    this.setPhase(PHASE.PASS2);
    this.survey.pass = 2;
    this.pass2Travel = 0;
    this.refreshTargets();
    // Verification requires observations from two independent passes. A
    // normal first lap therefore has zero verified bins and needs another
    // dense lap, not a request to hold on the centre of one 360-degree target.
    this.verificationSweep = this.survey.coverage().verifiedBins === 0;
  }

  refreshTargets() {
    const weak = this.survey.weakSectors(1.0).map(target => ({ ...target, kind: 'weak-skyline' }));
    const report = captureGapReport(this.survey.keyframes, this.survey.yawDatum || 0,
      { minOverlap: overlapFloor(this.mode) });
    // Cleanup concerns the lap just completed. A gap in pass 1 that was filled
    // during pass 2 no longer needs another visit; a gap repeated in pass 2 is
    // exactly where an offline stitcher will be unable to connect the photos.
    const latest = report.passes[report.passes.length - 1];
    const photoGaps = (latest?.gaps || []).flatMap(gap =>
      (gap.recaptureAzimuthsDeg || [gap.targetAzimuthDeg]).map((targetAzimuthDeg, targetIndex) => {
        const widthDeg = clamp((gap.desiredMaximumStepDeg || 12) * 0.25, 6, 10);
        const fromDeg = wrap360(targetAzimuthDeg - widthDeg / 2);
        return {
          kind: 'photo-gap',
          fromDeg,
          toDeg: wrap360(fromDeg + widthDeg),
          widthDeg,
          targetAzimuthDeg,
          targetLabel: gap.recaptureLabels?.[targetIndex] || `${targetAzimuthDeg.toFixed(1)}°`,
          gap
        };
      })
    );
    this.targets = [...photoGaps, ...weak].slice(0, 24);
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
      // No roll requirement. However the operator chooses to hold the device
      // IS level as far as this app is concerned: the projection carries roll
      // through the full quaternion, so a rotated hold changes nothing about
      // the geometry. The check only ever existed as a tidiness heuristic, and
      // on 2026-08-14 an iPad whose screen angle was misreported showed a
      // permanent -85° and could not start a scan at all. Never block a person
      // on a derived angle that has already been observed to be wrong.
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
      // Losing coverage outranks every frame-level complaint. The frame message
      // says what is wrong with the current view; this one says what it has
      // already cost and where to go to get it back.
      const stalled = this._captureStall(ctx);
      if (stalled) return stalled;
      const blocking = this._frameProblem(ctx);
      if (blocking) return blocking;
      // The loop-closure hunt has no upper bound of its own: when the visual
      // match never lands, "keep turning until the view matches" is an
      // instruction to turn forever. One field capture ran to 714 degrees on
      // it, which put both physical laps inside pass 1 and left the survey with
      // no independent verification at all.
      const over = pass1OverTravel(this.pass1Travel);
      if (over.prompt) {
        return say('fix', 'Stop — the lap is done',
          `${over.travelledDeg.toFixed(0)}° covered, which is more than a full circle. The starting view never matched visually, so the app cannot close the loop for you. Tap the button below to close the lap and start the verification lap — turning further only adds photographs to a pass that is already complete.${over.refuseNewSweeps ? ` Past ${PASS1_REFUSE_DEG}° no further pass-1 photographs are being recorded, because every bearing already has one.` : ''}`,
          0);
      }
      if (this.pass1Travel > 12) {
        return say('fix', 'Turn counter-clockwise', 'The survey is accumulating in the clockwise direction. Reverse direction and continue counter-clockwise.', -1);
      }

      if (ctx.overlap != null && ctx.overlap < M.minOverlap) {
        const back = Math.max(4, Math.round((M.targetOverlap - ctx.overlap) * ctx.hfovDeg));
        return say('fix', `Return ${back}° clockwise`, 'Insufficient overlap with the last accepted frame.', +back);
      }
      // Only complain about speed when registration is actually suffering. A
      // number on its own is not evidence that anything went wrong.
      if (ctx.rotationRate > M.maxRate) {
        return say('fix', 'Slow down', `${ctx.rotationRate.toFixed(0)}°/s will start to blur frames. Anything under ${M.idealRate}°/s is comfortable.`, +1);
      }
      if (ctx.visualQuality !== null && ctx.visualQuality < 0.35 && ctx.rotationRate > 20) {
        return say('fix', 'Ease off a little', `Frame matching is struggling at ${ctx.rotationRate.toFixed(0)}°/s. Slow to about ${M.idealRate}°/s until it locks.`, +1);
      }
      if (ctx.visualQuality != null && ctx.visualQuality < 0.25 && ctx.stillness > 0.7) {
        return say('warn', 'Not enough texture here', 'Tilt down slightly to include more of the skyline edge, or pause while more frames are collected.');
      }
      const guided = this._followTheDot(ctx, say);
      if (guided) return guided;

      const progress = clamp(Math.abs(this.pass1Travel) / 360, 0, 1);
      if (Math.abs(this.pass1Travel) >= 358) {
        return say('good', 'Loop nearly closed', 'Keep turning counter-clockwise until the view matches where you started.', -1, progress);
      }
      if (Math.abs(ctx.rotationRate) < 1.5) {
        return say('work', 'Rotate slowly counter-clockwise', `${Math.abs(this.pass1Travel).toFixed(0)}° of 360° covered.`, -1, progress);
      }
      return say('good', 'Collecting counter-clockwise', `${Math.abs(this.pass1Travel).toFixed(0)}° of 360° covered at ${Math.abs(ctx.rotationRate).toFixed(0)}°/s.`, -1, progress);
    }

    if (this.phase === PHASE.ANALYSING) {
      return say('work', 'Building the profile', 'Optimising the camera path, closing the loop, and merging observations.');
    }

    if (this.phase === PHASE.PASS2) {
      if (this.verificationSweep) {
        const stalled = this._captureStall(ctx);
        if (stalled) return stalled;
        const blocking = this._frameProblem(ctx);
        if (blocking) return blocking;
        if (this.pass2Travel > 12) {
          return say('fix', 'Turn counter-clockwise', 'The verification lap must continue in the same direction as the first lap.', -1);
        }
        if (ctx.overlap != null && ctx.overlap < M.minOverlap) {
          const back = Math.max(4, Math.round((M.targetOverlap - ctx.overlap) * ctx.hfovDeg));
          return say('fix', `Return ${back} degrees clockwise`, 'Insufficient overlap with the last accepted verification frame.', +back);
        }
        if (ctx.rotationRate > M.maxRate) {
          return say('fix', 'Slow down', `${ctx.rotationRate.toFixed(0)} degrees/s will start to blur verification frames.`, +1);
        }
        const guided = this._followTheDot(ctx, say);
        if (guided) return guided;
        const progress = clamp(Math.abs(this.pass2Travel) / 360, 0, 1);
        const verified = this.survey.coverage().verifiedBins;
        if (Math.abs(this.pass2Travel) >= 358) {
          return say('good', 'Verification lap complete', `Tap Finish verification lap. ${verified} of 720 bins currently agree across both passes.`, -1, progress);
        }
        if (Math.abs(ctx.rotationRate) < 1.5) {
          return say('work', 'Rotate counter-clockwise again', `${Math.abs(this.pass2Travel).toFixed(0)} degrees of the verification lap covered.`, -1, progress);
        }
        return say('good', 'Collecting verification lap', `${Math.abs(this.pass2Travel).toFixed(0)} degrees of 360 degrees covered; ${verified} bins verified so far.`, -1, progress);
      }
      if (!this.targets.length) return say('good', 'All sectors verified', 'Finish the survey to generate the report.');
      const t = this.pickNearestTarget(ctx.heading);
      const centre = wrap360(t.fromDeg + t.widthDeg / 2);
      const delta = angDiff(centre, ctx.heading);
      const remaining = this.targets.length;

      const blocking = this._frameProblem(ctx);
      if (blocking && Math.abs(delta) < 20) return blocking;

      if (Math.abs(delta) > 12) {
        return say('work', `Turn ${delta > 0 ? 'right' : 'left'} ${Math.abs(delta).toFixed(0)}°`,
          t.kind === 'photo-gap'
            ? `${remaining} capture target${remaining > 1 ? 's' : ''} remain. The source photos across this gap have only ${(t.gap.estimatedOverlap * 100).toFixed(0)}% overlap; return to ${t.targetLabel} for another image.`
            : `${remaining} sector${remaining > 1 ? 's' : ''} still unverified. Next: ${t.fromDeg.toFixed(1)}°–${t.toDeg.toFixed(1)}°.`,
          delta > 0 ? +Math.abs(delta) : -Math.abs(delta));
      }
      if (Math.abs(delta) > 3) {
        return say('work', `Nudge ${delta > 0 ? 'right' : 'left'} ${Math.abs(delta).toFixed(0)}°`, 'Centre the highlighted sector in the frame.', delta > 0 ? +1 : -1);
      }
      if (ctx.stillness < 0.5) return say('fix', 'Hold still', 'Collecting confirmation frames for this sector.');
      return say('good', t.kind === 'photo-gap' ? 'Filling photo gap' : 'Holding on target',
        t.kind === 'photo-gap'
          ? `Capturing extra overlap at ${t.targetLabel}. Keep the phone in the same position.`
          : `Confirming ${t.fromDeg.toFixed(1)}°–${t.toDeg.toFixed(1)}°.`, 0);
    }

    if (this.phase === PHASE.VALIDATING) return say('work', 'Validating', 'Checking coverage, spread, and loop closure.');
    return say('good', 'Survey complete', 'Review the report, then export.');
  }

  /**
   * Nothing has been recorded for a while — say so, say why, and say where to
   * go back to.
   *
   * The recovery bearing is the edge of what is still recoverable, not the
   * middle of the hole. Turning back to the midpoint leaves the far side of the
   * gap just as unmatched as it was; turning back to `returnDeg` restores
   * overlap with the last frame that actually exists.
   */
  _captureStall(ctx) {
    const stall = captureStall({
      sinceMs: ctx.sinceKeyframeMs,
      travelDeg: ctx.travelSinceKeyframeDeg,
      hfovDeg: ctx.hfovDeg,
      reason: ctx.lastRejectReason,
      hasAcceptedFrame: ctx.hasAcceptedFrame !== false,
      // The active mode's floor, so a tripod survey — which needs more overlap
      // than a handheld one — is warned at its own limit rather than at the
      // looser default.
      minOverlap: overlapFloor(this.mode)
    });
    if (!stall.stalled) return null;

    const cause = this._stallCause(ctx, stall);
    if (stall.kind === 'waiting') {
      return {
        tone: 'warn',
        headline: `Nothing recorded for ${stall.elapsedSec.toFixed(0)} s`,
        detail: `${cause} Hold this bearing until a photograph is accepted — moving on now leaves a hole here that a second lap will not fill, because the same thing will happen at the same bearing.`,
        arrow: 0, tilt: null, phase: this.phase, stall
      };
    }

    // Where the operator has to return to. Signed against the direction of
    // travel, which for this app is always counter-clockwise.
    const sign = ctx.travelSinceKeyframeDeg < 0 ? +1 : -1;
    const backDeg = Math.round(stall.returnDeg);
    const target = Number.isFinite(ctx.heading)
      ? ` — back to about ${bearingLabel(wrap360(ctx.heading + sign * stall.returnDeg))}`
      : '';
    return {
      tone: 'fix',
      headline: `Turn back ${backDeg}°${backDeg > 30 ? ' — coverage lost' : ''}`,
      detail: `${stall.sweptDeg.toFixed(0)}° swept with no photograph accepted${stall.elapsedSec >= 1 ? ` over ${stall.elapsedSec.toFixed(0)} s` : ''}${target}. ${cause}${stall.uncoveredDeg > 0 ? ` ${stall.uncoveredDeg.toFixed(0)}° of the circle now has no image at all.` : ''}`,
      arrow: sign * Math.max(1, backDeg), tilt: null, phase: this.phase, stall
    };
  }

  /** Why the gates are refusing, in something an operator can act on outdoors. */
  _stallCause(ctx, stall) {
    if (ctx.glareFraction > 0.02) {
      return 'The sun is in the frame, so the exposure has collapsed and the sky boundary cannot be traced. Shade the lens with your hand, put the sun behind a tree or the roofline, or come back when it is higher or lower.';
    }
    const byStatus = {
      noSky: 'No sky is visible, so there is no boundary to measure.',
      allSky: 'No obstruction is visible, so there is no boundary to measure.',
      clippedTop: 'The obstruction runs off the top of the frame, so its height is unknown here.',
      tooDark: 'It is too dark here for the sky boundary to be found.',
      trackingLost: 'Visual tracking is lost, so azimuth cannot be advanced.',
      parallax: 'The phone has moved sideways, not just turned.',
      tooHigh: 'The camera is too close to straight up.'
    };
    if (byStatus[ctx.frameStatus]) return byStatus[ctx.frameStatus];
    if (stall.reason === 'motion-too-fast') return 'Every frame here was turning too fast to record.';
    if (stall.reason === 'segmentation-error' || stall.reason === 'no-synchronized-frame') {
      return 'The camera is not delivering frames the segmenter can use.';
    }
    return 'The frame gates have refused every candidate along this arc.';
  }

  /**
   * Follow the dot.
   *
   * Everything the operator is told here comes from the coverage map, and none
   * of it from how far the phone has turned. Four states, and each one has
   * exactly one thing for them to do:
   *
   *   complete   — stop; the horizon is covered.
   *   waiting    — the dot is not moving, so give this sector more.
   *   behind     — the dot is back the way you came; go and get it.
   *   advancing  — follow it.
   *
   * The individual reasons a sector scored badly — too fast, too rolled, a
   * skyline the segmenter could not find, a sun in the lens — are deliberately
   * not surfaced. The operator does not need eight diagnostics; they need to
   * see that the target has not moved on yet. Genuine faults that make the
   * whole frame unusable are still reported, by `_frameProblem`, before this.
   */
  _followTheDot(ctx, say) {
    const g = ctx.guidance;
    if (!g || !g.summary) return null;
    const pct = Math.round(g.summary.fraction * 100);

    if (g.state === 'complete') {
      return say('good', 'Horizon covered',
        'Every part of the skyline has enough good data. Tap the button below to continue.',
        0, 1);
    }
    if (!Number.isFinite(g.offsetDeg)) return null;

    const away = Math.abs(g.offsetDeg);
    const arrow = g.offsetDeg > 0 ? +Math.max(1, Math.round(away)) : -Math.max(1, Math.round(away));

    /*
     * Tilt outranks turn, but only once the operator is roughly on the bearing.
     * Something stands here whose top has never been inside a frame, and no
     * amount of turning will fix that — which is exactly what the 2026-08-17
     * capture did for eighty-four frames while the dot sat on the horizon.
     */
    if (g.beyondTilt && away < 25) {
      return {
        tone: 'warn',
        headline: 'Too tall to frame — noted, keep going',
        detail: 'This stands higher than the camera can take in from here without pointing so steeply that azimuth stops being reliable. Its height is recorded as unmeasured and this sector will not hold up the survey. Carry on turning.',
        arrow: 0, tilt: null, phase: this.phase, progress: g.summary.fraction
      };
    }
    if (g.wantsLift && away < 25) {
      return {
        tone: 'work',
        headline: `Tilt up ${Math.max(1, Math.round(g.liftDeg))}° — this is taller than the frame`,
        detail: `The top of what stands here has never been inside a picture, so its height is unmeasured. Raise the camera until the target sits on it, keeping the same spot on the ground. ${pct}% of the horizon done.`,
        arrow: 0, tilt: +1, phase: this.phase, progress: g.summary.fraction
      };
    }

    if (g.state === 'waiting' && away < 25) {
      return say('work', 'Hold here — filling this section',
        `This part of the horizon still needs more. Keep the camera on the target and move slowly; it will move on by itself. ${pct}% of the horizon done.`,
        0, g.summary.fraction);
    }
    if (g.state === 'behind' || away > 35) {
      return say('fix', `Target is ${away.toFixed(0)}° ${g.offsetDeg > 0 ? 'right' : 'left'}`,
        `That section did not get enough usable data. Sweep back onto the target and cover it again. ${pct}% of the horizon done.`,
        arrow, g.summary.fraction);
    }
    if (away > 12) {
      return say('work', `Follow the target — ${g.offsetDeg > 0 ? 'right' : 'left'}`,
        `${pct}% of the horizon covered. Keep the target near the middle of the picture.`,
        arrow, g.summary.fraction);
    }
    if (g.wantsLift) {
      return say('work', `Follow the target — ${g.offsetDeg > 0 ? 'right' : 'left'} and up`,
        `${pct}% covered. The next section is taller than the frame, so the target sits above the horizon; raise the camera to meet it.`,
        arrow, g.summary.fraction);
    }
    return say('good', 'Following the target',
      `${pct}% of the horizon covered. Keep sweeping smoothly; the target moves on as each section fills in.`,
      arrow, g.summary.fraction);
  }

  /** Frame-level problems that make the current view unusable. */
  _frameProblem(ctx) {
    if (ctx.frameStatus === 'tooHigh') {
      /*
       * The gate is on the MAGNITUDE of elevation, so it catches the camera
       * pointing at the ground just as readily as at the zenith — and on the
       * 2026-08-17 capture that is overwhelmingly what it caught: 290 frames,
       * median elevation -81 degrees, which is a phone held flat while the
       * operator reads the screen. Telling that person to tilt down is the
       * exact opposite of the remedy, so the two cases now say different things.
       */
      const pointingDown = Number.isFinite(ctx.elevation) && ctx.elevation < 0;
      return pointingDown
        ? { tone: 'fix', headline: 'Raise the camera to the horizon', detail: 'The camera is pointing at the ground, so there is no skyline in the picture to measure. Bring it up until the horizon sits across the middle of the frame.', arrow: null, tilt: +1, phase: this.phase }
        : { tone: 'fix', headline: 'Tilt down — too close to straight up', detail: 'Measurements above 78° elevation are rejected because yaw becomes unstable near the zenith. Tilt down below 70° and keep turning.', arrow: null, tilt: -1, phase: this.phase };
    }
    if (ctx.frameStatus === 'parallax') {
      return { tone: 'fix', headline: 'Phone position moved', detail: 'Return the phone to the same spot and hold it still. Moving sideways while viewing a nearby roof changes its apparent direction and cannot be corrected as rotation.', arrow: null, tilt: null, phase: this.phase };
    }
    if (ctx.frameStatus === 'trackingLost') {
      return { tone: 'fix', headline: 'Tracking lost — stop turning', detail: 'Visual registration failed and the inertial sensors cannot be trusted here, so azimuth cannot be advanced. Stop, hold still until the view locks, then turn much more slowly. Nothing is being recorded until it does.', arrow: null, tilt: null, phase: this.phase };
    }
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
