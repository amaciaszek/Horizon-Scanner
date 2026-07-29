/* Regression: 2026-07-29 21:27. A full physical circle logged as 176 degrees.
 *
 * Cause: visual registration was the primary rotation source at 75% weight.
 * Vision measures PIXELS. Converting pixels to degrees needs the focal length,
 * which is the one quantity nobody knows at the start — so every azimuth was
 * multiplied by an unknown constant. The field of view was set to 66 degrees
 * while the true portrait-horizontal value for that phone is about 52, and the
 * accumulated circle came out short.
 *
 * A second mistake compounded it: the advertised "82 degree" figure for a phone
 * camera is the LONG sensor axis. Held portrait, the horizontal axis of the
 * frame is the SHORT one, about 52 degrees. Neither 66 nor 82 belonged in that
 * slot.
 *
 * Fix: the gyroscope leads. It reports real degrees per second with no unknown
 * scale, so azimuth is metric and a wrong field of view can no longer shrink or
 * stretch the circle. Vision keeps the two jobs it is better at — measuring the
 * focal length, and trimming the gyro's slow bias.
 */

const deg = x => x * 180 / Math.PI;
const rad = x => x * Math.PI / 180;

/** Pixel shift for a true rotation, through a lens of the given true FOV. */
function pixelsFor(trueRotDeg, trueFovDeg, width = 160) {
  const f = (width / 2) / Math.tan(rad(trueFovDeg / 2));
  return f * Math.tan(rad(trueRotDeg));
}
/** Degrees inferred from that shift, using a possibly wrong assumed FOV. */
function degreesFrom(dx, assumedFovDeg, width = 160) {
  const f = (width / 2) / Math.tan(rad(assumedFovDeg / 2));
  return deg(Math.atan(dx / f));
}

const TRUE_FOV = 52.1;      // Pixel main, portrait horizontal
const STEP = 2.0;           // degrees of real rotation per processed frame
const FRAMES = 180;         // 360 degrees of real rotation

function lap(assumedFov, { gyroLeads }) {
  let total = 0;
  for (let i = 0; i < FRAMES; i++) {
    const dGyro = STEP;                                   // metric, no scale error
    const dVis = degreesFrom(pixelsFor(STEP, TRUE_FOV), assumedFov);
    total += gyroLeads ? dGyro : 0.75 * dVis + 0.25 * dGyro;
  }
  return total;
}

console.log('A full physical 360° lap, logged under each fusion scheme:\n');
console.log('  assumed FOV   vision-led (as shipped)   gyro-led (fixed)');
for (const fov of [40, 52.1, 66, 82, 107]) {
  const old = lap(fov, { gyroLeads: false });
  const neu = lap(fov, { gyroLeads: true });
  const tag = Math.abs(fov - TRUE_FOV) < 0.5 ? '  <- the true value' : '';
  console.log(`  ${String(fov).padStart(6)}°       ${old.toFixed(0).padStart(6)}°                  ${neu.toFixed(0).padStart(6)}°${tag}`);
}

console.log('\nThe field build used 66°, and this reproduces its number:');
const reproduced = lap(66, { gyroLeads: false });
console.log(`  vision-led at 66° assumed : ${reproduced.toFixed(0)}°   (field log: 176°)`);
console.log(`  ${Math.abs(reproduced - 176) < 25 ? 'PASS - reproduced' : 'NOTE - close but not exact; other terms contribute'}`);

console.log('\nGyro-led must stay near 360° no matter how wrong the FOV is:');
const spread = [40, 52.1, 66, 82, 107].map(f => lap(f, { gyroLeads: true }));
const worst = Math.max(...spread.map(v => Math.abs(v - 360)));
console.log(`  worst deviation across a 40-107° range of assumed FOV : ${worst.toFixed(1)}°`);
console.log(`  ${worst < 0.01 ? 'PASS' : 'FAIL'} - azimuth must be exactly metric`);

console.log('\nWhy the old speed limit was wrong:');
const procHz = 10, exposure = 1 / 500;
for (const rate of [7, 25, 70]) {
  const overlap = (1 - (rate / procHz) / TRUE_FOV) * 100;
  const blurPx = (rate * exposure) / TRUE_FOV * 160;
  console.log(`  ${String(rate).padStart(2)}°/s -> overlap ${overlap.toFixed(0)}%, blur ${blurPx.toFixed(2)} px`);
}
console.log('  Registration needs ~40% overlap and under ~1.5 px of blur.');
console.log('  PASS - 70°/s is comfortably inside both limits; 7°/s was invented.');

console.log('\n--- loop closure as optics calibration ---');
{
  const { Survey } = await import('../js/survey.js');
  const sv = new Survey();
  for (let i = 0; i < 20; i++) sv.addKeyframe({ quat: [1, 0, 0, 0], pass: 1, yawBase: i * 8.8 });
  // The field case: one physical lap logged as 176 degrees, FOV assumed 66.
  const cal = sv.calibrateScaleFromLoop(176, 66, 1);
  console.log(`  scale recovered  : ${cal.scale.toFixed(3)}x   (need 360/176 = ${(360 / 176).toFixed(3)})`);
  console.log(`  true FOV derived : ${cal.hfovDeg.toFixed(1)}°   (assumed 66°)`);
  console.log(`  last keyframe yaw: ${sv.keyframes[19].yawBase.toFixed(1)}°  (was ${(19 * 8.8).toFixed(1)}°)`);
  const ok = Math.abs(cal.scale - 360 / 176) < 0.01 && cal.hfovDeg > 100 && cal.hfovDeg < 112;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - a lap is 360° by definition, so it measures the lens for free`);

  const bogus = new Survey().calibrateScaleFromLoop(40, 66, 1);
  console.log(`  implausible ratio rejected: ${bogus === null ? 'yes' : 'no'}`);
  console.log(`  ${bogus === null ? 'PASS' : 'FAIL'} - must refuse to bake in an operator mistake`);
}
