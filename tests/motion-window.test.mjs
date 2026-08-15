import { OrientationSource } from '../js/orientation.js';

const source = new OrientationSource();
const event = timeStamp => ({
  timeStamp,
  rotationRate: { alpha: 5, beta: 1, gamma: 2 },
  accelerationIncludingGravity: { x: 0, y: -9.81, z: 0 }
});

source._onMotion(event(1000)); // establishes dt
source._onMotion(event(1100));
source._onMotion(event(1200));
source._onMotion(event(1800)); // rejected: dt >= 0.5 s

const window = source.motionWindow(1150, 75, 75);
let failures = 0;
function check(name, ok) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}`);
  if (!ok) failures++;
}

check('window contains samples on both sides of the video frame', window.length === 2);
check('samples carry offsets on the video performance clock',
  window[0].offsetFromFrameMs === -50 && window[1].offsetFromFrameMs === 50);
check('raw, mapped, gravity and quaternion evidence is retained',
  window[0].rawRateDeviceDegPerSec.length === 3
  && window[0].mappedRateDeviceDegPerSec.length === 3
  && window[0].gravityDeviceMPerSec2.length === 3
  && window[0].orientationQuaternion.length === 4);

console.log(failures ? `\n${failures} FAILED` : '\nall motion-window checks passed');
process.exitCode = failures ? 1 : 0;
