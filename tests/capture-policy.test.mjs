import {
  keyframeStepDeg, maxKeyframeYawRate, keyframeMotionAccepted,
  pass2CaptureAccepted
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
check('tripod and obstruction captures are stricter',
  maxKeyframeYawRate({ mode: 'tripod' }) === 20
  && maxKeyframeYawRate({ probe: true }) === 3);
check('verification sweep accepts dense angular steps without a target hold',
  pass2CaptureAccepted({ verificationSweep: true, angularTravelDeg: -9.2, stepDeg: 9.12 }));
check('verification sweep still rejects insufficient overlap steps',
  !pass2CaptureAccepted({ verificationSweep: true, angularTravelDeg: -8, stepDeg: 9.12 }));
check('targeted cleanup retains its hold and timing gates',
  pass2CaptureAccepted({ onTarget: true, stillness: 0.8, elapsedMs: 500 })
  && !pass2CaptureAccepted({ onTarget: true, stillness: 0.4, elapsedMs: 500 }));

console.log(failures ? `\n${failures} FAILED` : '\nall capture-policy checks passed');
process.exitCode = failures ? 1 : 0;
