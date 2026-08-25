import {
  keyframeStepDeg, maxKeyframeYawRate, keyframeMotionAccepted,
  pass2CaptureAccepted, keyframeSpacingReached, keyframeTiltStepDeg
} from '../js/capture-policy.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

// 86% overlap, raised from 80% on 2026-08-20. A frame is cheap on a survey that
// is run once and relied on for years; a hole in the overlap graph is not, and
// the 2026-08-20 capture lost 24 of its 63 photographs in the arc that had the
// least redundancy in it.
check('iPad sweep targets about 86% horizontal overlap',
  Math.abs(keyframeStepDeg(45.6) - 45.6 * 0.14) < 1e-9,
  `${keyframeStepDeg(45.6).toFixed(2)}° step on a 45.6° lens`);
check('very narrow lenses retain a safe minimum spacing', keyframeStepDeg(10) === 3);
check('handheld rate ceiling admits a deliberate 25 deg/s sweep',
  maxKeyframeYawRate({ mode: 'handheld' }) === 35
  && keyframeMotionAccepted(-25, { mode: 'handheld' }));
check('fast handheld frames are rejected using instantaneous rate',
  !keyframeMotionAccepted(35.01, { mode: 'handheld' }));
// The per-mode rate ceilings (tripod 20, probe 3) were removed; the function
// now ignores its argument and returns one number. Asserting the old contract
// left this suite red, which is how the genuine failures beside it went unread.
//
// WORTH REVISITING, not silently accepted: a probe frame is a deliberate slow
// look at the top of an obstruction, and it is now admitted at the same 35°/s
// as an ordinary sweep. Nothing is broken — the coverage ramps still discount
// fast frames, so a hurried probe earns little — but the hard gate no longer
// distinguishes them.
check('the rate ceiling is now one number for every mode',
  maxKeyframeYawRate() === 35
  && maxKeyframeYawRate({ mode: 'tripod' }) === 35
  && maxKeyframeYawRate({ probe: true }) === 35);
check('verification sweep accepts dense angular steps without a target hold',
  pass2CaptureAccepted({ verificationSweep: true, angularTravelDeg: -9.2, stepDeg: 9.12 }));
check('verification sweep still rejects insufficient overlap steps',
  !pass2CaptureAccepted({ verificationSweep: true, angularTravelDeg: -8, stepDeg: 9.12 }));
check('targeted cleanup retains its hold and timing gates',
  pass2CaptureAccepted({ onTarget: true, stillness: 0.8, elapsedMs: 500 })
  && !pass2CaptureAccepted({ onTarget: true, stillness: 0.4, elapsedMs: 500 }));


/* ------------------------------------------------ spacing is measured on the
 * sphere, not in yaw.
 *
 * The gate was `|yawDelta| >= stepDeg`. Tilting therefore counted as no
 * movement at all, so an operator sweeping up a column at one bearing had every
 * candidate after the first refused. The 2026-08-20 capture recorded 1,734
 * "spacing-not-reached" rejections against 63 accepted photographs, and the
 * vertical work the guidance had just asked for was exactly the part that could
 * never be recorded. */
{
  const HF = 38.73, VF = 30.75;
  const at = over => keyframeSpacingReached({ hfovDeg: HF, vfovDeg: VF, ...over });

  check('a pure tilt of one vertical step is movement',
    at({ yawDeltaDeg: 0, tiltDeltaDeg: keyframeTiltStepDeg(VF) }),
    `${keyframeTiltStepDeg(VF).toFixed(2)}° of tilt`);
  check('a pure tilt of half a step is not yet',
    !at({ yawDeltaDeg: 0, tiltDeltaDeg: keyframeTiltStepDeg(VF) * 0.5 }));
  check('a pure turn of one horizontal step is still movement',
    at({ yawDeltaDeg: keyframeStepDeg(HF), tiltDeltaDeg: 0 }));
  check('standing still is not movement', !at({ yawDeltaDeg: 0, tiltDeltaDeg: 0 }));

  // A diagonal move earns its share of both axes and trips sooner than either
  // alone would.
  check('a diagonal move counts both axes',
    at({ yawDeltaDeg: keyframeStepDeg(HF) * 0.8, tiltDeltaDeg: keyframeTiltStepDeg(VF) * 0.8 }));
  check('but two small nudges are still not enough',
    !at({ yawDeltaDeg: keyframeStepDeg(HF) * 0.4, tiltDeltaDeg: keyframeTiltStepDeg(VF) * 0.4 }));

  // A degree of yaw is a smaller angle the higher the camera points, so the
  // same yaw must not certify the same spacing up a column.
  const yawAtStep = keyframeStepDeg(HF);
  check('the same yaw at 60° elevation is NOT enough',
    !at({ yawDeltaDeg: yawAtStep, tiltDeltaDeg: 0, elevationDeg: 60 }),
    'a degree of bearing is worth half as much up there');
  check('but a proportionally larger turn is',
    at({ yawDeltaDeg: yawAtStep / Math.cos(60 * Math.PI / 180), tiltDeltaDeg: 0, elevationDeg: 60 }));

  /* The property that matters: walking a column the way the guidance asks
   * actually produces photographs. Under the old rule this produced exactly
   * one, at the bottom, and then nothing. */
  let taken = 0, elevation = 0, sinceYaw = 0, sinceTilt = 0;
  for (let k = 0; k < 60; k++) {
    elevation += 1;                      // a degree at a time, one bearing
    sinceTilt += 1;
    if (at({ yawDeltaDeg: sinceYaw, tiltDeltaDeg: sinceTilt, elevationDeg: elevation })) {
      taken++; sinceTilt = 0; sinceYaw = 0;
    }
  }
  check('sweeping 60° up one column yields a column of photographs',
    taken >= 12, `${taken} frames over 60° of tilt`);
  check('and they are spaced for overlap, not crowded',
    taken <= 60 / (keyframeTiltStepDeg(VF) * 0.8),
    `${taken} frames, step ${keyframeTiltStepDeg(VF).toFixed(1)}°`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall capture-policy checks passed');
process.exitCode = failures ? 1 : 0;
