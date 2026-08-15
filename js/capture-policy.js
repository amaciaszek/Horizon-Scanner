'use strict';

/** Horizontal keyframe spacing for dense visual overlap. */
export function keyframeStepDeg(horizontalFovDeg) {
  return Math.max(3, Number(horizontalFovDeg) * 0.20);
}

/** Instantaneous yaw-rate ceiling at the exposure, not a smoothed later rate. */
export function maxKeyframeYawRate({ probe = false, mode = 'handheld' } = {}) {
  if (probe) return 3;
  return mode === 'tripod' ? 20 : 35;
}

export function keyframeMotionAccepted(yawRateDegPerSec, options) {
  return Number.isFinite(yawRateDegPerSec)
    && Math.abs(yawRateDegPerSec) <= maxKeyframeYawRate(options);
}
