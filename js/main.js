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

const $ = id => document.getElementById(id);
const log = (level, ...a) => L.log(level, ...a);

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
  targetLuma: null
};

const PROCESS_INTERVAL_MS = 110;
const RENDER_INTERVAL_MS = 55;

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
    state.frameCount++;

    // Predict the pixel shift from the orientation stream so the visual search
    // starts in the right neighbourhood. Withheld until the sign convention is
    // known, because an inverted hint is the one error the matcher cannot undo.
    const dGyroPredict = state.prevRawYaw === null ? 0 : angDiff(rawYaw, state.prevRawYaw);
    let hintX;
    if (state.visualSign !== null) {
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
      if (state.visualSign === null) {
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
      const lensChange = survey.addFocalSample(r.dx, dGyro, att.elevation, r.quality);
      if (lensChange) {
        const oldFov = camera.hfovDeg;
        camera.adoptFocal(lensChange.to * (WORK_W / LUMA_W));
        $('fovRange').value = camera.hfovDeg.toFixed(1);
        $('fovOut').textContent = `${camera.hfovDeg.toFixed(1)}°`;
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
        if (state.visualSign !== null && r.quality > 0.6 && Math.abs(dGyro) > 0.5) {
          const ratio = dVis / dGyro;
          if (ratio > 0.2 && ratio < 5) {
            state.visualScale = state.visualScale === null
              ? ratio : 0.98 * state.visualScale + 0.02 * ratio;
          }
          // Opposed signs on a confident match means one of them is wrong;
          // trust neither for this frame rather than averaging them.
          if (dVis * dGyro < 0 && Math.abs(dVis) > 1) dFused = 0;
        }
      } else if (state.visualSign !== null && r.quality > 0.25 && Math.abs(dVis) < 25) {
        // No usable gyroscope. Vision alone, and the scale is only as good as
        // the focal length, so say so once rather than pretending otherwise.
        dFused = dVis;
        if (!state.warnedVisualOnly) {
          state.warnedVisualOnly = true;
          log('warn', 'No gyroscope available — azimuth is being scaled by the field-of-view estimate, so a wrong field of view becomes a wrong azimuth. Run the pre-flight sweep before trusting the result.');
        }
      } else if (state.visualSign !== null && Math.abs(dVis) < 25) {
        // Weak but not absent. Advancing on a poor match is far better than
        // discarding real rotation: dropping frames is what turned a physical
        // 360 degree lap into a logged 176.
        dFused = dVis;
      } else {
        dFused = 0;
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
      state.frameStatus = state.trackingLost ? 'trackingLost'
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
        $('fovRange').value = camera.hfovDeg.toFixed(1);
        $('fovOut').textContent = `${camera.hfovDeg.toFixed(1)}°`;
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
  if (Math.abs(att.roll) > 20) return;
  if (Math.abs(orientation.rotationRate) > 18) return;

  const stepDeg = Math.max(4, camera.hfovDeg * 0.35);
  const last = survey.keyframes[survey.keyframes.length - 1];
  let accept = false;

  if (!last) accept = true;
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
    yawFused: state.fusedYaw,
    yawBase: angDiff(state.fusedYaw, rawYaw),
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

  state.fusedYawAtKeyframe = state.fusedYaw;
  state.lastKeyframeAt = t;

  survey._projectKeyframe(kf, camera.intrinsics());
  survey.recompute();

  // Thumbnails are only captured when the archive will embed them, to keep
  // memory sane across a long survey.
  if ($('embedThumbs').checked) {
    camera.grabKeyframeThumb().then(blob => {
      if (!blob || !state.sessionId) return;
      store.putKeyframeThumb(state.sessionId, kf.index, blob).catch(() => {});
    });
  }

  if (director.phase === PHASE.PASS2) {
    director.refreshTargets();
    if (!director.targets.length) log('info', 'All sectors verified.');
  }
}

function currentHeading() {
  return wrap360(state.fusedYaw + survey.yawDatum);
}

/* ------------------------------------------------------------- calibration */

function tickCalibration(now) {
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
      $('fovRange').value = camera.hfovDeg.toFixed(1);
      $('fovOut').textContent = `${camera.hfovDeg.toFixed(1)}°`;
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
  state.frame = null;
  state.thumbs = {};
  pipeline.resetRegistration();
  if (state.running) { director.beginCalibration(); state.calibStart = performance.now(); }
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
  const d = director.directive(ctx);

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
  const h = orientation.health();
  lines.push(`Rotation source        ${h.gyro === 'available' ? 'gyroscope (metric)' : 'visual only (scaled by field of view)'}`);
  if (state.visualScale !== null) {
    lines.push(`Visual/gyro scale      ${state.visualScale.toFixed(3)} — field of view is ${state.visualScale > 1 ? 'under' : 'over'}stated by ${Math.abs(1 - state.visualScale) * 100 < 200 ? (Math.abs(1 - state.visualScale) * 100).toFixed(0) + '%' : 'a lot'}`);
  }
  lines.push(`Capture mode           ${director.mode.label}`);
  if (survey.lensChanges.length) {
    lines.push(`Lens changes mid-scan  ${survey.lensChanges.length} (${survey.lensChanges.map(c => c.ratio.toFixed(2) + 'x').join(', ')})`);
  }
  lines.push(`Keyframes              ${survey.keyframes.length}`);
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
  const btn = $('primaryBtn'), sec = $('secondaryBtn'), abort = $('abortBtn');
  sec.hidden = !state.running;
  abort.hidden = !state.running;
  sec.textContent = state.paused ? 'Resume' : 'Pause';

  if (!state.running) { btn.textContent = 'Start camera and sensors'; btn.disabled = false; return; }
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
  if (p === PHASE.PASS1) return finishPass1();
  if (p === PHASE.PASS2) return finishSurvey();
  if (p === PHASE.COMPLETE) return resetSurvey();
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
  $('secondaryBtn').addEventListener('click', () => { state.paused = !state.paused; syncControls(); });
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

  $('fovRange').addEventListener('input', e => {
    camera.setHfov(Number(e.target.value));
    $('fovOut').textContent = `${camera.hfovDeg.toFixed(1)}°`;
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
      $('fovRange').value = camera.hfovDeg.toFixed(1);
      $('fovOut').textContent = `${camera.hfovDeg.toFixed(1)}°`;
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
      camera.setHfov(Number(b.dataset.fov));
      camera.focalSource = 'preset';
      $('fovRange').value = camera.hfovDeg.toFixed(1);
      $('fovOut').textContent = `${camera.hfovDeg.toFixed(1)}°`;
      log('info', `Field of view seeded to ${camera.hfovDeg}° from a preset. This is still a seed — run the pre-flight sweep to measure it.`);
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
  $('copyLogBtn').addEventListener('click', async () => { const ok = await L.copy(); log('info', ok ? 'Log copied.' : 'Copy refused.'); });
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
