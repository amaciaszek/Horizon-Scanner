/* Replay a capture's recorded guidance trail through the current dot logic.
 *
 * WHY. The 2026-08-25 back-yard capture failed in a way that nothing on the
 * screen showed and no single metric named: the dot was tracking the phone
 * instead of leading it. Every recorded field looked plausible in isolation.
 * What made it legible was reading the trail as a sequence and asking one
 * question — how often did the dot sit on the operator's own pose — and then
 * asking the same question of the new code over the same 533 samples.
 *
 * That comparison is the only honest way to know whether a change to
 * `js/guidance.js` helps. A synthetic operator does whatever the test author
 * imagined; a recorded one did what a person actually did, including all the
 * parts the author would not have thought to simulate.
 *
 *     node tools/replay-guidance.mjs <capture-debug>/metadata/scan-coverage.json
 *
 * WHAT IT CANNOT TELL YOU. The trail records the operator's poses, not the
 * pixels, so the replayed run cannot know where the skyline was in each frame —
 * `skylineTopDeg` and `skylineMeasuredFraction` are not in the trail, so
 * obstruction heights come out lower than the capture measured them. Treat the
 * column-completion figure as a floor, and the dot-behaviour figures, which
 * depend only on pose and quality, as sound.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(join(root, 'js', name)).href);

const { CoverageMap } = await load('coverage.js');
const { ColumnPlan } = await load('column-plan.js');
const { ScanGuidance } = await load('guidance.js');

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/replay-guidance.mjs <scan-coverage.json>');
  process.exit(2);
}

const archive = JSON.parse(readFileSync(path, 'utf8'));
const trail = archive.trail || [];
if (!trail.length) {
  console.error('That archive has no guidance trail in it.');
  process.exit(2);
}

/* The lens the capture was taken with, where the archive knows it. */
const HFOV = Number(process.env.HFOV) || 48.36;
const VFOV = Number(process.env.VFOV) || 37.22;

const angDiff = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return d; };

const coverage = new CoverageMap();
const plan = new ColumnPlan({ vfovDeg: VFOV, binCount: coverage.binCount });
plan.setCeiling(coverage.tuning.maxRequestedElevationDeg);
const guide = new ScanGuidance();
guide.columnPlan = plan;
guide.bandStepDeg = plan.bandStepDeg;

const rows = [];
let previousMs = null;
for (const x of trail) {
  const dtSec = previousMs === null ? 0.1 : Math.min(0.5, (x.performanceMs - previousMs) / 1000);
  previousMs = x.performanceMs;
  const sample = {
    headingDeg: x.headingDeg, elevationDeg: x.elevationDeg, rollDeg: x.rollDeg,
    yawRateDegPerSec: x.yawRateDegPerSec ?? 0, jitterDeg: 0.31,
    skylineConfidence: x.skylineConfidence, visualQuality: x.visualQuality,
    glareFraction: x.glareFraction ?? 0, frameStatus: x.frameStatus,
    hfovDeg: HFOV, vfovDeg: VFOV, clippedFraction: x.clippedFraction ?? 0,
    dtSec, atMs: x.performanceMs
  };
  coverage.observe(sample);
  plan.syncRequirements(coverage);
  plan.observe({
    headingDeg: x.headingDeg, elevationDeg: x.elevationDeg,
    quality: coverage.structuralQuality(sample), hfovDeg: HFOV
  });
  const g = guide.update({
    coverage, headingDeg: x.headingDeg, elevationDeg: x.elevationDeg,
    dtSec, nowMs: x.performanceMs, hfovDeg: HFOV
  });
  rows.push({
    offsetWasDeg: Math.abs(x.offsetDeg ?? 0),
    offsetNowDeg: Math.abs(angDiff(g.rawBearingDeg, x.headingDeg)),
    // The archived trail predates `aimSource`; derive the equivalent from what
    // it did record, so old captures can still be compared against new code.
    sourceWas: x.aimSource || (x.wantsLift ? 'lift' : x.wantsDrop ? 'rest' : 'camera'),
    sourceNow: g.aimSource,
    // The vertical target, before and after. This is the number the operator
    // feels: an asked-for height that moves half a column between two samples
    // is the "top to the bottom instantly" complaint, whatever the smoothing
    // downstream does to soften its edges.
    aimWasDeg: Number.isFinite(x.aimElevationDeg) ? x.aimElevationDeg : null,
    aimNowDeg: Number.isFinite(g.aimElevationDeg) ? g.aimElevationDeg : null,
    dotWasDeg: Number.isFinite(x.dotElevationDeg) ? x.dotElevationDeg : null,
    dotNowDeg: Number.isFinite(g.elevationDeg) ? g.elevationDeg : null,
    band: g.targetBand, state: g.state
  });
}

const pct = p => `${(rows.filter(p).length / rows.length * 100).toFixed(0)}%`;
const done = plan.completeness();

console.log(`${rows.length} samples from ${path}`);
console.log(`lens ${HFOV.toFixed(1)}° x ${VFOV.toFixed(1)}° (override with HFOV=/VFOV=)`);

console.log('\nHOW OFTEN THE DOT SAT ON THE OPERATOR  (|offset| < 2°)');
console.log(`  as recorded in the field  ${pct(r => r.offsetWasDeg < 2)}`);
console.log(`  under the current code    ${pct(r => r.offsetNowDeg < 2)}`);
console.log('  A dot that is on the operator most of the time is not instructing');
console.log('  anyone — it is following the phone.');

console.log('\nWHERE THE VERTICAL ASK CAME FROM');
console.log(`  field: mirrored the camera  ${pct(r => r.sourceWas === 'camera')}`);
console.log(`  now:   mirrored the camera  ${pct(r => r.sourceNow === 'camera')}`);
console.log(`  now:   named a plan band    ${pct(r => r.sourceNow === 'band')}`);
console.log(`  now:   ring lift or descent ${pct(r => r.sourceNow === 'lift' || r.sourceNow === 'rest')}`);

/*
 * VERTICAL CONTINUITY.
 *
 * The dot is followed with someone's hands. An asked-for height that moves half
 * a column between two samples cannot be followed, and an operator who tries
 * sweeps the camera through a huge arc photographing nothing on the way. On the
 * 2026-08-25 22:23 capture the ask jumped more than 20 degrees eighteen times,
 * several of them the full 59.5 degree height of the column.
 */
function jumps(key) {
  const out = [];
  let previous = null;
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined) continue;
    if (previous !== null) out.push(Math.abs(v - previous));
    previous = v;
  }
  return out.sort((a, b) => a - b);
}
const quote = (label, list) => {
  if (!list.length) { console.log(`  ${label} no samples`); return; }
  const at = f => list[Math.min(list.length - 1, Math.floor(list.length * f))];
  console.log(`  ${label} median ${at(0.5).toFixed(1)}°  p99 ${at(0.99).toFixed(1)}°  `
    + `max ${list[list.length - 1].toFixed(1)}°  over 20°: ${list.filter(v => v > 20).length}`);
};
console.log('\nVERTICAL CONTINUITY  (change in asked-for height between samples)');
quote('field ask ', jumps('aimWasDeg'));
quote('now   ask ', jumps('aimNowDeg'));
quote('field dot ', jumps('dotWasDeg'));
quote('now   dot ', jumps('dotNowDeg'));

console.log('\nCOLUMN PLAN OVER THE SAME POSES');
console.log(`  cells filled  ${done.have} / ${done.need}  (${(done.fraction * 100).toFixed(1)}%)`);
const tallest = Math.max(...plan.bandsRequired);
console.log(`  tallest column required ${tallest} bands, top centre `
  + `${plan.elevationOf(tallest - 1).toFixed(1)}° `
  + `(ceiling ${coverage.tuning.maxRequestedElevationDeg}°)`);
let beyond = 0;
for (let i = 0; i < plan.binCount; i++) if (plan.beyondReach(i)) beyond++;
console.log(`  columns taller than the ceiling, recorded but not required: ${beyond}`);
console.log(`  bands the dot asked for: ${[...new Set(rows.map(r => r.band))].filter(b => b >= 0).sort((a, b) => a - b).join(', ') || 'none'}`);
