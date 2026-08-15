'use strict';

import { buildZip } from './zip.js';
import { cameraRay, quatMul, quatRotate, vecToAzAlt, yawQuat } from './math3d.js';

const finite = value => Number.isFinite(value) ? value : null;
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const wrap360 = value => ((value % 360) + 360) % 360;

function slugify(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'horizon';
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function csvCell(value) {
  if (value == null) return '';
  const text = Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function photoExtension(blob) {
  if (blob?.type === 'image/png') return 'png';
  if (blob?.type === 'image/webp') return 'webp';
  return 'jpg';
}

function projectedSkyline(kf, yawDatumDeg, azimuthOffsetDeg) {
  const n = kf.boundary?.length || 0;
  if (!n || !Number.isFinite(kf.height) || !Number.isFinite(kf.tanHalfH) || !Number.isFinite(kf.tanHalfV)) return [];
  const totalYaw = (finite(kf.yawBase) ?? 0) + (finite(kf.yawCorrection) ?? 0) + yawDatumDeg;
  const q = totalYaw ? quatMul(yawQuat(totalYaw), kf.quat) : kf.quat;
  const samples = [];
  for (let column = 0; column < n; column++) {
    const u = (column + 0.5) / n * 2 - 1;
    const pixelY = kf.boundary[column];
    const v = 1 - (pixelY / kf.height) * 2;
    const { az, alt } = vecToAzAlt(quatRotate(q, cameraRay(u, v, kf.tanHalfH, kf.tanHalfV)));
    samples.push({
      column,
      pixelY: round(pixelY, 3),
      azimuthDeg: round(wrap360(az)),
      outputAzimuthDeg: round(wrap360(az + azimuthOffsetDeg)),
      altitudeDeg: round(alt),
      confidence: round(kf.confidence?.[column], 5),
      flag: kf.flags?.[column] ?? null
    });
  }
  return samples;
}

function serialiseFrame(kf, photo, photoName, yawDatumDeg, azimuthOffsetDeg) {
  const captureHeading = Number.isFinite(kf.yawFused)
    ? kf.yawFused + yawDatumDeg
    : (finite(kf.yawRaw) ?? 0) + (finite(kf.yawBase) ?? 0) + yawDatumDeg;
  const stitchedHeading = captureHeading + (finite(kf.yawCorrection) ?? 0);
  return {
    index: kf.index,
    capturedAt: Number.isFinite(kf.t) ? new Date(kf.t).toISOString() : null,
    timestampMs: finite(kf.t),
    pass: finite(kf.pass),
    captureKind: kf.captureKind || 'sweep',
    photo: photo ? {
      path: photoName,
      mimeType: photo.type || 'image/jpeg',
      bytes: photo.size,
      width: finite(kf.photoWidth),
      height: finite(kf.photoHeight)
    } : null,
    pointing: {
      centerAltitudeDeg: round(kf.elevation),
      rollDeg: round(kf.roll),
      captureAzimuthDeg: round(wrap360(captureHeading)),
      stitchedAzimuthDeg: round(wrap360(stitchedHeading)),
      outputAzimuthDeg: round(wrap360(stitchedHeading + azimuthOffsetDeg)),
      azimuthDatumDeg: round(yawDatumDeg),
      outputAzimuthOffsetDeg: round(azimuthOffsetDeg),
      compassDeg: round(kf.compass)
    },
    orientation: {
      quaternion: Array.from(kf.quat || [], v => round(v, 9)),
      screenAngleDeg: finite(kf.screenAngle),
      yawRawDeg: round(kf.yawRaw),
      yawFusedDeg: round(kf.yawFused),
      yawBaseCorrectionDeg: round(kf.yawBase),
      stitchYawCorrectionDeg: round(kf.yawCorrection),
      sample: kf.orientationSample || null
    },
    gyroscope: kf.gyro || null,
    camera: {
      tanHalfHorizontal: round(kf.tanHalfH, 9),
      tanHalfVertical: round(kf.tanHalfV, 9),
      focalPx: round(kf.focalPx),
      analysisWidth: kf.boundary?.length || null,
      analysisHeight: finite(kf.height)
    },
    analysis: {
      visualQuality: round(kf.visualQuality),
      skyFraction: round(kf.skyFraction),
      boundary: Array.from(kf.boundary || [], v => round(v, 3)),
      confidence: Array.from(kf.confidence || [], v => round(v, 5)),
      flags: Array.from(kf.flags || []),
      skylineSamples: projectedSkyline(kf, yawDatumDeg, azimuthOffsetDeg)
    }
  };
}

function framesCsv(frames) {
  const columns = [
    'index', 'photo', 'captured_at', 'timestamp_ms', 'pass', 'capture_kind',
    'capture_azimuth_deg', 'stitched_azimuth_deg', 'output_azimuth_deg',
    'center_altitude_deg', 'roll_deg', 'compass_deg',
    'gyro_available', 'gyro_integrated_yaw_deg', 'gyro_yaw_rate_deg_per_sec',
    'rotation_rate_deg_per_sec', 'tilt_rate_deg_per_sec', 'stillness',
    'gyro_samples', 'gyro_scale', 'gyro_bias_deg_per_sec',
    'raw_gyro_rate_device_deg_per_sec', 'mapped_gyro_rate_device_deg_per_sec',
    'gravity_device_m_per_sec2', 'yaw_raw_deg', 'yaw_fused_deg',
    'yaw_base_correction_deg', 'stitch_yaw_correction_deg',
    'screen_angle_deg', 'quaternion', 'tan_half_horizontal',
    'tan_half_vertical', 'focal_px', 'visual_quality', 'sky_fraction'
  ];
  const rows = frames.map(frame => {
    const gyro = frame.gyroscope || {};
    const values = [
      frame.index, frame.photo?.path, frame.capturedAt, frame.timestampMs, frame.pass, frame.captureKind,
      frame.pointing.captureAzimuthDeg, frame.pointing.stitchedAzimuthDeg, frame.pointing.outputAzimuthDeg,
      frame.pointing.centerAltitudeDeg, frame.pointing.rollDeg, frame.pointing.compassDeg,
      gyro.available, gyro.integratedYawDeg, gyro.yawRateDegPerSec,
      gyro.rotationRateDegPerSec, gyro.tiltRateDegPerSec, gyro.stillness,
      gyro.sampleCount, gyro.scale, gyro.biasDegPerSec,
      gyro.rawRateDeviceDegPerSec, gyro.mappedRateDeviceDegPerSec,
      gyro.gravityDeviceMPerSec2, frame.orientation.yawRawDeg, frame.orientation.yawFusedDeg,
      frame.orientation.yawBaseCorrectionDeg, frame.orientation.stitchYawCorrectionDeg,
      frame.orientation.screenAngleDeg, frame.orientation.quaternion,
      frame.camera.tanHalfHorizontal, frame.camera.tanHalfVertical, frame.camera.focalPx,
      frame.analysis.visualQuality, frame.analysis.skyFraction
    ];
    return values.map(csvCell).join(',');
  });
  return `${columns.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

function readme(photoCount, keyframeCount, missing) {
  return [
    'Horizon Scanner capture debug archive',
    '',
    `Photos included: ${photoCount} of ${keyframeCount} keyframes.`,
    missing.length ? `Keyframes missing a stored photo: ${missing.join(', ')}.` : 'Every keyframe has a stored photo.',
    '',
    'photos/ contains the source JPEGs used to build the stitched panorama.',
    'metadata/keyframes.csv is a quick per-photo table for spreadsheets.',
    'metadata/keyframes.json contains the full per-photo orientation, gyro snapshot, camera geometry, skyline boundary, confidence, flags, and directly projected azimuth/altitude for every skyline column.',
    'metadata/session.json contains session/site/report/device data and explains missing photos.',
    'metadata/project.horizon-project is the normal recomputable project archive without duplicate embedded images.',
    'logs/field-log.txt is the complete in-app field log at export time.',
    'logs/debug-bundle.txt combines the final state snapshot, lens inventory, acceptance report, and field log.',
    '',
    'Azimuth fields:',
    '- captureAzimuthDeg is the fused heading at exposure plus the survey datum.',
    '- stitchedAzimuthDeg also includes the per-frame loop/bundle correction used for placement.',
    '- outputAzimuthDeg additionally includes the operator-entered azimuth offset.',
    '',
    'Gyroscope data is the instantaneous sensor snapshot saved with each keyframe, not a continuous raw motion stream.',
    'Older saved sessions may show null for fields that were not recorded by their app version.',
    ''
  ].join('\n');
}

/** Build the single-download source-photo + metadata + log archive. */
export async function buildCaptureDebugZip({
  siteName, sessionId, keyframes, photos, yawDatumDeg = 0,
  azimuthOffsetDeg = 0, project, debugText, logText, snapshot
}) {
  const exportedAt = new Date();
  const photoMap = photos instanceof Map ? photos : new Map();
  const pad = Math.max(4, String(Math.max(0, keyframes.length - 1)).length);
  const frames = [];
  const entries = [];
  const missing = [];
  let includedPhotos = 0;

  for (const kf of keyframes) {
    const photo = photoMap.get(kf.index) || null;
    const base = `keyframe-${String(kf.index).padStart(pad, '0')}`;
    const photoName = photo ? `photos/${base}.${photoExtension(photo)}` : null;
    if (photo) {
      includedPhotos++;
      entries.push({ name: photoName, data: photo, modifiedAt: kf.t || exportedAt });
    }
    else missing.push(kf.index);
    frames.push(serialiseFrame(kf, photo, photoName, Number(yawDatumDeg) || 0, Number(azimuthOffsetDeg) || 0));
  }

  const session = {
    format: 'horizon-capture-debug',
    version: 1,
    exportedAt: exportedAt.toISOString(),
    sessionId: sessionId || null,
    site: project?.site || { name: siteName || '' },
    capture: project?.capture || null,
    report: project?.report || null,
    photoCount: includedPhotos,
    keyframeCount: keyframes.length,
    missingPhotoIndexes: missing,
    finalSnapshot: snapshot || null
  };

  entries.unshift(
    { name: 'README.txt', data: readme(includedPhotos, keyframes.length, missing), modifiedAt: exportedAt },
    { name: 'metadata/session.json', data: json(session), modifiedAt: exportedAt },
    { name: 'metadata/keyframes.json', data: json(frames), modifiedAt: exportedAt },
    { name: 'metadata/keyframes.csv', data: framesCsv(frames), modifiedAt: exportedAt },
    { name: 'metadata/project.horizon-project', data: json(project), modifiedAt: exportedAt },
    { name: 'logs/field-log.txt', data: `${logText || '(empty)'}\n`, modifiedAt: exportedAt },
    { name: 'logs/debug-bundle.txt', data: `${debugText || '(empty)'}\n`, modifiedAt: exportedAt }
  );

  const blob = await buildZip(entries);
  const stamp = exportedAt.toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return {
    blob,
    filename: `${slugify(siteName)}-capture-debug-${stamp}.zip`,
    photoCount: includedPhotos,
    keyframeCount: keyframes.length,
    missingPhotoIndexes: missing
  };
}
