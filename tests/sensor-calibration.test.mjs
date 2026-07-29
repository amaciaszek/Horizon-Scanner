import { OrientationSource } from '../js/orientation.js';

function assert(ok, message) {
  if (!ok) throw new Error(message);
  console.log(`PASS  ${message}`);
}

const o = new OrientationSource();
o.beginStationaryDiagnostic();
for (let i = 0; i < 200; i++) {
  const noise = (i % 5 - 2) * 0.002;
  o._stationarySamples.push({
    t: i * 20,
    w: [0.12 + noise, -0.08 - noise, 0.04 + noise],
    g: [0.02, -0.03, 9.81],
    alpha: 0, beta: 0, gamma: 0,
    elevation: -90, roll: 0
  });
}
const stationary = o.finishStationaryDiagnostic();
assert(stationary.biasApplied, 'stationary run accepts a four-second, 50 Hz sample');
assert(Math.abs(o.gyroBias[0] - 0.12) < 0.001, 'stationary x-axis bias is recovered');
assert(stationary.screenFlatnessDeg.mean < 0.3, 'face-up gravity reports a horizontal screen');

o.gyroYaw = 10;
o.compassHeading = 42;
o.beginSpinDiagnostic();
o.gyroYaw = 370; // exactly one physical lap
let spin = o.finishSpinDiagnostic();
assert(Math.abs(spin.proposedScale - 1) < 1e-9 && spin.scaleApplied, 'a measured 360° lap keeps unit gyro scale');

o.gyroScale = 1;
o.gyroYaw = 0;
o.beginSpinDiagnostic();
o.gyroYaw = 176; // field failure previously observed
spin = o.finishSpinDiagnostic();
assert(!spin.scaleApplied && o.gyroScale === 1, 'a 176° lap is diagnosed but not hidden by an unsafe scale correction');
