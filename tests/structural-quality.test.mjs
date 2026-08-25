/* A frame full of sky is worthless to the horizon and valuable to the stitch.
 *
 * THE BUG THIS EXISTS TO PREVENT, found 2026-08-21 before the first multi-device
 * field test and never observed in the wild only because the serpentine that
 * triggers it had just been written.
 *
 * The column plan was credited with `observationQuality`, the same number the
 * coverage ring uses. That number returns exactly zero for frameStatus
 * 'allSky', 'clippedTop' and 'noSky', and it is right to: a photograph with no
 * skyline in it measures no horizon.
 *
 * But the top band of a tall column is BY CONSTRUCTION aimed over the
 * obstruction, so it reports allSky or clippedTop every time. Those bands could
 * therefore never fill; the column could never complete; and the serpentine
 * hold — which refuses to move sideways until the column completes — would pin
 * the dot for its full patience window and then abandon every tall column in
 * the survey. The photograph was being taken and stored while the plan was told
 * it did not exist.
 *
 * The two questions are simply different. The ring asks "was the horizon
 * observed". The column asks "will this photograph chain to its neighbours".
 * Motion and tracking gates belong to both; the skyline gates belong only to
 * the first.
 */

import { CoverageMap } from '../js/coverage.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const map = new CoverageMap();
const base = {
  headingDeg: 0, elevationDeg: 0, rollDeg: 1, yawRateDegPerSec: 2, jitterDeg: 0.2,
  skylineConfidence: 0.7, visualQuality: 0.25, glareFraction: 0,
  trackingLost: false, hfovDeg: 40, vfovDeg: 31, dtSec: 0.1
};
const ring = s => map.observationQuality({ ...base, ...s });
const col = s => map.structuralQuality({ ...base, ...s });

console.log('\n=== A sky frame is refused by the ring and accepted by the column ===');
for (const status of ['allSky', 'clippedTop', 'noSky']) {
  check(`${status}: earns nothing on the ring`, ring({ frameStatus: status }) === 0);
  check(`${status}: still fills a column band`, col({ frameStatus: status }) > 0.5,
    `structural ${col({ frameStatus: status }).toFixed(3)}`);
}

console.log('\n=== The gates that belong to both are still shared ===');
check('tracking loss blocks the column too', col({ trackingLost: true }) === 0);
check('too dark blocks the column too', col({ frameStatus: 'tooDark' }) === 0);
check('past the tilt limit blocks the column too', col({ frameStatus: 'tooHigh' }) === 0);
check('a sun in the lens blocks the column too', col({ glareFraction: 0.9 }) === 0);
check('a frantic sweep is penalised on both',
  col({ yawRateDegPerSec: 65 }) < col({}) * 0.5
  && ring({ yawRateDegPerSec: 65, frameStatus: 'ok' }) < ring({ frameStatus: 'ok' }) * 0.5);
check('a wildly rolled frame is penalised on both',
  col({ rollDeg: 35 }) < col({}) * 0.5);
check('a badly tracked frame is penalised on both',
  col({ visualQuality: 0.05 }) === 0, 'below the registration floor');

console.log('\n=== An ordinary frame is good for both ===');
check('ordinary horizon frame', ring({ frameStatus: 'ok' }) > 0.5 && col({ frameStatus: 'ok' }) > 0.5,
  `ring ${ring({ frameStatus: 'ok' }).toFixed(3)}, column ${col({ frameStatus: 'ok' }).toFixed(3)}`);

console.log('\n=== The elevation ramp belongs to the ring alone ===');
// A high frame is judged against what the bearing needs, so pointing high
// without being asked costs ring credit. The column must not care: height is
// exactly what it is asking for.
check('an unasked-for high frame loses ring credit',
  ring({ frameStatus: 'ok', elevationDeg: 45 }) < ring({ frameStatus: 'ok' }) * 0.6,
  `${ring({ frameStatus: 'ok', elevationDeg: 45 }).toFixed(3)} vs ${ring({ frameStatus: 'ok' }).toFixed(3)}`);
check('but keeps full column credit',
  Math.abs(col({ frameStatus: 'ok', elevationDeg: 45 }) - col({ frameStatus: 'ok' })) < 1e-9);

console.log(failures ? `\n${failures} FAILED` : '\nall structural-quality checks passed');
process.exitCode = failures ? 1 : 0;
