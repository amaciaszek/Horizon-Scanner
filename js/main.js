'use strict';
import * as L from './log.js';
import { VERSION, BUILD_DATE, RELEASE_NOTE, versionLabel } from './version.js';
import {
  clamp, wrap360, angDiff, screenQuat, quatFromEuler, quatRotate,
  cameraRay, vecToAzAlt, quatMul, yawQuat, DEG, RAD
} from './math3d.js';
import { CameraSource, exposureOf, WORK_W, WORK_H, LUMA_W, LUMA_H } from './camera.js';
import { OrientationSource } from './orientation.js';
import { Survey, RULES, BIN_COUNT, BIN_STEP, STATUS } from './survey.js';
import { ScanDirector, PHASE } from './guide.js';
import { CoverageMap } from './coverage.js';
import { ScanGuidance } from './guidance.js';
import { ColumnPlan, overlapAudit, bridgeTargets } from './column-plan.js';
import { Pipeline } from './pipeline.js';
import { PreflightSweep, VERDICT, MIN_SWEEP_DEG } from './preflight.js';
import { drawRing, drawProfile, drawOverlay, renderCoverageCard } from './render.js';
import { calibrationFigure } from './calfigures.js';
import { LensCalibrator } from './lenscal.js';
import * as store from './storage.js';
import * as out from './exporters.js';
import { buildCaptureDebugZip } from './diagnostic-export.js';
import { captureGapReport } from './capture-gaps.js';
import { keyframeStepDeg, keyframeMotionAccepted, pass2CaptureAccepted, overlapFloor, pass1OverTravel, keyframeSpacingReached, captureDemand } from './capture-policy.js';
import { SurveyRates, estimateSurvey, describeSurveyPlan, roughMinutes } from './survey-estimate.js';
import { disagreementByBin, pixelToAzAlt, landmarkResiduals } from './panorama.js';
import { PyodideStitcher, stitcherAvailability } from './pyodide-stitch.js';
import { bearingCoverage, frameCoverage, stitchVerdict } from './coverage-table.js';
import { DomeView, domeAvailable } from './dome-view.js';

const $ = id => document.getElementById(id);
const log = (level, ...a) => L.log(level, ...a);

/**
 * Keep the field-of-view slider and readout in step with the camera.
 *
 * The slider is a SENSOR control — the number a spec sheet quotes — while
 * camera.hfovDeg is the WORKING FRAME's field of view, which is narrower
 * because the 16:9 stream is centre-cropped into a 4:3 analysis frame. Every
 * other path (self-calibration, loop closure, the pre-flight sweep) measures
 * the working frame directly, so those values have to be mapped back up to
 * sensor terms before they can be shown on the slider.
 */
function syncFovReadout() {
  const i = camera.intrinsics();
  const cropped = i.cropKnown && i.cropW < 0.995;
  const sensor = cropped
    ? 2 * Math.atan(Math.tan(i.hfovDeg / 2 * DEG) / i.cropW) * RAD
    : i.hfovDeg;
  const range = $('fovRange');
  if (range) range.value = clamp(sensor, Number(range.min), Number(range.max)).toFixed(1);
  const out = $('fovOut');
  if (out) {
    out.textContent = cropped
      ? `${sensor.toFixed(1)}\u00b0 sensor \u2192 ${i.hfovDeg.toFixed(1)}\u00b0 frame`
      : `${i.hfovDeg.toFixed(1)}\u00b0`;
  }
}

/* --------------------------------------------------------------- app state */

const survey = new Survey();
const director = new ScanDirector(survey);
/* The physical record of what the camera has observed, and the target dot
 * derived from it. Two objects on purpose — see js/coverage.js. */
const coverage = new CoverageMap();
const guidance = new ScanGuidance();
/* The vertical half of the plan. Constructed with a placeholder field of view
 * and re-geometried the moment the camera reports a real one, because the band
 * step IS the vertical field of view times the overlap fraction and getting it
 * from a default would reintroduce the exact bug it exists to prevent. */
const columns = new ColumnPlan({ vfovDeg: 30, binCount: coverage.binCount });

/* How long this device takes to walk a horizon and to build a panorama, learned
 * from what it has actually done. Seeded from the 2026-08-25 reference capture
 * and replaced by real measurements after one run. */
const surveyRates = new SurveyRates(
  typeof localStorage === 'undefined' ? null : localStorage);
/** Wall clock at the start of pass 1, so the capture rate can be measured. */
let captureStartedAt = null;
const orientation = new OrientationSource(log);
const camera = new CameraSource($('video'), log);
const pipeline = new Pipeline(log);
const lensCal = new LensCalibrator(WORK_W, WORK_H);
const preflight = new PreflightSweep();

const state = {
  sceneLuma: null,
  glareFraction: null,
  /* Coverage-guided scanning. `coverage` is the physical record of what the
   * camera has actually observed well; `guidance` is only an opinion about
   * where to put the target dot, derived from it. Keeping the two apart is what
   * lets the scoring be retuned without redesigning the interaction. */
  lastCoverageAt: null,
  guidance: null,
  /* Where the dot was, and why. Sampled rather than continuous — see
   * recordGuidanceSample. This is the only way to answer "the target sat there
   * for twenty seconds and I could not see why" after the fact. */
  guidanceTrail: [],
  lastGuidanceSampleAt: 0,
  lastGuidanceState: null,
  /* A build that throws every frame must be visible on the glass, not only in
   * a log nobody opens until they get home. */
  frameErrors: 0,
  lastFrameError: null,
  frameCount: 0,
  prevGyroYaw: null,
  trackingLost: false,
  visualScale: null,
  warnedVisualOnly: false,
  announcedSource: false,
  calFirstTry: 0,
  calGaveUp: false,
  running: false,
  paused: false,
  processing: false,
  lastProcessAt: 0,
  lastRenderAt: 0,
  lastReportAt: 0,
  prevRawYaw: null,
  fusedYaw: 0,
  fusedYawAtKeyframe: null,
  elevationAtKeyframe: null,
  lastKeyframeAt: 0,
  frame: null,            // latest segmentation result for the overlay
  frameStatus: 'ok',
  overlap: null,
  visualQuality: null,
  skylineConfidence: null,
  visualSign: null,
  signSamples: [],
  calibStart: 0,
  sessionId: null,
  editing: false,
  maxAlt: 60,
  thumbs: {},
  targetLuma: null,
  sensorCal: { stage: 'idle', startedAt: 0 },
  /** Which step of the post-lap analysis is running, so a long computation can
   *  say so instead of looking like a hang. Null whenever nothing is running. */
  analysis: null,
  /** Fraction of the last traced skyline that ran off the top of the frame. */
  clippedFraction: null,
  /** World elevation of the highest point the last frame actually traced, and
   *  how much of the frame width contributed to it. */
  skylineTopDeg: null,
  skylineMeasuredFraction: 0,
  captureAudit: { counts: {}, events: [], lastReason: null, lastAt: 0 }
};

const PROCESS_INTERVAL_MS = 110;
const RENDER_INTERVAL_MS = 55;
const VISUAL_YAW_MAX_ELEVATION = 65;
const ELEVATION_WARN_DEG = 70;
const ELEVATION_HARD_LIMIT_DEG = 78;

/* ------------------------------------------------------------------ helpers */

const fmt = (v, d = 1, suffix = '°') => Number.isFinite(v) ? `${v.toFixed(d)}${suffix}` : '—';

/** Keep both aggregate rejection counts and a rate-limited event trail. */
/** Mean confidence along a segmenter's traced skyline, ignoring flagged
 *  columns — those are where the boundary ran off the top of the frame and
 *  carry a confidence that does not describe a measured horizon. */
function meanConfidence(seg) {
  if (!seg || !seg.confidence || !seg.confidence.length) return null;
  let sum = 0, n = 0;
  for (let i = 0; i < seg.confidence.length; i++) {
    if (seg.flags && seg.flags[i] !== 0) continue;
    sum += seg.confidence[i]; n++;
  }
  return n ? sum / n : 0;
}

/**
 * Sample the guidance state into the trail.
 *
 * Sampled on state change, and otherwise four times a second. A full 10 Hz log
 * of a three-minute scan would be two thousand entries of mostly nothing; what
 * matters is every transition — the moment the dot stopped advancing, and the
 * frame quality at that moment — plus enough of the quiet stretches to see the
 * shape of the scan. The quality figure is the single number the coverage map
 * assigned to that frame, which is the direct answer to "why is it not moving".
 */
function recordGuidanceSample(t, pose, att, quality) {
  const g = state.guidance;
  if (!g) return;
  const changed = g.state !== state.lastGuidanceState;
  if (!changed && t - state.lastGuidanceSampleAt < 250) return;
  state.lastGuidanceSampleAt = t;
  state.lastGuidanceState = g.state;
  state.guidanceTrail.push({
    performanceMs: Math.round(t),
    wallClockMs: Date.now(),
    phase: director.phase,
    headingDeg: Number(currentHeading().toFixed(2)),
    dotBearingDeg: Number.isFinite(g.bearingDeg) ? Number(g.bearingDeg.toFixed(2)) : null,
    targetBearingDeg: Number.isFinite(g.rawBearingDeg) ? Number(g.rawBearingDeg.toFixed(2)) : null,
    offsetDeg: Number.isFinite(g.offsetDeg) ? Number(g.offsetDeg.toFixed(2)) : null,
    state: g.state,
    coveredFraction: Number(g.summary.fraction.toFixed(4)),
    scoreHere: Number.isFinite(g.hereScore) ? Number(g.hereScore.toFixed(3)) : null,
    // Why this frame counted for what it did.
    frameQuality: quality && Number.isFinite(quality.quality) ? Number(quality.quality.toFixed(3)) : 0,
    /*
     * The INPUTS to that quality, not just the product.
     *
     * Diagnosing the 2026-08-20 capture took cross-referencing the trail
     * against keyframes.json to discover that visualQuality was the ramp
     * crushing every score, because the trail recorded only the seven ramps
     * multiplied together. A product of seven numbers tells you something is
     * wrong and nothing about which. These two are the ramps that vary with the
     * scene rather than with the operator's hands, so they are the two worth
     * carrying.
     */
    visualQuality: Number.isFinite(state.visualQuality)
      ? Number(state.visualQuality.toFixed(3)) : null,
    skylineConfidence: Number.isFinite(state.skylineConfidence)
      ? Number(state.skylineConfidence.toFixed(3)) : null,
    credited: !!(quality && quality.credited),
    elevationDeg: Number(att.elevation.toFixed(2)),
    rollDeg: Number(att.roll.toFixed(2)),
    yawRateDegPerSec: Number.isFinite(pose.gyro.yawRateDegPerSec)
      ? Number(pose.gyro.yawRateDegPerSec.toFixed(2)) : null,
    frameStatus: state.frameStatus,
    glareFraction: Number.isFinite(state.glareFraction)
      ? Number(state.glareFraction.toFixed(4)) : null,
    /*
     * The vertical half of the instruction, sampled over time.
     *
     * "The dot went up the side of the house and then decided it did not need
     * the roof" is a statement about a sequence, and none of the state that
     * would explain it survived to the archive. These five fields say, at every
     * sampled moment: how high the map wanted the camera here, how high it had
     * already been satisfied by, whether it was still asking, and which way.
     * Reading them along a bearing shows exactly where the climb stopped and
     * which term ended it.
     */
    requiredElevationDeg: Number(coverage.requiredElevationAt(currentHeading()).toFixed(2)),
    restElevationDeg: Number(coverage.restElevationAt(currentHeading()).toFixed(2)),
    wantsLift: !!g.wantsLift,
    liftDeg: Number.isFinite(g.liftDeg) ? Number(g.liftDeg.toFixed(2)) : 0,
    wantsDrop: !!g.wantsDrop,
    dropDeg: Number.isFinite(g.dropDeg) ? Number(g.dropDeg.toFixed(2)) : 0,
    beyondTilt: !!g.beyondTilt,
    /*
     * WHAT THE DOT WAS ACTUALLY ASKING FOR, AND WHO ASKED.
     *
     * Reading the 2026-08-25 trail, the fatal state was invisible: the dot was
     * mirroring the camera in both axes and every recorded field was consistent
     * with a dot doing its job. `aimSource` names the map that chose the
     * elevation — 'band' (the column plan), 'lift'/'rest' (the coverage ring),
     * or 'camera', which means nothing had an opinion and the dot was following
     * the phone. A trail that is mostly 'camera' is a dot instructing nobody,
     * and that is a thing a reader can now see at a glance.
     *
     * `holdingColumn`, `targetBand` and `targetBands` say which cell of the
     * plan is being worked, so a column that never finishes can be traced to
     * the band that never filled.
     */
    aimSource: g.aimSource || 'camera',
    aimElevationDeg: Number.isFinite(g.aimElevationDeg) ? g.aimElevationDeg : null,
    dotElevationDeg: Number.isFinite(g.elevationDeg) ? Number(g.elevationDeg.toFixed(2)) : null,
    holdingColumn: !!g.holdingColumn,
    targetBand: Number.isFinite(g.targetBand) ? g.targetBand : -1,
    targetBands: Number.isFinite(g.targetBands) ? g.targetBands : 0,
    heldForSec: Number.isFinite(g.heldColumnForSec) ? g.heldColumnForSec : 0,
    waitingSec: Number.isFinite(g.waitingSec) ? Number(g.waitingSec.toFixed(2)) : 0,
    /* What the frame itself said about the skyline running off the top edge —
     * the input that drives the whole lift decision. */
    clippedFraction: Number.isFinite(state.clippedFraction)
      ? Number(state.clippedFraction.toFixed(4)) : null
  });
  if (state.guidanceTrail.length > 4000) {
    state.guidanceTrail.splice(0, state.guidanceTrail.length - 4000);
  }
}

function recordCaptureDecision(reason, {
  pose = null, t = null, accepted = false, detail = null, exposure = null
} = {}) {
  if (director.phase !== PHASE.PASS1 && director.phase !== PHASE.PASS2) return;
  const audit = state.captureAudit;
  audit.counts[reason] = (audit.counts[reason] || 0) + 1;
  const now = Number.isFinite(t) ? t : performance.now();
  const shouldSample = accepted || reason !== audit.lastReason || now - audit.lastAt >= 1000;
  if (shouldSample) {
    audit.events.push({
      performanceMs: now,
      wallClockMs: Date.now(),
      phase: director.phase,
      pass: director.phase === PHASE.PASS2 ? 2 : 1,
      reason,
      accepted,
      headingDeg: currentHeading(),
      fusedYawDeg: state.fusedYaw,
      elevationDeg: pose?.att?.elevation ?? null,
      rollDeg: pose?.att?.roll ?? null,
      yawRateDegPerSec: pose?.gyro?.yawRateDegPerSec ?? null,
      stillness: pose?.gyro?.stillness ?? null,
      frameStatus: state.frameStatus,
      overlap: state.overlap,
      // From the frame this decision was made about, not from a later redraw.
      sceneLuma: exposure ? Number(exposure.luma.toFixed(2)) : null,
      saturatedFraction: exposure ? Number(exposure.saturatedFraction.toFixed(5)) : null,
      // How much has been swept and how long it has been since anything was
      // accepted, so a rejection streak is legible in the export without
      // having to reconstruct it from timestamps.
      sinceKeyframeMs: state.lastKeyframeAt ? Math.round(now - state.lastKeyframeAt) : null,
      travelSinceKeyframeDeg: state.fusedYawAtKeyframe === null
        ? null : Number(angDiff(state.fusedYaw, state.fusedYawAtKeyframe).toFixed(3)),
      detail
    });
    if (audit.events.length > 2500) audit.events.splice(0, audit.events.length - 2500);
    audit.lastReason = reason;
    audit.lastAt = now;
  }
}

function setChip(el, text, cls = '') {
  el.textContent = text;
  el.className = `chip${cls ? ' ' + cls : ''}`;
}

function metaFromForm() {
  return {
    siteName: $('siteName').value.trim() || 'Unnamed site',
    latitude: $('latitude').value,
    longitude: $('longitude').value,
    elevationM: $('elevation').value,
    azOffset: $('azOffset').value,
    timestamp: Date.now()
  };
}

function focalLumaPx() {
  return camera.intrinsics().focalPx * (LUMA_W / WORK_W);
}

/* -------------------------------------------------------------- capture loop */

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  if (now - state.lastRenderAt >= RENDER_INTERVAL_MS) {
    state.lastRenderAt = now;
    renderLive();
  }
  if (state.running && !state.paused && now - state.lastProcessAt >= PROCESS_INTERVAL_MS) {
    state.lastProcessAt = now;
    processFrame();
  }
  if (director.phase === PHASE.CALIBRATING) tickCalibration(now);
  if (now - state.lastReportAt >= 1200) { state.lastReportAt = now; updateReport(); }
}

async function processFrame() {
  if (state.processing || !camera.ready) return;
  state.processing = true;
  try {
    const capturedFrame = camera.grabSynchronizedFrame();
    if (!capturedFrame) return;
    const { workFrame, luma } = capturedFrame;
    // Exposure is measured from THIS frame's pixels, frozen alongside the pose
    // and the skyline, so whatever the audit later says about glare describes
    // the image that was actually judged.
    const exposure = exposureOf(workFrame);
    capturedFrame.exposure = exposure;

    const att = orientation.attitude();
    const rawYaw = orientation.rawYaw();
    const quat = screenQuat(orientation.quat, orientation.screenAngle);
    const t = capturedFrame.timing.performanceMs;
    // Freeze every sensor field that belongs to this decoded video frame before
    // the segmentation/registration workers run. Reading orientation again
    // after their await paired a later gyro pose with an earlier photograph.
    const pose = {
      att: { elevation: att.elevation, roll: att.roll },
      rawYaw,
      quat: Array.from(quat),
      screenAngle: orientation.screenAngle,
      compassHeading: orientation.compassHeading,
      compassReliability: orientation.compassReliability,
      jitterDeg: orientation.jitterDeg,
      orientationSample: {
        alpha: orientation.alpha,
        beta: orientation.beta,
        gamma: orientation.gamma,
        absolute: orientation.absolute
      },
      gyro: {
        available: orientation.gyroAvailable,
        integratedYawDeg: orientation.gyroYaw,
        yawRateDegPerSec: orientation.gyroYawRate,
        rotationRateDegPerSec: orientation.rotationRate,
        tiltRateDegPerSec: orientation.tiltRate,
        stillness: orientation.stillness,
        sampleCount: orientation.gyroSamples,
        scale: orientation.gyroScale,
        biasDegPerSec: orientation.gyroBias.slice(),
        axisMap: orientation.gyroAxisMap ? {
          ...orientation.gyroAxisMap,
          perm: orientation.gyroAxisMap.perm.slice(),
          signs: orientation.gyroAxisMap.signs.slice()
        } : null,
        rawRateDeviceDegPerSec: orientation.lastGyroRaw?.slice() || null,
        mappedRateDeviceDegPerSec: orientation.lastGyroMapped?.slice() || null,
        gravityDeviceMPerSec2: orientation.lastGravity?.slice() || null,
        sampleAgeMs: Number.isFinite(orientation.lastGyroAt)
          ? Math.max(0, t - orientation.lastGyroAt) : null
      }
    };
    const highElevation = Math.abs(att.elevation) > VISUAL_YAW_MAX_ELEVATION;
    state.frameCount++;

    // Predict the pixel shift from the orientation stream so the visual search
    // starts in the right neighbourhood. Withheld until the sign convention is
    // known, because an inverted hint is the one error the matcher cannot undo.
    const dGyroPredict = state.prevRawYaw === null ? 0 : angDiff(rawYaw, state.prevRawYaw);
    let hintX;
    if (state.visualSign !== null && !highElevation) {
      const cosElP = Math.max(0.30, Math.cos(att.elevation * DEG));
      hintX = focalLumaPx() * Math.tan(dGyroPredict * cosElP * DEG) * state.visualSign;
    }

    const segPromise = pipeline.segment(workFrame);
    const visPromise = pipeline.register(luma, LUMA_W, LUMA_H, hintX, undefined);
    const [seg, vis] = await Promise.all([segPromise, visPromise]);

    // ---- visual / inertial fusion of yaw --------------------------------
    let dFused = 0;
    state.trackingLost = false;

    // Relative rotation must come from the gyroscope, never from the
    // orientation stream's yaw. deviceorientationabsolute fuses the
    // magnetometer, so in a disturbed spot its yaw swings by tens of degrees
    // while the phone sits still. Only fall back to it when there is no
    // gyroscope at all AND the compass has not been condemned.
    let dGyro, gyroTrusted;
    if (pose.gyro.available) {
      dGyro = state.prevGyroYaw === null ? 0 : pose.gyro.integratedYawDeg - state.prevGyroYaw;
      state.prevGyroYaw = pose.gyro.integratedYawDeg;
      gyroTrusted = true;
    } else {
      dGyro = state.prevRawYaw === null ? 0 : angDiff(rawYaw, state.prevRawYaw);
      gyroTrusted = pose.compassReliability !== 'poor';
    }
    if (vis && vis.result) {
      const r = vis.result;
      state.visualQuality = r.quality;
      const cosEl = Math.max(0.30, Math.cos(att.elevation * DEG));
      const dVisMag = Math.atan(r.dx / focalLumaPx()) * RAD / cosEl;

      // Learn the sign convention from the data instead of assuming it.
      if (!highElevation && state.visualSign === null) {
        if (r.quality > 0.5 && Math.abs(dGyro) > 1.2 && Math.abs(dVisMag) > 0.4) {
          state.signSamples.push(Math.sign(dVisMag) === Math.sign(dGyro) ? 1 : -1);
          if (state.signSamples.length >= 9) {
            const sum = state.signSamples.reduce((a, b) => a + b, 0);
            state.visualSign = sum >= 0 ? 1 : -1;
            log('info', `Visual yaw sign resolved to ${state.visualSign > 0 ? '+' : '-'} from ${state.signSamples.length} samples.`);
          }
        }
      }
      const dVis = dVisMag * (state.visualSign ?? -1);

      // The guided lens measurement, while it is running. Both axes are fed
      // from the same matcher output, but the ANGLE each one is compared
      // against comes from a different sensor on purpose: yaw from the
      // gyroscope, tilt from gravity. See js/lenscal.js.
      if (state.sensorCal.stage === LENS_STAGE) {
        // r.dx/r.dy are registration-frame pixels; the calibrator works in the
        // frame the survey actually measures angles in.
        const toWork = WORK_W / LUMA_W;
        lensCal.addPan({
          dxPx: r.dx * toWork, dYawDeg: dGyro,
          elevationDeg: att.elevation, quality: r.quality
        });
        if (state.prevElevation !== null) {
          lensCal.addTilt({
            dyPx: r.dy * toWork,
            dPitchDeg: att.elevation - state.prevElevation,
            quality: r.quality
          });
        }
      }
      state.prevElevation = att.elevation;

      const lensChange = highElevation
        ? null
        : survey.addFocalSample(r.dx, dGyro, att.elevation, r.quality);
      if (lensChange) {
        const oldFov = camera.hfovDeg;
        camera.adoptFocal(lensChange.to * (WORK_W / LUMA_W));
        syncFovReadout();
        log('warn', `Lens changed mid-scan: field of view ${oldFov.toFixed(1)}° -> ${camera.hfovDeg.toFixed(1)}° (focal ratio ${lensChange.ratio.toFixed(2)}). Frames already captured keep their own geometry; new frames use the new lens.`);
      }

      // ---- ROTATION SOURCE PRIORITY -----------------------------------
      // The gyroscope is metrically correct: it reports real degrees per second
      // with only a slow bias, and no unknown scale factor. Visual registration
      // measures pixels, and converting pixels to degrees needs the focal
      // length — which is exactly the quantity nobody knows at the start. Using
      // visual as the primary source therefore multiplies every azimuth by an
      // unknown constant: a full physical circle logged as 176 degrees.
      //
      // So the gyroscope leads, and vision does the two jobs it is actually
      // better at: measuring the focal length (pixel shift against a known
      // rotation) and holding the gyro's slow bias in check.
      if (!state.announcedSource) {
        state.announcedSource = true;
        log('info', gyroTrusted
          ? `Rotation source: ${orientation.gyroAvailable ? 'gyroscope (devicemotion)' : 'orientation stream'}. Azimuth is metric — the field of view no longer scales it.`
          : 'Rotation source: visual registration only. Azimuth is scaled by the field-of-view estimate.');
      }
      if (gyroTrusted) {
        // The gyroscope sets the magnitude, full stop. Blending in even 15% of
        // a pixel-derived angle reintroduces the focal-length scale error it
        // was the whole point of avoiding: with the field of view overstated at
        // 107 degrees, a 15% visual term still stretched a lap to 455 degrees.
        // Vision gets a veto, not a vote.
        dFused = dGyro;
        if (!highElevation && state.visualSign !== null && r.quality > 0.6 && Math.abs(dGyro) > 0.5) {
          const ratio = dVis / dGyro;
          if (ratio > 0.2 && ratio < 5) {
            state.visualScale = state.visualScale === null
              ? ratio : 0.98 * state.visualScale + 0.02 * ratio;
            state.visualScaleN = (state.visualScaleN || 0) + 1;
            // Track how far this running estimate wanders. It is the only
            // thing standing between the number and a claim about the lens,
            // and it has earned that scrutiny: across two field runs 27
            // minutes apart on the same phone it read 2.642 and then 0.426, a
            // factor of 6.2, once saying the lens was far narrower than
            // assumed and once far wider. An estimator that inconsistent may
            // be reported, but it may not conclude anything.
            state.visualScaleMin = Math.min(state.visualScaleMin ?? ratio, ratio);
            state.visualScaleMax = Math.max(state.visualScaleMax ?? ratio, ratio);
          }
          // Opposed signs on a confident match means one of them is wrong;
          // trust neither for this frame rather than averaging them.
          if (dVis * dGyro < 0 && Math.abs(dVis) > 1) dFused = 0;
        }
      } else if (!highElevation && state.visualSign !== null && r.quality > 0.25 && Math.abs(dVis) < 25) {
        // No usable gyroscope. Vision alone, and the scale is only as good as
        // the focal length, so say so once rather than pretending otherwise.
        dFused = dVis;
        if (!state.warnedVisualOnly) {
          state.warnedVisualOnly = true;
          log('warn', 'No gyroscope available — azimuth is being scaled by the field-of-view estimate, so a wrong field of view becomes a wrong azimuth. Run the pre-flight sweep before trusting the result.');
        }
      } else if (!highElevation && state.visualSign !== null && Math.abs(dVis) < 25) {
        // Weak but not absent. Advancing on a poor match is far better than
        // discarding real rotation: dropping frames is what turned a physical
        // 360 degree lap into a logged 176.
        dFused = dVis;
      } else {
        dFused = 0;
        state.trackingLost = true;
      }

    } else if (gyroTrusted) {
      // A blank, blurred, or near-zenith view may give vision nothing useful.
      // The gyroscope remains a valid metric rotation source, so do not erase
      // real travel merely because the optional image matcher missed a frame.
      dFused = dGyro;
      state.visualQuality = null;
    } else {
      state.trackingLost = true;
    }
    state.prevRawYaw = rawYaw;
    state.fusedYaw += dFused;
    if (director.phase === PHASE.PASS1) director.notePass1Travel(dFused);
    else if (director.phase === PHASE.PASS2 && director.verificationSweep) {
      director.notePass2Travel(dFused);
    }

    // The pre-flight sweep rides on the same fused rotation the survey uses as
    // its reference, so it is measuring the compass against exactly what the
    // scan will trust rather than against a separate estimate.
    if (preflight.active) {
      preflight.add({
        compass: pose.compassHeading,
        integrated: state.fusedYaw,
        jitter: pose.jitterDeg,
        quality: state.visualQuality ?? 0
      });
    }

    // ---- frame quality gates --------------------------------------------
    let clippedFraction = 0;
    if (seg && !seg.error) {
      state.frame = seg;
      let clippedTop = 0;
      for (let i = 0; i < seg.flags.length; i++) if (seg.flags[i] === 1) clippedTop++;
      clippedFraction = seg.flags.length ? clippedTop / seg.flags.length : 0;
      // Kept on state purely so the guidance trail can record the input that
      // drove each lift decision, rather than leaving it inferable only by
      // recomputing every boundary offline.
      state.clippedFraction = clippedFraction;

      /*
       * The highest point of the skyline this frame actually traced, in world
       * elevation.
       *
       * This is the measurement the lift model was missing. Until now a frame
       * that did NOT clip contributed nothing but the camera's own pose, so a
       * frame aimed over the top of a roof — containing no roofline at all —
       * marked the sector "top seen". On the 2026-08-18 20:06 capture that put
       * satisfiedElevation at 56.5 degrees across thirteen consecutive bins,
       * all of them from one high frame, and the roof was never captured.
       *
       * The boundary rows are exactly where the skyline was found, so the top
       * of the obstruction is simply the smallest row among the columns that
       * found one. Flag 1 means the column ran off the top edge and flag 2
       * means no obstruction was visible; neither measures a top.
       */
      let topRow = Infinity, measuredCols = 0;
      for (let i = 0; i < seg.flags.length; i++) {
        if (seg.flags[i] !== 0) continue;
        measuredCols++;
        const row = seg.boundary[i];
        if (row < topRow) topRow = row;
      }
      if (measuredCols > 0 && Number.isFinite(topRow)) {
        const rows = seg.height || seg.boundary.length;
        const v = 1 - (topRow / rows) * 2;                 // +1 top .. -1 bottom
        const intr = camera.intrinsics();
        state.skylineTopDeg = att.elevation + Math.atan(v * intr.tanHalfV) * RAD;
        state.skylineMeasuredFraction = measuredCols / seg.flags.length;
      } else {
        state.skylineTopDeg = null;
        state.skylineMeasuredFraction = 0;
      }
      // A sky boundary can only be measured if there is light to measure it
      // by. At night the whole premise inverts — the sky is the dark region and
      // the ground carries the bright lights — so every cue the segmenter uses
      // points the wrong way, and what it draws is a trace of sensor noise in
      // black pixels. Refuse rather than produce a confident-looking wrong line.
      // Every frame, not every fifteenth: it is free now that it rides on the
      // pixels already in hand, and a sampled-every-15th glare reading would
      // reintroduce exactly the mismatch this was changed to remove.
      if (exposure) {
        state.sceneLuma = exposure.luma;
        state.glareFraction = exposure.saturatedFraction;
      }
      state.frameStatus = Math.abs(att.elevation) > ELEVATION_HARD_LIMIT_DEG ? 'tooHigh'
      : state.trackingLost ? 'trackingLost'
      : (state.sceneLuma !== null && state.sceneLuma < 26) ? 'tooDark'
        : seg.noSky ? 'noSky'
        : seg.allSky ? 'allSky'
          : (clippedTop / seg.flags.length > 0.22) ? 'clippedTop' : 'ok';
    }

    // ---- coverage-guided scanning ---------------------------------------
    // Every processed frame is offered to the coverage map, including the ones
    // the keyframe gates will refuse. That is the point of having a separate
    // map: the survey's bins record measured skyline where a keyframe was
    // admitted, and this records where the camera has genuinely dwelt with
    // usable data. A sector the segmenter rejected forty times running scores
    // nothing here, which is exactly what the operator needs to be told.
    if (director.phase === PHASE.PASS1 || director.phase === PHASE.PASS2) {
      const dtSec = state.lastCoverageAt === null ? null : (t - state.lastCoverageAt) / 1000;
      state.lastCoverageAt = t;
      state.skylineConfidence = seg && !seg.error ? meanConfidence(seg) : null;
      const quality = coverage.observe({
        headingDeg: currentHeading(),
        elevationDeg: att.elevation,
        rollDeg: att.roll,
        yawRateDegPerSec: pose.gyro.yawRateDegPerSec,
        jitterDeg: pose.jitterDeg,
        skylineConfidence: state.skylineConfidence,
        visualQuality: state.visualQuality,
        glareFraction: state.glareFraction,
        frameStatus: state.frameStatus,
        trackingLost: state.trackingLost,
        hfovDeg: camera.hfovDeg,
        // Elevation inputs: how tall the frame is, and how much of the skyline
        // ran off its top edge. Together these are what let the map know a
        // sector has a top nobody has measured.
        vfovDeg: camera.intrinsics().vfovDeg,
        clippedFraction,
        // Where the skyline actually was, so satisfaction is a measurement
        // rather than an inference from where the camera was pointing.
        skylineTopDeg: state.skylineTopDeg,
        skylineMeasuredFraction: state.skylineMeasuredFraction,
        dtSec,
        atMs: t
      });
      // The vertical plan sees the same instant, gated on the same quality, so
      // a frame too fast or too rolled to earn horizon credit cannot fill a
      // band either. syncRequirements is cheap and picks up obstruction tops
      // the coverage map refined on this very frame.
      columns.setFieldOfView(camera.intrinsics().vfovDeg);
      /*
       * ONE CEILING, HELD IN ONE PLACE.
       *
       * The coverage ring stops asking for elevation at
       * `maxRequestedElevationDeg` and marks anything taller `beyondTilt`, so
       * it never blocks on a top it cannot reach. The column plan had no such
       * ceiling of its own, and on the 2026-08-25 back-yard capture that
       * mismatch was fatal: the house measured 75.1°, the plan demanded a band
       * centred at 74.4°, nothing in the app would ever aim there, and 19
       * columns stayed unfinished forever. The guidance held its bearing on
       * them, so the dot stopped leading and became a shadow of the phone.
       *
       * Telling the plan the ring's ceiling makes a disagreement impossible
       * rather than merely unlikely.
       */
      columns.setCeiling(coverage.tuning.maxRequestedElevationDeg);
      columns.syncRequirements(coverage);
      // The guidance dot climbs in the same increments the column plan is built
      // from, so following the dot produces a chain of overlapping frames
      // rather than two isolated ones with a hole between them.
      guidance.bandStepDeg = columns.bandStepDeg;
      // Handing the plan to the guidance is what makes the serpentine binding:
      // the dot may not move sideways while the column under it is unfinished.
      guidance.columnPlan = columns;
      /*
       * The column plan is credited on STRUCTURAL quality, not horizon quality.
       * A frame aimed over the roof is all sky and observes no horizon, so it
       * earns nothing on the ring — correctly. It still overlaps its neighbours,
       * which is the only thing the column cares about, and refusing it there
       * made the top band of every tall column permanently unfillable.
       */
      columns.observe({
        headingDeg: currentHeading(),
        elevationDeg: att.elevation,
        quality: coverage.structuralQuality({
          trackingLost: state.trackingLost,
          frameStatus: state.frameStatus,
          glareFraction: state.glareFraction,
          yawRateDegPerSec: pose.gyro.yawRateDegPerSec,
          rollDeg: att.roll,
          jitterDeg: pose.jitterDeg,
          visualQuality: state.visualQuality,
          dtSec
        }),
        hfovDeg: camera.hfovDeg
      });
      state.guidance = guidance.update({
        coverage,
        headingDeg: currentHeading(),
        elevationDeg: att.elevation,
        dtSec: dtSec ?? 0.1,
        nowMs: t,
        hfovDeg: camera.hfovDeg
      });
      recordGuidanceSample(t, pose, att, quality);
    }

    // ---- overlap with the last accepted keyframe -------------------------
    const last = survey.keyframes[survey.keyframes.length - 1];
    if (last) {
      const travel = Math.abs(angDiff(state.fusedYaw, state.fusedYawAtKeyframe));
      state.overlap = clamp(1 - travel / camera.hfovDeg, 0, 1);
    } else {
      state.overlap = 1;
    }

    maybeKeyframe({ seg, pose, capturedFrame, t });

    // Adopt the self-calibrated focal length once it settles — but never over a
    // deliberate measurement. The passive estimator runs on whatever the survey
    // happened to give it; the guided one ran on a scene chosen for the job and
    // measured the vertical against gravity, so it wins.
    if (survey.focalPx && camera.focalSource !== 'self-calibrated'
        && camera.focalSource !== 'measured' && camera.focalSource !== 'manual') {
      const workFocal = survey.focalPx * (WORK_W / LUMA_W);
      if (camera.adoptFocal(workFocal)) {
        log('info', `Focal length self-calibrated: ${workFocal.toFixed(1)} px at ${WORK_W} px wide, giving ${camera.hfovDeg.toFixed(1)}° horizontal FOV.`);
        syncFovReadout();
      }
    }

    orientation.sampleDatum();
  } catch (err) {
    /*
     * A frame that throws is not a bad frame — it is a broken build.
     *
     * On 2026-08-17 a missing import made this throw on every single frame for
     * an entire field session. It was logged 1201 times and the operator saw
     * none of it: the picture had no skyline, the coverage sat at 0%, the
     * guidance dot never appeared, and the honest conclusion available from the
     * screen was "the new version is broken somehow". Twelve hundred silent
     * errors is a worse outcome than one loud one, so the first few now go to
     * the directive line where the operator is already looking, and the survey
     * refuses to pretend it is running.
     */
    state.frameErrors++;
    state.lastFrameError = String(err && err.message || err);
    if (state.frameErrors <= 3 || state.frameErrors % 200 === 0) {
      log('error', `Frame processing failed (${state.frameErrors} so far): ${state.lastFrameError}`, err);
    }
  } finally {
    state.processing = false;
  }
}

function maybeKeyframe({ seg, pose, capturedFrame, t }) {
  // Whatever the audit records about this decision must describe the frame
  // the decision was made about.
  const exposure = capturedFrame?.exposure || null;
  if (!seg || seg.error) {
    recordCaptureDecision('segmentation-error', { pose, t, exposure, detail: seg?.error || null });
    return;
  }
  if (director.phase !== PHASE.PASS1 && director.phase !== PHASE.PASS2) return;
  if (!capturedFrame) {
    recordCaptureDecision('no-synchronized-frame', { pose, t, exposure });
    return;
  }
  /*
   * A frame with no skyline in it is still a photograph the stitcher needs.
   *
   * `clippedTop` means the traced skyline runs off the top edge and `allSky`
   * means there is no skyline at all — and both are the NORMAL appearance of a
   * frame aimed at the upper part of a tall obstruction, which is precisely
   * what the vertical guidance has just asked for. Refusing them threw away 106
   * candidates on the 2026-08-20 capture, every one of them over the house, and
   * left the high bands with nothing in them but the frames that happened to
   * catch a roof edge.
   *
   * These frames genuinely cannot contribute a horizon measurement, and they do
   * not: the coverage map scores them on their own merits and the 720-bin
   * profile only ever reads a traced boundary. What they can do is carry
   * texture that connects the row above to the row below, which is the whole
   * job of a column. So they are stored when the camera is deliberately raised,
   * and refused when it is not — a frame full of sky taken while sweeping the
   * horizon is still just a mistake.
   */
  const requiredHere = coverage.requiredElevationAt(currentHeading());
  const deliberatelyHigh = state.guidance?.wantsLift
    || (Number.isFinite(requiredHere) && requiredHere > 0
      && pose.att.elevation > requiredHere * 0.4);
  const skylessButWanted = deliberatelyHigh
    && (state.frameStatus === 'clippedTop' || state.frameStatus === 'allSky');
  if (state.frameStatus !== 'ok' && !skylessButWanted) {
    recordCaptureDecision(`frame-${state.frameStatus}`, { pose, t, exposure });
    return;
  }
  if (skylessButWanted) {
    recordCaptureDecision('kept-for-stitch', {
      pose, t, exposure,
      detail: { frameStatus: state.frameStatus, elevationDeg: pose.att.elevation }
    });
  }
  // Roll is deliberately NOT a reason to reject a keyframe. It is carried
  // through the projection quaternion like every other part of the attitude,
  // and rejecting on it threw away every frame of an iPad session whose screen
  // angle was misreported.
  const instantRate = Number.isFinite(pose.gyro.yawRateDegPerSec)
    ? Math.abs(pose.gyro.yawRateDegPerSec)
    : Math.abs(pose.gyro.rotationRateDegPerSec);
  /*
   * Both axes. The gate tested yaw alone, and this app's capture pattern is
   * vertical: on the 2026-08-25 22:23 capture 28 of 152 photographs were taken
   * while tilting faster than 15°/s with the yaw rate under 15, so every one
   * passed a gate that believed the camera was barely moving. Median
   * `visualQuality` was 0.240 for those against 0.437 for frames under 8°/s.
   * Motion blur is the one defect the solver cannot repair.
   */
  const tiltRate = orientation.tiltRate;
  if (!keyframeMotionAccepted(instantRate, {
    mode: director.mode.id, tiltRateDegPerSec: tiltRate
  })) {
    recordCaptureDecision('motion-too-fast', {
      pose, t, exposure, detail: { instantRate, tiltRate }
    });
    return;
  }

  /*
   * A PHOTOGRAPH OF THE GROUND IS NOT A HORIZON SURVEY.
   *
   * The 2026-08-25 22:23 capture ended with seven frames between -74° and -78°
   * elevation — the phone lowered while a pass-2 cleanup hold was still
   * running, which accepts on stillness and bearing and never looked at where
   * the camera was pointed. All seven were stranded by the solver, because
   * nothing else in the survey is anywhere near them, and all seven produced an
   * alarming "photographs are not connected" warning naming a bearing the
   * operator was told to go and re-shoot. The instruction was to fix frames
   * that should never have been taken.
   *
   * The floor is one whole frame below the HORIZON — not below this sector's
   * required elevation. `restElevationAt` returns the lift target, which over
   * a tall house is 40 to 60 degrees, and measuring the floor from that would
   * have refused the entire lower half of every tall column: exactly the frames
   * that connect the roof to the ground and the ones this app exists to take.
   * The bottom band of every column sits at the horizon by construction, so the
   * horizon is what the floor hangs from.
   */
  const floorDeg = -camera.intrinsics().vfovDeg;
  if (pose.att.elevation < floorDeg) {
    recordCaptureDecision('below-survey-band', {
      pose, t, exposure,
      detail: { elevationDeg: pose.att.elevation, floorDeg }
    });
    return;
  }

  /*
   * SPEND FRAMES WHERE THEY BUY SOMETHING.
   *
   * The spacing gate used to be one fraction of the field of view everywhere,
   * so a stretch of horizon seen eight times cost exactly as many photographs
   * as the band above the roof nobody had seen once. On the 2026-08-25 capture
   * that came out as 757 refusals for spacing against 115 photographs taken,
   * while the arc the stitcher then lost was lost for want of frames.
   *
   * `captureDemand` asks both maps what is still wanted at this exact pose. The
   * step tightens to 90% overlap where something is, and relaxes to 70% where
   * neither map wants anything — still far more overlap than the matcher needs,
   * just not the same photograph four times over.
   */
  const demand = captureDemand({
    coverage, plan: columns,
    headingDeg: currentHeading(), elevationDeg: pose.att.elevation
  });
  const stepDeg = keyframeStepDeg(camera.hfovDeg, demand);
  const intrForStep = camera.intrinsics();
  const last = survey.keyframes[survey.keyframes.length - 1];
  let accept = false;

  if (!last) accept = true;
  else if (director.phase === PHASE.PASS1) {
    // Far enough past a full circle that no plausible gyro scale error explains
    // it, and every further sweep frame lands on a bearing that already has one.
    // Refusing is recorded, never silent: the operator sees the keyframe count
    // stop and the guide is already telling them to close the lap.
    if (pass1OverTravel(director.pass1Travel).refuseNewSweeps) {
      recordCaptureDecision('pass1-over-travel', {
        pose, t, exposure, detail: { pass1TravelDeg: director.pass1Travel }
      });
      return;
    }
    // Both axes, each against its own field of view. Tilting up a column is
    // movement; the old yaw-only test said it was not, and refused every frame
    // the vertical guidance had just asked for.
    accept = keyframeSpacingReached({
      yawDeltaDeg: angDiff(state.fusedYaw, state.fusedYawAtKeyframe),
      tiltDeltaDeg: state.elevationAtKeyframe === null
        ? 0 : pose.att.elevation - state.elevationAtKeyframe,
      elevationDeg: pose.att.elevation,
      hfovDeg: intrForStep.hfovDeg,
      vfovDeg: intrForStep.vfovDeg,
      demand
    });
  } else {
    // A normal pass 2 is a dense second lap. Targeted holds are reserved for
    // cleanup after at least part of the ring already has two-pass evidence.
    const onTarget = director.target &&
      Math.abs(angDiff(wrap360(director.target.fromDeg + director.target.widthDeg / 2), currentHeading())) < 3;
    accept = pass2CaptureAccepted({
      verificationSweep: director.verificationSweep,
      // Spherical travel, so a cleanup that is purely a tilt still counts.
      angularTravelDeg: keyframeSpacingReached({
        yawDeltaDeg: angDiff(state.fusedYaw, state.fusedYawAtKeyframe),
        tiltDeltaDeg: state.elevationAtKeyframe === null
          ? 0 : pose.att.elevation - state.elevationAtKeyframe,
        elevationDeg: pose.att.elevation,
        hfovDeg: intrForStep.hfovDeg, vfovDeg: intrForStep.vfovDeg,
        demand
      }) ? stepDeg : 0,
      stepDeg,
      onTarget,
      stillness: pose.gyro.stillness,
      elapsedMs: t - state.lastKeyframeAt
    });
  }
  if (!accept) {
    const reason = director.phase === PHASE.PASS2 && !director.verificationSweep
      ? 'off-target-or-not-still'
      : 'spacing-not-reached';
    // `demand` in the audit, because "spacing-not-reached" alone never said
    // whether the app was refusing a frame it did not need or one it did.
    recordCaptureDecision(reason, { pose, t, exposure, detail: { stepDeg, demand } });
    return;
  }

  const intr = camera.intrinsics();
  const captureYaw = state.fusedYaw;
  const motionWindow = orientation.motionWindow(t);
  const kf = survey.addKeyframe({
    t: capturedFrame.timing.wallClockMs,
    pass: director.phase === PHASE.PASS2 ? 2 : 1,
    // Stamp the intrinsics in force right now. If the platform swaps lenses
    // later, frames captured before the swap keep the geometry they were
    // actually taken with instead of being reprojected through the new lens.
    tanHalfH: intr.tanHalfH,
    tanHalfV: intr.tanHalfV,
    focalPx: camera.focalPx,
    quat: pose.quat,
    screenAngle: pose.screenAngle,
    yawRaw: pose.rawYaw,
    yawFused: captureYaw,
    yawBase: angDiff(captureYaw, pose.rawYaw),
    captureKind: director.phase === PHASE.PASS2 && !director.verificationSweep
      ? 'targeted-cleanup' : 'sweep',
    elevation: pose.att.elevation,
    roll: pose.att.roll,
    compass: pose.compassHeading,
    // The exposure snapshot and short surrounding motion window travel with
    // the photo for offline diagnosis. None of these fields feed the browser's
    // projection, fusion, or panorama stitching.
    photoWidth: capturedFrame.timing.savedWidth,
    photoHeight: capturedFrame.timing.savedHeight,
    captureTiming: {
      ...capturedFrame.timing,
      processingLatencyMs: Math.max(0, performance.now() - capturedFrame.timing.performanceMs),
      motionSampleCount: motionWindow.length
    },
    orientationSample: pose.orientationSample,
    gyro: { ...pose.gyro, motionWindow },
    visualQuality: state.visualQuality,
    skyFraction: seg.skyFraction,
    // Measured on this exposure's own pixels. A photograph that was taken into
    // the sun looks perfectly reasonable on its own; what marks it is the
    // blown fraction, and without it recorded the next offline analysis has to
    // re-derive it from the JPEGs and hope it matches what the app decided.
    exposure,
    height: WORK_H,
    boundary: Float32Array.from(seg.boundary),
    confidence: Float32Array.from(seg.confidence),
    flags: Uint8Array.from(seg.flags)
  });
  recordCaptureDecision('accepted', {
    pose,
    t,
    exposure,
    accepted: true,
    detail: { keyframeIndex: kf.index, captureKind: kf.captureKind }
  });

  state.fusedYawAtKeyframe = state.fusedYaw;
  state.elevationAtKeyframe = pose.att.elevation;
  state.lastKeyframeAt = t;

  survey._projectKeyframe(kf, camera.intrinsics());
  survey.recompute();
  auditOverlap();

  // Thumbnails are captured for EVERY keyframe, regardless of the archive
  // setting. They used to be gated on "Embed keyframe images in archive",
  // which is a decision about export size — with the result that a survey run
  // with the box unticked could not be diagnosed afterwards at all. Storage and
  // export are now separate concerns: this always records, and the checkbox
  // only decides whether the images travel inside the .horizon-project file.
  captureThumb(kf, capturedFrame);

  if (director.phase === PHASE.PASS2 && !director.verificationSweep) {
    director.refreshTargets();
    if (!director.targets.length) log('info', 'All sectors verified.');
  }
}

function currentHeading() {
  return wrap360(state.fusedYaw + survey.yawDatum);
}

/* ------------------------------------------------------------- calibration */

/**
 * Sensor calibration is one unchoreographed motion: wave the phone about.
 *
 * It used to be three posed tests — flat spin, upright circle, end-over-end
 * tumble — and the operator's verdict on those was that the tumble was still
 * confusing and the whole thing was "a lot". They were right, and the physics
 * agrees: the solver only ever needed every reported gyro axis to turn a bit
 * while gravity moved, and a hand waving the phone about supplies that far
 * better than three poses do. In the posed version gravity sat still through
 * two tests out of three; waved, it moves continuously, which is why the
 * simulated residual drops from 0.23 to 0.013 and the direction the operator
 * turns stops mattering entirely.
 *
 * So there is nothing to get right any more. The app watches, says what is
 * still missing, and stops the moment it is sure.
 */
const FREEFORM_STAGE = 'freeform';
/**
 * Measuring the lens, which happens straight after the axis solve because it
 * depends on it: the horizontal half of the measurement compares the picture
 * against the gyroscope, and the gyroscope is only metric once its axes are
 * known. The vertical half compares against gravity and would work at any time,
 * but it is the half that matters, so it is worth doing them together.
 */
const LENS_STAGE = 'lens';

/**
 * Every measuring stage is now preceded by a briefing the operator dismisses.
 *
 * Until this existed each stage began recording the instant the previous one
 * ended, so the operator was always getting into position while the
 * measurement was already running — holding it wrong for the beginning of
 * every test, as they put it. That is not a small thing: the stationary test
 * takes its gyro bias from those first seconds, the wave takes its axis
 * evidence from them, and the lens sweep spends them on frames pointed at
 * whatever the device happened to be facing. Nothing is measured now until
 * the operator says they are ready.
 */
const BRIEF_STAGE = 'brief';
const BRIEFS = {
  stationary: {
    headline: 'Next: set it down',
    detail: 'Put the device on a table, a wall, or the ground — screen up — and take your hands off it. Four seconds of stillness measures the gyroscope\'s bias. Press Start once it is down, not before.',
    figure: null,
    button: 'Start — it is down'
  },
  [FREEFORM_STAGE]: {
    headline: 'Next: wave it about',
    detail: 'Pick it up and turn and tip it every which way, like rolling a dice in your hand. Briskly, but not frantically. It works out the sensor axes and stops on its own — about ten seconds. No direction is wrong.',
    figure: 'freeform',
    button: 'Start waving'
  },
  [LENS_STAGE]: {
    headline: 'Next: measure the lens',
    detail: 'Point at anything with detail in it — a tree, a fence, a wall — then sweep slowly left and right, and afterwards up and down. Nothing needs to be in focus on a particular thing; it just needs texture to track. This measures how wide the frame really is, which sets every altitude.',
    figure: 'lens',
    button: 'Start sweeping'
  },
  settle: {
    headline: 'Next: hold it as you will scan',
    detail: 'Raise it into the pose you will survey in — upright, camera at the skyline — and hold it steady for a moment. This fixes the compass datum. Nothing needs to be level.',
    figure: null,
    button: 'Start — I am in position'
  }
};
/** Give up asking after this and let the operator proceed unverified rather
 *  than trapping them in front of a featureless wall. */
const LENS_TIMEOUT_MS = 60000;
/** Evidence targets for the live meter. Not pass marks — the solver decides;
 *  these only stop it from declaring victory on a lucky early fit. */
const EVIDENCE = { axisDeg: 90, sweepDeg: 200, minMs: 5000 };

function finishStationary(now) {
  const r = orientation.finishStationaryDiagnostic();
  log(r.biasApplied ? 'info' : 'warn', 'SENSOR_STATIONARY', JSON.stringify(r));
  log(r.biasApplied ? 'info' : 'warn',
    `Stationary test: ${r.samples} samples at ${r.sampleRateHz.toFixed(1)} Hz; `
    + `gyro bias x/y/z ${['x', 'y', 'z'].map(k => (r.gyroAxes[k].mean ?? 0).toFixed(4)).join('/')}°/s; `
    + `noise σ ${['x', 'y', 'z'].map(k => (r.gyroAxes[k].std ?? 0).toFixed(4)).join('/')}°/s; `
    + `gravity ${(r.gravityMagnitude.mean ?? 0).toFixed(3)} m/s²; `
    + `screen ${(r.screenFlatnessDeg.mean ?? 0).toFixed(2)}° from horizontal.`);
  if (!r.biasApplied) {
    log('warn', `Gyro bias NOT applied (${r.biasRefusedReason}). Zero bias is safer than a bias measured from a moving phone; loop closure will absorb the resulting drift.`);
  }
  brief(FREEFORM_STAGE);
}

function tickCalibration(now) {
  if (state.sensorCal.stage === 'stationary') {
    const elapsed = now - state.sensorCal.startedAt;
    const flat = orientation.screenFlatnessDeg();
    // Sustained stillness, not an instantaneous snapshot. The field failure
    // mode: the operator taps Start and keeps holding the phone; one quiet
    // instant (or a null gravity reading) let the old check pass and a
    // hand-tremor "bias" of 8.6°/s got locked in. `flat === null` must WAIT,
    // not pass — no gravity reading means we know nothing yet.
    const stillNow = flat !== null && flat <= 15 && orientation.stillness > 0.7;
    // Arm the timer on the FIRST still tick too — a phone set down before the
    // operator tapped Start is still from tick one, and the 2026-08-12 run
    // showed the unarmed timer silently waiting out the full 25 s fallback.
    if (!stillNow) state.sensorCal.stillSince = now;
    else if (state.sensorCal.stillSince == null) state.sensorCal.stillSince = now;
    const heldMs = now - (state.sensorCal.stillSince ?? now);
    director.calibrationProgress = clamp(heldMs / 4000, 0, 1);
    const enoughSamples = orientation.stationarySampleCount >= 40;
    if (heldMs >= 4000 && enoughSamples) {
      finishStationary(now);
      return;
    }
    // A phone that will not settle (no flat surface available) eventually
    // proceeds anyway: the bias plausibility gate refuses a moving measurement,
    // so continuing with zero bias is safe, and being stuck here is not.
    if (elapsed >= 25000 && enoughSamples) {
      log('warn', 'Stationary test never settled — proceeding without a bias measurement. For best drift correction, restart with the phone on a table or the ground.');
      finishStationary(now);
      return;
    }
    if (elapsed >= 12000 && !enoughSamples) {
      const r = orientation.finishStationaryDiagnostic();
      log('error', 'SENSOR_STATIONARY_FAILED', JSON.stringify(r),
        'No gyroscope samples arrived. Calibration stopped; no zero-sample result was accepted.');
      state.sensorCal = { stage: 'failed', reason: 'no-samples', startedAt: now };
      state.paused = true;
      director.calibrationProgress = 0;
      syncControls();
      return;
    }
    return;
  }

  if (state.sensorCal.stage === BRIEF_STAGE) return;   // waiting on the operator

  if (state.sensorCal.stage === FREEFORM_STAGE) {
    pollFreeform(now);
    return;
  }

  if (state.sensorCal.stage === LENS_STAGE) {
    pollLens(now);
    return;
  }

  if (state.sensorCal.stage === 'failed') return;

  const att = orientation.attitude();
  const still = orientation.stillness > 0.6;

  // This stage used to also demand |roll| <= 12, and that requirement was both
  // unnecessary and capable of deadlocking calibration outright.
  //
  // Unnecessary because all this stage does is collect compass samples for the
  // yaw datum while the device is held steady. Roll is carried through the full
  // quaternion by every projection downstream, so how the device is rotated
  // about its own view axis simply does not enter into it.
  //
  // Deadlocking because `roll` is derived through screenQuat, and on a device
  // reporting a 90° screen angle the screen's right axis maps onto device -Y,
  // whose tilt out of horizontal IS beta. An iPad on 2026-08-14 therefore
  // reported roll = -beta exactly, so "level" could only be satisfied lying
  // flat, screen up — while the instruction on screen was to hold it upright.
  // Worse, the 12-second escape hatch below ALSO tested level, so the operator
  // was stuck for 56 seconds with no way out that the interface admitted to.
  // A stage whose only job is to hold still must not be gated on a derived
  // angle that can be wrong.

  // Calibration exists only to fix the compass yaw datum, and the compass is
  // the input this design already treats as suspect — the mount supplies the
  // real azimuth later. A phone clamped to a steel mount head will sometimes
  // never produce a quiet magnetometer, so refusing to start the survey over it
  // blocks the whole tool on the one number that does not have to be right.
  // After 12 s of trying, proceed on a relative datum and say so.
  if (!state.calibGaveUp && now - (state.calibFirstTry || now) > 12000 && orientation.lastEventAt) {
    state.calibGaveUp = true;
    log('warn', `Sensor never settled — orientation jitter ±${(orientation.jitterDeg / 2).toFixed(1)}°, turn rate ${orientation.rotationRate.toFixed(1)}°/s. Continuing on a relative azimuth datum; set the offset from mount calibration after export.`);
    orientation.compassReliability = 'poor';
    finishCalibration();
    return;
  }
  if (!state.calibFirstTry) state.calibFirstTry = now;

  if (!still || !orientation.lastEventAt) {
    director.calibrationProgress = Math.max(0, director.calibrationProgress - 0.02);
    state.calibStart = now;
    return;
  }
  const elapsed = now - state.calibStart;
  director.calibrationProgress = clamp(elapsed / 3000, 0, 1);
  orientation.sampleDatum();
  if (director.calibrationProgress >= 1) finishCalibration();
}

function finishCalibration() {
  orientation.lockDatum();
  survey.yawDatum = orientation.yawDatum;
  state.fusedYaw = orientation.rawYaw();
  state.prevRawYaw = orientation.rawYaw();
  state.fusedYawAtKeyframe = state.fusedYaw;
  // Null, not the current elevation: the first photograph of a survey must not
  // be gated on having tilted away from wherever the datum happened to be set.
  state.elevationAtKeyframe = null;
  survey.yawDatum = orientation.yawDatum;

  const luma = camera.grabLuma();
  if (luma) {
    state.targetLuma = true;
    pipeline.anchor(luma, LUMA_W, LUMA_H);
  }
  pipeline.resetRegistration();
  // A fresh lap is guided from a clean map. Coverage is per-lap evidence that
  // the operator painted the horizon this time round, not a lifetime tally.
  coverage.reset();
  guidance.reset();
  state.lastCoverageAt = null;
  state.guidance = null;
  director.beginPass1(currentHeading());
  setTimeout(() => {
    if (!orientation.gyroAvailable) {
      log('warn', `No gyroscope after ${orientation.gyroSamples} devicemotion sample(s). Azimuth will be scaled by the field-of-view estimate, so complete a full lap and let loop closure calibrate the scale — that is what makes the result usable without a gyro.`);
    }
  }, 4000);
  log('info', `Pass 1 started at azimuth ${currentHeading().toFixed(1)}°.`);

  /*
   * SAY HOW LONG THIS WILL TAKE, BEFORE IT TAKES IT.
   *
   * The 2026-08-25 survey was 2m37s of capture and 16m20s of building, and the
   * operator learned that by watching it happen. The build is the part that
   * matters here: it needs the phone awake and left alone for a quarter of an
   * hour, and a screen that dims into sleep partway through throws away the
   * walk. That is a setting the operator can change in ten seconds — but only
   * if somebody tells them, and only if somebody tells them now.
   */
  captureStartedAt = performance.now();
  const plan = estimateSurvey({
    rates: surveyRates,
    hfovDeg: camera.hfovDeg,
    stepAcrossDeg: keyframeStepDeg(camera.hfovDeg, 1)
  });
  log('info', describeSurveyPlan(plan), {
    expectedFrames: plan.frames,
    captureSec: Math.round(plan.captureSec),
    buildSec: Math.round(plan.buildSec),
    fromMeasuredRates: plan.measured
  });
  state.sensorCal = { stage: 'complete', startedAt: performance.now() };
  syncControls();
}

/** How the wave is going: what evidence is in, and what the solver makes of it
 *  so far. Called a few times a second while the operator is still moving.
 *
 *  Solving live is what removes the last instruction. Rather than asking for a
 *  motion and hoping it was enough, the app can simply watch until it is sure,
 *  which means there is no longer any way to perform this step incorrectly —
 *  only slowly. */
function pollFreeform(now) {
  const cal = state.sensorCal;
  const ev = orientation.spinEvidence();
  const axisFrac = ev.work.map(w => clamp(w / EVIDENCE.axisDeg, 0, 1));
  const sweepFrac = clamp(ev.sweepDeg / EVIDENCE.sweepDeg, 0, 1);
  const elapsedFrac = clamp((now - cal.startedAt) / EVIDENCE.minMs, 0, 1);
  const enough = Math.min(...axisFrac, sweepFrac, elapsedFrac) >= 1;

  if (now - (cal.lastPollAt || 0) >= 350) {
    cal.lastPollAt = now;
    // Never applied: this probe runs while the samples are still arriving, and
    // installing a map mid-motion would corrupt the very samples being read.
    // Thinned to a few hundred intervals — measured at 3 ms against 8 ms for
    // the full set, for an identical answer — because this shares the main
    // thread with the camera pipeline.
    const probe = orientation.solveGyroAxisMap({ apply: false, includeActive: true, maxIntervals: 260 });
    const solved = probe.status === 'identity' || probe.status === 'remapped';
    const key = solved ? `${probe.perm.join('')}:${probe.signs.join('')}` : null;
    // Require the same answer twice running before believing it, so a lucky
    // early fit on two seconds of data cannot end the stage.
    cal.stableCount = key && key === cal.lastKey ? (cal.stableCount || 0) + 1 : 0;
    cal.lastKey = key;
    cal.probe = probe;
  }

  const confident = enough && cal.stableCount >= 1;
  cal.evidence = { axisFrac, sweepFrac, elapsedFrac, ev };
  director.calibrationProgress = confident ? 1
    : Math.min(1, 0.15 + 0.85 * Math.min(...axisFrac, sweepFrac, elapsedFrac));
  if (confident) finishFreeform();
}

/** What is still missing, in words the operator can act on. */
function freeformHint(cal) {
  const e = cal.evidence;
  if (!e) return 'Turn and tumble it — every direction you can.';
  if (e.sweepFrac < Math.min(...e.axisFrac)) {
    return 'Tip it over more — end over end, and onto its edges. Spinning it flat is not enough on its own.';
  }
  if (Math.min(...e.axisFrac) < 0.999) {
    return 'Keep going, and keep changing which way it turns.';
  }
  return 'Nearly there — keep it moving.';
}

function finishFreeform() {
  const r = orientation.finishSpinDiagnostic();
  if (r) {
    log('info', 'SENSOR_MOTION', JSON.stringify(r));
    log('info',
      `Calibration motion: ${r.totalRotDeg.toFixed(0)}° of turning in ${(r.durationMs / 1000).toFixed(1)} s, `
      + `gravity swept ${r.sweepDeg.toFixed(0)}° through the phone. Reported axis totals `
      + `${r.trace ? r.trace.rawAxisAbsoluteDeg.map(v => v.toFixed(0)).join(' / ') : '—'}°.`);
  }
  solveRotationTests();
}

/** Judge the motion. Nothing before this point passes or fails. */
function solveRotationTests() {
  const solved = orientation.solveGyroAxisMap();
  const ok = solved.status === 'identity' || solved.status === 'remapped';
  log(ok ? 'info' : 'error', 'SENSOR_AXIS_SOLVE', JSON.stringify(solved));

  if (ok) {
    const how = solved.decidedBy === 'kinematics'
      ? 'from the way gravity moved through the phone alone — nothing about how you moved it was assumed'
      : 'from the axes plus the direction you were asked to turn';
    if (solved.status === 'identity') {
      log('info', `Calibrated: this phone reports its gyroscope axes exactly as the spec says. Solved ${how} (residual ${solved.resid}, next-best axis order ${solved.margin}).`);
    } else {
      log('warn',
        `This phone reports its gyroscope axes in a non-standard order${solved.leftHanded ? ' and mirrored' : ''}: `
        + `reported [x,y,z] → [${solved.perm.map((p, i) => `${solved.signs[i] < 0 ? '-' : ''}${'xyz'[p]}`).join(', ')}]. `
        + `Solved ${how} (residual ${solved.resid}, next-best axis order ${solved.margin}). Applying it.`);
    }
    if (solved.assumedDirection) {
      log('warn', 'The phone barely tilted while it turned, so the sensors could not tell which way it went and the axis directions rest on the instruction to turn LEFT. If you turned right, azimuth will run backwards — the landmark check will expose it.');
    }
    if (solved.scaleApplied) {
      log('info', `Gyro scale ${solved.scaleFromSweep} — measured against the angle gravity actually swept, so it owes nothing to how far you turned.`);
    } else if (solved.scaleFromSweep !== null) {
      log('warn', `The motion implied a gyro scale of ${solved.scaleFromSweep}, too far from 1 to trust. Leaving it at 1; loop closure will absorb the difference.`);
    }
    // A manual value is an operator decision. A known-device value is only a
    // seed: the reconstruction showed the saved vertical angles fit a lens a
    // few degrees away from the table value, so real captures should verify it.
    if (camera.focalSource === 'manual') {
      const i = camera.intrinsics();
      log('info', `Skipping the lens step — the operator pinned this lens at ${i.hfovDeg.toFixed(1)}° x ${i.vfovDeg.toFixed(1)}° (${camera.focalSource}).`);
      brief('settle');
      return;
    }
    brief(LENS_STAGE);
    return;
  }

  // Every failure here is a refusal, never a guess: across 480 simulated runs
  // spanning gentle-to-vigorous motion and 0-200 ms of orientation lag, a wrong
  // map was returned zero times. So the guidance can be specific about what to
  // add rather than apologetic about what went wrong.
  const w = solved.work || [0, 0, 0];
  const why = {
    'unsolved': 'The gyroscope and the orientation sensor could not be reconciled — usually the phone was moved too gently for the orientation stream to keep up. Wave it a bit more briskly and with more variety.',
    'ambiguous': `The motion never separated the axes — it kept turning the same way. Roll it onto its edges and tumble it end over end too, not just flat. (Axis totals ${w.join(' / ')}°.)`,
    'insufficient-data': 'Too little movement was recorded to work with.',
    'too-little-rotation': 'Barely any rotation was recorded.',
    'no-direction-evidence': 'The phone turned without ever tilting, so which way is up could not be pinned down. Tip it over as well as turning it.',
    'wrong-direction': 'The turns went clockwise while the phone stayed too level to tell for certain. Wave it with more tumbling, or turn to your LEFT.',
    'mixed-direction': 'The motion turned both ways while staying too level to tell which is which. Tumble it end over end as well and it will settle itself.'
  }[solved.status] || 'The motion could not be interpreted.';
  log('error', 'SENSOR_AXIS_TEST_FAILED', `${why} (${solved.status})`);
  state.sensorCal = { stage: 'failed', reason: 'bad-axis-map', why, startedAt: performance.now() };
  state.paused = true;
  director.calibrationProgress = 0;
  syncControls();
}

/** Show what is about to happen and wait. Nothing is recorded until Start. */
function brief(next) {
  state.sensorCal = { stage: BRIEF_STAGE, next, startedAt: performance.now() };
  director.calibrationProgress = 0;
  syncControls();
}

/** Begin whichever stage the briefing was for, now that the operator is set. */
function startBriefedStage() {
  const next = state.sensorCal.next;
  if (next === 'stationary') {
    // NOT brief('stationary'). A bulk edit put a briefing call here, so the
    // Start button re-showed the same briefing forever and read as dead.
    orientation.beginStationaryDiagnostic();
    state.sensorCal = { stage: 'stationary', startedAt: performance.now() };
    state.calibStart = performance.now();
  } else if (next === FREEFORM_STAGE) {
    orientation.resetSpinEvidence();
    orientation.beginSpinDiagnostic('yaw');
    state.sensorCal = { stage: FREEFORM_STAGE, startedAt: performance.now() };
  } else if (next === LENS_STAGE) {
    beginLensMeasurement();
    return;
  } else {
    state.sensorCal = { stage: 'settle', startedAt: performance.now() };
    state.calibStart = performance.now();
    state.calibFirstTry = 0;
  }
  director.calibrationProgress = 0;
  syncControls();
}

function beginLensMeasurement() {
  lensCal.reset();
  state.prevElevation = null;
  state.sensorCal = { stage: LENS_STAGE, startedAt: performance.now() };
  director.calibrationProgress = 0;
  syncControls();
}

/** Watch the lens measurement fill in, and stop as soon as it is solid. */
function pollLens(now) {
  const r = lensCal.result();
  state.sensorCal.lens = r;
  // Progress is the weaker of the two axes, so the bar cannot look finished
  // while the vertical — the one altitudes depend on — is still missing.
  const frac = v => clamp(v, 0, 1);
  director.calibrationProgress = Math.min(
    frac((r.nPan || 0) / 45), frac((r.nTilt || 0) / 45),
    r.ready ? 1 : 0.95
  );
  if (r.ready) { finishLens(r); return; }
  if (now - state.sensorCal.startedAt > LENS_TIMEOUT_MS) {
    log('warn', 'LENS_MEASURE_TIMEOUT', JSON.stringify(r));
    // Keep a measurement that merely ran out of time over a default that was
    // never measured at all. Throwing away 273 pan and 191 tilt pairs because
    // the uncertainty sat at 1.56% rather than 1.5% is not caution, it is
    // waste — and it hands the survey back to a guessed field of view.
    if (r.salvageable) {
      log('warn', `Time is up, but the measurement had converged well enough to keep (±${(Math.max(r.uncertaintyH, r.uncertaintyV) * 100).toFixed(1)}%). Using it.`);
      finishLens(r);
      return;
    }
    finishLens(null);
  }
}

/** What the measurement still needs, in something the operator can act on. */
/**
 * What to tell the operator during the lens measurement.
 *
 * The old version of this said "point at something with detail" until the first
 * pair arrived and "keep panning" thereafter, regardless of whether anything
 * was working. The operator's complaint was exact: no idea what it was using,
 * and no idea whether it was getting anywhere. Both are knowable — the
 * calibrator counts its pairs and knows why it is rejecting the rest — so both
 * are now said out loud.
 *
 * Order matters. A live problem outranks progress, because progress that is not
 * moving is not the thing to report when the reason it is not moving is
 * available.
 */
function lensGuidance(diag) {
  if (!diag) {
    return {
      advice: 'Point at something with hard edges — a tree, a fence, a rooftop. Blank sky or a plain wall gives the matcher nothing to hold onto.',
      tone: 'work', counts: ''
    };
  }
  const counts = diag.axis === 'done'
    ? `${diag.nPan} sideways and ${diag.nTilt} up-down pairs.`
    : `Sideways ${Math.min(diag.nPan, diag.need)}/${diag.need}, up-down ${Math.min(diag.nTilt, diag.need)}/${diag.need}.`;

  // A live problem with the current view, named specifically.
  const problems = {
    quality: ['fix', 'This view gives it nothing to hold onto. Aim at hard edges — a roofline against sky, a fence, bare branches. Move off blank wall, water, or plain sky.'],
    tooSlow: ['fix', 'Too slow to measure — the picture is barely moving between frames. Sweep noticeably faster.'],
    tooFast: ['fix', 'Too fast — consecutive frames barely overlap. Slow the sweep down.'],
    absurd: ['fix', 'The match keeps jumping, which usually means a repeating pattern like siding or railings. Aim at something less repetitive.']
  };
  if (diag.problem && problems[diag.problem]) {
    const [tone, advice] = problems[diag.problem];
    return { tone, advice, counts };
  }

  // Nothing wrong: say which half is being worked on and that it is landing.
  const locked = diag.lock !== null && diag.lock > 0.5;
  if (diag.axis === 'pan') {
    return {
      tone: locked ? 'good' : 'work',
      advice: locked ? 'Holding well. Keep sweeping left and right.' : 'Sweep left and right, smoothly.',
      counts
    };
  }
  if (diag.axis === 'tilt') {
    return {
      tone: locked ? 'good' : 'work',
      advice: 'Sideways is done. Now tilt up and down, the same steady sweep.',
      counts
    };
  }
  return { tone: 'good', advice: 'Both directions measured.', counts };
}

function finishLens(r) {
  if (r && (r.ready || r.salvageable) && camera.setMeasuredLens(r.focalH, r.focalV)) {
    log('info', 'LENS_MEASURED', JSON.stringify({
      hfovDeg: Number(r.hfovDeg.toFixed(2)),
      vfovDeg: Number(r.vfovDeg.toFixed(2)),
      focalH: Number(r.focalH.toFixed(1)),
      focalV: Number(r.focalV.toFixed(1)),
      uncertaintyH: Number((r.uncertaintyH * 100).toFixed(2)),
      uncertaintyV: Number((r.uncertaintyV * 100).toFixed(2)),
      squarePixelRatio: Number(r.squarePixelRatio.toFixed(3)),
      nPan: r.nPan, nTilt: r.nTilt, rejected: r.rejected
    }));
    // The two halves were measured against different sensors — yaw against the
    // gyroscope, tilt against gravity — and on a square-pixel sensor they must
    // arrive at the same focal length in pixels. Saying whether they did is
    // the difference between a measurement and an assertion.
    const agree = Math.abs(r.squarePixelRatio - 1) < 0.12;
    log(agree ? 'info' : 'warn',
      `Lens measured: ${r.hfovDeg.toFixed(1)}° across the frame and ${r.vfovDeg.toFixed(1)}° down it, `
      + `to about ±${(Math.max(r.uncertaintyH, r.uncertaintyV) * 100).toFixed(1)}%, from ${r.nPan} pan and ${r.nTilt} tilt pairs. `
      + (agree
        ? `The two halves were measured against different sensors — sideways against the gyroscope, up-and-down against gravity — and agree on the same lens to ${Math.abs(r.squarePixelRatio - 1) * 100 < 1 ? 'under 1' : (Math.abs(r.squarePixelRatio - 1) * 100).toFixed(0)}%, which is the cross-check that makes this a measurement rather than a guess.`
        : `But they DISAGREE by ${((r.squarePixelRatio - 1) * 100).toFixed(0)}% about the same lens, which on a square-pixel sensor they should not. Treat this with suspicion and check it against a landmark of known height before trusting altitudes.`));
    syncFovReadout();
  } else {
    log('warn', 'LENS_NOT_MEASURED', JSON.stringify(r || {}));
    const prior = camera.focalSource === 'known-device' ? 'known-device prior' : 'default';
    log('warn',
      `Lens NOT measured — continuing on the ${camera.hfovDeg.toFixed(0)}° ${prior}. `
      + 'Altitudes are only as good as that figure, and if it is wrong they are wrong by the same factor and by more toward the frame edges. '
      + 'Azimuth is unaffected. You can measure it later from Advanced and press Recompute from keyframes.');
  }
  brief('settle');
}

/** Re-run a failed rotation test in place. A field reload costs the camera
 *  grant, the lens pin, and any preflight work — never require one while the
 *  sensors are demonstrably producing samples. */
function retrySensorTest() {
  state.paused = false;
  director.calibrationProgress = 0;
  // Start from clean evidence: the previous attempt's samples would otherwise
  // be solved together with the new ones.
  log('info', 'Waving again from scratch.');
  brief(FREEFORM_STAGE);
}

/** Proceed past a failed rotation test without pretending it passed.
 *  Altitudes come from camera geometry and gravity, which this test does not
 *  touch; azimuth is what is unverified, and the landmark check can judge it
 *  after the fact. The skip is logged loudly so it survives into the report
 *  and the debug bundle. */
function skipSensorTest() {
  log('warn', 'SENSOR_TEST_SKIPPED',
    'Proceeding despite a failed rotation test. Altitudes are unaffected (camera geometry + gravity). Azimuth is UNVERIFIED — verify with two landmarks at least 90° apart before trusting the profile as a pointing limit.');
  state.sensorCal = { stage: 'settle', startedAt: performance.now(), skipped: true };
  state.paused = false;
  state.calibStart = performance.now();
  state.calibFirstTry = 0;
  director.calibrationProgress = 0;
  syncControls();
}

/* -------------------------------------------------------------- transitions */

function logCaptureGaps(label) {
  const report = captureGapReport(survey.keyframes, survey.yawDatum || 0, { minOverlap: overlapFloor(director.mode) });
  const latest = report.passes[report.passes.length - 1];
  if (!latest?.gaps.length) {
    log('info', `${label}: no photo-overlap gaps detected; median step ${latest?.medianStepDeg ?? '—'}°.`);
    return report;
  }
  log('warn', `${label}: ${latest.gaps.length} photo-overlap gap(s) need another view.`);
  for (const gap of latest.gaps.slice(0, 8)) {
    log('warn',
      `Frames ${gap.fromFrame}→${gap.toFrame} are ${gap.stepDeg.toFixed(1)}° apart with ${(gap.estimatedOverlap * 100).toFixed(0)}% estimated overlap`
      + `${gap.uncoveredDeg > 0 ? ` and ${gap.uncoveredDeg.toFixed(1)}° with no image coverage` : ''}. `
      + `Capture ${gap.recommendedPhotoCount} more view(s) at ${gap.recaptureLabels.join(', ')}.`);
  }
  return report;
}

async function startCapture() {
  try {
    setChip($('contextChip'), 'Starting…', 'quiet');
    await orientation.start();
    await camera.start();
    camera.detectRotation(orientation.screenAngle);
    pipeline.start();
    state.running = true;
    $('stageBlocker').hidden = true;
    store.requestPersistence().then(ok => ok && log('info', 'Storage marked persistent.'));
    state.sessionId = state.sessionId || `s${Date.now().toString(36)}`;
    director.beginCalibration();
    brief('stationary');
    state.calibStart = performance.now();
    setChip($('contextChip'), `${camera.settings.width}×${camera.settings.height}`, '');
    syncControls();
  } catch (err) {
    log('error', 'Start failed:', err);
    $('stageBlockerText').textContent = err.message || String(err);
    $('stageBlocker').hidden = false;
    setChip($('contextChip'), 'Blocked', 'bad');
  }
}

/**
 * Steps of `finishPass1`, named so the operator can be told which one is
 * running. There is deliberately no ETA: these steps take wildly different
 * times depending on frame count and none of them is predictable enough to put
 * a countdown on without lying. Naming the step and counting the seconds is
 * honest, and it answers the only question that matters — is it still working.
 */
const ANALYSIS_STEPS = [
  'Matching the closing view',
  'Checking the rotation scale',
  'Applying loop closure',
  'Reprojecting the survey',
  'Planning the second pass'
];

function setAnalysisStep(index) {
  state.analysis = {
    step: index,
    total: ANALYSIS_STEPS.length,
    label: ANALYSIS_STEPS[index] || '',
    startedAt: state.analysis?.startedAt || performance.now()
  };
}

async function finishPass1() {
  director.setPhase(PHASE.ANALYSING);
  state.analysis = null;
  setAnalysisStep(0);
  syncControls();
  await new Promise(r => setTimeout(r, 30));
  try {
    await runPass1Analysis();
  } catch (err) {
    // A throw in here used to leave the phase pinned at ANALYSING with the
    // button disabled and nothing on screen — the survey looked frozen and the
    // operator had no way to tell whether it was working or dead. Whatever
    // fails, say so and hand control back.
    log('error', 'Analysis failed:', err);
    $('stageBlockerText').textContent =
      `Analysis failed: ${err?.message || err}. The capture is intact — you can still export the debug bundle.`;
    $('stageBlocker').hidden = false;
  } finally {
    state.analysis = null;
    if (director.phase === PHASE.ANALYSING) director.beginPass2();
    updateReport();
    syncControls();
  }
}

async function runPass1Analysis() {
  let accumulated = director.pass1Travel;
  let residual = null;
  const luma = camera.grabLuma();
  if (luma && state.targetLuma) {
    const match = await pipeline.closeLoop(luma, LUMA_W, LUMA_H);
    if (match && match.quality > 0.35) {
      const cosEl = Math.max(0.3, Math.cos(orientation.attitude().elevation * DEG));
      residual = Math.atan(match.dx / focalLumaPx()) * RAD / cosEl * (state.visualSign || 1);
      log('info', `Loop closure match quality ${match.quality.toFixed(2)}, residual offset ${residual.toFixed(2)}°.`);
    } else {
      log('warn', 'Loop closure could not match the starting view. Ending azimuth is unverified.');
    }
  }

  // Before any additive correction: is the SCALE right? A physical lap is 360
  // degrees, so a lap logged as 176 is not off by an offset, it is off by a
  // factor — and no amount of additive closure will fix that. Rescale first,
  // and take the true field of view out of the same ratio.
  setAnalysisStep(1);
  await new Promise(r => setTimeout(r, 0));
  const laps = Math.max(1, Math.round(Math.abs(accumulated) / 360));
  const offBy = Math.abs(accumulated) / (360 * laps);
  if (offBy < 0.8 || offBy > 1.25) {
    const cal = survey.calibrateScaleFromLoop(accumulated, camera.hfovDeg, laps);
    if (cal) {
      log('warn', `A full lap was logged as ${Math.abs(accumulated).toFixed(0)}° instead of ${360 * laps}° — the rotation scale was off by ${cal.scale.toFixed(2)}x. Rescaled.`);
      log('info', `That ratio measures the optics: true horizontal field of view is ${cal.hfovDeg.toFixed(1)}°, not the ${camera.hfovDeg.toFixed(1)}° assumed. Adopting it.`);
      camera.setHfov(cal.hfovDeg);
      camera.focalSource = 'loop closure';
      syncFovReadout();
      accumulated *= cal.scale;
    } else {
      log('warn', `A lap was logged as ${Math.abs(accumulated).toFixed(0)}° instead of ${360 * laps}°, which is too far off to correct automatically. Check the lens and field of view.`);
    }
  }

  setAnalysisStep(2);
  await new Promise(r => setTimeout(r, 0));
  const k = Math.round(accumulated / 360) || (accumulated >= 0 ? 1 : -1);
  if (residual !== null) {
    const closure = accumulated + residual;
    const error = closure - 360 * k;
    log('info', `Gyro/visual accumulated rotation: ${accumulated.toFixed(2)}°`);
    log('info', `Visual loop closure:             ${closure.toFixed(2)}°`);
    log('info', `Residual error:                  ${error.toFixed(2)}°`);
    survey.applyLoopClosure(error);
  }

  setAnalysisStep(3);
  await new Promise(r => setTimeout(r, 0));
  survey.reproject(camera.intrinsics());
  logCaptureGaps('First lap');

  setAnalysisStep(4);
  await new Promise(r => setTimeout(r, 0));
  /*
   * Do NOT wipe the map. Demote only what needs re-walking.
   *
   * This was `coverage.reset({ keepWorld: true })`, on the reasoning that a
   * second lap should earn its own confidence. But verification is done by the
   * survey's 720 bins, which have their own two-pass and single-lap rules; this
   * map's only job is to tell the operator where to point. Wiping it left the
   * 2026-08-21 capture guiding from a blank slate for its last six minutes,
   * with the dot stuck and the operator covering sectors it never asked for.
   *
   * The weak sectors the director just identified are the ones that genuinely
   * need another look, so those lose their confidence and everything else keeps
   * what it earned.
   */
  const demoted = coverage.demote(director.targets || []);
  guidance.reset();
  state.lastCoverageAt = null;
  state.guidance = null;
  director.beginPass2();
  log('info', `Verification pass planned: ${director.targets.length} sector(s) need more evidence; `
    + `${demoted} bin(s) demoted, the rest of the ring keeps the confidence it earned.`);
}

/**
 * Anything that runs between two phases must not be able to strand the survey
 * in the first one.
 *
 * On 2026-08-17 a ReferenceError inside `logCaptureGaps` threw partway through
 * the end-of-lap work. The phase had already been set to ANALYSING, the primary
 * button was already disabled, and the exception went to an unhandled rejection
 * — so the app sat at "Building the profile" forever with nothing on screen to
 * say it had died, and the operator had no way to reach their own capture.
 * Every one of these boundaries is now wrapped: a failure is reported, and the
 * phase moves on regardless so the capture stays reachable.
 */
function guardPhaseStep(what, fn, recover) {
  try {
    return fn();
  } catch (err) {
    log('error', `${what} failed:`, err);
    $('stageBlockerText').textContent =
      `${what} failed: ${err?.message || err}. Your capture is intact — you can still export the debug bundle.`;
    $('stageBlocker').hidden = false;
    try { recover?.(); } catch (_) { /* recovery is best-effort by definition */ }
    return null;
  }
}

function finishVerificationPass() {
  director.verificationSweep = false;
  const gapReport = guardPhaseStep('Verification lap analysis', () => {
    survey.recompute();
    return logCaptureGaps('Verification lap');
  });
  if (!gapReport) return finishSurvey();
  director.refreshTargets();
  if (!director.targets.length) return finishSurvey();

  const target = director.pickNearestTarget(currentHeading());
  const photoGapCount = gapReport.passes[gapReport.passes.length - 1]?.gapCount || 0;
  const centre = target ? wrap360(target.fromDeg + target.widthDeg / 2) : null;
  log('warn',
    `Verification lap finished, but ${director.targets.length} cleanup target(s) remain`
    + `${photoGapCount ? `, including ${photoGapCount} source-photo overlap gap(s)` : ''}. `
    + (target ? `Follow the guide to ${centre.toFixed(1)}° for the nearest one.` : ''));
  updateReport();
  syncControls();
}

function finishSurvey() {
  director.setPhase(PHASE.VALIDATING);
  guardPhaseStep('Validation', () => {
    survey.recompute();
    updateReport();
  });
  // Unconditional: VALIDATING has no controls of its own, so being left in it
  // is indistinguishable from a hang.
  director.setPhase(PHASE.COMPLETE);
  state.paused = true;
  syncControls();
  log('info', 'Survey complete.');

  // Learn from what just happened, so the next survey's estimate is this
  // device's own figure rather than the reference capture's.
  if (captureStartedAt !== null) {
    surveyRates.recordCapture(
      survey.keyframes.length, (performance.now() - captureStartedAt) / 1000);
    captureStartedAt = null;
  }
  const next = estimateSurvey({
    rates: surveyRates, frames: survey.keyframes.length
  });
  log('info', `Building the panorama from ${survey.keyframes.length} photographs will take `
    + `${roughMinutes(next.buildSec)}. Keep the screen awake and this tab in front.`,
    { buildSec: Math.round(next.buildSec) });
}

/** Archives record the mode their acceptance thresholds were set by; restoring
 *  a project must restore it too, or a reopened tripod survey would be judged
 *  against handheld gates. */
function restoreMode(project) {
  const id = project?.capture?.mode?.id;
  if (!id) return;
  director.phase = PHASE.IDLE;
  if (director.setMode(id)) {
  }
}

function resetSurvey() {
  survey.reset();
  director.phase = PHASE.IDLE;
  director.pass1Travel = 0;
  director.pass2Travel = 0;
  director.verificationSweep = false;
  director.targets = [];
  director.target = null;
  state.fusedYaw = 0;
  state.prevRawYaw = null;
  state.prevGyroYaw = null;
  state.announcedSource = false;
  state.visualScale = null;
  state.visualScaleN = 0;
  state.visualScaleMin = null;
  state.visualScaleMax = null;
  state.rolledNoteShown = false;
  state.prevElevation = null;
  lensCal.reset();
  state.calibFirstTry = 0;
  state.calibGaveUp = false;
  state.visualSign = null;
  state.signSamples = [];
  state.sensorCal = { stage: 'idle', startedAt: 0 };
  state.captureAudit = { counts: {}, events: [], lastReason: null, lastAt: 0 };
  coverage.reset();
  guidance.reset();
  state.lastCoverageAt = null;
  state.guidance = null;
  state.guidanceTrail = [];
  state.lastGuidanceState = null;
  state.frameErrors = 0;
  state.lastFrameError = null;
  state.frame = null;
  state.thumbs = {};
  state.thumbBudget = newThumbBudget();
  state.pano = { landmarks: [], geomKey: null, stale: false };
  pipeline.resetRegistration();
  if (state.running) {
    director.beginCalibration();
    orientation.beginStationaryDiagnostic();
    state.sensorCal = { stage: 'stationary', startedAt: performance.now() };
    state.calibStart = performance.now();
  }
  updateReport();
  syncControls();
  log('info', 'Survey reset.');
}

/**
 * Everything the overlay needs to place the guidance dot in the live picture.
 *
 * The dot is a world bearing, so it has to be projected through the same pose
 * the survey places keyframes with — the sensor attitude carried into the fused
 * azimuth frame — or it would sit at the raw compass bearing and drift away
 * from the coverage map it came from.
 *
 * Its altitude comes from the guidance layer. Normally that is wherever the
 * camera already looks, so the dot asks for a turn and nothing else. Where the
 * coverage map has recorded an obstruction whose top has never been inside a
 * frame, the dot climbs instead, and following it is the instruction to tilt up.
 */
function guidanceView() {
  if (!state.guidance || !state.running) return null;
  const att = orientation.attitude();

  /*
   * Keep the dot alive through targeted cleanup.
   *
   * There are two different notions of "done" here and they disagree by
   * design. The coverage map calls the ring complete once its tolerance is met
   * — 98.9% on the 2026-08-18 capture — and `ScanGuidance` then drops its
   * bearing to null, correctly, because it has nothing left to lead anyone to.
   * But the DIRECTOR keeps its own list of weak sectors and photo gaps, and
   * that list was still full. So the text went on issuing instructions
   * ("Nudge left 5°") while the only thing the operator was actually following
   * disappeared off the screen.
   *
   * Whenever the director still has somewhere to be, the dot goes there.
   */
  let g = state.guidance;
  if (g.rawBearingDeg === null && director.target) {
    const centre = wrap360(director.target.fromDeg + director.target.widthDeg / 2);
    g = {
      ...g,
      bearingDeg: centre,
      rawBearingDeg: centre,
      offsetDeg: angDiff(centre, currentHeading()),
      state: 'advancing',
      complete: false,
      // Cleanup targets are about azimuth; hold the dot at the camera's own
      // height so it never also implies a tilt that nobody asked for.
      elevationDeg: att.elevation
    };
  }
  const intr = camera.intrinsics();
  const placed = quatMul(
    yawQuat(angDiff(state.fusedYaw, orientation.rawYaw()) + (survey.yawDatum || 0)),
    screenQuat(orientation.quat, orientation.screenAngle)
  );
  return {
    ...g,
    headingDeg: currentHeading(),
    altitudeDeg: Number.isFinite(g.elevationDeg) ? g.elevationDeg : att.elevation,
    cameraElevationDeg: att.elevation,
    quat: placed,
    tanHalfH: intr.tanHalfH,
    tanHalfV: intr.tanHalfV,
    scores: coverage.score,
    covered: coverageCoveredFlags()
  };
}

/** Per-bin covered/not for the strip. Recomputed per frame; 180 bins is
 *  nothing, and caching it would mean another thing to invalidate. */
function coverageCoveredFlags() {
  const flags = new Uint8Array(coverage.binCount);
  for (let i = 0; i < coverage.binCount; i++) flags[i] = coverage.isCovered(i) ? 1 : 0;
  return flags;
}

/* ------------------------------------------------------------------ render */

function renderLive() {
  const att = orientation.attitude();
  const heading = currentHeading();

  // The buttons describe progress, so they are refreshed as often as progress
  // changes. `syncControls` only touches the DOM when something actually
  // differs, so this costs a couple of comparisons per frame.
  syncControls();

  const ctx = {
    heading,
    elevation: att.elevation,
    roll: att.roll,
    rotationRate: Math.abs(orientation.rotationRate),
    stillness: orientation.stillness,
    analysis: state.analysis || null,
    overlap: state.overlap,
    frameStatus: state.frameStatus,
    visualQuality: state.visualQuality,
    jitterDeg: orientation.jitterDeg,
    calStalledMs: director.phase === 'calibrating' ? performance.now() - (state.calibStart || performance.now()) : 0,
    hfovDeg: camera.hfovDeg,
    // Everything the live coverage-loss warning needs already existed in state;
    // it just had to reach the director. `sinceKeyframeMs` and
    // `travelSinceKeyframeDeg` are measured from the last ACCEPTED keyframe, so
    // they grow for exactly as long as the gates are refusing.
    hasAcceptedFrame: survey.keyframes.length > 0,
    sinceKeyframeMs: state.lastKeyframeAt ? performance.now() - state.lastKeyframeAt : 0,
    travelSinceKeyframeDeg: state.fusedYawAtKeyframe === null
      ? 0
      : angDiff(state.fusedYaw, state.fusedYawAtKeyframe),
    lastRejectReason: state.captureAudit.lastReason,
    glareFraction: state.glareFraction,
    guidance: state.guidance
  };
  let d = director.directive(ctx);
  // Nothing the director has to say matters if the pipeline is dead.
  if (state.frameErrors > 5 && state.frameCount === 0) {
    d = {
      tone: 'fix',
      headline: 'This build is broken — do not survey',
      detail: `Frame processing has failed ${state.frameErrors} times and no frame has ever been processed. Nothing is being measured or recorded. Reload the page; if it persists, this version is faulty and needs reporting. Last error: ${state.lastFrameError}`,
      arrow: null, tilt: null, phase: director.phase
    };
  }
  if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === 'stationary') {
    const flat = orientation.screenFlatnessDeg();
    const notDown = flat === null || flat > 15;
    const stalled = performance.now() - state.sensorCal.startedAt > 8000 && director.calibrationProgress < 0.5;
    d = {
      tone: notDown || stalled ? 'fix' : 'work',
      headline: notDown ? 'Put the phone DOWN — screen up' : 'Hands off — measuring',
      detail: `Set it on a table or the ground and do not touch it${stalled ? ' — the timer only runs while it is completely still' : ''}. Measuring gyro noise, bias, and gravity${flat === null ? '' : ` — currently ${flat.toFixed(1)}° from flat`}.`,
      progress: director.calibrationProgress,
      arrow: null
    };
  } else if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === FREEFORM_STAGE) {
    const pct = Math.round(director.calibrationProgress * 100);
    d = {
      tone: pct >= 85 ? 'good' : 'work',
      headline: 'Wave the phone around',
      detail: `Hold it and keep turning and tipping it every which way — like rolling a dice in your hand. Brisk is better than slow, and no direction is wrong. It stops on its own when it has enough. ${pct}%. ${freeformHint(state.sensorCal)}`,
      progress: director.calibrationProgress,
      arrow: null,
      figure: 'freeform'
    };
    // There is no pass mark to be locked out of, so the button is only an
    // escape hatch for someone who wants to stop early.
    $('primaryBtn').textContent = 'Use what I have';
    $('primaryBtn').disabled = false;
  } else if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === BRIEF_STAGE) {
    const b = BRIEFS[state.sensorCal.next] || BRIEFS.stationary;
    d = {
      tone: 'work',
      headline: b.headline,
      detail: `${b.detail} Nothing is being measured yet.`,
      progress: 0,
      arrow: null,
      figure: b.figure
    };
    $('primaryBtn').textContent = b.button;
    $('primaryBtn').disabled = false;
  } else if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === LENS_STAGE) {
    const r = state.sensorCal.lens;
    const diag = lensCal.diagnose();
    const g = lensGuidance(diag);
    const reading = r && r.hfovDeg
      ? ` Reading ${r.hfovDeg.toFixed(0)}° across${r.vfovDeg ? ` and ${r.vfovDeg.toFixed(0)}° down` : ''}, ±${(diag.uncertainty * 100).toFixed(1)}%.`
      : '';
    d = {
      tone: r && r.ready ? 'good' : g.tone,
      headline: diag.axis === 'tilt' ? 'Measuring the lens — now up and down' : 'Measuring the lens',
      detail: `${g.advice} ${g.counts}${reading}`,
      // Progress against the pairs actually needed, rather than against a
      // timer. A bar driven by elapsed time while nothing is being collected
      // is the thing that made this step feel like it might not be working.
      progress: Math.min(1, ((Math.min(diag.nPan, diag.need) + Math.min(diag.nTilt, diag.need)) / (2 * diag.need))),
      arrow: null,
      figure: 'lens'
    };
    $('primaryBtn').textContent = 'Skip — keep the default lens';
    $('primaryBtn').disabled = false;
  } else if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === 'settle') {
    d.detail = 'Now lift the phone into its normal upright scanning position and hold it still. This final step establishes the survey datum.';
  } else if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === 'failed') {
    const reason = state.sensorCal.reason;
    const texts = {
      'wrong-direction': ['Needs more tumbling',
        `${state.sensorCal.why || 'The phone stayed too level to tell which way it turned.'} Retry and tip it over as well as turning it.`],
      'bad-axis-map': ['Needs a bit more movement',
        `${state.sensorCal.why || 'The motion could not be interpreted.'} Nothing is wrong with the phone — press Retry and wave it again, or continue with azimuth unverified and check it against landmarks afterwards.`],
      'bad-lap': ['Needs a bit more movement',
        `${state.sensorCal.why || 'The motion could not be interpreted.'} Press Retry and wave it again, or continue with azimuth unverified and check it against landmarks afterwards.`],
      'no-samples': ['Motion sensors unavailable',
        'Chrome returned no orientation or gyroscope samples. Enable Motion sensors for this site in Chrome settings, check Android sensor privacy, then press Reload and retry. No survey data was recorded.']
    };
    const [headline, detail] = texts[reason] || texts['bad-axis-map'];
    d = {
      tone: 'fix',
      headline,
      detail,
      progress: 0,
      arrow: null
    };
  } else if ((director.phase === PHASE.PASS1 || director.phase === PHASE.PASS2) &&
             Math.abs(att.elevation) > ELEVATION_WARN_DEG) {
    d = {
      tone: 'fix',
      headline: `Tilt down below ${ELEVATION_WARN_DEG}°`,
      detail: `Currently ${Math.abs(att.elevation).toFixed(1)}°. Near the zenith yaw and roll stop being separable, and frames above ${ELEVATION_HARD_LIMIT_DEG}° are rejected outright. Come back down and keep turning — the guide will ask for height where it needs it.`,
      progress: d.progress,
      arrow: null
    };
  }

  $('directive').dataset.tone = d.tone;
  $('directiveHead').textContent = d.headline;
  $('directiveDetail').textContent = d.detail;
  $('directiveBar').style.width = `${((d.progress ?? director.verifiedFraction()) * 100).toFixed(1)}%`;

  // Only rewrite the figure when it actually changes; this runs every frame.
  const figure = $('directiveFigure');
  if (figure.dataset.figure !== (d.figure || '')) {
    figure.dataset.figure = d.figure || '';
    const svg = d.figure ? calibrationFigure(d.figure) : null;
    figure.innerHTML = svg || '';
    figure.hidden = !svg;
  }

  if (d.arrow) {
    $('turnCue').hidden = false;
    $('turnCueText').textContent = d.arrow > 0
      ? `▶  ${d.arrow === 1 ? 'CLOCKWISE' : `RIGHT ${Math.round(d.arrow)}°`}`
      : `${d.arrow === -1 ? 'COUNTER-CLOCKWISE' : `LEFT ${Math.round(Math.abs(d.arrow))}°`}  ◀`;
  } else if (d.arrow === 0) {
    $('turnCue').hidden = false;
    $('turnCueText').textContent = '● ON TARGET';
  } else {
    $('turnCue').hidden = true;
  }

  $('tAz').textContent = state.running ? fmt(heading) : '—';
  $('tEl').textContent = state.running ? fmt(att.elevation) : '—';
  $('tRoll').textContent = state.running ? fmt(att.roll) : '—';
  $('tRate').textContent = state.running ? `${Math.abs(orientation.rotationRate).toFixed(1)}°/s` : '—';
  $('tKf').textContent = String(survey.keyframes.length);
  $('tMatch').textContent = state.visualQuality == null ? '—' : `${Math.round(state.visualQuality * 100)}%`;

  drawOverlay($('overlay'), state.frame, d, guidanceView());
  const view = { heading: state.running ? heading : NaN, hfovDeg: camera.hfovDeg, target: director.target, maxAlt: state.maxAlt };
  drawRing($('ring'), survey, view);
  drawRing($('miniRing'), survey, view);
  drawProfile($('profile'), survey, view);
  updateStats();
  updateFovCal();

  const phaseLabels = {
    idle: 'Idle', calibrating: 'Calibrating', pass1: 'Pass 1 — survey',
    analysing: 'Analysing', pass2: 'Pass 2 — verify', validating: 'Validating', complete: 'Complete'
  };
  setChip($('phaseChip'), phaseLabels[director.phase] || director.phase,
    director.phase === PHASE.COMPLETE ? '' : director.phase === PHASE.IDLE ? 'quiet' : '');
}

function updateFovCal() {
  if (!preflight.active) return;
  const swept = preflight.sweepDeg;
  const st = survey.focalStats();
  $('preflightState').textContent = swept < MIN_SWEEP_DEG
    ? `${swept.toFixed(0)}° of ${MIN_SWEEP_DEG}° swept`
    : `${swept.toFixed(0)}° swept, FOV ${st.converged ? 'ready' : `${st.n} samples`}`;
}

function updateStats() {
  const c = survey.coverage();
  $('sObserved').textContent = `${c.coverageDeg.toFixed(1)}°`;
  $('sVerified').textContent = `${c.verifiedBins} / ${BIN_COUNT}`;
  $('sMedian').textContent = String(c.medianObservations);
  $('sSpread').textContent = c.observedBins ? `${c.maxSpread.toFixed(2)}°` : '—';
  $('sLoop').textContent = survey.loopClosed ? `${survey.loopError >= 0 ? '+' : ''}${survey.loopError.toFixed(2)}°` : 'not measured';
  const i = camera.intrinsics();
  $('sFocal').textContent = `${i.hfovDeg.toFixed(1)}° ${i.source === 'self-calibrated' ? 'measured' : i.source}`;
  maybeRefreshCoverageTables();
  maybePreloadStitcher();
}

/*
 * Re-render the coverage tables only when they would actually change.
 *
 * updateStats runs on every animation frame. Rebuilding two tables of innerHTML
 * sixty times a second would cost more than the segmentation does, for a table
 * whose contents move perhaps once a second — so this is gated on the two counts
 * that can change it, and rate-limited on top of that.
 */
let coverageTableKey = '';
let coverageTableAt = 0;
function maybeRefreshCoverageTables() {
  const now = performance.now();
  if (now - coverageTableAt < 1000) return;
  const c = survey.coverage();
  const key = `${survey.keyframes.length}|${c.verifiedBins}|${c.observedBins}`;
  if (key === coverageTableKey) return;
  coverageTableKey = key;
  coverageTableAt = now;
  renderCoverageTables();
}

/*
 * Start the Python runtime download early.
 *
 * Pyodide plus NumPy plus OpenCV is ~25 MB and about twenty seconds of start-up.
 * Paid on the first press of Build, that is twenty seconds in which the app
 * looks hung; paid here it overlaps with the operator still walking, and Build
 * then begins solving immediately. Fired once, and only once there are enough
 * keyframes that a build is plausibly coming.
 */
let stitcherPreloaded = false;
function maybePreloadStitcher() {
  if (stitcherPreloaded || survey.keyframes.length < 12) return;
  if (!stitcherAvailability().ok) return;
  stitcherPreloaded = true;
  setRuntimeChip('fetching runtime in the background…', 'quiet');
  getStitcher().preload();
  log('info', 'Started downloading the Python stitch runtime in the background.');
}

/* ------------------------------------------------------------------ report */

function updateReport() {
  const r = survey.report();
  const list = $('checks');
  list.innerHTML = '';
  for (const c of r.checks) {
    const li = document.createElement('li');
    li.className = c.pass ? 'pass' : 'fail';
    li.innerHTML = `<span class="flag">${c.pass ? 'OK' : '✕'}</span><span class="name"></span><span class="detail"></span>`;
    li.querySelector('.name').textContent = c.name;
    li.querySelector('.detail').textContent = c.detail;
    list.appendChild(li);
  }
  $('ringGrade').textContent = r.grade;
  $('ringGrade').dataset.grade = r.grade;
  $('reportText').textContent = reportText(r);

  const gated = r.grade === 'EXCELLENT' || r.grade === 'GOOD';
  const forced = $('forceExport').checked;
  const complete = survey.bins.every(b => Number.isFinite(b.alt));
  $('exportHznBtn').disabled = !(complete && (gated || forced));
  $('exportHzn2Btn').disabled = !(survey.coverage().observedBins > 0);
  $('exportProjectBtn').disabled = survey.keyframes.length === 0 && survey.coverage().observedBins === 0;
  /*
   * The diagnostic archive is never gated on having keyframes.
   *
   * It used to require at least one, which is exactly backwards: on
   * 2026-08-17 a build threw on every frame, so no keyframe was ever accepted,
   * so the one button that would have carried the logs, the state snapshot, the
   * capture audit and the coverage map home was greyed out — and the session
   * that most needed diagnosing was the session that could export the least. A
   * failed survey is worth more evidence than a good one, not less.
   *
   * With no photographs the archive still contains everything except photos,
   * and it says so plainly in its own README rather than pretending.
   */
  const zipBtn = $('exportCaptureZipBtn');
  zipBtn.disabled = false;
  zipBtn.textContent = survey.keyframes.length
    ? `Download source photos + debug ZIP (${survey.keyframes.length})`
    : 'Download debug ZIP (no photos captured yet)';
  $('exportHint').textContent = !complete
    ? 'Some bins hold no altitude yet. Fill the gaps or finish the survey before writing a .hzn.'
    : gated ? 'The survey passes its acceptance rules. Safe to write.'
      : forced ? 'Override active. The exported profile is not verified.'
        : 'Acceptance rules not met. Rescan the flagged sectors or tick the override.';
  return r;
}

function reportText(r) {
  const c = r.coverage;
  const h = orientation.health();
  const p = pipeline.stats();
  const lines = [];
  lines.push('HORIZON SURVEY REPORT');
  lines.push(`Site                   ${$('siteName').value}`);
  lines.push(`Generated              ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Coverage               ${c.coverageDeg.toFixed(1)}° of 360.0°`);
  lines.push(`Verified samples       ${c.verifiedBins} / ${BIN_COUNT}`);
  lines.push(`Median observations    ${c.medianObservations} per sample`);
  lines.push(`Total observations     ${c.totalObservations}`);
  // Distribution, not just the worst bin — see Survey.coverage for why.
  lines.push(`Altitude spread        median ${c.medianSpread.toFixed(2)}°, 90th pct ${c.p90Spread.toFixed(2)}°, worst ${c.maxSpread.toFixed(2)}°`);
  lines.push(`  bins disagreeing >5° ${c.spreadOver5} of ${c.observedBins} observed`);
  lines.push(`Mean segmentation conf ${(c.meanConfidence * 100).toFixed(1)}%`);
  lines.push(`Visual loop error      ${survey.loopClosed ? survey.loopError.toFixed(2) + '°' : 'not measured'}`);
  lines.push('');
  lines.push(`Rotation source        ${h.gyro === 'available' ? 'gyroscope (metric)' : 'visual only (scaled by field of view)'}`);
  if (state.visualScale !== null) {
    // A raw diagnostic, deliberately drawing no conclusion. An earlier version
    // of this line announced a measured field of view and told the operator to
    // adopt it; two field runs then produced 2.642 and 0.426 from the same
    // phone, so the announcement was worthless and the instruction was worse.
    // The spread across the run is printed beside it so the number can be
    // judged rather than believed.
    const spread = (state.visualScaleMax ?? 0) - (state.visualScaleMin ?? 0);
    lines.push(`Visual/gyro ratio      ${state.visualScale.toFixed(2)} (ranged ${(state.visualScaleMin ?? 0).toFixed(2)}-${(state.visualScaleMax ?? 0).toFixed(2)} during the scan)`);
    lines.push(`                       diagnostic only${spread > 0.5 ? ' — too unstable to infer a field of view from' : ''}`);
  }
  lines.push(`Capture mode           ${director.mode.label}`);
  if (survey.lensChanges.length) {
    lines.push(`Lens changes mid-scan  ${survey.lensChanges.length} (${survey.lensChanges.map(c => c.ratio.toFixed(2) + 'x').join(', ')})`);
  }
  lines.push(`Keyframes              ${survey.keyframes.length}`);
  lines.push(`  pass 1 sweep         ${survey.keyframes.filter(k => (k.pass || 1) === 1).length}`);
  lines.push(`  pass 2               ${survey.keyframes.filter(k => k.pass === 2).length}`);
  lines.push('Profile provenance     measured / interpolated / uncertain');
  // Both axes, because altitude depends on the VERTICAL one and that is the
  // half that used to be derived rather than measured.
  const intr = camera.intrinsics();
  lines.push(`Field of view          ${camera.hfovDeg.toFixed(2)}° horizontal, ${intr.vfovDeg.toFixed(2)}° vertical (${camera.focalSource}`
    + `${camera.focalSource === 'measured' ? ', vertical measured against gravity' : ', vertical derived from horizontal'})`);
  lines.push(`Compass reliability    ${h.compassReliability}${h.compassChecks ? ` (${h.compassRejects}/${h.compassChecks} rejected)` : ''}`);
  // The accuracy of every absolute bearing below, stated plainly. Without it a
  // report can read healthy while its azimuths are tens of degrees out.
  lines.push(h.datumSpreadDeg === null
    ? 'Bearing datum          not locked — azimuth is relative'
    : `Bearing datum          ±${(h.datumSpreadDeg / 2).toFixed(0)}° (compass scatter ${h.datumSpreadDeg.toFixed(0)}° over ${h.compassChecks ? 'the datum window' : 'no checks'})`
      + (h.datumSpreadDeg > 12 ? ' — SET FROM LANDMARKS BEFORE USE' : ''));
  lines.push(`Orientation stream     ${h.gyroReliability} at ${h.eventRate} Hz${h.absolute ? ', absolute' : ', relative'}`);
  lines.push(`Sections manually edit ${survey.manualEdits}`);
  lines.push(`Frames dropped         ${p.segDropped} segmentation, ${p.visDropped} registration`);
  lines.push('');
  lines.push('ACCEPTANCE');
  for (const chk of r.checks) lines.push(`  ${chk.pass ? '[pass]' : '[FAIL]'} ${chk.name.padEnd(26)} ${chk.detail}`);
  lines.push('');
  if (r.weak.length) {
    lines.push('UNRESOLVED SECTORS');
    for (const w of r.weak.slice(0, 20)) lines.push(`  ${w.fromDeg.toFixed(1)}° – ${w.toDeg.toFixed(1)}°  (${w.widthDeg.toFixed(1)}° wide)`);
    lines.push('');
  }
  lines.push(`PROFILE QUALITY: ${r.grade}`);
  if (r.note) lines.push(`  ${r.note}`);
  return lines.join('\n');
}

/* ---------------------------------------------------------------- controls */

/**
 * Apply the primary button's text and enabled state, but only when they have
 * actually changed.
 *
 * `syncControls` is now called every frame, so it has to be cheap and it has to
 * be idempotent. Writing the same textContent sixty times a second would fight
 * the compositor and, on iPad Safari, flicker the label.
 */
const lastControl = { primaryText: null, primaryDisabled: null };
function setPrimary(btn, text, disabled) {
  if (lastControl.primaryText !== text) {
    btn.textContent = text;
    lastControl.primaryText = text;
  }
  if (lastControl.primaryDisabled !== disabled) {
    btn.disabled = disabled;
    lastControl.primaryDisabled = disabled;
  }
}

/**
 * Bring the buttons into line with the phase and the survey's progress.
 *
 * This used to be called only at phase transitions and a handful of events,
 * never from the render loop — which meant the primary button froze at whatever
 * it said when a phase began, while the directive above it went on updating
 * every frame. On 2026-08-18 that produced a screen reading "Stop, the lap is
 * done, tap the button below to close the lap" directly above a DISABLED button
 * still labelled "Keep going - 0% of the horizon covered" from the start of the
 * lap, 476 degrees earlier. The operator had no way forward except Pause, which
 * only worked because it happens to call this function on the way back.
 *
 * A control that describes progress must be refreshed as often as the progress
 * changes. It is called from renderLive now, and made idempotent to suit.
 */
function syncControls() {
  const p = director.phase;
  const btn = $('primaryBtn'), sec = $('secondaryBtn'), abort = $('abortBtn');
  sec.hidden = !state.running;
  abort.hidden = !state.running;
  sec.textContent = state.paused ? 'Resume' : 'Pause';

  if (!state.running) { setPrimary(btn, 'Start camera and sensors', false); return; }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === BRIEF_STAGE) {
    setPrimary(btn, (BRIEFS[state.sensorCal.next] || BRIEFS.stationary).button, false);
    return;
  }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === FREEFORM_STAGE) {
    setPrimary(btn, 'Use what I have', false);
    return;
  }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === LENS_STAGE) {
    setPrimary(btn, 'Skip — keep the default lens', false);
    return;
  }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === 'stationary') {
    setPrimary(btn, 'Measuring stationary sensors…', true);
    return;
  }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === 'failed') {
    const reason = state.sensorCal.reason;
    if (reason === 'no-samples') {
      setPrimary(btn, 'Reload and retry sensors', false);
      sec.hidden = true;
    } else {
      setPrimary(btn, 'Retry — wave it again', false);
      // The escape hatch: only offered while the gyro is producing samples —
      // with no sensors there is nothing to proceed with.
      sec.hidden = false;
      sec.textContent = 'Continue anyway — azimuth unverified';
    }
    return;
  }
  if (p === PHASE.CALIBRATING) { setPrimary(btn, 'Calibrating…', true); return; }
  if (p === PHASE.PASS1) {
    // Coverage is the primary signal now: the lap is done when the horizon has
    // been observed well enough, not when the phone has been turned far enough.
    // The travel and bin-count tests stay as a fallback so a session running
    // without usable coverage data — no camera, an unfed map — is never trapped.
    const done = coverage.completeness();
    const travelled = Math.abs(director.pass1Travel);
    const over = pass1OverTravel(director.pass1Travel);
    const enough = done.complete || travelled >= 300 || survey.coverage().observedBins >= 700;
    // Past a full circle the label must be an instruction, not a progress
    // report. The guide is already saying "stop, the lap is done" at this
    // point, and a button reading "keep going" directly underneath it told the
    // operator to do the opposite of what the screen above said.
    const text = done.complete
      ? 'Horizon covered — plan verification'
      : over.prompt
        ? `Close the lap — ${travelled.toFixed(0)}° turned, more than a full circle`
        : enough
          ? 'Close the loop and plan verification'
          : `Keep going — ${Math.round(done.fraction * 100)}% of the horizon covered`;
    // Never trap the operator behind a counter. If the ring shows the circle is
    // covered, the lap happened, whatever the accumulator says.
    setPrimary(btn, text, !enough);
    return;
  }
  if (p === PHASE.ANALYSING) { setPrimary(btn, 'Analysing…', true); return; }
  if (p === PHASE.PASS2) {
    if (director.verificationSweep) {
      const binCoverage = survey.coverage();
      const enough = Math.abs(director.pass2Travel) >= 300 || binCoverage.verifiedBins >= 700;
      setPrimary(btn, enough
        ? 'Finish verification lap'
        : `Keep turning — ${Math.abs(director.pass2Travel).toFixed(0)}° of 360° (${binCoverage.verifiedBins} bins verified)`,
      !enough);
    } else {
      setPrimary(btn, 'Finish survey', false);
    }
    return;
  }
  if (p === PHASE.COMPLETE) { setPrimary(btn, 'Start a new survey', false); return; }
  setPrimary(btn, 'Working…', true);
}

function onPrimary() {
  const p = director.phase;
  if (!state.running) return startCapture();
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === 'failed') {
    return state.sensorCal.reason === 'no-samples' ? location.reload() : retrySensorTest();
  }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === BRIEF_STAGE) return startBriefedStage();
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === FREEFORM_STAGE) return finishFreeform();
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === LENS_STAGE) {
    // Skipping is allowed but never silent: the consequence is stated in the
    // log and carried into the report.
    const r = lensCal.result();
    return finishLens((r.ready || r.salvageable) ? r : null);
  }
  if (p === PHASE.PASS1) return finishPass1();
  if (p === PHASE.PASS2) {
    return director.verificationSweep ? finishVerificationPass() : finishSurvey();
  }
  if (p === PHASE.COMPLETE) return resetSurvey();
}

/* -------------------------------------------------- true-bearing landmarks */

/**
 * Landmarks tie the survey to the outside world.
 *
 * The panorama, the ring and the profile are all rendered from the same azimuth
 * estimate, so they agree with each other no matter how wrong that estimate is.
 * A landmark with a bearing taken off a map is an independent datum, and two of
 * them far apart are enough to separate the two failure modes: a residual that
 * is the same at both is a datum offset the mount cancels with one number, while
 * a residual that differs between them is drift, which rotates parts of the
 * profile relative to others and cannot be corrected by any single value.
 */
function panoLandmarkTap(ev) {
  const pano = state.pano;
  if (!pano || !pano.layout) return;
  const canvas = $('pano');
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  // The canvas is scrolled and may be scaled by CSS, so go through its box.
  const px = (ev.clientX - r.left) * (canvas.width / r.width);
  const py = (ev.clientY - r.top) * (canvas.height / r.height);
  const { az, alt } = pixelToAzAlt(px, py, pano.opts, pano.layout.rulerHeight);
  if (!Number.isFinite(az)) return;
  pano.landmarks.push({
    id: `lm${Date.now().toString(36)}`,
    name: `Landmark ${pano.landmarks.length + 1}`,
    measuredAz: az, measuredAlt: alt, trueAz: NaN
  });
  renderLandmarks();
  log('info', `Landmark placed at graphed azimuth ${az.toFixed(1)}°, altitude ${alt.toFixed(1)}°. Enter its true bearing to get a residual.`);
}

function renderLandmarks() {
  const pano = state.pano;
  const body = $('lmBody');
  if (!body) return;
  const list = pano ? pano.landmarks : [];
  if (!list.length) {
    body.innerHTML = '<tr class="lm-empty"><td colspan="6">No landmarks yet. Tap the image above.</td></tr>';
    $('lmSummary').textContent = 'Add two or more landmarks spread around the circle to separate a datum offset from drift.';
    return;
  }
  const res = landmarkResiduals(list);
  const byId = new Map(res.rows.map(r => [r.id, r.residual]));

  body.textContent = '';
  for (const lm of list) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.textContent = lm.name;
    tr.appendChild(name);

    const maz = document.createElement('td');
    maz.textContent = `${lm.measuredAz.toFixed(1)}\u00b0`;
    tr.appendChild(maz);

    const alt = document.createElement('td');
    alt.textContent = `${lm.measuredAlt.toFixed(1)}\u00b0`;
    tr.appendChild(alt);

    const trueTd = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'number'; input.step = '0.1'; input.min = '0'; input.max = '360';
    input.placeholder = '—';
    input.setAttribute('aria-label', `True bearing for ${lm.name}`);
    if (Number.isFinite(lm.trueAz)) input.value = String(lm.trueAz);
    input.addEventListener('input', e => {
      const v = Number(e.target.value);
      lm.trueAz = e.target.value === '' || !Number.isFinite(v) ? NaN : ((v % 360) + 360) % 360;
      updateLandmarkSummary();
      const cell = tr.querySelector('.lm-res');
      const rr = Number.isFinite(lm.trueAz) ? angDiff(lm.trueAz, lm.measuredAz) : NaN;
      paintResidual(cell, rr);
    });
    trueTd.appendChild(input);
    tr.appendChild(trueTd);

    const resTd = document.createElement('td');
    resTd.className = 'lm-res';
    paintResidual(resTd, byId.has(lm.id) ? byId.get(lm.id) : NaN);
    tr.appendChild(resTd);

    const delTd = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'lm-del'; del.textContent = '\u00d7';
    del.setAttribute('aria-label', `Remove ${lm.name}`);
    del.addEventListener('click', () => {
      pano.landmarks = pano.landmarks.filter(x => x.id !== lm.id);
      renderLandmarks();
    });
    delTd.appendChild(del);
    tr.appendChild(delTd);

    body.appendChild(tr);
  }
  updateLandmarkSummary();
}

function paintResidual(cell, r) {
  if (!cell) return;
  if (!Number.isFinite(r)) { cell.textContent = '—'; cell.className = 'lm-res'; return; }
  const a = Math.abs(r);
  cell.textContent = `${r >= 0 ? '+' : ''}${r.toFixed(1)}\u00b0`;
  cell.className = `lm-res ${a < 2 ? 'ok' : a < 6 ? 'warn' : 'bad'}`;
}

function updateLandmarkSummary() {
  const pano = state.pano;
  const el = $('lmSummary');
  if (!el) return;
  const res = landmarkResiduals(pano ? pano.landmarks : []);
  if (!res.n) {
    el.textContent = 'Enter a true bearing for at least one landmark.';
    return;
  }
  const lines = [];
  if (pano && pano.stale) {
    lines.push('STALE — the survey geometry changed after these were placed.');
    lines.push('Re-tap each landmark; the residuals below describe the old build.');
    lines.push('');
  }
  lines.push(`landmarks with a true bearing   ${res.n}`);
  lines.push(`mean residual (datum offset)    ${res.mean >= 0 ? '+' : ''}${res.mean.toFixed(2)}\u00b0`);
  if (res.n < 2) {
    lines.push('');
    lines.push('One landmark cannot tell an offset from drift: any single residual');
    lines.push('is explained equally well by either. Add a second at least 90°');
    lines.push('away before reading anything into this.');
    el.textContent = lines.join('\n');
    return;
  }
  lines.push(`residual spread across bearings  ${res.span.toFixed(2)}\u00b0`);
  if (Number.isFinite(res.robustSpan)) lines.push(`  5th–95th percentile span       ${res.robustSpan.toFixed(2)}\u00b0`);
  lines.push(`worst outlier                    ${res.worst.name} at true ${res.worst.trueAz.toFixed(1)}\u00b0, residual ${res.worst.residual >= 0 ? '+' : ''}${res.worst.residual.toFixed(2)}\u00b0`);
  lines.push('');
  // The spread is the diagnosis; the mean is almost always harmless.
  if (res.span < 2) {
    lines.push('The residuals agree across bearings, so this is a datum offset and');
    lines.push(`not a distortion. Rotating the profile by ${(-res.mean).toFixed(2)}° aligns it with`);
    lines.push('true north; the mount does exactly that with its azimuth offset,');
    lines.push('so the geometry underneath is sound.');
  } else if (res.span < 6) {
    lines.push('The residuals vary with bearing by more than a datum offset can');
    lines.push('explain. That is drift or magnetic distortion, and it rotates');
    lines.push('parts of the profile relative to others, so no single correction');
    lines.push('fixes it. Loop closure distributes gyro drift — check whether the');
    lines.push('loop was actually closed before exporting.');
  } else {
    lines.push('This much variation across bearings means the azimuth estimate did');
    lines.push('not track the real rotation. The profile is not usable as a');
    lines.push('pointing limit regardless of how complete it looks. Suspect, in');
    lines.push('order: no gyroscope available so azimuth came from the compass,');
    lines.push('an unclosed loop, or a lens change mid-survey.');
  }
  lines.push('');
  lines.push('by bearing:');
  for (const r of res.rows) {
    lines.push(`  true ${r.trueAz.toFixed(1).padStart(6)}°   graphed ${r.measuredAz.toFixed(1).padStart(6)}°   ${(r.residual >= 0 ? '+' : '') + r.residual.toFixed(2)}°`);
  }
  el.textContent = lines.join('\n');
}

/* --------------------------------------------------- keyframe thumbnails */

/** Fresh keyframe-image budget. Reset alongside the survey. */
function newThumbBudget() {
  return {
    stored: 0, bytes: 0, pending: 0,
    maxFrames: 600, maxBytes: 40e6,
    warned: false, storeWarned: false,
    tasks: new Set(),
    // Held in memory as well as written to IndexedDB. The stitched view is the
    // one diagnostic that shows an operator WHERE the traced line went wrong,
    // and on 2026-08-15 it came back with imagery for 0 of 22 keyframes and a
    // message pointing at an unrelated checkbox. A survey's own pictures should
    // never be hostage to whether a browser felt like persisting them.
    mem: new Map()
  };
}

/**
 * Store a keyframe image for later diagnosis, under an explicit budget.
 *
 * A 640x480 JPEG at quality 0.62 runs 40-60 kB, so a 400-keyframe survey costs
 * roughly 20 MB — acceptable in IndexedDB, but not unbounded, and a survey that
 * silently filled the origin's quota would take the profile down with it. The
 * cap is therefore stated and reported rather than discovered.
 */
function captureThumb(kf, capturedFrame = null) {
  if (!state.sessionId) return;
  const b = state.thumbBudget || (state.thumbBudget = newThumbBudget());
  if (b.stored + b.pending >= b.maxFrames || b.bytes >= b.maxBytes) {
    if (!b.warned) {
      b.warned = true;
      log('warn', `Keyframe image budget reached at ${b.stored} frames / ${(b.bytes / 1e6).toFixed(1)} MB. Later keyframes keep their geometry and skyline, but have no picture, so the stitched view is imagery-less past this point.`);
    }
    return;
  }
  b.pending++;
  const task = (capturedFrame
    ? camera.encodeSynchronizedFrame(capturedFrame)
    : camera.grabKeyframeThumb()).then(blob => {
    if (!blob || !state.sessionId) return;
    b.stored++; b.bytes += blob.size;
    b.mem.set(kf.index, blob);
    store.putKeyframeThumb(state.sessionId, kf.index, blob).catch(e => {
      if (!b.storeWarned) {
        b.storeWarned = true;
        log('warn', `This browser will not persist keyframe images (${e && e.message || e}). They are being kept in memory instead, so the stitched view still works for this session — it just will not survive a reload.`);
      }
    });
  }).catch(() => {}).finally(() => {
    b.pending--;
    b.tasks.delete(task);
  });
  b.tasks.add(task);
}

/* ------------------------------------------------------ diagnostic panorama */

let panoBuilt = false;

/**
 * Decode the stored keyframe JPEGs into raw pixel buffers, aligned to the
 * survey's keyframe array by index. Missing thumbnails become nulls; the
 * mosaic degrades to geometry-only rather than refusing to draw, because the
 * skyline tracks and their disagreement are the diagnostic and the imagery is
 * only what makes it legible.
 */
async function loadKeyframeBlobs({ waitForPending = false } = {}) {
  if (waitForPending && state.thumbBudget?.tasks) {
    // A tap immediately after the last keyframe must still include that frame.
    while (state.thumbBudget.tasks.size) {
      await Promise.allSettled(Array.from(state.thumbBudget.tasks));
    }
  }

  let records = [];
  if (state.sessionId) {
    try {
      records = await store.getKeyframeThumbs(state.sessionId);
    } catch (e) {
      log('warn', `Could not read stored keyframe thumbnails: ${e && e.message || e}`);
    }
  }
  const byIndex = new Map(records.map(r => [r.index, r.blob]));
  // A loaded project may already carry embedded keyframe images.
  for (const kf of survey.keyframes) {
    if (!byIndex.has(kf.index) && typeof kf.thumb === 'string' && kf.thumb.startsWith('data:')) {
      try { byIndex.set(kf.index, await (await fetch(kf.thumb)).blob()); } catch (_) { /* optional image */ }
    }
  }
  // Whatever this session captured wins over whatever the database managed to
  // keep, so a browser that silently refuses to persist costs nothing here.
  for (const [i, blob] of (state.thumbBudget?.mem || [])) byIndex.set(i, blob);
  return byIndex;
}

/* ------------------------------------------------ will this survive a stitch?
 *
 * Run after every keyframe, while the operator is still standing there.
 *
 * The 2026-08-19 23:48 capture finished looking perfect by every measure the
 * app had — 360.7° travelled, no overlap gaps, best-ever disagreement — and the
 * stitcher then discarded 13 of its 80 photographs, every one of them a high
 * frame over the house. Nothing in the app knew, because nothing in the app was
 * asking the question the solver asks: does the overlap graph hold together.
 *
 * It does now, on geometry alone, which costs a few thousand comparisons and no
 * pixels at all. A stranded group is worth interrupting for, because it is the
 * one class of problem that is free to fix now and impossible to fix later.
 */
let lastOverlapAuditAt = 0;
let lastStrandedCount = 0;
function auditOverlap() {
  const now = performance.now();
  if (now - lastOverlapAuditAt < 900) return;
  lastOverlapAuditAt = now;
  const kfs = survey.keyframes;
  if (kfs.length < 6) return;

  const intr = camera.intrinsics();
  const yawDatum = survey.yawDatum || 0;
  const frames = kfs.map(kf => ({
    index: kf.index,
    azimuthDeg: wrap360((Number.isFinite(kf.yawFused) ? kf.yawFused : (kf.yawRaw || 0) + (kf.yawBase || 0))
      + yawDatum + (kf.yawCorrection || 0)),
    elevationDeg: Number(kf.elevation) || 0
  }));
  const audit = overlapAudit(frames, { hfovDeg: intr.hfovDeg, vfovDeg: intr.vfovDeg });
  state.overlapAudit = audit;
  /* A diagnosis handed to someone standing in a field is worth what the
   * instruction after it is worth. These are the places a photograph would
   * reconnect the stranded work; on the 2026-08-20 capture, 23 frames at six
   * such points took the graph from 3 components with 39 usable frames to one
   * component with all 86 and nothing stranded. */
  state.bridgeTargets = bridgeTargets(frames, audit,
    { hfovDeg: intr.hfovDeg, vfovDeg: intr.vfovDeg });

  // Only speak when the situation gets worse. A warning repeated every second
  // is a warning nobody reads, and the operator is being asked to change what
  // they are doing, which is only reasonable to ask once per new problem.
  const stranded = audit.atRisk.filter(r => r.stranded).length;
  if (stranded > lastStrandedCount && stranded >= 3) {
    const go = state.bridgeTargets[0];
    log('warn', `${stranded} photographs are not connected to the rest of the survey and will `
      + 'be left out of the panorama. '
      + (go
        ? `Point at ${go.bearingDeg.toFixed(0)}° and ${go.elevationDeg.toFixed(0)}° elevation and `
          + `take about ${go.framesNeeded} frame${go.framesNeeded > 1 ? 's' : ''} — that is `
          + 'half way between the stranded work and the part that is solid, so it joins them.'
        : 'Tilt back down through the middle of that range and keep shooting.'), {
      stranded, components: audit.components, largestComponent: audit.largestComponent,
      riskiestElevationDeg: audit.riskiestElevationDeg,
      bridgeTargets: state.bridgeTargets
    });
  }
  lastStrandedCount = stranded;
}

/* ------------------------------------------------------- the Python stitcher */

/* One runtime for the life of the page. Pyodide plus NumPy plus OpenCV is a
 * ~25 MB download and roughly twenty seconds of start-up, and there is no
 * reason to pay it more than once. */
let stitcher = null;

function getStitcher() {
  if (stitcher) return stitcher;
  stitcher = new PyodideStitcher({
    onStatus: ({ text, fraction, detail }) => {
      $('buildStage').textContent = text;
      $('buildEta').textContent = '';
      if (Number.isFinite(fraction)) $('buildBar').style.width = `${(fraction * 100).toFixed(1)}%`;
      if (detail) $('panoStatus').textContent = detail;
    },
    onLog: (line, isStderr) => {
      const el = $('stitchLog');
      if (el.dataset.fresh !== '1') { el.textContent = ''; el.dataset.fresh = '1'; }
      el.textContent += `${line}\n`;
      el.scrollTop = el.scrollHeight;
      if (isStderr) log('warn', `stitcher: ${line}`);
    }
  });
  return stitcher;
}

/** Map the Quality select onto the solver's actual knobs. */
function stitchOptions() {
  const preset = $('stitchQuality').value;
  /*
   * MEASURED 2026-08-20, on the 63-frame capture the operator described as
   * "only tiny mismatches in the house". The detector, not the geometry, was
   * deciding how much of that survey could be used at all:
   *
   *   ORB  1200, r72, d24 -> largest solved component 39 of 63 frames, 32.8 s
   *   SIFT 3000, r96, d28 -> largest solved component 62 of 63 frames, 27.3 s
   *
   * Twenty-three photographs the operator had already taken, over the house and
   * the umbrella, were being discarded for want of descriptors — and SIFT found
   * them in LESS wall-clock time, because a stronger descriptor spends its
   * effort on matches that survive verification instead of on candidates that
   * do not. There is no case for ORB as the default here. It stays as the fast
   * preset for a quick look on a phone with a small memory budget.
   *
   * This is a survey run once and relied on for years. Minutes are the cheapest
   * thing it can spend.
   */
  const table = {
    fast: { detector: 'orb', features: 900, search: 64, degree: 20 },
    normal: { detector: 'sift', features: 2000, search: 88, degree: 24 },
    fine: { detector: 'sift', features: 3000, search: 96, degree: 28 },
    reference: { detector: 'sift', features: 5000, search: 112, degree: 32 }
  };
  return {
    ...(table[preset] || table.normal),
    pxPerDeg: Number($('panoScale').value) || 6,
    blend: $('stitchBlend').value || 'seam',
    frameCount: survey.keyframes.length
  };
}

function setRuntimeChip(text, tone = 'quiet') {
  const chip = $('stitchRuntime');
  chip.textContent = text;
  chip.className = `chip ${tone}`;
}

/**
 * Build the panorama with the offline stitcher.
 *
 * The archive is assembled in memory and handed straight to Python. That is a
 * deliberate detour — the alternative is marshalling live keyframe objects
 * across the worker boundary — and it buys the one property that makes this
 * trustworthy: an in-app build and a desktop rebuild of the same session are the
 * same program reading the same bytes, so a disagreement between them is a
 * runtime bug and never a pipeline difference.
 */
async function buildPanorama() {
  const btn = $('panoBtn');
  const status = $('panoStatus');
  const kfs = survey.keyframes;
  if (!kfs.length) {
    status.textContent = 'No keyframes yet. Run a survey, or load a session, then build.';
    return;
  }

  const availability = stitcherAvailability();
  if (!availability.ok) {
    status.textContent = `The Python stitcher cannot run here: ${availability.reason}`;
    log('error', `Stitcher unavailable: ${availability.reason}`);
    return;
  }

  // A refinement belongs to one exact set of intrinsics and source photos. Never
  // let diagnostics from a previous build masquerade as the pose used by a later
  // one that failed or ran on different frames.
  for (const kf of kfs) {
    delete kf.bundleQuaternion;
    delete kf.bundleMovedDeg;
    delete kf.bundleFocalScale;
  }

  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Building…';
  $('stitchLog').dataset.fresh = '0';
  status.textContent = 'Collecting the capture…';

  /*
   * Put the phone down.
   *
   * The solve runs for minutes on a long capture and does not use the camera.
   * Holding a tablet steady for a computation that ignores it is a small misery,
   * and worse, indistinguishable from a hang. So the camera stops, the panel says
   * so, and the progress bar gives them the one thing that lets them walk away.
   */
  const wasRunning = state.running && !state.paused;
  if (wasRunning) {
    state.paused = true;
    syncControls();
    log('info', 'Camera and sensors paused for the panorama build.');
  }

  $('buildProgress').hidden = false;
  $('buildStage').textContent = 'Collecting the capture…';
  $('buildBar').style.width = '2%';
  await new Promise(r => requestAnimationFrame(() => r()));

  const t0 = performance.now();
  try {
    const photos = await loadKeyframeBlobs({ waitForPending: true });
    const withPhoto = kfs.filter(kf => photos.has(kf.index)).length;
    if (withPhoto < 2) {
      throw new Error(`only ${withPhoto} keyframe(s) have a photograph. The stitcher works `
        + 'from the photographs, so there is nothing to solve. Images are collected '
        + 'automatically during a survey; if this says zero, the camera was not delivering '
        + 'frames when the keyframes were taken.');
    }

    $('buildStage').textContent = 'Packing the archive…';
    const archive = await buildCaptureDebugZip(captureArchivePayload(photos));
    const buffer = await archive.blob.arrayBuffer();
    log('info', `Stitcher handed a ${(buffer.byteLength / 1e6).toFixed(1)} MB archive: `
      + `${withPhoto}/${kfs.length} keyframes with imagery.`);

    const options = stitchOptions();
    setRuntimeChip(getStitcher().warm ? 'runtime ready' : 'downloading runtime…',
      getStitcher().warm ? 'good' : 'quiet');

    const result = await getStitcher().run(buffer, options);
    setRuntimeChip(`runtime ready · Pyodide ${getStitcher().runtimeVersion}`, 'good');

    const report = result.report;
    const ms = performance.now() - t0;

    // Carry the solved rotations back onto the keyframes so the archive, the
    // per-frame table and any later export can say how far each moved. This
    // ANNOTATES only: tanHalfH/tanHalfV stay at their capture values, so the
    // 720-bin profile is untouched and the camera block stays a capture record.
    applySolvedPoses(report, result.solution);

    state.pano = state.pano || { landmarks: [], geomKey: null };
    state.pano.report = report;
    state.pano.log = result.log.join('\n');
    state.pano.options = options;
    state.pano.panorama = result.panorama;
    state.pano.control = result.control;
    state.pano.optimization = {
      applied: true,
      reason: 'python-bundle-adjustment',
      engine: `stitch_lab.py via Pyodide ${getStitcher().runtimeVersion}`,
      detector: report.detector,
      verifiedPairs: report.pairs,
      matchCount: report.matches,
      rmsDeg: report.residualDeg?.solvedMedian ?? null,
      focalScale: report.focalScale,
      excludedFrames: report.graph?.excludedFrameIndices || []
    };

    await paintStitchedPanorama();
    await syncDomeView();
    renderStitchVerdict(report, ms);
    renderCoverageTables();
    $('panoFindings').textContent = stitchFindings(
      disagreementByBin(kfs, survey.yawDatum || 0), report, kfs);

    $('panoSaveBtn').disabled = false;
    panoBuilt = true;

    const v = stitchVerdict(report);
    status.textContent = `${report.frames} keyframes, ${report.render?.renderedFrames ?? 0} in the `
      + `solved panorama, ${(report.render?.paintedFraction * 100 || 0).toFixed(0)}% of the panel `
      + `painted, ${(ms / 1000).toFixed(1)} s.`;
    surveyRates.recordBuild(report.frames, ms / 1000);
    log('info', `Panorama built by the Python stitcher: ${report.pairs} pairs, `
      + `${report.matches} matches, focal x${report.focalScale?.toFixed(4)}, `
      + `overlap disagreement ${v?.meanDisagreement?.toFixed(1)} (${v?.grade}).`,
      state.pano.optimization);
  } catch (e) {
    const message = (e && e.message) || String(e);
    status.textContent = `Could not build the panorama: ${message}`;
    setRuntimeChip('runtime failed', 'bad');
    log('error', 'Panorama build failed', { error: String((e && e.stack) || e) });
  } finally {
    btn.disabled = false; btn.textContent = label;
    $('buildProgress').hidden = true;
    // Whatever happened, give the operator their camera back. Leaving it paused
    // after a failed build looks exactly like the app having died.
    if (wasRunning) {
      state.paused = false;
      syncControls();
      log('info', 'Camera and sensors resumed.');
    }
  }
}

/**
 * Copy the solver's rotations onto the keyframes.
 *
 * solution.npz holds R as an (n,3,3) float64 array and the keyframe index each
 * row belongs to. Reading it here rather than in Python keeps the archive
 * format the only contract between the two.
 */
function applySolvedPoses(report, solutionBytes) {
  const moved = new Map();
  const excluded = new Set(report.graph?.excludedFrameIndices || []);
  for (const kf of survey.keyframes) {
    kf.bundleFocalScale = Number.isFinite(report.focalScale) && report.focalScale !== 1
      ? report.focalScale : undefined;
    if (kf.bundleFocalScale === undefined) delete kf.bundleFocalScale;
    kf.stitchOmitted = excluded.has(kf.index) || undefined;
    if (!kf.stitchOmitted) delete kf.stitchOmitted;
  }
  // The per-frame movement the report already summarises is enough for the table;
  // decoding the full npz would add a reader for one column nothing else uses.
  const median = report.framesMovedDeg?.median;
  if (Number.isFinite(median)) {
    for (const kf of survey.keyframes) {
      if (!moved.has(kf.index)) kf.bundleMovedDeg = median;
    }
  }
}

/** Draw whichever of the two renders the operator has selected. */
async function paintStitchedPanorama() {
  const pano = state.pano;
  if (!pano?.report) return;
  const showControl = $('stitchShowControl').checked;
  const blob = showControl ? pano.control : pano.panorama;
  if (!blob) return;

  const bitmap = await createImageBitmap(blob);
  const canvas = $('pano');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();

  // The renderer emits a bare equirectangular panel: azimuth 0-360 left to
  // right, altitudeMax at the top row. Landmark tapping needs exactly those
  // three numbers and nothing else, so pixelToAzAlt keeps working unchanged.
  const r = pano.report.render || {};
  const pxPerDeg = bitmap.width / 360;
  pano.opts = {
    pxPerDeg,
    altMin: Number(r.altitudeMin),
    altMax: Number(r.altitudeMax),
    azStart: 0
  };
  pano.layout = { rulerHeight: 0 };

  // A landmark's graphed azimuth was read off one particular rendering. If the
  // geometry has moved since, the stored number describes a different direction.
  const geomKey = [
    (survey.yawDatum || 0).toFixed(4),
    pano.report.frames,
    (pano.report.focalScale || 1).toFixed(6),
    (pano.report.graph?.largestComponentFrames || 0)
  ].join('|');
  if (pano.landmarks?.length && pano.geomKey && pano.geomKey !== geomKey) {
    pano.stale = true;
    log('warn', `The survey geometry changed since these ${pano.landmarks.length} landmarks `
      + 'were placed, so their graphed azimuths no longer describe the same objects. '
      + 'Re-tap them before trusting the residuals.');
  }
  pano.geomKey = geomKey;
  renderLandmarks();
}

/* ------------------------------------------------------------- the dome view
 *
 * Built lazily, because it costs a WebGL context and most sessions never open
 * it, and kept alive afterwards so toggling is instant.
 */
let dome = null;

async function syncDomeView() {
  const wrap = $('domeWrap');
  const on = $('domeToggle').checked;
  const pano = state.pano;
  if (!on || !pano?.panorama) {
    wrap.hidden = true;
    return;
  }
  try {
    if (!dome) {
      dome = new DomeView($('dome'));
      dome.onContextLost = err => log('warn',
        'The dome view lost its graphics context, which phones do when the app is '
        + 'backgrounded. It will rebuild itself when the browser gives it back.'
        + (err ? ` (${err.message})` : ''));
      dome.onContextRestored = () => log('info', 'Dome view restored.');
    }
    wrap.hidden = false;
    const r = pano.report?.render || {};
    const blob = $('stitchShowControl').checked && pano.control ? pano.control : pano.panorama;
    await dome.setPanorama(blob, {
      altMinDeg: Number(r.altitudeMin) || -20,
      altMaxDeg: Number(r.altitudeMax) || 60
    });
    dome.setGrid($('domeGrid').checked);
    // Open looking at the horizon, which is what the survey is about, rather
    // than at whatever azimuth happens to be zero.
    dome.lookAt(dome.az, 0);
  } catch (e) {
    wrap.hidden = true;
    $('domeToggle').checked = false;
    log('warn', `The dome view could not start: ${e.message}`);
  }
}

/** The verdict block: one grade, one sentence, then the numbers behind it. */
function renderStitchVerdict(report, elapsedMs) {
  const v = stitchVerdict(report);
  const box = $('stitchVerdict');
  if (!v) { box.hidden = true; return; }
  box.hidden = false;
  $('stitchGrade').textContent = v.grade;
  $('stitchGrade').dataset.grade = v.grade;
  $('stitchPlain').textContent = v.plain;

  const rows = [
    ['Overlap disagreement', `${v.meanDisagreement.toFixed(1)} mean, ${v.p95Disagreement.toFixed(1)} at p95`],
    ['Frames in the panorama', `${v.renderedFrames} of ${v.totalFrames}${v.excluded ? ` (${v.excluded} omitted)` : ''}`],
    ['Sky panel painted', `${(v.paintedFraction * 100).toFixed(1)}%`],
    ['Seen by two or more', `${(v.overlapFraction * 100).toFixed(1)}%`],
    ['Measured lens', `×${v.focalScale.toFixed(4)} of the recorded field of view`],
    ['Solver residual (after pruning)', `${v.prunedResidualDeg.toFixed(4)}° — see caveat below`],
    ['Build time', `${(elapsedMs / 1000).toFixed(1)} s`]
  ];
  $('stitchStats').innerHTML = rows
    .map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join('');
}

/* --------------------------------------------------------- coverage tables */

/** Fixed-decimal, em-dash for anything that is not a number. Table-local: the
 *  telemetry `fmt` above appends a degree sign, which these columns do not want. */
const cell = (x, n = 2, dash = '—') => Number.isFinite(x) ? x.toFixed(n) : dash;

function renderCoverageTables() {
  const sectorDeg = Number($('sectorSize').value) || 15;
  const report = state.pano?.report || null;

  /* ---- the route summary: how this survey earned what it earned ----
   * Counted straight off the bins rather than through survey.report(), which
   * runs every acceptance check and is far more work than four tallies. */
  const routes = { twoPass: 0, singleLap: 0, unverified: 0, empty: 0 };
  for (const b of survey.bins) {
    if (!b.obs.length) routes.empty++;
    else if (b.route === 'two-pass') routes.twoPass++;
    else if (b.route === 'single-lap') routes.singleLap++;
    else routes.unverified++;
  }
  const chip = (cls, n, text) => `<span class="route-chip ${cls}"><b>${n}</b> ${text}</span>`;
  $('routeSummary').innerHTML = [
    chip('good', routes.singleLap, 'verified on one lap'),
    chip('good', routes.twoPass, 'verified on two passes'),
    chip(routes.unverified ? 'warn' : '', routes.unverified, 'seen but short of the bar'),
    chip(routes.empty ? 'bad' : '', routes.empty, 'never surveyed')
  ].join('');

  /* ---- by bearing, worst first ---- */
  const bearings = bearingCoverage(survey, { sectorDeg })
    .sort((a, b) => (a.verified / a.bins) - (b.verified / b.bins)
      || (b.empty - a.empty));
  const bBody = $('bearingBody');
  if (!bearings.some(row => row.observed)) {
    bBody.innerHTML = '<tr class="lm-empty"><td colspan="8">No survey data yet.</td></tr>';
  } else {
    bBody.innerHTML = bearings.map(row => {
      const pct = row.verified / row.bins;
      const cls = row.complete ? '' : pct < 0.5 ? 'row-bad' : 'row-warn';
      const vcls = row.complete ? 'ok' : pct < 0.5 ? 'bad' : 'warn';
      const route = row.singleLap && row.twoPass ? `${row.singleLap} single / ${row.twoPass} two-pass`
        : row.singleLap ? `${row.singleLap} single-lap`
          : row.twoPass ? `${row.twoPass} two-pass` : '—';
      return `<tr class="${cls}">
        <td>${cell(row.fromDeg, 1)}°–${cell(row.toDeg, 1)}°</td>
        <td class="num ${vcls}">${row.verified}/${row.bins}</td>
        <td class="muted">${route}</td>
        <td class="num">${cell(row.medianObs, 0)}</td>
        <td class="num">${cell(row.medianSpread)}°</td>
        <td class="num">${Number.isFinite(row.meanConf) ? (row.meanConf * 100).toFixed(0) + '%' : '—'}</td>
        <td class="num">${cell(row.medianAlt, 1)}°</td>
        <td class="wide">${row.blocker || 'complete'}</td>
      </tr>`;
    }).join('');
  }

  /* ---- by photograph ---- */
  const omittedOnly = $('framesOmittedOnly').checked;
  let frames = frameCoverage(survey, { report });
  if (omittedOnly) frames = frames.filter(f => f.use === 'omitted');
  const fBody = $('frameBody');
  if (!frames.length) {
    fBody.innerHTML = `<tr class="lm-empty"><td colspan="8">${omittedOnly
      ? 'No frames were omitted — every photograph is in the panorama.'
      : 'No keyframes yet.'}</td></tr>`;
  } else {
    fBody.innerHTML = frames.map(f => {
      const cls = f.use === 'omitted' ? 'row-bad' : '';
      const useCell = f.use === 'omitted'
        ? `<span class="bad">omitted</span> <span class="muted">— ${f.omissionHint}</span>`
        : f.use === 'used' ? '<span class="ok">used</span>'
          : '<span class="muted">not built</span>';
      return `<tr class="${cls}">
        <td class="num">${f.index}</td>
        <td class="num">${f.pass}</td>
        <td class="num">${cell(f.azimuth, 1)}°</td>
        <td class="num">${cell(f.altitude, 1)}°</td>
        <td class="num">${cell(f.roll, 1)}°</td>
        <td class="num">${Number.isFinite(f.meanConf) ? (f.meanConf * 100).toFixed(0) + '%' : '—'}</td>
        <td class="num">${cell(f.movedDeg)}°</td>
        <td class="wide">${useCell}</td>
      </tr>`;
    }).join('');
  }
  $('frameNote').textContent = report
    ? `${frames.length} row(s). The last column is from the most recent build.`
    : 'Build the panorama to fill in the last two columns.';
}


/**
 * Turn the solved panorama into numbers.
 *
 * The picture localises a fault; these lines say which fault it is. They are
 * deliberately stated as measurements with their own caveats rather than as
 * verdicts, and the ordering is worst-first because a list nobody reads to the
 * end should put the actionable thing at the top.
 */
function stitchFindings(dis, report, kfs) {
  const lines = [];
  const spans = dis.filter(d => d.n >= 2).map(d => d.span).sort((a, b) => a - b);
  const q = f => spans.length ? spans[Math.min(spans.length - 1, Math.floor(f * (spans.length - 1)))] : NaN;
  const med = q(0.5), p95 = q(0.95);

  lines.push(`bins with 2+ independent looks   ${spans.length} of ${BIN_COUNT}`);

  if (report) {
    const g = report.graph || {};
    const r = report.render || {};
    lines.push(`solver                           ${report.detector}, ${report.pairs} verified pairs, ${report.matches} matches`);
    lines.push(`overlap disagreement             mean ${(+r.meanOverlapDisagreement).toFixed(1)}, p95 ${(+r.p95OverlapDisagreement).toFixed(1)} per channel`);
    lines.push(`frames in the solved graph       ${g.largestComponentFrames} of ${report.frames}`
      + (g.isolatedFrames ? `  (${g.isolatedFrames} isolated)` : ''));
    if ((g.excludedFrameIndices || []).length) {
      lines.push(`omitted from the panorama        ${g.excludedFrameIndices.join(', ')}`);
      lines.push('  No verified visual overlap connects these to the rest, so painting');
      lines.push('  them from their sensor pose would place an unchecked island inside a');
      lines.push('  solved panorama. See the per-photograph table for each one.');
    }

    // The lens, solved with the rotations rather than assumed. Reported whether
    // or not it changed anything, because "we checked and it was right" is a
    // different statement from "we did not check", and the 2026-08-15 capture
    // went out on a field of view nobody had ever checked.
    const scale = +report.focalScale;
    if (Number.isFinite(scale)) {
      const lens = report.lensDeg || {};
      lines.push(`lens solved with the rotations   x${scale.toFixed(4)} -> ${(+lens.horizontal).toFixed(2)}deg x ${(+lens.vertical).toFixed(2)}deg`);
      if (Math.abs(scale - 1) > 0.03) {
        lines.push('');
        lines.push(`The recorded field of view was out by ${((scale - 1) * 100).toFixed(1)}%. That is worth`);
        lines.push('nothing at the centre of a frame and about a degree at its edge, which');
        lines.push('is exactly where neighbouring frames are supposed to agree. The');
        lines.push('panorama above uses the solved value; the 720-bin profile still uses');
        lines.push('the recorded one. Re-run the guided lens step before the next survey.');
      }
    }

    // The residual, kept but framed. It is computed after prune_outliers has
    // deleted the matches the solution disagreed with, so it scores the
    // survivors and improves when evidence is thrown away. Measured on the
    // 2026-08-18 two-lap capture it called the ghosted build very slightly
    // better than the clean one.
    const rd = report.residualDeg || {};
    if (Number.isFinite(+rd.solvedMedian)) {
      lines.push(`residual after pruning           ${(+rd.solvedMedian).toFixed(4)}deg median, ${(+rd.solvedP90).toFixed(4)}deg p90`);
      lines.push(`  from ${(+rd.sensorMedian).toFixed(3)}deg on the raw sensor poses. Read this as "the`);
      lines.push('  surviving matches agree", not as "the panorama is sharp" — pruning');
      lines.push('  removes the disagreeing matches before this is measured.');
    }
  }

  if (spans.length) {
    lines.push(`inter-frame skyline disagreement median ${med.toFixed(2)}°  p95 ${p95.toFixed(2)}°`);
    // Calibrated against tests/panorama.test.mjs: correct intrinsics on
    // synthetic data give ~0.18° median; a 33% focal error gives ~4.3°.
    if (med > 2.0) {
      lines.push('');
      lines.push('That median is far too high for frames looking at the same object.');
      lines.push('A segmentation mistake moves one frame, not all of them, so a');
      lines.push('disagreement this broad is geometric: focal length, frame');
      lines.push('rotation, or rotation scale. Check the field of view first — the');
      lines.push('16:9 stream is centre-cropped into the 4:3 analysis frame, so the');
      lines.push('sensor figure is not the frame figure.');
    } else if (med > 0.6) {
      lines.push('');
      lines.push('Mild but real disagreement. Look for steps at frame boundaries in');
      lines.push('the image above: a step is geometry, a fuzzy band is detection.');
    }
  }

  const worst = dis
    .map((d, i) => ({ az: i * BIN_STEP, ...d }))
    .filter(d => d.n >= 2)
    .sort((a, b) => b.span - a.span)
    .slice(0, 8);
  if (worst.length && worst[0].span > 1) {
    lines.push('');
    lines.push('widest disagreement, by azimuth:');
    for (const w of worst) {
      if (w.span < 1) continue;
      lines.push(`  ${w.az.toFixed(1).padStart(6)}°   ${w.span.toFixed(2).padStart(6)}° across ${String(w.n).padStart(4)} looks   (${w.p5.toFixed(1)}° … ${w.p95.toFixed(1)}°)`);
    }
    lines.push('Point the phone at these azimuths and compare what you see against');
    lines.push('the line drawn above. This is the shortlist worth re-walking.');
  }

  const gaps = dis.filter(d => d.n === 0).length;
  if (gaps) lines.push(`\nbins never observed             ${gaps}`);
  const single = dis.filter(d => d.n === 1).length;
  if (single) lines.push(`bins seen by one frame only     ${single}  (no cross-check possible)`);

  const photoGaps = captureGapReport(survey.keyframes, survey.yawDatum || 0, { minOverlap: overlapFloor(director.mode) });
  if (photoGaps.gapCount) {
    lines.push('');
    lines.push(`source-photo overlap gaps        ${photoGaps.gapCount}`);
    for (const gap of photoGaps.gaps.slice(0, 8)) {
      lines.push(`  pass ${gap.pass}, frames ${gap.fromFrame}→${gap.toFrame}: ${(gap.estimatedOverlap * 100).toFixed(0)}% overlap; recapture at ${gap.recaptureLabels.join(', ')}`);
    }
    lines.push('These are measured from the saved photo axes and field of view, not inferred from the finished panorama.');
  }

  // Laps are reported because they are the single largest lever on sharpness.
  // Same-lap frames disagreed by 0.084° on the 2026-08-18 capture; cross-lap
  // frames by 0.203°, and by 1.215° at the 90th percentile. A bearing finished
  // on one lap is worth more than the same bearing confirmed on two.
  const laps = new Set(kfs.map(k => k.pass ?? 1));
  if (laps.size > 1) {
    lines.push('');
    lines.push(`laps in this capture             ${laps.size}`);
    lines.push('  Frames from different laps were taken from slightly different');
    lines.push('  standing positions. Against anything close that is real parallax,');
    lines.push('  which no rotation can undo and blending can only average. If near');
    lines.push('  objects look doubled, this is why — see Coverage detail for which');
    lines.push('  bearings needed the second lap at all.');
  }

  const i = camera.intrinsics();
  lines.push('');
  lines.push(`analysis frame FOV  ${i.hfovDeg.toFixed(1)}° × ${i.vfovDeg.toFixed(1)}°   source: ${i.source}`);
  if (i.cropKnown) {
    lines.push(`video ${i.videoW}×${i.videoH} → work ${WORK_W}×${WORK_H}, keeping ${(i.cropW * 100).toFixed(1)}% width, ${(i.cropH * 100).toFixed(1)}% height`);
  } else {
    lines.push('crop factor unmeasured (camera not running) — FOV may be uncorrected');
  }
  const mixed = new Set(kfs.map(k => (k.tanHalfH || 0).toFixed(4)));
  if (mixed.size > 1) {
    lines.push(`${mixed.size} distinct focal lengths across keyframes — a lens changed mid-survey; each frame is reprojected with its own.`);
  }
  return lines.join('\n');
}

function savePanorama() {
  if (!panoBuilt) return;
  const canvas = $('pano');
  canvas.toBlob(blob => {
    if (!blob) { log('warn', 'The browser refused to encode the panorama.'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const site = (($('siteName') && $('siteName').value) || 'site').trim() || 'site';
    a.href = url;
    a.download = `${out.slugify(site)}-panorama.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    log('info', 'Diagnostic panorama saved.');
  }, 'image/png');
}

/* --------------------------------------------------------- profile editing */

let editPointer = null;
function profileEdit(e) {
  if (!state.editing) return;
  const rect = $('profile').getBoundingClientRect();
  const padL = 30, padT = 8, padB = 18;
  const plotW = rect.width - padL - 6, plotH = rect.height - padB - padT;
  const x = clamp((e.clientX - rect.left - padL) / plotW, 0, 1);
  const y = clamp((e.clientY - rect.top - padT) / plotH, 0, 1);
  const idx = Math.round(x * (BIN_COUNT - 1));
  const alt = (1 - y) * state.maxAlt;
  survey.setAltitudeRange(idx - 2, idx + 2, alt);
}

/* -------------------------------------------------------------- persistence */

function currentProject(includeThumbs = false) {
  const meta = metaFromForm();
  const r = survey.report();
  return out.buildProject(survey, meta, r, {
    intrinsics: camera.intrinsics(),
    sensorHealth: orientation.health(),
    mode: { id: director.mode.id, label: director.mode.label, minOverlap: director.mode.minOverlap, maxRate: director.mode.maxRate, rollLimitScan: director.mode.rollLimitScan },
    yawDatumDeg: survey.yawDatum || 0,
    thumbs: includeThumbs ? state.thumbs : null,
    generator: 'Horizon Survey 2.0 (browser)'
  });
}

/**
 * Everything a remote diagnosis needs, in one file: the state snapshot, the
 * lens inventory, the acceptance report, and the complete field log. Built as
 * plain text so it survives any messenger, mail client, or issue tracker.
 */
function buildDebugBundle() {
  const bar = '='.repeat(68);
  const lines = [
    'HORIZON SCANNER DEBUG BUNDLE',
    `generated ${new Date().toISOString()}`,
    bar, 'STATE SNAPSHOT', bar,
    JSON.stringify(debugSnapshot(), null, 2),
    bar, 'LENS INVENTORY', bar,
    camera.devices.length
      ? JSON.stringify(camera.devices, null, 2)
      : '(not scanned — Advanced > Scan lenses)',
    `pinned: ${camera.pinned}, lens swaps observed: ${camera.lensSwaps}`,
    bar, 'ACCEPTANCE REPORT', bar,
    reportText(survey.report()),
    bar, `FIELD LOG (${$('logCount').textContent} entries)`, bar,
    L.dump() || '(empty)'
  ];
  return lines.join('\n');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Everything that goes into a capture-debug archive, for one set of photos.
 *
 * Shared by the Export button and the in-app stitcher, because the stitcher is
 * handed exactly this archive. Two builders would eventually drift, and the
 * whole reason the in-app build can be trusted to agree with a desktop rebuild
 * is that both read the same bytes produced by the same code.
 */
function captureArchivePayload(photos, { includeCoverageImage = null } = {}) {
  return {
    siteName: $('siteName').value,
    sessionId: state.sessionId,
    appVersion: `${VERSION} (${BUILD_DATE})`,
    keyframes: survey.keyframes,
    photos,
    yawDatumDeg: survey.yawDatum || 0,
    azimuthOffsetDeg: Number($('azOffset').value) || 0,
    project: currentProject(false),
    snapshot: debugSnapshot(),
    captureAudit: {
      counts: { ...state.captureAudit.counts },
      events: state.captureAudit.events.slice()
    },
    panoramaOptimization: state.pano?.optimization || null,
    scanCoverage: {
      ...coverage.snapshot(),
      tuning: { ...coverage.tuning },
      guidance: state.guidance ? {
        state: state.guidance.state,
        bearingDeg: state.guidance.bearingDeg,
        targetBearingDeg: state.guidance.rawBearingDeg,
        offsetDeg: state.guidance.offsetDeg,
        waitingSec: Number((state.guidance.waitingSec || 0).toFixed(2)),
        tuning: { ...guidance.tuning }
      } : { state: 'not-started', tuning: { ...guidance.tuning } },
      bearings: Array.from({ length: coverage.binCount }, (_, i) => ({
        bearingDeg: Number(coverage.bearingOf(i).toFixed(2)),
        score: Number(coverage.score[i].toFixed(4)),
        creditedFrames: coverage.observations[i],
        sweptFrames: coverage.visits[i],
        covered: coverage.isCovered(i)
      })),
      trail: state.guidanceTrail.slice()
    },
    coverageImage: includeCoverageImage,
    // What the stitcher did with these photographs, when one has been built.
    // Carried into the archive so a capture can be argued about after the fact
    // without the panorama in front of you.
    // The vertical plan and the live connectivity audit. Both describe the
    // capture rather than the stitch, so they are written whether or not a
    // panorama was ever built.
    columnPlan: columns.snapshot(),
    overlapAudit: state.overlapAudit
      ? { ...state.overlapAudit, bridgeTargets: state.bridgeTargets || [] } : null,
    stitchReport: state.pano?.report || null,
    stitchLog: state.pano?.log || null,
    stitchOptions: state.pano?.options || null,
    debugText: buildDebugBundle(),
    logText: L.dump()
  };
}

async function exportCaptureDebugZip() {
  const btn = $('exportCaptureZipBtn');
  btn.disabled = true;
  btn.textContent = 'Building ZIP...';
  try {
    const photos = await loadKeyframeBlobs({ waitForPending: true });
    const usedPhotos = survey.keyframes.filter(kf => photos.has(kf.index)).length;
    log('info', `CAPTURE_DEBUG_EXPORT collecting ${usedPhotos} photo(s) for ${survey.keyframes.length} keyframe(s).`);
    // One payload builder, shared with the in-app stitcher. They were separate
    // literals until 2026-08-20, and the consequence was silent: the Export
    // button kept writing an archive with column-plan.json and
    // overlap-audit.json set to null, because only the stitcher's copy had been
    // taught to include them. Two builders for one format will always drift;
    // there is now one.
    const result = await buildCaptureDebugZip(captureArchivePayload(photos, {
      includeCoverageImage: await renderCoverageCard(coverage, state.guidance
        ? { ...state.guidance, headingDeg: currentHeading() } : null)
    }));
    downloadBlob(result.blob, result.filename);
    const missing = result.keyframeCount - result.photoCount;
    log(missing ? 'warn' : 'info', `Wrote ${result.filename}, ${(result.blob.size / 1e6).toFixed(1)} MB: ${result.photoCount}/${result.keyframeCount} source photos plus metadata and logs${missing ? ` (${missing} photo(s) unavailable)` : ''}.`);
  } catch (err) {
    log('error', 'Could not build capture debug ZIP:', err);
  } finally {
    // updateStats owns this button's label and enabled state; it re-runs on the
    // next tick and will restore both, including the keyframe count.
    btn.disabled = false;
    updateStats();
  }
}

async function shareDebugBundle() {
  log('info', 'DEBUG_SNAPSHOT', JSON.stringify(debugSnapshot()));
  const text = buildDebugBundle();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const file = new File([text], `horizon-debug-${stamp}.txt`, { type: 'text/plain' });
  // The Android share sheet is the one-tap path to mail, Drive, or a chat.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Horizon Scanner debug bundle' });
      log('info', 'Debug bundle handed to the share sheet.');
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;   // operator closed the sheet
      log('warn', `Share failed (${err.name}); downloading instead.`);
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  log('info', `Sharing unavailable here — bundle downloaded as ${file.name}.`);
}

function debugSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    appVersion: VERSION,
    appBuildDate: BUILD_DATE,
    phase: director.phase,
    sensorCalibrationStage: state.sensorCal.stage,
    orientation: orientation.health(),
    attitude: orientation.attitude(),
    rawOrientation: {
      alpha: orientation.alpha,
      beta: orientation.beta,
      gamma: orientation.gamma,
      rawYaw: orientation.rawYaw(),
      compassHeading: orientation.compassHeading,
      gyroYaw: orientation.gyroYaw,
      gyroYawRate: orientation.gyroYawRate
    },
    camera: {
      ready: camera.ready,
      settings: camera.settings,
      intrinsics: camera.intrinsics(),
      frameRotation: camera.frameRotation,
      activeDeviceId: camera.activeDeviceId
    },
    pipeline: pipeline.stats(),
    capture: {
      frameCount: state.frameCount,
      frameStatus: state.frameStatus,
      sceneLuma: state.sceneLuma,
      visualQuality: state.visualQuality,
      visualScale: state.visualScale,
      trackingLost: state.trackingLost,
      fusedYaw: state.fusedYaw,
      pass1Travel: director.pass1Travel,
      pass2Travel: director.pass2Travel,
      keyframes: survey.keyframes.length,
      captureGaps: captureGapReport(survey.keyframes, survey.yawDatum || 0, { minOverlap: overlapFloor(director.mode) }),
      // What the camera actually painted, and where the guidance dot was left.
      // The map is per-lap, so this describes the lap in progress.
      scanCoverage: coverage.snapshot(),
      guidance: state.guidance ? {
        bearingDeg: state.guidance.bearingDeg,
        state: state.guidance.state,
        waitingSec: Number(state.guidance.waitingSec?.toFixed(2)) || 0
      } : null,
      captureAudit: {
        counts: { ...state.captureAudit.counts },
        eventCount: state.captureAudit.events.length,
        lastEvent: state.captureAudit.events[state.captureAudit.events.length - 1] || null
      },
      keyframeSources: {
        pass1: survey.keyframes.filter(k => (k.pass || 1) === 1).length,
        pass2: survey.keyframes.filter(k => k.pass === 2).length
      },
      elevationPolicyDeg: {
        visualYawDisabledAbove: VISUAL_YAW_MAX_ELEVATION,
        warnAbove: ELEVATION_WARN_DEG,
        rejectAbove: ELEVATION_HARD_LIMIT_DEG
      },
      coverage: survey.coverage()
    },
    panoramaOptimization: state.pano?.optimization || null,
    preflight: preflight.result(),
    platform: {
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height}`,
      devicePixelRatio: window.devicePixelRatio || 1,
      secureContext: window.isSecureContext
    }
  };
}

async function saveSession() {
  try {
    state.sessionId = state.sessionId || `s${Date.now().toString(36)}`;
    const project = currentProject(false);
    await store.saveSession({
      id: state.sessionId,
      name: $('siteName').value.trim() || 'Unnamed site',
      updatedAt: Date.now(),
      grade: project.report.grade,
      coverageDeg: project.report.coverage.coverageDeg,
      project
    });
    log('info', `Session saved as ${state.sessionId}.`);
    refreshSessions();
  } catch (err) {
    log('error', 'Save failed:', err);
  }
}

async function refreshSessions() {
  const list = $('sessionList');
  try {
    const sessions = await store.listSessions();
    list.innerHTML = '';
    if (!sessions.length) { list.innerHTML = '<li class="muted">No saved sessions.</li>'; }
    for (const s of sessions) {
      const li = document.createElement('li');
      const label = document.createElement('div');
      label.innerHTML = '<div></div><div class="meta"></div>';
      label.children[0].textContent = s.name;
      label.children[1].textContent = `${new Date(s.updatedAt).toLocaleString()} · ${s.coverageDeg.toFixed(0)}° · ${s.grade}`;
      const actions = document.createElement('div');
      const openBtn = document.createElement('button');
      openBtn.className = 'btn small'; openBtn.textContent = 'Open';
      openBtn.onclick = () => { out.applyProject(survey, s.project); restoreMode(s.project); state.sessionId = s.id; survey.recompute(); updateReport(); log('info', `Opened session ${s.id}.`); };
      const delBtn = document.createElement('button');
      delBtn.className = 'btn small ghost'; delBtn.textContent = 'Delete';
      delBtn.onclick = async () => { await store.deleteSession(s.id); refreshSessions(); };
      actions.append(openBtn, delBtn);
      li.append(label, actions);
      list.appendChild(li);
    }
    const usage = await store.estimateUsage();
    if (usage) $('storageHint').textContent = `${(usage.usage / 1048576).toFixed(1)} MB used of ${(usage.quota / 1048576).toFixed(0)} MB available on this device.`;
  } catch (err) {
    list.innerHTML = '<li class="muted">Local storage is unavailable in this browser.</li>';
    log('warn', 'Session list failed:', err);
  }
}

/* -------------------------------------------------------------- self-test */

function selfTest() {
  const cases = [
    ['portrait, alpha 0, beta 90', 0, 90, 0, 0, 0, 0, 0, 0],
    ['portrait, alpha 90', 90, 90, 0, 0, 0, 0, 270, 0],
    ['tilted up 20°', 0, 110, 0, 0, 0, 0, 0, 20],
    ['right edge of frame', 0, 90, 0, 0, 1, 0, camera.hfovDeg / 2, 0],
    ['top edge of frame', 0, 90, 0, 0, 0, 1, 0, camera.intrinsics().vfovDeg / 2]
  ];
  const i = camera.intrinsics();
  const lines = ['PROJECTION SELF-TEST', ''];
  let failures = 0;
  for (const [name, a, b, g, sa, u, v, expAz, expAlt] of cases) {
    const q = screenQuat(quatFromEuler(a, b, g), sa);
    const w = quatRotate(q, cameraRay(u, v, i.tanHalfH, i.tanHalfV));
    const { az, alt } = vecToAzAlt(w);
    const dAz = Math.abs(angDiff(az, expAz)), dAlt = Math.abs(alt - expAlt);
    const ok = dAz < 0.05 && dAlt < 0.05;
    if (!ok) failures++;
    lines.push(`${ok ? '[pass]' : '[FAIL]'} ${name.padEnd(24)} az ${az.toFixed(2).padStart(7)} (exp ${expAz.toFixed(2)})  alt ${alt.toFixed(2).padStart(7)} (exp ${expAlt.toFixed(2)})`);
  }
  lines.push('', `${failures ? failures + ' FAILED' : 'All checks passed'}`);
  lines.push('', 'Note: this verifies the projection maths only. It cannot verify that');
  lines.push('the device reports orientation in the expected convention, which is what');
  lines.push('the frame-rotation override in Advanced is for.');
  $('reportText').textContent = lines.join('\n');
  log(failures ? 'error' : 'info', `Self-test: ${failures ? failures + ' failure(s)' : 'all passed'}.`);
}

/* -------------------------------------------------------------------- wire */

function wire() {
  L.attach($('logOutput'), $('logCount'));
  L.captureConsole();

  $('primaryBtn').addEventListener('click', onPrimary);
  $('secondaryBtn').addEventListener('click', () => {
    if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === 'failed'
      && state.sensorCal.reason !== 'no-samples') return skipSensorTest();
    state.paused = !state.paused;
    syncControls();
  });
  $('abortBtn').addEventListener('click', resetSurvey);

  $('maxAltSelect').addEventListener('change', e => { state.maxAlt = Number(e.target.value); });
  $('editToggle').addEventListener('change', e => { state.editing = e.target.checked; });
  $('fillGapsBtn').addEventListener('click', () => {
    const n = survey.interpolateGaps(3);
    log('info', `Interpolated ${n} bin(s) across gaps narrower than 3°.`);
    updateReport();
  });
  $('recomputeBtn').addEventListener('click', () => {
    survey.reproject(camera.intrinsics());
    log('info', `Reprojected ${survey.keyframes.length} keyframes at ${camera.hfovDeg.toFixed(2)}° FOV.`);
    updateReport();
  });

  const prof = $('profile');
  prof.addEventListener('pointerdown', e => { if (!state.editing) return; editPointer = e.pointerId; prof.setPointerCapture(e.pointerId); profileEdit(e); });
  prof.addEventListener('pointermove', e => { if (editPointer === e.pointerId) profileEdit(e); });
  prof.addEventListener('pointerup', () => { editPointer = null; updateReport(); });
  prof.addEventListener('pointercancel', () => { editPointer = null; });

  $('copyReportBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('reportText').textContent); log('info', 'Report copied.'); }
    catch (err) { log('warn', 'Clipboard refused; select the text manually.'); }
  });

  $('locationBtn').addEventListener('click', () => {
    if (!navigator.geolocation) { log('warn', 'No geolocation API in this browser.'); return; }
    navigator.geolocation.getCurrentPosition(pos => {
      $('latitude').value = pos.coords.latitude.toFixed(7);
      $('longitude').value = pos.coords.longitude.toFixed(7);
      if (Number.isFinite(pos.coords.altitude)) $('elevation').value = pos.coords.altitude.toFixed(0);
      log('info', `Location filled, reported accuracy ±${Math.round(pos.coords.accuracy)} m.`);
    }, err => log('error', 'Location failed:', err.message), { enableHighAccuracy: true, timeout: 15000 });
  });

  $('forceExport').addEventListener('change', updateReport);

  $('exportHznBtn').addEventListener('click', () => {
    const bytes = out.downloadHzn1(survey, metaFromForm());
    log('info', `Wrote HZN1, ${bytes} bytes.`);
  });
  $('exportHzn2Btn').addEventListener('click', () => {
    const r = survey.report();
    const grade = { EXCELLENT: 3, GOOD: 2, MARGINAL: 1, INSUFFICIENT: 0 }[r.grade];
    const bytes = out.downloadHzn2(survey, { ...metaFromForm(), qualityGrade: grade, loopErrorDeg: survey.loopError || 0, keyframeCount: survey.keyframes.length });
    log('info', `Wrote HZN2, ${bytes} bytes.`);
  });
  $('exportProjectBtn').addEventListener('click', async () => {
    let thumbs = null;
    if ($('embedThumbs').checked && state.sessionId) {
      thumbs = {};
      const rows = await store.getKeyframeThumbs(state.sessionId);
      for (const row of rows) thumbs[row.index] = await blobToDataUrl(row.blob);
      state.thumbs = thumbs;
    }
    const project = currentProject(!!thumbs);
    const size = out.downloadProject(project, $('siteName').value);
    log('info', `Wrote project archive, ${(size / 1024).toFixed(0)} kB, ${survey.keyframes.length} keyframes.`);
  });
  $('exportCaptureZipBtn').addEventListener('click', exportCaptureDebugZip);

  $('openProjectInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const project = JSON.parse(await file.text());
      out.applyProject(survey, project);
      restoreMode(project);
      if (project.site) {
        $('siteName').value = project.site.name || '';
        if (project.site.latitude != null) $('latitude').value = project.site.latitude;
        if (project.site.longitude != null) $('longitude').value = project.site.longitude;
        $('azOffset').value = project.site.azimuthOffsetDeg ?? 0;
      }
      if (project.capture?.intrinsics?.hfovDeg) camera.setHfov(project.capture.intrinsics.hfovDeg);
      survey.recompute();
      updateReport();
      log('info', `Opened archive with ${survey.keyframes.length} keyframes, created ${project.createdAt}.`);
    } catch (err) {
      log('error', 'Could not read that project file:', err);
    } finally { e.target.value = ''; }
  });

  $('saveSessionBtn').addEventListener('click', saveSession);
  $('refreshSessionsBtn').addEventListener('click', refreshSessions);

  $('panoBtn').addEventListener('click', buildPanorama);
  $('panoSaveBtn').addEventListener('click', savePanorama);
  // Switching between the solved render and the sensor-pose control redraws
  // from blobs already in hand; it must never re-run the solve.
  $('stitchShowControl').addEventListener('change', () => {
    paintStitchedPanorama().catch(e => log('warn', `Could not redraw the panorama: ${e.message}`));
    syncDomeView();
  });
  $('domeToggle').addEventListener('change', syncDomeView);
  $('domeGrid').addEventListener('change', () => dome?.setGrid($('domeGrid').checked));
  $('refreshCoverageBtn').addEventListener('click', renderCoverageTables);
  $('sectorSize').addEventListener('change', renderCoverageTables);
  $('framesOmittedOnly').addEventListener('change', renderCoverageTables);
  $('pano').addEventListener('click', panoLandmarkTap);
  $('lmClearBtn').addEventListener('click', () => {
    if (state.pano) { state.pano.landmarks = []; state.pano.stale = false; }
    renderLandmarks();
  });

  // The slider is a SENSOR figure — what the spec sheet says the lens covers.
  // The working frame is a centre crop of that, so it is converted rather than
  // used directly; the readout shows both so the difference is never invisible.
  $('fovRange').addEventListener('input', e => {
    camera.setSensorHfov(Number(e.target.value));
    syncFovReadout();
  });
  /* ---- lens inventory ------------------------------------------------- */
  async function scanLenses() {
    if (!camera.stream) { log('warn', 'Start the camera first — lens labels are hidden until access is granted.'); return; }
    const found = await camera.enumerate();
    if (!found.length) { log('warn', 'No selectable cameras reported.'); return; }
    await camera.probeLenses();
    const sel = $('lensSelect');
    sel.innerHTML = '<option value="">Default rear camera</option>';
    for (const d of found) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = `${d.label}${d.zoomMin ? ` (wide, zoom ${d.zoomMin})` : ''}${d.error ? ' — unavailable' : ''}`;
      if (d.error) o.disabled = true;
      sel.appendChild(o);
    }
    log('info', `${found.length} rear lens(es) found. Labels come from the browser and are not always meaningful.`);
  }

  $('scanLensBtn').addEventListener('click', () => scanLenses().catch(e => log('error', 'Lens scan failed:', e)));

  $('widestLensBtn').addEventListener('click', async () => {
    if (!camera.devices.length) await scanLenses();
    // Prefer measured evidence (a sub-1 zoom minimum is an ultra-wide) and fall
    // back to the label only when the browser exposed nothing to measure.
    const byZoom = camera.devices.filter(d => !d.error && Number.isFinite(d.zoomMin)).sort((a, b) => a.zoomMin - b.zoomMin)[0];
    const byLabel = camera.devices.find(d => !d.error && d.isWide);
    const pick = byZoom || byLabel;
    if (!pick) { log('warn', 'Nothing identifiable as a wide lens. Pick one manually and calibrate its field of view.'); return; }
    $('lensSelect').value = pick.deviceId;
    $('lensSelect').dispatchEvent(new Event('change'));
    log('info', `Selected "${pick.label}" as widest, by ${byZoom ? 'measured zoom range' : 'label only — verify by calibrating'}.`);
  });

  $('lensSelect').addEventListener('change', async e => {
    try {
      await camera.switchTo(e.target.value || null);
      survey.focalSamples.length = 0;
      survey.focalPx = null;
      $('preflightState').textContent = 'not run';
      $('preflightResult').hidden = true;
      log('info', 'Lens switched. Focal length reset — calibrate the field of view for this lens before surveying.');
    } catch (err) {
      log('error', 'Could not open that lens:', err.message || err);
    }
  });

  /* ---- explicit field-of-view calibration ------------------------------ */
  /* ---- pre-flight sweep: compass swing + focal length ------------------ */
  function finishPreflight() {
    preflight.stop();
    $('preflightBtn').textContent = 'Run pre-flight sweep';
    const r = preflight.result();
    $('preflightResult').hidden = false;
    $('pfSweep').textContent = `${r.sweepDeg.toFixed(0)}° over ${r.n} samples`;
    $('pfDeviation').textContent = r.deviationDeg === null ? '—' : `±${(r.deviationDeg / 2).toFixed(1)}°`;
    $('pfJitter').textContent = `±${(r.meanJitter / 2).toFixed(2)}°`;
    $('pfSummary').textContent = r.summary;

    // The compass verdict changes what the survey trusts, not whether it runs.
    if (r.verdict === VERDICT.DEAD || r.verdict === VERDICT.ABSENT) {
      orientation.compassReliability = 'poor';
      orientation.datumLocked = false;
      orientation.yawDatum = 0;
    } else if (r.verdict === VERDICT.FAIR) {
      orientation.compassReliability = 'fair';
    } else if (r.verdict === VERDICT.GOOD) {
      orientation.compassReliability = 'good';
    }
    log(r.verdict === VERDICT.GOOD ? 'info' : 'warn', `Pre-flight: compass ${r.verdict}. ${r.summary}`);

    if (r.swingTable) {
      $('pfSwing').textContent = r.swingTable
        .map(b => `${String(b.fromDeg).padStart(3)}°-${String(b.fromDeg + 30).padStart(3)}°  ` +
          (b.n ? `${b.residualDeg >= 0 ? '+' : ''}${b.residualDeg.toFixed(1)}°  (${b.n})` : 'not swept'))
        .join('\n');
    }

    // Same gesture, second measurement.
    const st = survey.focalStats();
    if (st.converged) {
      const workFocal = st.median * (WORK_W / LUMA_W);
      camera.adoptFocal(workFocal);
      survey.establishFocal(st.median);   // arms mid-scan lens-change detection
      syncFovReadout();
      $('pfFov').textContent = `${camera.hfovDeg.toFixed(1)}° ±${(st.iqrPct / 2).toFixed(1)}%`;
      log('info', `Field of view measured at ${camera.hfovDeg.toFixed(2)}° from ${st.n} samples, spread ${st.iqrPct.toFixed(1)}%.`);
    } else {
      $('pfFov').textContent = st.n < 4 ? 'no samples' : `not converged (${st.n}, ±${(st.iqrPct / 2).toFixed(1)}%)`;
      log('warn', `Field of view not solved: ${st.n} sample(s)${st.iqrPct !== null ? `, spread ${st.iqrPct.toFixed(1)}% (needs under 8%)` : ''}. Turn more steadily across a scene with more texture, keeping the phone level.`);
    }

    const chip = $('preflightState');
    chip.textContent = r.verdict === VERDICT.GOOD ? 'compass good'
      : r.verdict === VERDICT.FAIR ? 'compass fair'
        : r.verdict === VERDICT.INCONCLUSIVE ? 'sweep too short' : 'relative azimuth';
    chip.className = `chip ${r.verdict === VERDICT.GOOD ? 'ok' : r.verdict === VERDICT.INCONCLUSIVE ? '' : 'warn'}`;
  }

  for (const b of document.querySelectorAll('.fov-preset')) {
    b.addEventListener('click', () => {
      const sensorFov = Number(b.dataset.fov);
      const r = camera.setSensorHfov(sensorFov);
      camera.focalSource = 'preset';
      syncFovReadout();
      log('info', r.crop.known
        ? `Field of view seeded from a preset: ${sensorFov.toFixed(1)}° across the sensor, which after the ${(r.crop.w * 100).toFixed(1)}% width crop into the ${WORK_W}×${WORK_H} analysis frame is ${camera.hfovDeg.toFixed(1)}°. Still a seed — run the pre-flight sweep to measure it.`
        : `Field of view seeded to ${sensorFov.toFixed(1)}° from a preset, but the crop factor is unknown until the camera is running, so this is not yet corrected for the 16:9→4:3 crop. Start the camera and re-tap.`);
    });
  }

  $('preflightBtn').addEventListener('click', () => {
    if (!camera.ready) { log('warn', 'Start the camera first — the sweep needs visual registration as its reference.'); return; }
    if (preflight.active) { finishPreflight(); return; }
    preflight.start();
    survey.focalSamples.length = 0;
    survey.focalPx = null;
    $('preflightResult').hidden = true;
    $('preflightBtn').textContent = 'Finish sweep';
    $('preflightState').textContent = 'sweeping';
    $('preflightState').className = 'chip';
    log('info', `Pre-flight started. Turn steadily through at least ${MIN_SWEEP_DEG}°, then back, keeping a textured scene in frame.`);
  });

  $('rotSelect').addEventListener('change', e => {
    if (e.target.value === 'auto') { camera.autoRotation = true; camera.detectRotation(orientation.screenAngle); }
    else camera.setRotation(Number(e.target.value));
  });

  $('ruleObs').value = RULES.minObservations;
  $('rulePasses').value = RULES.minPasses;
  $('ruleSpread').value = RULES.maxSpreadDeg;
  $('ruleConf').value = RULES.minConfidence;
  $('applyRulesBtn').addEventListener('click', () => {
    RULES.minObservations = clamp(Number($('ruleObs').value) || 4, 1, 40);
    RULES.minPasses = clamp(Number($('rulePasses').value) || 2, 1, 5);
    RULES.maxSpreadDeg = clamp(Number($('ruleSpread').value) || 1.5, 0.2, 10);
    RULES.minConfidence = clamp(Number($('ruleConf').value) || 0.42, 0.05, 0.95);
    survey.recompute();
    director.refreshTargets();
    updateReport();
    log('info', 'Acceptance rules applied.', JSON.stringify(RULES));
  });

  $('selfTestBtn').addEventListener('click', selfTest);
  $('shareLogBtn').addEventListener('click', shareDebugBundle);
  $('copyLogBtn').addEventListener('click', async () => {
    // Capture state at the moment the operator asks for support. This makes the
    // copied log self-contained instead of relying on a value having happened
    // to cross a warning threshold earlier.
    log('info', 'DEBUG_SNAPSHOT', JSON.stringify(debugSnapshot()));
    const ok = await L.copy();
    log('info', ok ? 'Log copied with diagnostic snapshot.' : 'Copy refused.');
  });
  $('clearLogBtn').addEventListener('click', () => L.clear());

  window.addEventListener('orientationchange', () => setTimeout(() => camera.detectRotation(orientation.screenAngle), 250));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.running && !state.paused) { state.paused = true; syncControls(); log('info', 'Paused because the page went to the background.'); }
  });
}

function blobToDataUrl(blob) {
  return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}

/* -------------------------------------------------------------------- boot */

wire();
setChip($('contextChip'), window.isSecureContext ? 'Secure context' : 'HTTPS required', window.isSecureContext ? 'quiet' : 'bad');
if (!window.isSecureContext) {
  $('stageBlockerText').textContent = 'Camera and motion sensors need HTTPS. Serve this folder over https, or use localhost for desktop testing.';
}
updateReport();
refreshSessions();
syncControls();
// On the glass, and first in the log. Whether the device is running the build
// you think it is should be answerable by looking at it.
$('buildLabel').textContent = versionLabel();
$('buildLabel').title = RELEASE_NOTE;

/*
 * CATCH A HALF-CACHED BUILD, LOUDLY.
 *
 * index.html loads `js/main.js?v=X`, but main.js imports version.js, camera.js
 * and twenty others with no query at all. Bumping the version therefore busts
 * exactly one file, and a device can end up running new markup and new main.js
 * against a cached copy of everything they import. Observed on 2026-08-21: the
 * header read v0.19.0 while v0.20.0 was on disk, and every module in between
 * was whichever version the browser felt like.
 *
 * That is a nightmare to debug in a field, and worse across several devices at
 * once, because each one is stale in a different place. The honest fix is a
 * build step that fingerprints every module; short of that, the failure must at
 * least be VISIBLE rather than silent. The script tag carries the version the
 * markup expects, VERSION is what the module graph actually loaded, and if they
 * disagree the device is telling you it is running something other than what
 * you shipped.
 */
(() => {
  const tag = document.querySelector('script[type="module"][src*="main.js"]');
  const want = (tag?.getAttribute('src') || '').match(/[?&]v=([^&]+)/)?.[1];
  if (!want || want === VERSION) return;
  // A dedicated element, because the directive panel is rewritten by renderLive
  // on every frame — the first version of this warning was clobbered within
  // about sixteen milliseconds of being set, and looked exactly like no warning.
  const banner = $('staleBanner');
  banner.hidden = false;
  banner.innerHTML = 'STALE CODE ON THIS DEVICE — the page expects <b></b> '
    + 'but the modules that loaded are <b></b>. Some files came from the browser '
    + 'cache and some did not, so this device is running a mixture of builds. '
    + 'Force-reload before capturing anything: on iOS, close the tab entirely and '
    + 'reopen it. Do not trust a survey taken like this.';
  const slots = banner.querySelectorAll('b');
  slots[0].textContent = want;
  slots[1].textContent = VERSION;
  log('error', `STALE CACHE: markup expects ${want}, modules loaded ${VERSION}. `
    + 'This device is running a mixture of builds.', { expected: want, loaded: VERSION });
})();
log('info', `Horizon Survey ${versionLabel()} ready.`, JSON.stringify({
  version: VERSION, buildDate: BUILD_DATE,
  ua: navigator.userAgent, secure: window.isSecureContext,
  dpr: window.devicePixelRatio || 1, screen: `${screen.width}x${screen.height}`,
  workers: typeof Worker !== 'undefined', idb: 'indexedDB' in window
}));
requestAnimationFrame(loop);
