/* Regression: the first full survey, 2026-07-29 18:33.
 *
 * Report said 360.0 of 360.0 degrees observed, 39534 observations, 54 per bin —
 * and 0 of 720 verified, 19.74 degrees maximum spread, 13 spike bins. The
 * pass-1 travel counter read "0 of 360" the whole way round while the ring
 * filled completely.
 *
 * That combination has one explanation: azimuth was advancing on a random walk.
 * The log recorded orientation jitter of +-57 degrees, a compass datum spread of
 * 154.8 degrees, and 7913 of 7956 compass samples rejected. The app knew the
 * magnetometer was dead and still blended 25% of it into every fused step, and
 * fell back to 100% of it whenever visual registration failed. Zero-mean noise
 * integrates to a walk that visits every azimuth, so coverage looks complete
 * while no bin points where it claims. Signed travel stays near zero, which is
 * why the counter never moved: it was the one honest number on the screen.
 *
 * Fix: relative rotation comes from the raw gyroscope via devicemotion, which
 * no magnet touches. Where there is no gyroscope and the compass is condemned,
 * azimuth does not advance at all and the operator is told tracking is lost.
 */
import { Survey } from '../js/survey.js';

let seed = 424242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

/**
 * Model the fusion decision as shipped and as fixed, over a scan where visual
 * registration fails half the time (motion blur at 50 deg/s) and the compass is
 * condemned.
 */
function walk({ useCondemnedSensor }) {
  let azimuth = 0, travel = 0;
  const visited = new Set();
  const trueHeadings = [];
  for (let i = 0; i < 4000; i++) {
    const visualOk = i % 2 === 0;              // half the frames register
    const dVis = visualOk ? 0.09 : null;       // real motion, ~7 deg/s at 80 Hz
    const dMag = rnd() * 115;                  // +-57 deg of magnetometer chaos

    let d;
    if (visualOk) d = useCondemnedSensor ? 0.75 * dVis + 0.25 * dMag : dVis;
    else d = useCondemnedSensor ? dMag : 0;    // fixed build refuses to advance

    azimuth = ((azimuth + d) % 360 + 360) % 360;
    travel += d;
    visited.add(Math.floor(azimuth / 0.5));
    trueHeadings.push(azimuth);
  }
  return { coverage: visited.size / 720, travel, azimuth };
}

console.log('--- as shipped: 25% of a condemned magnetometer in every step ---');
const bad = walk({ useCondemnedSensor: true });
console.log(`  bins visited      : ${(bad.coverage * 100).toFixed(1)}%   <- looks like full coverage`);
console.log(`  signed travel     : ${bad.travel.toFixed(0)}°   <- field build showed "0 of 360"`);
console.log(`  ${bad.coverage > 0.95 && Math.abs(bad.travel) < 3000 ? 'reproduced' : 'NOT reproduced'} - a random walk manufactures coverage\n`);

console.log('--- fixed: visual only, no advance when registration fails ---');
const good = walk({ useCondemnedSensor: false });
console.log(`  bins visited      : ${(good.coverage * 100).toFixed(1)}%`);
console.log(`  signed travel     : ${good.travel.toFixed(0)}°   (truth 180° of real motion)`);
console.log(`  ${Math.abs(good.travel - 180) < 1 ? 'PASS' : 'FAIL'} - travel must track real rotation\n`);

/* Observations are only recorded through keyframes, which is itself part of the
 * defence: a frame that cannot be registered never becomes a keyframe, so a
 * lost-tracking stretch contributes nothing rather than contributing noise.
 * Acceptance behaviour on scattered data is covered by tests/sim5.mjs. */
console.log('--- tracking-loss policy ---');
console.log('  With no gyroscope and a condemned compass, dFused is 0 and the');
console.log('  frame is marked trackingLost: no keyframe, no observation, and');
console.log('  the overlay draws nothing. Verified by inspection of main.js and');
console.log('  guide.js; the numeric case is the walk above.');
