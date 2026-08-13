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

// No rotation test scales anything on its own any more. A lap that fell short
// used to be read as a scale error, which quietly assumed the operator had
// meant to turn exactly 360°; the scale now comes from the angle gravity
// sweeps during the tumble instead. See tests/gyro-axis.test.mjs.
o.gyroYaw = 10;
o.compassHeading = 42;
o.beginSpinDiagnostic('yaw');
o.gyroYaw = 370;
let spin = o.finishSpinDiagnostic();
assert(o.gyroScale === 1, 'a rotation test never rescales the gyro by itself');
assert(spin.kind === 'yaw' && Math.abs(spin.measuredDeg - 360) < 1e-9, 'the lap is still reported for the log');

o.gyroYaw = 0;
o.beginSpinDiagnostic('roll');
o.gyroYaw = 176; // the short lap seen in the field
spin = o.finishSpinDiagnostic();
assert(o.gyroScale === 1, 'a short lap is recorded, not silently corrected for');
assert(o.spinDiagnostics.yaw && o.spinDiagnostics.roll, 'each rotation test is filed under its own axis');
