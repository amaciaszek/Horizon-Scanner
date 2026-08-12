'use strict';
import * as L from './log.js';
import {
  clamp, wrap360, angDiff, screenQuat, quatFromEuler, quatRotate,
  cameraRay, vecToAzAlt, DEG, RAD
} from './math3d.js';
import { CameraSource, WORK_W, WORK_H, LUMA_W, LUMA_H } from './camera.js';
import { OrientationSource } from './orientation.js';
import { Survey, RULES, BIN_COUNT, BIN_STEP, STATUS } from './survey.js';
import { ScanDirector, PHASE } from './guide.js';
import { Pipeline } from './pipeline.js';
import { PreflightSweep, VERDICT, MIN_SWEEP_DEG } from './preflight.js';
import { drawRing, drawProfile, drawOverlay } from './render.js';
import * as store from './storage.js';
import * as out from './exporters.js';
import {
  buildMosaic, skylineTracks, drawPanorama, disagreementByBin,
  pixelToAzAlt, landmarkResiduals
} from './panorama.js';

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
const orientation = new OrientationSource(log);
const camera = new CameraSource($('video'), log);
const pipeline = new Pipeline(log);
const preflight = new PreflightSweep();

const state = {
  sceneLuma: null,
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
  lastKeyframeAt: 0,
  frame: null,            // latest segmentation result for the overlay
  frameStatus: 'ok',
  overlap: null,
  visualQuality: null,
  visualSign: null,
  signSamples: [],
  calibStart: 0,
  sessionId: null,
  editing: false,
  maxAlt: 60,
  thumbs: {},
  targetLuma: null,
  sensorCal: { stage: 'idle', startedAt: 0 },
  obstructionProbe: {
    active: false, anchorYaw: null, startedAt: 0, frames: 0,
    lastCaptureAt: 0, parallax: false
  }
};

const PROCESS_INTERVAL_MS = 110;
const RENDER_INTERVAL_MS = 55;
const VISUAL_YAW_MAX_ELEVATION = 65;
const ELEVATION_WARN_DEG = 70;
const ELEVATION_HARD_LIMIT_DEG = 78;

/* ------------------------------------------------------------------ helpers */

const fmt = (v, d = 1, suffix = '°') => Number.isFinite(v) ? `${v.toFixed(d)}${suffix}` : '—';

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
    const workFrame = camera.grabWorkFrame();
    const luma = camera.grabLuma();
    if (!workFrame || !luma) return;

    const att = orientation.attitude();
    const rawYaw = orientation.rawYaw();
    const quat = screenQuat(orientation.quat, orientation.screenAngle);
    const t = performance.now();
    const highElevation = Math.abs(att.elevation) > VISUAL_YAW_MAX_ELEVATION ||
      state.obstructionProbe.active;
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
    if (orientation.gyroAvailable) {
      dGyro = state.prevGyroYaw === null ? 0 : orientation.gyroYaw - state.prevGyroYaw;
      state.prevGyroYaw = orientation.gyroYaw;
      gyroTrusted = true;
    } else {
      dGyro = state.prevRawYaw === null ? 0 : angDiff(rawYaw, state.prevRawYaw);
      gyroTrusted = orientation.compassReliability !== 'poor';
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

      // A high-obstruction probe intentionally tilts the view, so the image's
      // horizontal translation is no longer a trustworthy yaw measurement.
      // While the phone is supposed to be still, however, a large residual
      // image shift is useful evidence that the operator translated the phone
      // and introduced parallax.
      if (state.obstructionProbe.active && orientation.stillness > 0.65 &&
          r.quality > 0.45 && Math.abs(dGyro) < 0.5 &&
          Math.hypot(r.dx, r.dy) > 3.5) {
        state.obstructionProbe.parallax = true;
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

    // The pre-flight sweep rides on the same fused rotation the survey uses as
    // its reference, so it is measuring the compass against exactly what the
    // scan will trust rather than against a separate estimate.
    if (preflight.active) {
      preflight.add({
        compass: orientation.compassHeading,
        integrated: state.fusedYaw,
        jitter: orientation.jitterDeg,
        quality: state.visualQuality ?? 0
      });
    }

    // ---- frame quality gates --------------------------------------------
    if (seg && !seg.error) {
      state.frame = seg;
      let clippedTop = 0;
      for (let i = 0; i < seg.flags.length; i++) if (seg.flags[i] === 1) clippedTop++;
      // A sky boundary can only be measured if there is light to measure it
      // by. At night the whole premise inverts — the sky is the dark region and
      // the ground carries the bright lights — so every cue the segmenter uses
      // points the wrong way, and what it draws is a trace of sensor noise in
      // black pixels. Refuse rather than produce a confident-looking wrong line.
      if (state.frameCount % 15 === 0) state.sceneLuma = camera.meanLuma();
      state.frameStatus = Math.abs(att.elevation) > ELEVATION_HARD_LIMIT_DEG ? 'tooHigh'
      : state.obstructionProbe.parallax ? 'parallax'
      : state.trackingLost ? 'trackingLost'
      : (state.sceneLuma !== null && state.sceneLuma < 26) ? 'tooDark'
        : seg.noSky ? 'noSky'
        : seg.allSky ? 'allSky'
          : (clippedTop / seg.flags.length > 0.22) ? 'clippedTop' : 'ok';
    }

    // ---- overlap with the last accepted keyframe -------------------------
    const last = survey.keyframes[survey.keyframes.length - 1];
    if (last) {
      const travel = Math.abs(angDiff(state.fusedYaw, state.fusedYawAtKeyframe));
      state.overlap = clamp(1 - travel / camera.hfovDeg, 0, 1);
    } else {
      state.overlap = 1;
    }

    maybeKeyframe({ seg, quat, rawYaw, att, t });

    // Adopt the self-calibrated focal length once it settles.
    if (survey.focalPx && camera.focalSource !== 'self-calibrated') {
      const workFocal = survey.focalPx * (WORK_W / LUMA_W);
      if (camera.adoptFocal(workFocal)) {
        log('info', `Focal length self-calibrated: ${workFocal.toFixed(1)} px at ${WORK_W} px wide, giving ${camera.hfovDeg.toFixed(1)}° horizontal FOV.`);
        syncFovReadout();
      }
    }

    orientation.sampleDatum();
  } catch (err) {
    log('error', 'Frame processing failed:', err);
  } finally {
    state.processing = false;
  }
}

function maybeKeyframe({ seg, quat, rawYaw, att, t }) {
  if (!seg || seg.error) return;
  if (director.phase !== PHASE.PASS1 && director.phase !== PHASE.PASS2) return;
  if (state.frameStatus !== 'ok') return;
  const probe = state.obstructionProbe;
  if (!probe.active && Math.abs(att.roll) > 20) return;
  if (Math.abs(orientation.rotationRate) > (probe.active ? 3 : 18)) return;

  const stepDeg = Math.max(4, camera.hfovDeg * 0.35);
  const last = survey.keyframes[survey.keyframes.length - 1];
  let accept = false;

  if (probe.active) {
    accept = Math.abs(att.elevation) >= 20 &&
      Math.abs(att.elevation) <= ELEVATION_WARN_DEG &&
      orientation.stillness > 0.65 &&
      (t - probe.lastCaptureAt) > 500;
  } else if (!last) accept = true;
  else if (director.phase === PHASE.PASS1) {
    accept = Math.abs(angDiff(state.fusedYaw, state.fusedYawAtKeyframe)) >= stepDeg;
  } else {
    // Pass 2 collects confirmation frames while the operator holds on target.
    const onTarget = director.target &&
      Math.abs(angDiff(wrap360(director.target.fromDeg + director.target.widthDeg / 2), currentHeading())) < 6;
    accept = onTarget && orientation.stillness > 0.5 && (t - state.lastKeyframeAt) > 380;
  }
  if (!accept) return;

  const intr = camera.intrinsics();
  const captureYaw = probe.active ? probe.anchorYaw : state.fusedYaw;
  const kf = survey.addKeyframe({
    t: Date.now(),
    pass: director.phase === PHASE.PASS2 ? 2 : 1,
    // Stamp the intrinsics in force right now. If the platform swaps lenses
    // later, frames captured before the swap keep the geometry they were
    // actually taken with instead of being reprojected through the new lens.
    tanHalfH: intr.tanHalfH,
    tanHalfV: intr.tanHalfV,
    focalPx: camera.focalPx,
    quat,
    screenAngle: orientation.screenAngle,
    yawRaw: rawYaw,
    yawFused: captureYaw,
    yawBase: angDiff(captureYaw, rawYaw),
    captureKind: probe.active ? 'obstruction-probe' : 'sweep',
    elevation: att.elevation,
    roll: att.roll,
    compass: orientation.compassHeading,
    visualQuality: state.visualQuality,
    skyFraction: seg.skyFraction,
    height: WORK_H,
    boundary: Float32Array.from(seg.boundary),
    confidence: Float32Array.from(seg.confidence),
    flags: Uint8Array.from(seg.flags)
  });

  if (probe.active) {
    probe.frames++;
    probe.lastCaptureAt = t;
  } else {
    state.fusedYawAtKeyframe = state.fusedYaw;
  }
  state.lastKeyframeAt = t;

  survey._projectKeyframe(kf, camera.intrinsics());
  survey.recompute();

  // Thumbnails are captured for EVERY keyframe, regardless of the archive
  // setting. They used to be gated on "Embed keyframe images in archive",
  // which is a decision about export size — with the result that a survey run
  // with the box unticked could not be diagnosed afterwards at all. Storage and
  // export are now separate concerns: this always records, and the checkbox
  // only decides whether the images travel inside the .horizon-project file.
  captureThumb(kf);

  if (director.phase === PHASE.PASS2) {
    director.refreshTargets();
    if (!director.targets.length) log('info', 'All sectors verified.');
  }
}

function currentHeading() {
  return wrap360(state.fusedYaw + survey.yawDatum);
}

/* ------------------------------------------------------------- calibration */

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
  orientation.beginSpinDiagnostic();
  state.sensorCal = { stage: 'spin', startedAt: now };
  director.calibrationProgress = 0;
  syncControls();
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
    if (!stillNow) state.sensorCal.stillSince = now;
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

  if (state.sensorCal.stage === 'spin' || state.sensorCal.stage === 'upright-spin') {
    director.calibrationProgress = clamp(Math.abs(orientation.spinProgress()) / 360, 0, 1);
    return;
  }

  if (state.sensorCal.stage === 'failed') return;

  const att = orientation.attitude();
  const level = Math.abs(att.roll) <= 12;
  const still = orientation.stillness > 0.6;

  // Calibration exists only to fix the compass yaw datum, and the compass is
  // the input this design already treats as suspect — the mount supplies the
  // real azimuth later. A phone clamped to a steel mount head will sometimes
  // never produce a quiet magnetometer, so refusing to start the survey over it
  // blocks the whole tool on the one number that does not have to be right.
  // After 12 s of trying, proceed on a relative datum and say so.
  if (!state.calibGaveUp && now - (state.calibFirstTry || now) > 12000 && level && orientation.lastEventAt) {
    state.calibGaveUp = true;
    log('warn', `Sensor never settled — orientation jitter ±${(orientation.jitterDeg / 2).toFixed(1)}°, turn rate ${orientation.rotationRate.toFixed(1)}°/s. Continuing on a relative azimuth datum; set the offset from mount calibration after export.`);
    orientation.compassReliability = 'poor';
    finishCalibration();
    return;
  }
  if (!state.calibFirstTry) state.calibFirstTry = now;

  if (!level || !still || !orientation.lastEventAt) {
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
  survey.yawDatum = orientation.yawDatum;

  const luma = camera.grabLuma();
  if (luma) {
    state.targetLuma = true;
    pipeline.anchor(luma, LUMA_W, LUMA_H);
  }
  pipeline.resetRegistration();
  director.beginPass1(currentHeading());
  setTimeout(() => {
    if (!orientation.gyroAvailable) {
      log('warn', `No gyroscope after ${orientation.gyroSamples} devicemotion sample(s). Azimuth will be scaled by the field-of-view estimate, so complete a full lap and let loop closure calibrate the scale — that is what makes the result usable without a gyro.`);
    }
  }, 4000);
  log('info', `Pass 1 started at azimuth ${currentHeading().toFixed(1)}°.`);
  state.sensorCal = { stage: 'complete', startedAt: performance.now() };
  syncControls();
}

function finishSpinDiagnostic() {
  if (state.sensorCal.stage !== 'spin') return;
  const r = orientation.finishSpinDiagnostic();
  if (!r) return;
  log(r.scaleApplied ? 'info' : 'warn', 'SENSOR_360', JSON.stringify(r));
  log(r.scaleApplied ? 'info' : 'warn',
    `360 test: gyroscope measured ${r.measuredDeg.toFixed(2)}° in ${(r.durationMs / 1000).toFixed(1)} s; `
    + `proposed scale ${Number.isFinite(r.proposedScale) ? r.proposedScale.toFixed(5) : 'unavailable'}`
    + `${r.scaleApplied ? ' (applied)' : ' (not applied — outside conservative 0.8–1.2 range)'}; `
    + `compass closure ${Number.isFinite(r.compassClosureDeg) ? r.compassClosureDeg.toFixed(2) + '°' : 'unavailable'}; `
    + `flatness mean/max ${Number.isFinite(r.flatnessMeanDeg) ? r.flatnessMeanDeg.toFixed(2) : '—'}/`
    + `${Number.isFinite(r.flatnessMaxDeg) ? r.flatnessMaxDeg.toFixed(2) : '—'}°.`);
  if (r.trace) {
    log('info', 'SENSOR_360_TRACE',
      `projected signed/absolute/positive/negative ${r.trace.projectedSignedDeg.toFixed(2)}/`
      + `${r.trace.projectedAbsoluteDeg.toFixed(2)}/${r.trace.projectedPositiveDeg.toFixed(2)}/`
      + `${r.trace.projectedNegativeDeg.toFixed(2)}°; raw XYZ signed `
      + `${r.trace.rawAxisSignedDeg.map(v => v.toFixed(2)).join('/') }°; raw XYZ absolute `
      + `${r.trace.rawAxisAbsoluteDeg.map(v => v.toFixed(2)).join('/') }°; orientation alpha travel `
      + `${r.trace.orientationAlphaTravel.toFixed(2)}°; dt accepted/rejected `
      + `${r.trace.acceptedDt}/${r.trace.rejectedDt}; rate min/max `
      + `${r.trace.rateMin?.toFixed(2) ?? '—'}/${r.trace.rateMax?.toFixed(2) ?? '—'}°/s.`);
  }
  orientation.beginSpinDiagnostic('upright');
  state.sensorCal = { stage: 'upright-spin', startedAt: performance.now() };
  director.calibrationProgress = 0;
  syncControls();
}

function finishUprightSpinDiagnostic() {
  if (state.sensorCal.stage !== 'upright-spin') return;
  const r = orientation.finishSpinDiagnostic();
  if (!r) return;
  log('info', 'SENSOR_UPRIGHT_360', JSON.stringify(r));
  if (r.trace) {
    log('info', 'SENSOR_UPRIGHT_360_TRACE',
      `raw XYZ signed ${r.trace.rawAxisSignedDeg.map(v => v.toFixed(2)).join('/')}°; `
      + `raw XYZ absolute ${r.trace.rawAxisAbsoluteDeg.map(v => v.toFixed(2)).join('/')}°; `
      + `projected signed/absolute ${r.trace.projectedSignedDeg.toFixed(2)}/${r.trace.projectedAbsoluteDeg.toFixed(2)}°; `
      + `dt accepted/rejected ${r.trace.acceptedDt}/${r.trace.rejectedDt}; `
      + `rate min/max ${r.trace.rateMin?.toFixed(2) ?? '—'}/${r.trace.rateMax?.toFixed(2) ?? '—'}°/s.`);
  }

  const flat = orientation.flatSpinDiagnostic;
  const dominant = result => {
    const axes = result?.trace?.rawAxisSignedDeg || [0, 0, 0];
    let index = 0;
    for (let i = 1; i < axes.length; i++) if (Math.abs(axes[i]) > Math.abs(axes[index])) index = i;
    return { index, axis: ['x', 'y', 'z'][index], degrees: axes[index] };
  };
  const flatAxis = dominant(flat);
  const uprightAxis = dominant(r);
  const flatValid = Math.abs(flatAxis.degrees) >= 270 && Math.abs(flatAxis.degrees) <= 450;
  const uprightRawValid = Math.abs(uprightAxis.degrees) >= 270 && Math.abs(uprightAxis.degrees) <= 450;
  const uprightProjectedValid = Math.abs(r.measuredDeg) >= 270 && Math.abs(r.measuredDeg) <= 450;
  const uprightClosureValid = !Number.isFinite(r.orientationClosureDeg) || Math.abs(r.orientationClosureDeg) <= 30;
  const counterClockwiseSignValid = r.measuredDeg <= -270;
  const uprightValid = uprightRawValid && uprightProjectedValid && uprightClosureValid && counterClockwiseSignValid;
  const uniqueAxes = flatAxis.index !== uprightAxis.index;
  log(uprightValid ? (flatValid && uniqueAxes ? 'info' : 'warn') : 'error', 'SENSOR_AXIS_MAP',
    JSON.stringify({
      flat: flatAxis, upright: uprightAxis, uniqueAxes, flatValid,
      uprightRawValid, uprightProjectedValid, uprightClosureValid, counterClockwiseSignValid, uprightValid
    }));

  // The upright turn is the operational test: it exercises exactly the pose
  // and world-vertical projection used during a horizon survey. A failed flat
  // test remains valuable diagnostic evidence, but must not veto a proven-good
  // upright survey axis.
  if (!uprightValid) {
    // The single most common way this test "fails" is the operator turning
    // clockwise. Magnitude, raw axis and closure all check out, only the sign
    // is positive — that is a wrong-way turn, not a broken sensor, and it
    // deserves a one-tap redo of just this step rather than a dead end.
    const wrongDirection = uprightRawValid && uprightProjectedValid && uprightClosureValid
      && r.measuredDeg >= 270;
    if (wrongDirection) {
      log('warn', 'SENSOR_AXIS_TEST_WRONG_DIRECTION',
        `The upright rotation measured +${r.measuredDeg.toFixed(0)}° — a full clockwise turn where counter-clockwise was needed. The sensor looks fine; redo just this step turning the other way (to your left).`);
      state.sensorCal = { stage: 'failed', reason: 'wrong-direction', startedAt: performance.now() };
    } else {
      // Before declaring the sensor broken, try solving the axis mapping. Some
      // devices report rotationRate components transposed relative to their own
      // orientation frame; both spins showing clean full turns on the WRONG raw
      // axes is the signature (field case 2026-08-12: flat on y, upright on z).
      const solved = orientation.solveGyroAxisMap();
      if (solved.status === 'remapped') {
        log('warn', 'SENSOR_AXIS_MAP_SOLVED', JSON.stringify({
          perm: solved.perm, signs: solved.signs,
          residualDeg: Number(solved.residualDeg.toFixed(2)),
          projections: solved.projections.map(p => Number(p.toFixed(1))),
          leftHanded: solved.leftHanded
        }));
        log('warn',
          `This phone reports its gyroscope axes in a non-standard order${solved.leftHanded ? ' (mirrored)' : ''}. `
          + `Solved the mapping from your two turns: once remapped, the flat turn projects to ${solved.projections[0].toFixed(0)}° and the upright turn to ${solved.projections[1].toFixed(0)}° (residual ${solved.residualDeg.toFixed(1)}°). Applying it. `
          + `This assumes both turns were counter-clockwise as instructed — if they were not, azimuth will run backwards, which the landmark check will expose.`);
        const scale = 360 / Math.abs(solved.projections[0]);
        if (scale >= 0.8 && scale <= 1.2) {
          orientation.gyroScale = scale;
          log('info', `Gyro scale ${scale.toFixed(3)} adopted from the remapped flat turn.`);
        }
        state.sensorCal = { stage: 'settle', startedAt: performance.now() };
        state.calibStart = performance.now();
        state.calibFirstTry = 0;
        director.calibrationProgress = 0;
        syncControls();
        return;
      }
      log('error', 'SENSOR_AXIS_TEST_FAILED',
        `The upright counter-clockwise rotation did not produce about -360° in projected survey yaw, a matching raw-axis turn, and closure near its starting orientation, and the axis-map solver could not recover it (${solved.status}). Survey capture is blocked.`);
      state.sensorCal = { stage: 'failed', reason: 'bad-axis-map', startedAt: performance.now() };
    }
    state.paused = true;
    director.calibrationProgress = 0;
    syncControls();
    return;
  }
  state.sensorCal = { stage: 'settle', startedAt: performance.now() };
  state.calibStart = performance.now();
  state.calibFirstTry = 0;
  director.calibrationProgress = 0;
  syncControls();
}

/** Re-run a failed rotation test in place. A field reload costs the camera
 *  grant, the lens pin, and any preflight work — never require one while the
 *  sensors are demonstrably producing samples. */
function retrySensorTest() {
  const reason = state.sensorCal.reason;
  state.paused = false;
  director.calibrationProgress = 0;
  if (reason === 'wrong-direction') {
    orientation.beginSpinDiagnostic('upright');
    state.sensorCal = { stage: 'upright-spin', startedAt: performance.now() };
    log('info', 'Retrying the upright test only. Rotate counter-clockwise — to your LEFT.');
  } else {
    orientation.beginSpinDiagnostic();
    state.sensorCal = { stage: 'spin', startedAt: performance.now() };
    log('info', 'Retrying the rotation tests from the flat spin.');
  }
  syncControls();
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
    orientation.beginStationaryDiagnostic();
    state.sensorCal = { stage: 'stationary', startedAt: performance.now() };
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

async function finishPass1() {
  director.setPhase(PHASE.ANALYSING);
  syncControls();
  await new Promise(r => setTimeout(r, 30));

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

  const k = Math.round(accumulated / 360) || (accumulated >= 0 ? 1 : -1);
  if (residual !== null) {
    const closure = accumulated + residual;
    const error = closure - 360 * k;
    log('info', `Gyro/visual accumulated rotation: ${accumulated.toFixed(2)}°`);
    log('info', `Visual loop closure:             ${closure.toFixed(2)}°`);
    log('info', `Residual error:                  ${error.toFixed(2)}°`);
    survey.applyLoopClosure(error);
  }

  survey.reproject(camera.intrinsics());
  director.beginPass2();
  log('info', `Verification pass planned: ${director.targets.length} sector(s) need more evidence.`);
  updateReport();
  syncControls();
}

function finishSurvey() {
  director.setPhase(PHASE.VALIDATING);
  survey.recompute();
  updateReport();
  director.setPhase(PHASE.COMPLETE);
  state.paused = true;
  syncControls();
  log('info', 'Survey complete.');
}

/** Archives record the mode their acceptance thresholds were set by; restoring
 *  a project must restore it too, or a reopened tripod survey would be judged
 *  against handheld gates. */
function restoreMode(project) {
  const id = project?.capture?.mode?.id;
  if (!id) return;
  director.phase = PHASE.IDLE;
  if (director.setMode(id)) {
    $('modeSelect').value = id;
    $('modeHint').textContent = director.mode.setupDetail;
  }
}

function resetSurvey() {
  survey.reset();
  director.phase = PHASE.IDLE;
  director.pass1Travel = 0;
  director.targets = [];
  director.target = null;
  state.fusedYaw = 0;
  state.prevRawYaw = null;
  state.prevGyroYaw = null;
  state.announcedSource = false;
  state.visualScale = null;
  state.calibFirstTry = 0;
  state.calibGaveUp = false;
  state.visualSign = null;
  state.signSamples = [];
  state.sensorCal = { stage: 'idle', startedAt: 0 };
  state.obstructionProbe = {
    active: false, anchorYaw: null, startedAt: 0, frames: 0,
    lastCaptureAt: 0, parallax: false
  };
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

/* ------------------------------------------------------------------ render */

function renderLive() {
  const att = orientation.attitude();
  const heading = currentHeading();

  const ctx = {
    heading,
    elevation: att.elevation,
    roll: att.roll,
    rotationRate: Math.abs(orientation.rotationRate),
    stillness: orientation.stillness,
    overlap: state.overlap,
    frameStatus: state.frameStatus,
    visualQuality: state.visualQuality,
    jitterDeg: orientation.jitterDeg,
    calStalledMs: director.phase === 'calibrating' ? performance.now() - (state.calibStart || performance.now()) : 0,
    hfovDeg: camera.hfovDeg
  };
  let d = director.directive(ctx);
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
  } else if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === 'spin') {
    const travelled = Math.abs(orientation.spinProgress());
    d = {
      tone: travelled >= 270 ? 'good' : 'work',
      headline: 'Rotate once counter-clockwise',
      detail: `${travelled.toFixed(0)}° measured. Keep the screen face up and turn the phone counter-clockwise (to your LEFT) roughly one full circle, then press Finish. It does not need to be exact — direction matters, precision does not.`,
      progress: clamp(travelled / 360, 0, 1),
      arrow: -1
    };
    $('primaryBtn').textContent = `Finish 360° test — ${travelled.toFixed(0)}°`;
    $('primaryBtn').disabled = travelled < 270 && performance.now() - state.sensorCal.startedAt < 8000;
  } else if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === 'upright-spin') {
    const travelled = Math.abs(orientation.spinProgress());
    d = {
      tone: travelled >= 270 ? 'good' : 'work',
      headline: 'Sweep upright counter-clockwise',
      detail: `${travelled.toFixed(0)}° measured. Hold the phone upright as you will during the survey and turn yourself counter-clockwise (to your LEFT) through roughly one full circle, then press Finish. A rough circle is fine — direction matters, precision does not.`,
      progress: clamp(travelled / 360, 0, 1),
      arrow: -1
    };
    $('primaryBtn').textContent = `Finish upright test — ${travelled.toFixed(0)}°`;
    $('primaryBtn').disabled = travelled < 270 && performance.now() - state.sensorCal.startedAt < 8000;
  } else if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === 'settle') {
    d.detail = 'Now lift the phone into its normal upright scanning position and hold it still. This final step establishes the survey datum.';
  } else if (director.phase === PHASE.CALIBRATING && state.sensorCal.stage === 'failed') {
    const reason = state.sensorCal.reason;
    const texts = {
      'wrong-direction': ['Turned the wrong way',
        'That was a full clockwise turn — the sensor looks fine. Press Retry and rotate the other way: counter-clockwise, to your LEFT.'],
      'bad-axis-map': ['360° sensor test failed',
        'The gyroscope produced samples but did not integrate one physical turn correctly. Retry the rotation tests (turn smoothly, keep the pose steady), or continue with azimuth unverified and check it against landmarks afterwards.'],
      'bad-lap': ['360° sensor test failed',
        'The gyroscope produced samples but did not integrate one physical turn correctly. Retry the rotation tests (turn smoothly, keep the pose steady), or continue with azimuth unverified and check it against landmarks afterwards.'],
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
  } else if (state.obstructionProbe.active) {
    const probe = state.obstructionProbe;
    const elevation = Math.abs(att.elevation);
    if (probe.parallax) {
      d = {
        tone: 'fix',
        headline: 'Phone position moved',
        detail: 'Finish this probe and retry from the original spot. For a nearby roof, even a small sideways movement changes the measured direction.',
        progress: 0,
        arrow: null
      };
    } else if (elevation > ELEVATION_WARN_DEG) {
      d = {
        tone: 'fix',
        headline: 'Tilt down below 70°',
        detail: `Currently ${elevation.toFixed(1)}°. Do not point near the zenith; yaw becomes inaccurate there and frames above ${ELEVATION_HARD_LIMIT_DEG}° are rejected.`,
        progress: clamp(probe.frames / 4, 0, 1),
        arrow: null
      };
    } else if (Math.abs(orientation.rotationRate) > 3 || orientation.stillness < 0.65) {
      d = {
        tone: 'work',
        headline: 'Hold the phone still',
        detail: 'Keep it in the same physical spot and aim at the roof/sky boundary. Capturing begins automatically once the motion settles.',
        progress: clamp(probe.frames / 4, 0, 1),
        arrow: null
      };
    } else {
      d = {
        tone: probe.frames >= 4 ? 'good' : 'work',
        headline: probe.frames >= 4 ? 'High obstruction captured' : 'Capturing high obstruction',
        detail: `${probe.frames} still frame${probe.frames === 1 ? '' : 's'} captured at this azimuth. Press Finish probe, tilt back down, and continue counter-clockwise.`,
        progress: clamp(probe.frames / 4, 0, 1),
        arrow: null
      };
    }
  } else if ((director.phase === PHASE.PASS1 || director.phase === PHASE.PASS2) &&
             Math.abs(att.elevation) > ELEVATION_WARN_DEG) {
    d = {
      tone: 'fix',
      headline: 'Tilt down — use the obstruction probe',
      detail: `Continuous rotation this high is inaccurate. Tilt below ${ELEVATION_WARN_DEG}°, keep the phone in one spot, then press Capture high obstruction for the nearby roof.`,
      progress: d.progress,
      arrow: null
    };
  }

  $('directive').dataset.tone = d.tone;
  $('directiveHead').textContent = d.headline;
  $('directiveDetail').textContent = d.detail;
  $('directiveBar').style.width = `${((d.progress ?? director.verifiedFraction()) * 100).toFixed(1)}%`;

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

  drawOverlay($('overlay'), state.frame, d);
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
  lines.push(`Maximum spread         ${c.maxSpread.toFixed(2)}°`);
  lines.push(`Mean segmentation conf ${(c.meanConfidence * 100).toFixed(1)}%`);
  lines.push(`Visual loop error      ${survey.loopClosed ? survey.loopError.toFixed(2) + '°' : 'not measured'}`);
  lines.push('');
  lines.push(`Rotation source        ${h.gyro === 'available' ? 'gyroscope (metric)' : 'visual only (scaled by field of view)'}`);
  if (state.visualScale !== null) {
    lines.push(`Visual/gyro scale      ${state.visualScale.toFixed(3)} — field of view is ${state.visualScale > 1 ? 'under' : 'over'}stated by ${Math.abs(1 - state.visualScale) * 100 < 200 ? (Math.abs(1 - state.visualScale) * 100).toFixed(0) + '%' : 'a lot'}`);
  }
  lines.push(`Capture mode           ${director.mode.label}`);
  if (survey.lensChanges.length) {
    lines.push(`Lens changes mid-scan  ${survey.lensChanges.length} (${survey.lensChanges.map(c => c.ratio.toFixed(2) + 'x').join(', ')})`);
  }
  lines.push(`Keyframes              ${survey.keyframes.length}`);
  lines.push(`  normal sweep         ${survey.keyframes.filter(k => k.captureKind !== 'obstruction-probe').length}`);
  lines.push(`  high obstruction     ${survey.keyframes.filter(k => k.captureKind === 'obstruction-probe').length}`);
  lines.push('Profile provenance     measured / interpolated / uncertain');
  lines.push(`Field of view          ${camera.hfovDeg.toFixed(2)}° horizontal (${camera.focalSource})`);
  lines.push(`Compass reliability    ${h.compassReliability}${h.compassChecks ? ` (${h.compassRejects}/${h.compassChecks} rejected)` : ''}`);
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

function syncControls() {
  const p = director.phase;
  const btn = $('primaryBtn'), probeBtn = $('probeBtn'), sec = $('secondaryBtn'), abort = $('abortBtn');
  sec.hidden = !state.running;
  abort.hidden = !state.running;
  probeBtn.hidden = !state.running || (p !== PHASE.PASS1 && p !== PHASE.PASS2);
  probeBtn.textContent = state.obstructionProbe.active
    ? `Finish probe (${state.obstructionProbe.frames} frames)`
    : 'Capture high obstruction';
  sec.textContent = state.paused ? 'Resume' : 'Pause';

  if (!state.running) { btn.textContent = 'Start camera and sensors'; btn.disabled = false; return; }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === 'spin') {
    btn.textContent = 'Finish 360° test';
    btn.disabled = orientation.gyroSamples > 20;
    return;
  }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === 'upright-spin') {
    btn.textContent = 'Finish upright test';
    btn.disabled = orientation.gyroSamples > 20;
    return;
  }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === 'stationary') {
    btn.textContent = 'Measuring stationary sensors…';
    btn.disabled = true;
    return;
  }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === 'failed') {
    const reason = state.sensorCal.reason;
    if (reason === 'no-samples') {
      btn.textContent = 'Reload and retry sensors';
      sec.hidden = true;
    } else {
      btn.textContent = reason === 'wrong-direction' ? 'Retry upright test (turn LEFT)' : 'Retry rotation tests';
      // The escape hatch: only offered while the gyro is producing samples —
      // with no sensors there is nothing to proceed with.
      sec.hidden = false;
      sec.textContent = 'Continue anyway — azimuth unverified';
    }
    btn.disabled = false;
    return;
  }
  if (p === PHASE.CALIBRATING) { btn.textContent = 'Calibrating…'; btn.disabled = true; return; }
  if (p === PHASE.PASS1) {
    const enough = Math.abs(director.pass1Travel) >= 300 || survey.coverage().observedBins >= 700;
    btn.textContent = enough
      ? 'Close the loop and plan verification'
      : `Keep turning — ${Math.abs(director.pass1Travel).toFixed(0)}° of 360° (${survey.coverage().observedBins} of 720 bins seen)`;
    // Never trap the operator behind a counter. If the ring shows the circle is
    // covered, the lap happened, whatever the accumulator says.
    btn.disabled = false;
    btn.disabled = !enough;
    return;
  }
  if (p === PHASE.ANALYSING) { btn.textContent = 'Analysing…'; btn.disabled = true; return; }
  if (p === PHASE.PASS2) { btn.textContent = 'Finish survey'; btn.disabled = false; return; }
  if (p === PHASE.COMPLETE) { btn.textContent = 'Start a new survey'; btn.disabled = false; return; }
  btn.textContent = 'Working…'; btn.disabled = true;
}

function onPrimary() {
  const p = director.phase;
  if (!state.running) return startCapture();
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === 'failed') {
    return state.sensorCal.reason === 'no-samples' ? location.reload() : retrySensorTest();
  }
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === 'spin') return finishSpinDiagnostic();
  if (p === PHASE.CALIBRATING && state.sensorCal.stage === 'upright-spin') return finishUprightSpinDiagnostic();
  if (p === PHASE.PASS1) return finishPass1();
  if (p === PHASE.PASS2) return finishSurvey();
  if (p === PHASE.COMPLETE) return resetSurvey();
}

function toggleObstructionProbe() {
  if (director.phase !== PHASE.PASS1 && director.phase !== PHASE.PASS2) return;
  const probe = state.obstructionProbe;
  if (!probe.active) {
    probe.active = true;
    probe.anchorYaw = state.fusedYaw;
    probe.startedAt = performance.now();
    probe.frames = 0;
    probe.lastCaptureAt = 0;
    probe.parallax = false;
    pipeline.resetRegistration();
    log('info', 'HIGH_OBSTRUCTION_PROBE started', {
      anchorYaw: probe.anchorYaw,
      heading: currentHeading(),
      recommendedMaxElevationDeg: ELEVATION_WARN_DEG,
      hardLimitDeg: ELEVATION_HARD_LIMIT_DEG
    });
  } else {
    log(probe.parallax || probe.frames < 2 ? 'warn' : 'info', 'HIGH_OBSTRUCTION_PROBE finished', {
      anchorYaw: probe.anchorYaw,
      frames: probe.frames,
      parallaxRejected: probe.parallax,
      durationMs: Math.round(performance.now() - probe.startedAt)
    });
    probe.active = false;
    probe.anchorYaw = null;
    state.fusedYawAtKeyframe = state.fusedYaw;
    pipeline.resetRegistration();
  }
  syncControls();
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
    warned: false, storeWarned: false
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
function captureThumb(kf) {
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
  camera.grabKeyframeThumb().then(blob => {
    b.pending--;
    if (!blob || !state.sessionId) return;
    b.stored++; b.bytes += blob.size;
    store.putKeyframeThumb(state.sessionId, kf.index, blob).catch(e => {
      b.stored--; b.bytes -= blob.size;
      if (!b.storeWarned) {
        b.storeWarned = true;
        log('warn', `Could not store a keyframe image: ${e && e.message || e}. The survey continues; the stitched view will be incomplete.`);
      }
    });
  }).catch(() => { b.pending--; });
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
async function loadKeyframeSources(keyframes) {
  if (!state.sessionId) return { sources: [], found: 0 };
  let records = [];
  try {
    records = await store.getKeyframeThumbs(state.sessionId);
  } catch (e) {
    log('warn', `Could not read keyframe thumbnails: ${e && e.message || e}`);
    return { sources: [], found: 0 };
  }
  const byIndex = new Map(records.map(r => [r.index, r.blob]));
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  const sources = [];
  let found = 0;
  for (const kf of keyframes) {
    const blob = byIndex.get(kf.index);
    if (!blob) { sources.push(null); continue; }
    try {
      const bmp = await createImageBitmap(blob);
      scratch.width = bmp.width; scratch.height = bmp.height;
      sctx.drawImage(bmp, 0, 0);
      const d = sctx.getImageData(0, 0, bmp.width, bmp.height);
      sources.push({ w: bmp.width, h: bmp.height, data: d.data });
      if (bmp.close) bmp.close();
      found++;
    } catch {
      sources.push(null);
    }
  }
  return { sources, found };
}

async function buildPanorama() {
  const btn = $('panoBtn');
  const status = $('panoStatus');
  const kfs = survey.keyframes;
  if (!kfs.length) {
    status.textContent = 'No keyframes yet. Run a survey, or load a session, then build.';
    return;
  }
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Building…';
  status.textContent = `Reprojecting ${kfs.length} keyframes…`;
  // Yield so the button state paints before the synchronous mosaic pass.
  await new Promise(r => requestAnimationFrame(() => r()));

  try {
    const wantImagery = $('panoImagery').checked;
    const { sources, found } = wantImagery
      ? await loadKeyframeSources(kfs)
      : { sources: [], found: 0 };

    const pxPerDeg = Number($('panoScale').value) || 6;
    const maxAlt = Number($('maxAltSelect').value) || 60;
    const opts = { pxPerDeg, altMin: -10, altMax: Math.min(89, maxAlt + 2), azStart: 0 };

    const t0 = performance.now();
    const mosaic = buildMosaic({
      keyframes: kfs, sources, yawDatum: survey.yawDatum || 0, ...opts
    });
    const tracks = skylineTracks(kfs, survey.yawDatum || 0, opts);
    const dis = disagreementByBin(kfs, survey.yawDatum || 0);
    const ms = performance.now() - t0;

    const ctx = $('pano').getContext('2d');
    const layout = drawPanorama(ctx, mosaic, tracks, survey.bins, {});
    state.pano = state.pano || { landmarks: [], geomKey: null };
    // A landmark's graphed azimuth was read off a particular rendering. If the
    // focal length or the yaw datum has moved since — loop closure, a lens
    // change, a fresh self-calibration — the physical object now sits at a
    // different azimuth and the stored number is stale. Detect that rather than
    // letting a quietly-wrong residual drive a conclusion.
    const geomKey = [
      (survey.yawDatum || 0).toFixed(4),
      kfs.length,
      (kfs[0] && kfs[0].tanHalfH || 0).toFixed(5),
      (kfs[kfs.length - 1] && kfs[kfs.length - 1].tanHalfH || 0).toFixed(5)
    ].join('|');
    if (state.pano.landmarks.length && state.pano.geomKey && state.pano.geomKey !== geomKey) {
      state.pano.stale = true;
      log('warn', `The survey geometry changed since these ${state.pano.landmarks.length} landmarks were placed, so their graphed azimuths no longer describe the same objects. Re-tap them before trusting the residuals.`);
    }
    state.pano.geomKey = geomKey;
    state.pano.opts = opts;
    state.pano.layout = layout;
    renderLandmarks();
    panoBuilt = true;
    $('panoSaveBtn').disabled = false;

    const coverage = mosaic.painted / (mosaic.width * mosaic.height) * 100;
    status.textContent = found
      ? `${kfs.length} keyframes, ${found} with imagery, ${coverage.toFixed(0)}% of the sky panel painted, ${ms.toFixed(0)} ms.`
      : `${kfs.length} keyframes, geometry only — no stored photos for this session. Tick "Embed thumbnails" before the next survey to get imagery here.`;

    $('panoFindings').textContent = panoramaFindings(dis, mosaic, found, kfs);
    log('info', `Diagnostic panorama built: ${kfs.length} keyframes, imagery for ${found}, ${coverage.toFixed(1)}% painted, ${ms.toFixed(0)} ms.`);
  } catch (e) {
    status.textContent = `Could not build the panorama: ${e && e.message || e}`;
    log('error', 'Panorama build failed', { error: String(e && e.stack || e) });
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

/**
 * Turn the mosaic into numbers. The picture localises a fault; these lines say
 * which fault it is, and they are deliberately stated as measurements with
 * their own caveats rather than as verdicts.
 */
function panoramaFindings(dis, mosaic, found, kfs) {
  const lines = [];
  const spans = dis.filter(d => d.n >= 2).map(d => d.span).sort((a, b) => a - b);
  const q = f => spans.length ? spans[Math.min(spans.length - 1, Math.floor(f * (spans.length - 1)))] : NaN;
  const med = q(0.5), p95 = q(0.95);

  lines.push(`bins with 2+ independent looks   ${spans.length} of ${BIN_COUNT}`);
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
  if (gaps) lines.push(`\nbins never observed             ${gaps}  (hatched in the image)`);
  const single = dis.filter(d => d.n === 1).length;
  if (single) lines.push(`bins seen by one frame only     ${single}  (no cross-check possible)`);

  if (!found) {
    lines.push('');
    lines.push('Geometry only — no keyframe photos stored for this session, so the');
    lines.push('numbers above stand but the picture cannot show you why.');
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
      keyframes: survey.keyframes.length,
      keyframeSources: {
        sweep: survey.keyframes.filter(k => k.captureKind !== 'obstruction-probe').length,
        highObstruction: survey.keyframes.filter(k => k.captureKind === 'obstruction-probe').length
      },
      obstructionProbe: { ...state.obstructionProbe },
      elevationPolicyDeg: {
        visualYawDisabledAbove: VISUAL_YAW_MAX_ELEVATION,
        warnAbove: ELEVATION_WARN_DEG,
        rejectAbove: ELEVATION_HARD_LIMIT_DEG
      },
      coverage: survey.coverage()
    },
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
  $('probeBtn').addEventListener('click', toggleObstructionProbe);
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

  $('modeSelect').addEventListener('change', e => {
    if (director.setMode(e.target.value)) {
      const m = director.mode;
      log('info', `Capture mode set to ${m.label}: max ${m.maxRate}°/s, roll within ±${m.rollLimitScan}°, minimum overlap ${(m.minOverlap * 100).toFixed(0)}%.`);
      $('modeHint').textContent = m.setupDetail;
    } else {
      e.target.value = director.mode.id;
      log('warn', 'Capture mode cannot change once the survey has started. Reset first.');
    }
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
log('info', 'Horizon Survey ready.', JSON.stringify({
  ua: navigator.userAgent, secure: window.isSecureContext,
  dpr: window.devicePixelRatio || 1, screen: `${screen.width}x${screen.height}`,
  workers: typeof Worker !== 'undefined', idb: 'indexedDB' in window
}));
requestAnimationFrame(loop);
