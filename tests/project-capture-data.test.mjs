import { buildProject } from '../js/exporters.js';

const captureTiming = {
  performanceMs: 4000,
  videoCurrentTimeSec: 12.25,
  motionSampleCount: 22
};
const survey = {
  startedAt: Date.UTC(2026, 7, 15),
  loopError: null,
  loopClosed: false,
  focalPx: 456,
  manualEdits: 0,
  bins: [],
  keyframes: [{
    index: 0, t: Date.UTC(2026, 7, 15), pass: 1, captureKind: 'sweep',
    tanHalfH: 0.42, tanHalfV: 0.315, focalPx: 456,
    photoWidth: 640, photoHeight: 480, captureTiming,
    quat: [1, 0, 0, 0], screenAngle: 0, yawRaw: 0, yawFused: 0,
    yawBase: 0, yawCorrection: 0, elevation: 0, roll: 0, compass: 0,
    orientationSample: null, gyro: { motionWindow: [{ offsetFromFrameMs: 0 }] },
    visualQuality: 1, skyFraction: 0.5, height: 288,
    boundary: Float32Array.of(100), confidence: Float32Array.of(1), flags: Uint8Array.of(0)
  }]
};

const project = buildProject(survey, {}, {});
const frame = project.keyframes[0];
const ok = frame.captureTiming.videoCurrentTimeSec === 12.25
  && frame.captureTiming.motionSampleCount === 22
  && frame.gyro.motionWindow.length === 1;
console.log(`${ok ? '  ok  ' : '  FAIL'} project preserves photo timing and its sensor window`);
process.exitCode = ok ? 0 : 1;
