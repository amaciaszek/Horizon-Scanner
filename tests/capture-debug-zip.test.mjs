import { buildCaptureDebugZip } from '../js/diagnostic-export.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

function readStoredZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const files = new Map();
  let p = 0;
  while (p + 4 <= bytes.length && view.getUint32(p, true) === 0x04034b50) {
    const compressed = view.getUint32(p + 18, true);
    const nameLength = view.getUint16(p + 26, true);
    const extraLength = view.getUint16(p + 28, true);
    const nameStart = p + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    files.set(name, bytes.slice(dataStart, dataStart + compressed));
    p = dataStart + compressed;
  }
  return { files, centralOffset: p, centralSignature: view.getUint32(p, true) };
}

const keyframes = [0, 1].map(index => ({
  index,
  t: Date.UTC(2026, 7, 15, 20, 0, index),
  pass: 1,
  captureKind: 'sweep',
  tanHalfH: 0.5,
  tanHalfV: 0.375,
  focalPx: 384,
  photoWidth: 640,
  photoHeight: 480,
  captureTiming: {
    performanceMs: 1234.5 + index,
    videoCurrentTimeSec: 8.25 + index,
    sourceWidth: 1080,
    sourceHeight: 1920,
    frameRotationDeg: 0,
    coverFit: {
      sourceWidth: 1080, sourceHeight: 1920, rotationDeg: 0,
      outputWidth: 640, outputHeight: 480,
      visibleRectScreenAligned: { x: 0, y: 555, width: 1080, height: 810 },
      retainedFraction: { width: 1, height: 0.421875 }
    },
    track: { exposureTime: 0.01, iso: 80, focusMode: 'continuous' },
    processingLatencyMs: 42,
    videoFrame: {
      mediaTimeSec: 8.2 + index,
      captureTimeMs: 1200 + index,
      presentationTimeMs: 1230 + index
    }
  },
  quat: [1, 0, 0, 0],
  // A post-capture lens measurement moved the panorama render but must not
  // touch the capture record.
  bundleFocalScale: index === 0 ? 1.0655 : 1.0655,
  exposure: { luma: 118.4 + index, saturatedFraction: index === 0 ? 0.0 : 0.031 },
  screenAngle: 0,
  yawRaw: index * 15,
  yawFused: index * 15.25,
  yawBase: 0.25,
  yawCorrection: index * -0.1,
  elevation: 3.5 + index,
  roll: -0.25,
  compass: 123,
  gyro: {
    available: true,
    integratedYawDeg: index * 15.25,
    yawRateDegPerSec: 2.5,
    rawRateDeviceDegPerSec: [1, 2, 3],
    motionWindow: [{ performanceMs: 1234, offsetFromFrameMs: -0.5, yawRateDegPerSec: 2.5 }]
  },
  visualQuality: 0.9,
  skyFraction: 0.5,
  height: 288,
  boundary: Float32Array.from([100, 101]),
  confidence: Float32Array.from([0.8, 0.9]),
  flags: Uint8Array.from([0, 1])
}));

const firstPhoto = new Blob([Uint8Array.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])], { type: 'image/jpeg' });
const result = await buildCaptureDebugZip({
  siteName: 'Back Yard',
  sessionId: 'session-test',
  keyframes,
  photos: new Map([[0, firstPhoto]]),
  yawDatumDeg: 10,
  azimuthOffsetDeg: -2,
  project: { format: 'horizon-project', site: { name: 'Back Yard' }, capture: {}, report: {} },
  snapshot: { ready: true },
  captureAudit: {
    counts: { accepted: 2, 'motion-too-fast': 3 },
    events: [{ reason: 'motion-too-fast', accepted: false, headingDeg: 41 }]
  },
  scanCoverage: {
    binSizeDeg: 2, binCount: 180, coveredBins: 171, fraction: 0.95,
    complete: false, remainingDeg: 18, coverageThreshold: 0.75,
    tuning: { binSizeDeg: 2, coverageThreshold: 0.75, minObservations: 5 },
    guidance: { state: 'waiting', bearingDeg: 212.5, targetBearingDeg: 212.5, waitingSec: 6.4,
      tuning: { leadDeg: 7, hysteresisDeg: 12 } },
    gaps: [{ fromDeg: 204, toDeg: 222, widthDeg: 18, centreDeg: 213 }],
    bearings: [
      { bearingDeg: 1, score: 0.98, creditedFrames: 31, sweptFrames: 33, covered: true },
      { bearingDeg: 213, score: 0.11, creditedFrames: 1, sweptFrames: 26, covered: false }
    ],
    trail: [
      { performanceMs: 41200, headingDeg: 210.4, dotBearingDeg: 212.5, state: 'waiting',
        coveredFraction: 0.95, frameQuality: 0.02, credited: false, frameStatus: 'noSky',
        yawRateDegPerSec: 8.1, elevationDeg: 3.2, rollDeg: 1.1, glareFraction: 0.07 }
    ]
  },
  coverageImage: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
  panoramaOptimization: { applied: true, verifiedPairs: 1, rmsDeg: 0.2 },
  debugText: 'DEBUG DATA',
  logText: 'FIELD LOG'
});

check('archive uses a .zip filename', result.filename.endsWith('.zip'), result.filename);
check('photo and missing counts are exact', result.photoCount === 1 && result.keyframeCount === 2 && result.missingPhotoIndexes[0] === 1);

const parsed = readStoredZip(await result.blob.arrayBuffer());
check('central directory follows stored entries', parsed.centralSignature === 0x02014b50);
check('source JPEG is present', parsed.files.has('photos/keyframe-0000.jpg'));
check('missing source JPEG is not fabricated', !parsed.files.has('photos/keyframe-0001.jpg'));
check('field log is present', new TextDecoder().decode(parsed.files.get('logs/field-log.txt')).includes('FIELD LOG'));
const csv = new TextDecoder().decode(parsed.files.get('metadata/keyframes.csv'));
check('CSV is present', csv.includes('gyro_yaw_rate_deg_per_sec'));
check('CSV carries video/exposure timing', csv.includes('video_frame_media_time_sec') && csv.includes('processing_latency_ms'));
check('capture gap report is present', parsed.files.has('metadata/capture-gaps.json'));
check('optimizer-ready stitch manifest is present', parsed.files.has('metadata/stitch-manifest.json'));
check('capture audit is present', parsed.files.has('metadata/capture-audit.json'));
check('panorama optimizer diagnostics are present', parsed.files.has('metadata/panorama-optimization.json'));

const frames = JSON.parse(new TextDecoder().decode(parsed.files.get('metadata/keyframes.json')));
check('capture azimuth is associated with the photo', frames[0].pointing.captureAzimuthDeg === 10);
check('output azimuth includes the operator offset', frames[0].pointing.outputAzimuthDeg === 8);
check('altitude and gyro snapshot survive', frames[0].pointing.centerAltitudeDeg === 3.5 && frames[0].gyroscope.yawRateDegPerSec === 2.5);
check('surrounding raw motion samples survive', frames[0].gyroscope.motionWindow.length === 1
  && frames[0].gyroscope.motionWindow[0].offsetFromFrameMs === -0.5);
check('capture timing stays attached to its photo', frames[0].captureTiming.videoFrame.mediaTimeSec === 8.2
  && frames[0].captureTiming.processingLatencyMs === 42);
// The archive has to be able to say which optics the panorama was drawn with,
// without ever rewriting which optics the photograph was taken through.
check('capture-time intrinsics are untouched by the render correction',
  frames[0].camera.tanHalfHorizontal === 0.5 && frames[0].camera.tanHalfVertical === 0.375
  && frames[0].camera.focalPx === 384);
check('render intrinsics are exported separately and labelled',
  frames[0].renderCamera
  && frames[0].renderCamera.appliedFocalScale === 1.0655
  && Math.abs(frames[0].renderCamera.tanHalfHorizontal - 0.5 * 1.0655) < 1e-9
  && Math.abs(frames[0].renderCamera.tanHalfVertical - 0.375 * 1.0655) < 1e-9
  && /panorama render only/.test(frames[0].renderCamera.appliesTo));
check('the render correction keeps pixels square',
  Math.abs(frames[0].renderCamera.tanHalfHorizontal / frames[0].renderCamera.tanHalfVertical
    - frames[0].camera.tanHalfHorizontal / frames[0].camera.tanHalfVertical) < 1e-12);
check('per-photo exposure is exported for the frame it was measured on',
  frames[0].analysis.exposure.saturatedFraction === 0
  && frames[1].analysis.exposure.saturatedFraction === 0.031
  && frames[1].analysis.exposure.meanLuma === 119.4);

check('exact cover crop and exposure settings stay attached',
  frames[0].captureTiming.coverFit.visibleRectScreenAligned.y === 555
  && frames[0].captureTiming.track.exposureTime === 0.01);
check('full skyline evidence survives', frames[0].analysis.boundary.length === 2 && frames[0].analysis.flags[1] === 1);
check('skyline columns include projected angles', frames[0].analysis.skylineSamples.length === 2
  && Number.isFinite(frames[0].analysis.skylineSamples[0].azimuthDeg)
  && Number.isFinite(frames[0].analysis.skylineSamples[0].altitudeDeg));
const audit = JSON.parse(new TextDecoder().decode(parsed.files.get('metadata/capture-audit.json')));
// Coverage-guided scanning has to be diagnosable from the archive alone: if the
// dot sat somewhere for twenty seconds, the reason has to be in here.
const scanCoverage = JSON.parse(new TextDecoder().decode(parsed.files.get('metadata/scan-coverage.json')));
check('the coverage map is in the archive', scanCoverage.binCount === 180 && scanCoverage.coveredBins === 171);
check('the tuning that produced it travels with it',
  scanCoverage.tuning.coverageThreshold === 0.75 && scanCoverage.guidance.tuning.leadDeg === 7);
check('per-bearing evidence separates credited frames from swept-past ones',
  scanCoverage.bearings[1].creditedFrames === 1 && scanCoverage.bearings[1].sweptFrames === 26,
  'the distinction that says "you passed here and got nothing"');
check('where the dot was, and why it was not moving',
  scanCoverage.guidance.state === 'waiting'
  && scanCoverage.guidance.bearingDeg === 212.5
  && scanCoverage.trail[0].frameQuality === 0.02
  && scanCoverage.trail[0].frameStatus === 'noSky');
check('the rendered coverage picture is included',
  parsed.files.has('coverage-map.png') && parsed.files.get('coverage-map.png').length === 4);
const sessionJson = JSON.parse(new TextDecoder().decode(parsed.files.get('metadata/session.json')));
check('the session summary points at it',
  sessionJson.scanCoverage.coveredBins === 171
  && sessionJson.scanCoverage.guidanceState === 'waiting');
const readmeText = new TextDecoder().decode(parsed.files.get('README.txt'));
check('the README explains how to read it',
  readmeText.includes('scan-coverage.json') && readmeText.includes('coverage-map.png')
  && readmeText.includes('frameQuality'));

check('capture rejection reasons survive', audit.counts['motion-too-fast'] === 3
  && audit.events[0].headingDeg === 41);
const optimisation = JSON.parse(new TextDecoder().decode(parsed.files.get('metadata/panorama-optimization.json')));
check('visual optimisation residual survives', optimisation.applied && optimisation.rmsDeg === 0.2);
const manifest = JSON.parse(new TextDecoder().decode(parsed.files.get('metadata/stitch-manifest.json')));
check('the stitch manifest carries both lenses',
  manifest.images[0].tanHalfHorizontal === 0.5
  && Math.abs(manifest.images[0].renderTanHalfHorizontal - 0.5 * 1.0655) < 1e-9
  && manifest.images[0].appliedFocalScale === 1.0655
  && /never rewritten/.test(manifest.intrinsicsPolicy));
check('stitch manifest ties image, pose, intrinsics, and crop together',
  manifest.images[0].path === 'photos/keyframe-0000.jpg'
  && manifest.images[0].placedQuaternion.length === 4
  && manifest.images[0].tanHalfVertical === 0.375
  && manifest.images[0].coverFit.rotationDeg === 0);

console.log(failures ? `\n${failures} FAILED` : '\nall capture ZIP checks passed');
process.exitCode = failures ? 1 : 0;
