/* The dot holds a column until it is finished — and lets go when it cannot be.
 *
 * Two failures are being guarded against here, and they pull in opposite
 * directions. That is why they are in one file: a change that fixes either one
 * alone reintroduces the other.
 *
 *   1. NOT ENFORCING THE COLUMN. The horizontal chooser knows nothing about
 *      height, so it led the operator onward as soon as the bearing was covered
 *      at the horizon. Columns were left half done, which is a set of high
 *      frames with nothing beneath them, which is what the solver discards. The
 *      2026-08-20 capture lost 24 of 63 photographs that way.
 *
 *   2. ENFORCING IT TOO HARD. A column that cannot be finished from where the
 *      operator is standing — past the tilt limit, blown out by sun, simply not
 *      reachable — would pin the dot forever. The operator has reported a stuck
 *      dot twice, and a naive fix for (1) makes that strictly worse.
 */

import { ScanGuidance, GUIDANCE_TUNING } from '../js/guidance.js';
import { ColumnPlan } from '../js/column-plan.js';
import { CoverageMap } from '../js/coverage.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const section = t => console.log(`\n=== ${t} ===`);

const VFOV = 30.9, HFOV = 38.7;

function rig({ tallAt = null, tallDeg = 55 } = {}) {
  const coverage = new CoverageMap();
  const plan = new ColumnPlan({ vfovDeg: VFOV, binCount: coverage.binCount });
  const guidance = new ScanGuidance();
  guidance.columnPlan = plan;
  guidance.bandStepDeg = plan.bandStepDeg;
  if (tallAt !== null) plan.requireHeight(plan.indexOf(tallAt), tallDeg);
  return { coverage, plan, guidance };
}

/** Paint the horizon everywhere so only height is ever the open question. */
function coverRing(coverage) {
  for (let pass = 0; pass < 30; pass++) {
    for (let az = 0; az < 360; az += 2) {
      coverage.observe({
        headingDeg: az, elevationDeg: 0, rollDeg: 0, yawRateDegPerSec: 2,
        jitterDeg: 0, skylineConfidence: 0.8, visualQuality: 0.25,
        glareFraction: 0, frameStatus: 'ok', hfovDeg: HFOV, vfovDeg: VFOV,
        dtSec: 0.2, atMs: pass * 1000 + az
      });
    }
  }
}

section('An unfinished column pins the bearing');

{
  const { coverage, plan, guidance } = rig({ tallAt: 100 });
  coverRing(coverage);
  const bearing = plan.bearingOf(plan.indexOf(100));
  // The bottom band only. The column needs several.
  for (let k = 0; k < 4; k++) {
    plan.observe({ headingDeg: bearing, elevationDeg: 0, quality: 1, hfovDeg: HFOV });
  }
  check('the column is genuinely unfinished', !plan.columnComplete(plan.indexOf(100)));

  const g = guidance.update({
    coverage, headingDeg: bearing, elevationDeg: 0,
    dtSec: 0.1, nowMs: 1000, hfovDeg: HFOV
  });
  check('the dot stays on this bearing', Math.abs(g.bearingDeg - bearing) < 2,
    `dot at ${g.bearingDeg?.toFixed(1)}° vs camera at ${bearing.toFixed(1)}°`);
  check('and says so', g.holdingColumn === true);
}

section('A finished column releases the dot and reverses the sweep');

{
  const { coverage, plan, guidance } = rig({ tallAt: 100 });
  coverRing(coverage);
  const idx = plan.indexOf(100);
  const bearing = plan.bearingOf(idx);

  // Hold it first. The reversal is a transition out of a hold, not a property
  // of a complete column, so a test that never holds cannot observe it — and
  // that is right: a column already finished when the operator arrives should
  // not flip the sweep under them.
  for (let k = 0; k < 4; k++) {
    plan.observe({ headingDeg: bearing, elevationDeg: 0, quality: 1, hfovDeg: HFOV });
  }
  const held = guidance.update({
    coverage, headingDeg: bearing, elevationDeg: 0, dtSec: 0.1, nowMs: 500, hfovDeg: HFOV
  });
  check('it holds while unfinished', held.holdingColumn === true);

  for (let b = 0; b < plan.bandsRequired[idx]; b++) {
    for (let k = 0; k < 4; k++) {
      plan.observe({ headingDeg: bearing, elevationDeg: plan.elevationOf(b), quality: 1, hfovDeg: HFOV });
    }
  }
  check('the column is complete', plan.columnComplete(idx));

  const before = plan.ascending;
  const g = guidance.update({
    coverage, headingDeg: bearing, elevationDeg: 0,
    dtSec: 0.1, nowMs: 1000, hfovDeg: HFOV
  });
  check('the dot is no longer held', g.holdingColumn === false);
  check('the vertical direction reverses, which is the serpentine',
    plan.ascending !== before, `ascending ${before} -> ${plan.ascending}`);
}

section('A column that cannot be filled does NOT pin the dot');

{
  const { coverage, plan, guidance } = rig({ tallAt: 100, tallDeg: 80 });
  coverRing(coverage);
  const idx = plan.indexOf(100);
  const bearing = plan.bearingOf(idx);

  // The operator sits on the bearing and nothing ever fills — the obstruction
  // is out of reach. Run well past the patience window.
  let g = null, heldFor = 0;
  for (let ms = 0; ms < 40000; ms += 100) {
    g = guidance.update({
      coverage, headingDeg: bearing, elevationDeg: 0,
      dtSec: 0.1, nowMs: ms, hfovDeg: HFOV
    });
    if (g.holdingColumn) heldFor += 0.1;
    else break;
  }
  check('the hold is bounded', heldFor <= GUIDANCE_TUNING.columnPatienceSec + 1,
    `held ${heldFor.toFixed(1)} s, patience ${GUIDANCE_TUNING.columnPatienceSec} s`);
  check('the dot lets go rather than pinning', g.holdingColumn === false);
  check('and the abandonment is recorded, not silent',
    (g.abandonedColumns || 0) >= 1, `${g.abandonedColumns} column(s) given up`);
}

section('Progress resets the patience, so a slow climb is not abandoned');

{
  const { coverage, plan, guidance } = rig({ tallAt: 100, tallDeg: 55 });
  coverRing(coverage);
  const idx = plan.indexOf(100);
  const bearing = plan.bearingOf(idx);
  const need = plan.bandsRequired[idx];

  // Fill one band every 8 seconds — slower than a real operator, but inside the
  // patience window each time. The dot must stay for the whole climb.
  let band = 0, gaveUp = false;
  for (let ms = 0; ms < 8000 * need + 4000; ms += 100) {
    if (ms > 0 && ms % 8000 === 0 && band < need) {
      for (let k = 0; k < 4; k++) {
        plan.observe({ headingDeg: bearing, elevationDeg: plan.elevationOf(band), quality: 1, hfovDeg: HFOV });
      }
      band++;
    }
    const g = guidance.update({
      coverage, headingDeg: bearing, elevationDeg: 0,
      dtSec: 0.1, nowMs: ms, hfovDeg: HFOV
    });
    if (!g.holdingColumn && band < need) { gaveUp = true; break; }
  }
  check('a column that keeps gaining bands is never abandoned', !gaveUp,
    `filled ${band} of ${need} bands at 8 s each`);
  check('and it does complete', plan.columnComplete(idx));
}

console.log(failures ? `\n${failures} FAILED` : '\nall serpentine-hold checks passed');
process.exitCode = failures ? 1 : 0;
