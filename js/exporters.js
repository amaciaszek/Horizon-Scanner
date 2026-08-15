'use strict';
import { BIN_COUNT, BIN_STEP, STATUS } from './survey.js';
import { clamp } from './math3d.js';

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function slugify(name, fallback = 'horizon') {
  const s = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || fallback;
}

function writeFixedUtf8(bytes, offset, length, text) {
  bytes.fill(0, offset, offset + length);
  const encoded = new TextEncoder().encode(text || '');
  bytes.set(encoded.slice(0, length - 1), offset);
}

/**
 * HZN1: unchanged 764-byte layout, kept byte-compatible with the existing
 * controller firmware. Unobserved bins still export as 0°, which is why the app
 * refuses to write one until every bin holds a value.
 */
export function buildHzn1(survey, meta) {
  const buffer = new ArrayBuffer(764);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set([0x48, 0x5a, 0x4e, 0x31], 0);
  view.setUint16(4, BIN_COUNT, true);
  view.setInt16(6, Math.round((meta.azOffset || 0) * 10), true);
  view.setFloat32(8, Number(meta.latitude) || 0, true);
  view.setFloat32(12, Number(meta.longitude) || 0, true);
  view.setUint32(16, Math.floor((meta.timestamp || Date.now()) / 1000), true);
  writeFixedUtf8(bytes, 20, 24, meta.siteName || 'Unnamed site');
  for (let i = 0; i < BIN_COUNT; i++) {
    const alt = survey.bins[i].alt;
    bytes[44 + i] = Number.isFinite(alt) ? clamp(Math.round(alt * 2), 0, 180) : 0;
  }
  return buffer;
}

/**
 * HZN2: same header shape plus a per-sample status byte, a CRC32, and an
 * explicit missing-sample marker. Altitude 255 means "not surveyed" so the
 * firmware can refuse to slew rather than trusting a fabricated 0°.
 */
export function buildHzn2(survey, meta) {
  const HEADER = 64;
  const buffer = new ArrayBuffer(HEADER + BIN_COUNT * 2);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set([0x48, 0x5a, 0x4e, 0x32], 0);          // HZN2
  view.setUint16(4, BIN_COUNT, true);
  view.setInt16(6, Math.round((meta.azOffset || 0) * 10), true);
  view.setFloat32(8, Number(meta.latitude) || 0, true);
  view.setFloat32(12, Number(meta.longitude) || 0, true);
  view.setUint32(16, Math.floor((meta.timestamp || Date.now()) / 1000), true);
  writeFixedUtf8(bytes, 20, 24, meta.siteName || 'Unnamed site');
  view.setUint16(44, Math.round((meta.elevationM || 0)), true);
  view.setUint8(46, meta.qualityGrade || 0);        // 0 none .. 3 excellent
  view.setUint8(47, 2);                             // format minor version
  view.setUint16(48, Math.round((meta.loopErrorDeg || 0) * 100), true);
  view.setUint16(50, meta.keyframeCount || 0, true);
  // 52..59 reserved, 60..63 CRC32 of everything after the header

  for (let i = 0; i < BIN_COUNT; i++) {
    const b = survey.bins[i];
    bytes[HEADER + i] = Number.isFinite(b.alt) ? clamp(Math.round(b.alt * 2), 0, 180) : 255;
    const conf = clamp(Math.round(b.conf * 100), 0, 100);
    bytes[HEADER + BIN_COUNT + i] = (b.status << 6) | Math.min(63, conf >> 1);
  }
  view.setUint32(60, crc32(bytes.subarray(HEADER)), true);
  return buffer;
}

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * The archive. This is the file that matters in ten years: it holds enough to
 * recompute the profile with a better algorithm, re-cut the azimuth datum, or
 * compare a summer scan against a winter one.
 */
export function buildProject(survey, meta, report, extras = {}) {
  return {
    format: 'horizon-project',
    version: 1,
    generator: extras.generator || 'Horizon Survey (browser)',
    createdAt: new Date(survey.startedAt).toISOString(),
    exportedAt: new Date().toISOString(),
    site: {
      name: meta.siteName || '',
      latitude: Number(meta.latitude) || null,
      longitude: Number(meta.longitude) || null,
      elevationM: Number(meta.elevationM) || null,
      azimuthOffsetDeg: Number(meta.azOffset) || 0,
      notes: meta.notes || ''
    },
    capture: {
      binCount: BIN_COUNT,
      binStepDeg: BIN_STEP,
      mode: extras.mode || null,
      intrinsics: extras.intrinsics || null,
      sensorHealth: extras.sensorHealth || null,
      loopErrorDeg: survey.loopError,
      loopClosed: survey.loopClosed,
      focalPx: survey.focalPx,
      manualEdits: survey.manualEdits,
      yawDatumDeg: Number(extras.yawDatumDeg) || 0,
      userAgent: navigator.userAgent
    },
    report,
    profile: survey.bins.map(b => ({
      alt: Number.isFinite(b.alt) ? Number(b.alt.toFixed(3)) : null,
      conf: Number(b.conf.toFixed(3)),
      spread: Number(b.spread.toFixed(3)),
      n: b.obs.length,
      passes: Array.from(b.passes),
      status: b.status,
      manual: !!b.manual,
      interpolated: !!b.interpolated
    })),
    keyframes: survey.keyframes.map(kf => ({
      index: kf.index,
      t: kf.t,
      pass: kf.pass,
      captureKind: kf.captureKind || 'sweep',
      tanHalfH: Number.isFinite(kf.tanHalfH) ? kf.tanHalfH : null,
      tanHalfV: Number.isFinite(kf.tanHalfV) ? kf.tanHalfV : null,
      focalPx: Number.isFinite(kf.focalPx) ? kf.focalPx : null,
      photoWidth: Number.isFinite(kf.photoWidth) ? kf.photoWidth : null,
      photoHeight: Number.isFinite(kf.photoHeight) ? kf.photoHeight : null,
      captureTiming: kf.captureTiming || null,
      quat: kf.quat.map(v => Number(v.toFixed(6))),
      screenAngle: kf.screenAngle,
      yawRaw: Number(kf.yawRaw.toFixed(3)),
      yawFused: Number.isFinite(kf.yawFused) ? Number(kf.yawFused.toFixed(6)) : null,
      yawBase: Number.isFinite(kf.yawBase) ? Number(kf.yawBase.toFixed(6)) : 0,
      yawCorrection: Number(kf.yawCorrection.toFixed(3)),
      elevation: Number(kf.elevation.toFixed(3)),
      roll: Number(kf.roll.toFixed(3)),
      compass: kf.compass == null ? null : Number(kf.compass.toFixed(2)),
      orientationSample: kf.orientationSample || null,
      gyro: kf.gyro || null,
      visualQuality: kf.visualQuality == null ? null : Number(kf.visualQuality.toFixed(3)),
      skyFraction: Number(kf.skyFraction.toFixed(4)),
      width: kf.boundary.length,
      height: kf.height,
      boundary: Array.from(kf.boundary, v => Number(v.toFixed(2))),
      confidence: Array.from(kf.confidence, v => Number(v.toFixed(3))),
      flags: Array.from(kf.flags),
      thumb: extras.thumbs && extras.thumbs[kf.index] ? extras.thumbs[kf.index] : null
    }))
  };
}

export function downloadHzn1(survey, meta) {
  const buffer = buildHzn1(survey, meta);
  download(new Blob([buffer], { type: 'application/octet-stream' }), `${slugify(meta.siteName)}.hzn`);
  return buffer.byteLength;
}

export function downloadHzn2(survey, meta) {
  const buffer = buildHzn2(survey, meta);
  download(new Blob([buffer], { type: 'application/octet-stream' }), `${slugify(meta.siteName)}.hzn2`);
  return buffer.byteLength;
}

export function downloadProject(project, siteName) {
  const text = JSON.stringify(project);
  download(new Blob([text], { type: 'application/json' }), `${slugify(siteName)}.horizon-project`);
  return text.length;
}

export function downloadReport(reportText, siteName) {
  download(new Blob([reportText], { type: 'text/plain' }), `${slugify(siteName)}-survey-report.txt`);
}

/** Restore a survey from a project archive. */
export function applyProject(survey, project) {
  if (!project || project.format !== 'horizon-project') throw new Error('That file is not a horizon project archive.');
  survey.reset();
  survey.startedAt = Date.parse(project.createdAt) || Date.now();
  survey.loopError = project.capture?.loopErrorDeg ?? null;
  survey.loopClosed = !!project.capture?.loopClosed;
  survey.focalPx = project.capture?.focalPx ?? null;
  survey.manualEdits = project.capture?.manualEdits ?? 0;

  for (const kf of project.keyframes || []) {
    survey.keyframes.push({
      ...kf,
      quat: kf.quat,
      boundary: Float32Array.from(kf.boundary),
      confidence: Float32Array.from(kf.confidence),
      flags: Uint8Array.from(kf.flags)
    });
  }
  (project.profile || []).forEach((p, i) => {
    if (i >= BIN_COUNT) return;
    const b = survey.bins[i];
    b.alt = p.alt == null ? NaN : p.alt;
    b.conf = p.conf || 0;
    b.spread = p.spread || 0;
    b.status = p.status ?? STATUS.EMPTY;
    b.manual = !!p.manual;
    b.interpolated = !!p.interpolated;
    b.passes = new Set(p.passes || []);
    b.obs = new Array(p.n || 0).fill(null).map(() => ({ value: b.alt, weight: b.conf, pass: 1 }));
  });
  return project;
}
