'use strict';
/* Quaternion / vector helpers.
 *
 * World frame (W3C DeviceOrientation convention):
 *   X = east, Y = north, Z = up
 * Device frame:
 *   X = right edge, Y = top edge, Z = out of the screen toward the user
 *   The rear camera therefore looks along -Z.
 *
 * Quaternions are stored as [w, x, y, z] and rotate DEVICE vectors into WORLD.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function wrap360(v) { return ((v % 360) + 360) % 360; }

/** Signed shortest angular difference a - b, in (-180, 180]. */
export function angDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Circular mean of an array of degrees. */
export function circMean(list) {
  let s = 0, c = 0;
  for (const a of list) { s += Math.sin(a * DEG); c += Math.cos(a * DEG); }
  if (s === 0 && c === 0) return 0;
  return wrap360(Math.atan2(s, c) * RAD);
}

export function quatFromEuler(alphaDeg, betaDeg, gammaDeg) {
  // W3C ZXY intrinsic construction.
  const x = (betaDeg || 0) * DEG, y = (gammaDeg || 0) * DEG, z = (alphaDeg || 0) * DEG;
  const cX = Math.cos(x / 2), cY = Math.cos(y / 2), cZ = Math.cos(z / 2);
  const sX = Math.sin(x / 2), sY = Math.sin(y / 2), sZ = Math.sin(z / 2);
  return [
    cX * cY * cZ - sX * sY * sZ,
    sX * cY * cZ - cX * sY * sZ,
    cX * sY * cZ + sX * cY * sZ,
    cX * cY * sZ + sX * sY * cZ
  ];
}

export function quatFromAxisAngle(ax, ay, az, angleRad) {
  const h = angleRad / 2, s = Math.sin(h);
  return [Math.cos(h), ax * s, ay * s, az * s];
}

export function quatMul(a, b) {
  const [aw, ax, ay, az] = a, [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw
  ];
}

export function quatConj(q) { return [q[0], -q[1], -q[2], -q[3]]; }

export function quatNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotate vector v by quaternion q. */
export function quatRotate(q, v) {
  const [w, x, y, z] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx)
  ];
}

/** Angle in degrees between two unit-ish quaternion orientations. */
export function quatAngleBetween(a, b) {
  const d = quatMul(quatConj(a), b);
  return 2 * Math.acos(clamp(Math.abs(d[0]), -1, 1)) * RAD;
}

/** Rotation about world Z (yaw). Positive = clockwise when viewed from above
 *  in the compass sense, i.e. it increases azimuth. */
export function yawQuat(deg) {
  return quatFromAxisAngle(0, 0, 1, -deg * DEG);
}

/** Convert a world-frame unit direction to azimuth (deg from north, clockwise)
 *  and altitude (deg above horizon). */
export function vecToAzAlt(v) {
  const [e, n, u] = v;
  const h = Math.hypot(e, n);
  return {
    az: wrap360(Math.atan2(e, n) * RAD),
    alt: Math.atan2(u, h) * RAD
  };
}

/** Build the screen-frame -> world quaternion from a device quaternion and the
 *  current screen rotation, in degrees. */
export function screenQuat(qDevice, screenAngleDeg) {
  return quatMul(qDevice, quatFromAxisAngle(0, 0, 1, -screenAngleDeg * DEG));
}

/**
 * Camera ray for a normalized image coordinate.
 * u: -1 (left edge) .. +1 (right edge)
 * v: -1 (bottom edge) .. +1 (top edge)
 * fx, fy are focal lengths expressed in half-image units (i.e. tan of half-FOV
 * is 1/f). Returns a unit vector in the SCREEN frame.
 */
export function cameraRay(u, v, tanHalfH, tanHalfV) {
  const x = u * tanHalfH, y = v * tanHalfV, z = -1;
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

/** Weighted median. items = [{value, weight}] */
export function weightedMedian(items) {
  if (!items.length) return NaN;
  const sorted = items.slice().sort((a, b) => a.value - b.value);
  let total = 0;
  for (const it of sorted) total += it.weight;
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)].value;
  let acc = 0;
  for (const it of sorted) {
    acc += it.weight;
    if (acc >= total / 2) return it.value;
  }
  return sorted[sorted.length - 1].value;
}

/** Median absolute deviation. */
export function mad(values, center) {
  if (!values.length) return 0;
  const devs = values.map(v => Math.abs(v - center)).sort((a, b) => a - b);
  return devs[Math.floor(devs.length / 2)];
}
