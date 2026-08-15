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
    processingLatencyMs: 42,
    videoFrame: {
      mediaTimeSec: 8.2 + index,
      captureTimeMs: 1200 + index,
      presentationTimeMs: 1230 + index
    }
  },
  quat: [1, 0, 0, 0],
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

const frames = JSON.parse(new TextDecoder().decode(parsed.files.get('metadata/keyframes.json')));
check('capture azimuth is associated with the photo', frames[0].pointing.captureAzimuthDeg === 10);
check('output azimuth includes the operator offset', frames[0].pointing.outputAzimuthDeg === 8);
check('altitude and gyro snapshot survive', frames[0].pointing.centerAltitudeDeg === 3.5 && frames[0].gyroscope.yawRateDegPerSec === 2.5);
check('surrounding raw motion samples survive', frames[0].gyroscope.motionWindow.length === 1
  && frames[0].gyroscope.motionWindow[0].offsetFromFrameMs === -0.5);
check('capture timing stays attached to its photo', frames[0].captureTiming.videoFrame.mediaTimeSec === 8.2
  && frames[0].captureTiming.processingLatencyMs === 42);
check('full skyline evidence survives', frames[0].analysis.boundary.length === 2 && frames[0].analysis.flags[1] === 1);
check('skyline columns include projected angles', frames[0].analysis.skylineSamples.length === 2
  && Number.isFinite(frames[0].analysis.skylineSamples[0].azimuthDeg)
  && Number.isFinite(frames[0].analysis.skylineSamples[0].altitudeDeg));

console.log(failures ? `\n${failures} FAILED` : '\nall capture ZIP checks passed');
process.exitCode = failures ? 1 : 0;
