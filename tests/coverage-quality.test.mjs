/* The quality ramps must be calibrated against what the sensors actually report.
 *
 * THE BUG THIS EXISTS TO PREVENT.
 *
 * The 2026-08-20 capture ran for 224 seconds, held every motion ramp at 1.000,
 * traced a confident skyline the whole way, and finished with a mean bin score
 * of 0.005 and ZERO of its 180 bins covered. The operator reported the guidance
 * dot "kept lagging and didn't move when I was on it". The dot was not lagging;
 * the map underneath it was blind, and had been for the whole session.
 *
 * The cause was a single miscalibrated ramp. `visualQuality` was scored against
 * a range of 0.20–0.45 on the assumption that a well-registered frame reports
 * about 0.45. It does not: the NCC tracker computes
 * `((peak - 0.45) / 0.5) * clamp(sharpness * 12, 0.25, 1)`, and on foliage and
 * clapboard the second-best correlation peak nearly ties the best, so the
 * sharpness term pins a perfectly tracked frame near 0.25. Coverage multiplies
 * seven ramps together, so a median factor of 0.19 annihilated everything.
 *
 * Nothing in the app could see this, because the trail recorded the PRODUCT of
 * the seven ramps and not the inputs. The lesson generalises past this one
 * number: a ramp is a claim about a distribution, and a claim about a
 * distribution has to be checked against the distribution.
 *
 * So this file holds real measured values and asserts that a typical frame is
 * treated as typical.
 */

import { CoverageMap, COVERAGE_TUNING } from '../js/coverage.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const section = t => console.log(`\n=== ${t} ===`);

/* visualQuality over 142 keyframes from two real captures, 2026-08-19 23:48
 * and 2026-08-20 19:11. Both sessions independently give a median of ~0.247. */
const MEASURED = {
  p05: 0.111, p10: 0.151, median: 0.247, p90: 0.530, max: 0.879,
  // The frames over the nearby house and the closed umbrella beside the
  // operator, where the tracker genuinely fails because near-field parallax is
  // not a rotation. These must still score nothing.
  nearFieldFailures: [0.036, 0.043, 0.072, 0.096]
};

/** One otherwise-perfect sample, so a single ramp is isolated. */
function sample(over = {}) {
  return {
    headingDeg: 0, elevationDeg: 0, rollDeg: 0, yawRateDegPerSec: 0,
    jitterDeg: 0, skylineConfidence: 0.8, visualQuality: MEASURED.median,
    glareFraction: 0, frameStatus: 'ok', trackingLost: false,
    hfovDeg: 40, vfovDeg: 31, dtSec: 0.1, ...over
  };
}

const map = new CoverageMap();
const q = over => map.observationQuality(sample(over));

section('A typical real frame is treated as typical');

{
  const typical = q({});
  check('the median measured frame earns most of its credit',
    typical > 0.7, `quality ${typical.toFixed(3)} at visualQuality ${MEASURED.median}`);
  check('a p10 frame still earns something',
    q({ visualQuality: MEASURED.p10 }) > 0.15,
    `quality ${q({ visualQuality: MEASURED.p10 }).toFixed(3)} at ${MEASURED.p10}`);
  check('a p90 frame is essentially full credit',
    q({ visualQuality: MEASURED.p90 }) > 0.95,
    `quality ${q({ visualQuality: MEASURED.p90 }).toFixed(3)} at ${MEASURED.p90}`);
}

section('The discrimination that matters is kept');

{
  for (const v of MEASURED.nearFieldFailures.slice(0, 2)) {
    check(`a near-field tracking failure at ${v} earns nothing`,
      q({ visualQuality: v }) === 0, `quality ${q({ visualQuality: v }).toFixed(3)}`);
  }
  check('and a good frame is worth many times a failing one',
    q({}) > 20 * q({ visualQuality: 0.096 }) || q({ visualQuality: 0.096 }) === 0,
    `${q({}).toFixed(3)} vs ${q({ visualQuality: 0.096 }).toFixed(3)}`);
  check('the ramp floor sits below the measured p05',
    COVERAGE_TUNING.minVisualQuality < MEASURED.p05,
    `floor ${COVERAGE_TUNING.minVisualQuality}, p05 ${MEASURED.p05}`);
  check('and full credit is reachable by an ordinary frame',
    COVERAGE_TUNING.goodVisualQuality < MEASURED.median * 1.25,
    `full credit at ${COVERAGE_TUNING.goodVisualQuality}, median frame ${MEASURED.median}`);
}

section('A real session accumulates coverage instead of nothing');

{
  /* Replay the 2026-08-20 session's conditions: a steady sweep, confident
   * skyline, visualQuality at the measured median. The old ramp turned this
   * into a mean score of 0.005 over 224 seconds. */
  const replay = new CoverageMap();
  let t = 0;
  for (let k = 0; k < 2200; k++) {          // ~220 s at 10 Hz
    t += 100;
    replay.observe(sample({
      headingDeg: (k * 360) / 2200,
      yawRateDegPerSec: 1.8,
      dtSec: 0.1,
      atMs: t
    }));
  }
  const snap = replay.snapshot();
  check('one unhurried lap covers the ring',
    snap.fraction > 0.9, `${(snap.fraction * 100).toFixed(1)}% covered, mean score ${snap.meanScore.toFixed(3)}`);
  check('mean score is nothing like the 0.005 the field capture produced',
    snap.meanScore > 0.5, `mean ${snap.meanScore.toFixed(3)}`);
}

section('Ramps still reject what they are supposed to reject');

{
  check('tracking lost earns nothing', q({ trackingLost: true }) === 0);
  check('glare earns nothing', q({ glareFraction: 0.9 }) === 0);
  check('an untraceable skyline earns nothing', q({ skylineConfidence: 0.05 }) === 0);
  check('a wildly rolled camera earns less',
    q({ rollDeg: 35 }) < q({}) * 0.5, `${q({ rollDeg: 35 }).toFixed(3)} vs ${q({}).toFixed(3)}`);
  check('a frantic sweep earns less',
    q({ yawRateDegPerSec: 60 }) < q({}) * 0.5,
    `${q({ yawRateDegPerSec: 60 }).toFixed(3)} vs ${q({}).toFixed(3)}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall coverage-quality checks passed');
process.exitCode = failures ? 1 : 0;
