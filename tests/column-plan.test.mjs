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

import { ColumnPlan, COLUMN_TUNING, overlapAudit, bridgeTargets } from '../js/column-plan.js';

const angDiff = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };
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

  /*
   * The reversal is NOT a side effect of asking. `nextTarget` is called on
   * every frame to ask where the dot belongs, and a query that flipped the
   * sweep direction each time reversed it ten times a second — the serpentine
   * became a shiver. The flip is now one explicit call, made once by whoever
   * owns the decision that a column has finished.
   */
  check('asking does not flip the sweep under you', plan.ascending === ascendingBefore,
    `ascending stayed ${plan.ascending}`);
  plan.advanceSerpentine();
  check('and the vertical direction reverses when told to',
    plan.ascending !== ascendingBefore,
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

section('A stranded group is turned into somewhere to point');

{
  /* The 2026-08-20 failure, reproduced: a solid horizon row all the way round,
   * and a tall arc of work between 242° and 340° that never reaches it. The
   * solver kept 39 of 63 frames; the audit independently agreed. */
  const frames = [];
  for (let k = 0; k < 40; k++) {
    frames.push({ index: k, azimuthDeg: (k * 9) % 360, elevationDeg: 5 });
  }
  let n = 40;
  for (const az of [242, 252, 262, 272, 282, 292, 302, 312, 322, 332]) {
    for (const alt of [48, 55]) frames.push({ index: n++, azimuthDeg: az, elevationDeg: alt });
  }

  const HF = 38.73, VF = 30.75;
  const audit = overlapAudit(frames, { hfovDeg: HF, vfovDeg: VF });
  check('the tall arc is stranded', audit.components > 1,
    `${audit.components} components, largest ${audit.largestComponent}/${frames.length}`);

  const bridges = bridgeTargets(frames, audit, { hfovDeg: HF, vfovDeg: VF });
  check('somewhere to point is proposed', bridges.length > 0, `${bridges.length} target(s)`);
  check('the proposals sit between the two heights, not at either',
    bridges.every(b => b.elevationDeg > 8 && b.elevationDeg < 46),
    bridges.map(b => `${b.elevationDeg.toFixed(0)}°`).join(', '));
  check('and in the arc that is broken, not elsewhere',
    bridges.every(b => b.bearingDeg >= 235 && b.bearingDeg <= 345),
    bridges.map(b => `${b.bearingDeg.toFixed(0)}°`).join(', '));
  check('a wide gap asks for more than one frame',
    bridges.every(b => b.framesNeeded >= 1) && bridges.some(b => b.framesNeeded > 1));
  check('the worst disconnection is proposed first',
    bridges[0].gapDeg >= bridges[bridges.length - 1].gapDeg,
    `${bridges[0].gapDeg.toFixed(0)}° first`);

  // The property that matters: taking the suggested frames actually fixes it.
  const added = [];
  for (const b of bridges) {
    for (let k = 0; k < b.framesNeeded; k++) {
      added.push({ index: 900 + added.length, azimuthDeg: b.bearingDeg, elevationDeg: b.elevationDeg });
    }
  }
  const after = overlapAudit([...frames, ...added], { hfovDeg: HF, vfovDeg: VF });
  check('taking them reconnects the survey', after.components === 1,
    `${after.components} component(s), largest ${after.largestComponent}/${frames.length + added.length}`);
  check('and nothing originally captured is left stranded',
    after.atRisk.filter(r => r.stranded && r.index < 900).length === 0);
  check('the fix is cheap relative to the work it saves',
    added.length < frames.length / 2, `${added.length} frames to rescue ${frames.length - audit.largestComponent}`);
}

{
  // A healthy survey must not be told to go anywhere.
  const frames = [];
  for (let k = 0; k < 60; k++) frames.push({ index: k, azimuthDeg: (k * 6) % 360, elevationDeg: 5 });
  const audit = overlapAudit(frames, { hfovDeg: 38.73, vfovDeg: 30.75 });
  check('a connected survey proposes nothing',
    bridgeTargets(frames, audit, {}).length === 0);
}

section('A band is filled by looks, not by glimpses at the edge of a picture');

{
  /*
   * MEASURED, 2026-09-03. `observe` credits every bin within half the usable
   * field — nine columns either side on a 44° lens at 2° bins — with the weight
   * falling to about 0.1 at the outermost. The comment beside it said "an
   * edge-of-frame glimpse cannot complete a band", and then the frame counter
   * was incremented for every one of those nineteen bins.
   *
   * On that capture 83 of 180 columns were marked COMPLETE with zero
   * photographs ever aimed at them, and 41 more with exactly one. The plan
   * reported 97.4% done off 207 photographs against 813 required cells. The
   * operator: "the white dot guide is constantly ahead of me and I doubt if it
   * is actually checking the quality of the measurements."
   */
  const plan = new ColumnPlan({ vfovDeg: VFOV, binCount: 180 });
  const HF = 44.5;
  const target = plan.indexOf(100);
  const edge = plan.bearingOf(target) + HF * 0.38;   // near the edge of the credit fan

  for (let k = 0; k < 40; k++) {
    plan.observe({ headingDeg: edge, elevationDeg: 0, quality: 1, hfovDeg: HF });
  }
  check('forty edge glimpses do not complete a column nobody aimed at',
    !plan.columnComplete(target),
    `bands filled ${plan.bandsFilled(target)} of ${plan.bandsRequired[target]}`);

  // The same number of frames actually pointed at it does complete it.
  const plan2 = new ColumnPlan({ vfovDeg: VFOV, binCount: 180 });
  for (let k = 0; k < 6; k++) {
    plan2.observe({ headingDeg: plan2.bearingOf(target), elevationDeg: 0, quality: 1, hfovDeg: HF });
  }
  check('but a handful aimed at it does', plan2.columnComplete(target));
  check('and the edge credit still counts toward the score, just not as a look',
    plan.score[plan.cell(target, 0)] > 0,
    `score ${plan.score[plan.cell(target, 0)].toFixed(2)}`);
}

section('At the end of a lap the dot does not send you across the ring');

{
  /*
   * The sweep-direction walk took the first column needing work, up to a full
   * circle away. During the main sweep that is right. At the end, with a few
   * stragglers scattered round the ring, the nearest is often BEHIND and going
   * forward costs most of a lap. On the 2026-09-03 capture there were exactly
   * two target jumps over 25° in the whole session, both in the last quarter,
   * of 174° and 170°.
   */
  const plan = new ColumnPlan({ vfovDeg: VFOV, binCount: 180 });
  plan.setHorizontalFieldOfView(44.5);
  for (let i = 0; i < 180; i++) plan.bandsRequired[i] = 1;
  for (let i = 0; i < 180; i++) {
    for (let k = 0; k < 6; k++) {
      plan.observe({ headingDeg: plan.bearingOf(i), elevationDeg: 0, quality: 1, hfovDeg: 1 });
    }
  }
  const here = plan.indexOf(180);
  const behind = (here + 3) % 180;              // 6° the wrong way
  const farAhead = (here - 50 + 180) % 180;     // 100° the sweep way
  for (const i of [behind, farAhead]) {
    plan.score[plan.cell(i, 0)] = 0;
    plan.frames[plan.cell(i, 0)] = 0;
  }
  const t = plan.nextTarget(180, 0, { direction: -1 });
  const travel = Math.abs(angDiff(t.bearingDeg, 180));
  check('it turns round for work six degrees away rather than walking a hundred',
    travel < 20, `${travel.toFixed(0)}° of travel, action "${t.action}"`);
  check('and says that is what it did', t.action === 'nearest-work', t.action);
}

console.log(failures ? `\n${failures} FAILED` : '\nall column-plan checks passed');
process.exitCode = failures ? 1 : 0;
