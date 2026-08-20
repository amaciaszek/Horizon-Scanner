/* The serpentine column planner, tested against the capture that motivated it.
 *
 * The 2026-08-19 23:48 run was a clean single lap by every measure the app had:
 * 80 frames, 360.7° travelled, zero overlap gaps, best-ever disagreement. The
 * stitcher dropped 13 of the 80 anyway, all of them high — median elevation
 * 46.5° against 9.3° for the frames it kept, median 3 overlapping neighbours
 * against 9. The operator was jumping from the horizon row straight to the roof
 * and back, and a 38° jump against a 30.9° vertical field shares no pixels.
 *
 * So the tests that matter are: does the planner ever ask for a step that
 * leaves no overlap, does it refuse to move sideways with a column unfinished,
 * and would the audit have warned about those 13 frames while the operator was
 * still standing there.
 */

import { ColumnPlan, COLUMN_TUNING, overlapAudit } from '../js/column-plan.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const section = t => console.log(`\n=== ${t} ===`);

const VFOV = 30.9;          // the measured working-frame vertical field
const HFOV = 40.0;

/** Fill a band at a bearing the way a few good frames would. */
function fill(plan, bearingDeg, elevationDeg, times = 3) {
  for (let k = 0; k < times; k++) {
    plan.observe({ headingDeg: bearingDeg, elevationDeg, quality: 1, hfovDeg: HFOV });
  }
}

section('Band geometry always leaves frames overlapping');

{
  const plan = new ColumnPlan({ vfovDeg: VFOV });
  // The binding constraint is the guidance dot, not the matcher. The dot is
  // drawn one step above where the camera points, so a step at or past half the
  // vertical field puts it off the top of the screen at the start of every
  // climb — and an instruction the operator cannot see is not an instruction.
  check('the dot stays inside the frame at every step',
    plan.bandStepDeg < VFOV / 2,
    `${plan.bandStepDeg.toFixed(1)}° step against a ${(VFOV / 2).toFixed(1)}° half-frame`);
  check('and not so close to the edge that it is hard to see',
    plan.bandStepDeg / (VFOV / 2) < 0.9,
    `dot sits at ${(100 * plan.bandStepDeg / (VFOV / 2)).toFixed(0)}% of the half-frame`);
  check('the step is still a real fraction of the frame, not a crawl',
    plan.bandStepDeg > VFOV * 0.3, `${plan.bandStepDeg.toFixed(1)}°`);
  check('consecutive bands share a large fraction of the frame',
    (VFOV - plan.bandStepDeg) / VFOV > 0.4,
    `${(100 * (VFOV - plan.bandStepDeg) / VFOV).toFixed(0)}% overlap`);

  // The jump that broke the real capture must now be several bands.
  const bandsAcross = Math.round((47 - 9) / plan.bandStepDeg);
  check('the 9°-to-47° jump becomes multiple steps', bandsAcross >= 2,
    `${bandsAcross} steps instead of one leap`);

  const narrow = new ColumnPlan({ vfovDeg: 4 });
  check('a very narrow lens still gets a floor on the step',
    narrow.bandStepDeg === COLUMN_TUNING.minBandStepDeg, `${narrow.bandStepDeg}°`);
}

section('A tall obstruction demands more bands, a flat horizon does not');

{
  const plan = new ColumnPlan({ vfovDeg: VFOV });
  const flat = plan.indexOf(10);
  check('open horizon needs one band', plan.bandsRequired[flat] === 1);

  const roof = plan.indexOf(300);
  plan.requireHeight(roof, 58.5);          // the measured top on the real capture
  check('a 58.5° roof demands enough bands to frame it',
    plan.bandsRequired[roof] >= 4, `${plan.bandsRequired[roof]} bands`);
  const topAim = plan.elevationOf(plan.bandsRequired[roof] - 1);
  check('the top band is aimed BELOW the obstruction top, not at it',
    topAim < 58.5 && topAim + VFOV / 2 > 58.5,
    `aims at ${topAim.toFixed(1)}°, frame reaches ${(topAim + VFOV / 2).toFixed(1)}°`);
}

section('The dot finishes a column before it moves sideways');

{
  const plan = new ColumnPlan({ vfovDeg: VFOV });
  const here = plan.indexOf(300);
  plan.requireHeight(here, 58.5);
  const bearing = plan.bearingOf(here);

  fill(plan, bearing, plan.elevationOf(0));
  const t1 = plan.nextTarget(bearing, 0);
  check('with the bottom band done it asks for the next band up, same bearing',
    t1.action === 'fill-column' && t1.band === 1
      && Math.abs(t1.bearingDeg - bearing) < 1e-6,
    `band ${t1.band} at ${t1.bearingDeg.toFixed(1)}°`);

  const lift = plan.liftFor(t1, 0);
  check('the lift it asks for is one band step, not a leap',
    Math.abs(lift - plan.bandStepDeg) < 1e-6, `+${lift.toFixed(1)}°`);

  // Fill everything except the top band; it must still refuse to move on.
  for (let b = 1; b < plan.bandsRequired[here] - 1; b++) {
    fill(plan, bearing, plan.elevationOf(b));
  }
  const t2 = plan.nextTarget(bearing, plan.elevationOf(2));
  check('one missing band still holds the dot at this bearing',
    t2.action === 'fill-column' && Math.abs(t2.bearingDeg - bearing) < 1e-6,
    `still at ${t2.bearingDeg.toFixed(1)}°`);
}

section('A finished column turns the sweep around');

{
  const plan = new ColumnPlan({ vfovDeg: VFOV });
  const here = plan.indexOf(300);
  plan.requireHeight(here, 58.5);
  const bearing = plan.bearingOf(here);
  for (let b = 0; b < plan.bandsRequired[here]; b++) fill(plan, bearing, plan.elevationOf(b));
  check('the column reads complete', plan.columnComplete(here));

  const ascendingBefore = plan.ascending;
  const t = plan.nextTarget(bearing, plan.elevationOf(3), { direction: -1 });
  check('the dot steps sideways once the column is done',
    Math.abs(t.bearingDeg - bearing) > 1, `moved to ${t.bearingDeg.toFixed(1)}°`);
  check('it steps counter-clockwise',
    ((bearing - t.bearingDeg + 360) % 360) < 180, `${bearing.toFixed(1)}° -> ${t.bearingDeg.toFixed(1)}°`);
  check('and the vertical direction reverses', plan.ascending !== ascendingBefore,
    `ascending ${ascendingBefore} -> ${plan.ascending}`);
}

section('The serpentine does not re-cross ground it has covered');

{
  // Walk the planner the way an operator would and record the path. The test is
  // that consecutive targets never jump more than one band vertically, which is
  // exactly the property that guarantees overlap.
  const plan = new ColumnPlan({ vfovDeg: VFOV, binCount: 40 });
  for (let i = 0; i < plan.binCount; i++) plan.requireHeight(i, 40);

  let heading = plan.bearingOf(0);
  let elevation = 0;
  let worstJump = 0;
  let steps = 0;
  while (steps++ < 4000) {
    const t = plan.nextTarget(heading, elevation, { direction: -1 });
    if (t.complete) break;
    if (Math.abs(t.bearingDeg - heading) < 1e-6) {
      worstJump = Math.max(worstJump, Math.abs(t.elevationDeg - elevation));
    }
    heading = t.bearingDeg;
    elevation = t.elevationDeg;
    fill(plan, heading, elevation);
  }
  check('the walk terminates', steps < 4000, `${steps} steps`);
  check('every in-column move is at most one band',
    worstJump <= plan.bandStepDeg + 1e-6, `worst ${worstJump.toFixed(1)}° vs step ${plan.bandStepDeg.toFixed(1)}°`);
  check('the whole sphere-of-interest ends up covered',
    plan.completeness().fraction === 1, `${(plan.completeness().fraction * 100).toFixed(1)}%`);
}

section('The audit would have caught the 13 dropped frames in the field');

{
  // The real poses from the 2026-08-19 23:48 capture, abbreviated to the
  // structure that mattered: a dense horizon row, and high excursions taken
  // alone. Frame indices match the archive.
  const frames = [];
  for (let k = 0; k < 40; k++) {
    frames.push({ index: k, azimuthDeg: (k * 9) % 360, elevationDeg: 6 + (k % 3) });
  }
  for (const [index, az, alt] of [
    [47, 283.8, 46.4], [48, 273.9, 47.7], [49, 263.8, 46.9], [50, 253.6, 48.4],
    [62, 197.1, 58.5], [63, 188.3, 46.5], [64, 179.7, 53.7], [65, 171.5, 54.3]
  ]) frames.push({ index, azimuthDeg: az, elevationDeg: alt });

  const audit = overlapAudit(frames, { hfovDeg: HFOV, vfovDeg: VFOV });
  const flagged = new Set(audit.atRisk.map(r => r.index));
  check('the high excursions are flagged as unplaceable',
    [47, 48, 49, 50, 62, 63, 64, 65].every(i => flagged.has(i)),
    `${audit.atRisk.length} frames at risk`);
  check('they are reported as stranded, not merely thin',
    audit.atRisk.filter(r => r.stranded).length >= 8,
    `${audit.atRisk.filter(r => r.stranded).length} stranded`);
  check('the dense horizon row is not flagged',
    ![0, 5, 10, 20, 30].some(i => flagged.has(i)));
  check('the graph splits, as the solver found it did',
    audit.components > 1, `${audit.components} components, largest ${audit.largestComponent}`);
  check('it names the elevation that is in trouble',
    audit.riskiestElevationDeg > 40,
    `${audit.riskiestElevationDeg}°`);

  // And with a serpentine column instead, the same roof is safe.
  const serp = [];
  for (let k = 0; k < 40; k++) {
    serp.push({ index: k, azimuthDeg: (k * 9) % 360, elevationDeg: 6 });
  }
  let n = 100;
  for (const az of [171, 180, 189, 198, 207]) {
    for (const alt of [6, 23, 40, 51]) serp.push({ index: n++, azimuthDeg: az, elevationDeg: alt });
  }
  const serpAudit = overlapAudit(serp, { hfovDeg: HFOV, vfovDeg: VFOV });
  const serpHigh = serpAudit.atRisk.filter(r => r.elevationDeg > 35).length;
  check('a serpentine column leaves no high frame under-connected',
    serpHigh === 0, `${serpHigh} high frames at risk`);
}

section('Gaps are reported as bearings a person can act on');

{
  const plan = new ColumnPlan({ vfovDeg: VFOV, binCount: 36 });
  for (let i = 0; i < plan.binCount; i++) {
    plan.requireHeight(i, 40);
    if (i < 30) for (let b = 0; b < plan.bandsRequired[i]; b++) fill(plan, plan.bearingOf(i), plan.elevationOf(b));
  }
  const gaps = plan.gaps();
  check('the unfinished arc is reported as one run', gaps.length === 1, `${gaps.length} runs`);
  check('the run says how high it still needs to go',
    gaps[0].topElevationDeg > 20, `up to ${gaps[0].topElevationDeg.toFixed(1)}°`);
  // Six bins were left unvisited at 10° each, but the gap is 40° and not 60°:
  // a frame is 40° wide, so working the last visited column also filled the two
  // bins beyond it. That spill is the point of crediting neighbours, and a gap
  // report that ignored it would send the operator back over covered ground.
  check('the run is narrowed by the width of a frame',
    gaps[0].widthDeg === 40, `${gaps[0].widthDeg}° of the 60° never aimed at`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall column-plan checks passed');
process.exitCode = failures ? 1 : 0;
