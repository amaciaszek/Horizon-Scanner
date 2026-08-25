/* The dot leads. It does not shadow the phone.
 *
 * REPLAYS THE 2026-08-25 BACK-YARD CAPTURE, which is the failure this file
 * exists for. That survey ran 157 seconds over 115 frames against a house
 * measuring 75.1° at its tallest, and the guidance recorded its own trail while
 * it happened. Read back, the trail says:
 *
 *   - the target bearing sat within a degree of the camera's own heading for
 *     most of the session, walking 255 → 253 → 251 → 249 behind a phone that
 *     was choosing its own path;
 *   - the target elevation equalled the camera's elevation whenever a column
 *     was held, so the dot asked for nothing at all vertically;
 *   - 19 columns required a band centred at 74.4°, which nothing in the app
 *     will ever aim at, so they could never complete;
 *   - 60 of the 180 bins finished flagged beyondTilt.
 *
 * The operator's report — "it almost never moves even when I am centred in the
 * circle it wants me to be in, whatever threshold it is waiting for it never
 * reaches, all of my movement was of my own decision" — is that trail seen from
 * the other side of the screen.
 *
 * Four properties are checked. All four failed on that capture.
 */

import { ScanGuidance, GUIDANCE_TUNING } from '../js/guidance.js';
import { ColumnPlan, COLUMN_TUNING } from '../js/column-plan.js';
import { CoverageMap, COVERAGE_TUNING } from '../js/coverage.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const section = t => console.log(`\n=== ${t} ===`);
const wrap360 = v => ((v % 360) + 360) % 360;
const angDiff = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
const clampTo = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* The measured optics of that capture: a Pixel reporting 48.36° x 37.22°. */
const HFOV = 48.36, VFOV = 37.22;
/* The tallest thing measured in that back yard, from `measuredTop`. */
const HOUSE_TOP_DEG = 75.1;

function rig() {
  const coverage = new CoverageMap();
  const plan = new ColumnPlan({ vfovDeg: VFOV, binCount: coverage.binCount });
  plan.setCeiling(coverage.tuning.maxRequestedElevationDeg);
  const guidance = new ScanGuidance();
  guidance.columnPlan = plan;
  guidance.bandStepDeg = plan.bandStepDeg;
  return { coverage, plan, guidance };
}

section('A column may not require a band nobody will ever aim at');

{
  const { plan } = rig();
  // The house, across the arc it actually occupied on that capture.
  for (let az = 42; az <= 236; az += 2) plan.requireHeight(plan.indexOf(az), HOUSE_TOP_DEG);

  const ceiling = COVERAGE_TUNING.maxRequestedElevationDeg;
  let worst = 0, worstAt = null;
  for (let i = 0; i < plan.binCount; i++) {
    const top = plan.elevationOf(plan.bandsRequired[i] - 1);
    if (top > worst) { worst = top; worstAt = plan.bearingOf(i); }
  }
  check('the tallest band required is inside the tilt ceiling', worst <= ceiling,
    `${worst.toFixed(1)}° at ${worstAt?.toFixed(0)}°, ceiling ${ceiling}°`);
  check('the excess is recorded rather than silently forgotten',
    plan.beyondReach(plan.indexOf(120)) === true,
    `wanted ${plan.bandsWanted[plan.indexOf(120)]} bands, required ${plan.bandsRequired[plan.indexOf(120)]}`);
}

section('The dot names a band, not the elevation the camera already holds');

{
  const { coverage, plan, guidance } = rig();
  const az = 120;
  plan.requireHeight(plan.indexOf(az), HOUSE_TOP_DEG);
  const bearing = plan.bearingOf(plan.indexOf(az));

  // The operator is on the bearing, at the horizon, with the bottom band filled
  // — exactly the state the trail shows for six seconds at a stretch.
  for (let k = 0; k < 6; k++) {
    plan.observe({ headingDeg: bearing, elevationDeg: 0, quality: 1, hfovDeg: HFOV });
  }
  const g = guidance.update({
    coverage, headingDeg: bearing, elevationDeg: 0,
    dtSec: 0.1, nowMs: 1000, hfovDeg: HFOV
  });

  check('a band is being asked for', g.targetBand >= 1,
    `band ${g.targetBand} of ${g.targetBands}`);
  check('the ask comes from the column plan, not from mirroring the camera',
    g.aimSource === 'band', g.aimSource);
  check('the dot sits at that band centre',
    Math.abs(g.aimElevationDeg - plan.elevationOf(g.targetBand)) < 0.2,
    `dot aiming ${g.aimElevationDeg}°, band ${g.targetBand} centre ${plan.elevationOf(g.targetBand).toFixed(1)}°`);
  check('and it therefore asks the operator to tilt up', g.wantsLift === true,
    `wantsLift=${g.wantsLift}, liftDeg=${g.liftDeg}`);
  // `liftDeg` is reported to a tenth of a degree, so compare at that resolution.
  check('by no more than one band, so it stays on screen',
    g.liftDeg <= plan.bandStepDeg + 0.05,
    `${g.liftDeg}° vs one band ${plan.bandStepDeg.toFixed(1)}°`);
}

section('The dot does not walk along behind the phone');

{
  /*
   * The operator sweeps, as they did, depositing nothing either map can credit
   * — a stretch of scene the frame gates refuse. On the recorded capture the
   * target followed them bin for bin at an offset of a few tenths of a degree.
   * Here it must stay where the work is, and the offset must open up.
   */
  const { coverage, plan, guidance } = rig();
  for (let az = 0; az < 360; az += 2) plan.requireHeight(plan.indexOf(az), 45);

  let heading = 300, nowMs = 0;
  const offsets = [];
  for (let i = 0; i < 50; i++) {
    const g = guidance.update({
      coverage, headingDeg: heading, elevationDeg: 0,
      dtSec: 0.1, nowMs, hfovDeg: HFOV
    });
    offsets.push(Math.abs(angDiff(g.rawBearingDeg, heading)));
    heading = wrap360(heading - 1.2);        // 12°/s, an ordinary sweep
    nowMs += 100;
  }

  const finalOffset = offsets[offsets.length - 1];
  check('the target stays put while the operator walks away', finalOffset > 30,
    `${finalOffset.toFixed(0)}° behind after a 60° sweep`);
  // The signature of the bug: the offset barely varying while the heading
  // travels 60°, because the target was the heading.
  const spread = Math.max(...offsets) - Math.min(...offsets);
  check('the offset opens up rather than staying pinned near zero', spread > 30,
    `offset ranged over ${spread.toFixed(0)}°`);
}

section('An obedient operator can actually finish a tall column');

{
  const { coverage, plan, guidance } = rig();
  // Every bearing is a 75° house. Under the old rule every column on the ring
  // was unfinishable and the dot had nowhere legal to be.
  for (let az = 0; az < 360; az += 2) plan.requireHeight(plan.indexOf(az), HOUSE_TOP_DEG);

  const idx = plan.indexOf(120);
  const bearing = plan.bearingOf(idx);
  const asked = new Set();
  let elevation = 0;
  for (let ms = 0; ms < 30000; ms += 100) {
    const g = guidance.update({
      coverage, headingDeg: bearing, elevationDeg: elevation,
      dtSec: 0.1, nowMs: ms, hfovDeg: HFOV
    });
    // An obedient operator: go where the dot is, and photograph there.
    elevation += (g.elevationDeg - elevation) * 0.35;
    if (g.targetBand >= 0) asked.add(g.targetBand);
    plan.observe({ headingDeg: bearing, elevationDeg: elevation, quality: 1, hfovDeg: HFOV });
  }
  check('an obedient operator finishes the column', plan.columnComplete(idx),
    `${plan.bandsFilled(idx)} of ${plan.bandsRequired[idx]} bands`);
  check('every band was asked for on the way up, none skipped',
    asked.size >= plan.bandsRequired[idx] - 1,
    `asked for bands ${[...asked].sort((a, b) => a - b).join(', ')}`);
  check('the camera never had to go above the ceiling',
    elevation <= COVERAGE_TUNING.maxRequestedElevationDeg + COLUMN_TUNING.minBandStepDeg,
    `ended at ${elevation.toFixed(1)}°`);
}

section('The dot never throws the operator at the other end of a column');

{
  /*
   * MEASURED, 2026-08-25 22:23. `gapBand` returned `ascending ? lowestGap :
   * highestGap` — the far end of the column, chosen by a flag, with no regard
   * for where the camera was. The recorded trail:
   *
   *     t=67.8  camera at 53.4°, ask jumps 55.9° -> 0.0°
   *     t=71.4  camera at  3.3°, ask jumps  0.0° -> 41.9°
   *     t=78.8  camera at 58.9°, ask jumps 59.5° -> 0.0°
   *
   * Eighteen jumps over 20°. The operator followed every one, which is both the
   * "going from the top to the bottom instantly" they reported and why the
   * capture path zig-zagged back through sky it had already covered — at tilt
   * rates up to 135°/s, which is a smeared photograph.
   */
  const { coverage, plan, guidance } = rig();
  for (let az = 0; az < 360; az += 2) plan.requireHeight(plan.indexOf(az), HOUSE_TOP_DEG);

  // An operator who follows the dot at a human pace, in both axes.
  let heading = 300, elevation = 0, nowMs = 0;
  let worstDot = 0, previousDot = null;
  let reversals = 0, quickReversals = 0, direction = 0, runLength = 0;
  const bands = new Set();
  for (let i = 0; i < 3000; i++) {
    const g = guidance.update({
      coverage, headingDeg: heading, elevationDeg: elevation,
      dtSec: 0.1, nowMs, hfovDeg: HFOV
    });
    if (previousDot !== null) {
      const move = g.elevationDeg - previousDot;
      worstDot = Math.max(worstDot, Math.abs(move));
      const now = Math.sign(Math.round(move * 100));
      if (now !== 0) {
        if (direction !== 0 && now !== direction) {
          reversals++;
          if (runLength < 15) quickReversals++;   // turned around inside 1.5 s
          runLength = 0;
        } else runLength++;
        direction = now;
      }
    }
    previousDot = g.elevationDeg;
    if (g.targetBand >= 0) bands.add(g.targetBand);

    elevation += clampTo(g.elevationDeg - elevation, -2.5, 2.5);
    heading = wrap360(heading + clampTo(angDiff(g.bearingDeg, heading), -1.5, 1.5));
    plan.observe({ headingDeg: heading, elevationDeg: elevation, quality: 1, hfovDeg: HFOV });
    nowMs += 100;
  }

  /*
   * What the operator feels is the DRAWN dot, not the raw ask. The ask may
   * legitimately name somewhere far away — the far end of a column really is
   * the next work sometimes — and the job of the slew limit is to make getting
   * there a journey. So the assertions are about travel, not about targets.
   */
  check('the dot never moves faster than its slew limit',
    worstDot <= GUIDANCE_TUNING.maxElevationSlewDegPerSec * 0.1 + 0.01,
    `worst step ${worstDot.toFixed(2)}° in 0.1 s`);
  check('and never doubles back within a second and a half of turning',
    quickReversals === 0,
    `${reversals} reversals over 300 s, ${quickReversals} of them immediate`);
  check('one reversal per column or so — a serpentine, not a shiver',
    reversals < 60, `${reversals} reversals in 300 s`);
  check('the whole column is still worked, not just the end nearest the camera',
    bands.size >= 4, `bands asked for: ${[...bands].sort((a, b) => a - b).join(', ')}`);
}

section('Entering a new column starts from the height the camera is holding');

{
  const { plan } = rig();
  const idx = plan.indexOf(120);
  plan.requireHeight(idx, HOUSE_TOP_DEG);
  const need = plan.bandsRequired[idx];
  const top = plan.elevationOf(need - 1);

  const fromTop = plan.gapBand(idx, { fromElevationDeg: top, ascending: false });
  check('arriving high, the dot asks for the top band, not the bottom one',
    fromTop === need - 1, `band ${fromTop} of ${need}`);
  const fromBottom = plan.gapBand(idx, { fromElevationDeg: 0, ascending: true });
  check('arriving low, it asks for the bottom band', fromBottom === 0, `band ${fromBottom}`);

  // The direction is read off the camera rather than carried in a flag. That
  // flag was still `true` at the end of the 22:23 survey, having never once
  // flipped, which is why every column was entered at its bottom band.
  check('the travel direction is decided by where the camera is',
    plan.directionFrom(idx, top) === false && plan.directionFrom(idx, 0) === true,
    'high -> descend, low -> ascend');

  // Mid-column, with the band under the camera already filled, it must step to
  // the neighbour and not across to the far end.
  for (let k = 0; k < 6; k++) {
    plan.observe({
      headingDeg: plan.bearingOf(idx), elevationDeg: plan.elevationOf(2),
      quality: 1, hfovDeg: HFOV
    });
  }
  const next = plan.gapBand(idx, { fromElevationDeg: plan.elevationOf(2), ascending: true });
  check('a filled band steps to its neighbour, not across the column',
    next === 3, `band ${next}`);
}

section('The band being asked for does not flicker at a boundary');

{
  /*
   * Choosing the band from where the camera is stops the lurch and would, left
   * alone, cause a twitch instead: the camera drifts across a boundary the
   * operator cannot see and the ask flips back and forth over it.
   */
  const { coverage, plan, guidance } = rig();
  const idx = plan.indexOf(120);
  plan.requireHeight(idx, HOUSE_TOP_DEG);
  const bearing = plan.bearingOf(idx);
  const boundary = plan.bandStepDeg * 1.5;      // exactly between bands 1 and 2

  const asked = [];
  for (let i = 0; i < 60; i++) {
    const g = guidance.update({
      coverage, headingDeg: bearing,
      // Hover on the boundary, drifting either side of it as a hand does.
      elevationDeg: boundary + Math.sin(i / 3) * 1.2,
      dtSec: 0.1, nowMs: i * 100, hfovDeg: HFOV
    });
    asked.push(g.targetBand);
  }
  let flips = 0;
  for (let i = 1; i < asked.length; i++) if (asked[i] !== asked[i - 1]) flips++;
  check('a hand hovering on a band boundary does not make the ask oscillate',
    flips <= 1, `${flips} change(s) over 6 s: bands ${[...new Set(asked)].join(',')}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall dot-leads checks passed');
process.exitCode = failures ? 1 : 0;
