import {
  keyframeStepDeg, maxKeyframeYawRate, keyframeMotionAccepted
} from '../js/capture-policy.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

check('iPad sweep targets about 80% horizontal overlap',
  Math.abs(keyframeStepDeg(45.6) - 9.12) < 1e-9);
check('very narrow lenses retain a safe minimum spacing', keyframeStepDeg(10) === 3);
check('handheld rate ceiling admits a deliberate 25 deg/s sweep',
  maxKeyframeYawRate({ mode: 'handheld' }) === 35
  && keyframeMotionAccepted(-25, { mode: 'handheld' }));
check('fast handheld frames are rejected using instantaneous rate',
  !keyframeMotionAccepted(35.01, { mode: 'handheld' }));
check('tripod and obstruction captures are stricter',
  maxKeyframeYawRate({ mode: 'tripod' }) === 20
  && maxKeyframeYawRate({ probe: true }) === 3);

console.log(failures ? `\n${failures} FAILED` : '\nall capture-policy checks passed');
process.exitCode = failures ? 1 : 0;
