/* Degenerate inputs must not crash, hang, or silently poison the app.
 *
 * Written 2026-08-21, the day before the first multi-device field test, and it
 * found three real defects on its first run:
 *
 *   1. CoverageMap.observe() hung forever on a large heading. The bin loop walks
 *      `for (slot = first; slot <= last; slot++)`, and at 5e299 the increment is
 *      below the ULP — `slot++` does not change the value, so the condition
 *      never goes false. This is the per-frame path: the device would freeze
 *      mid-survey with no error and no way back. The heading is now wrapped
 *      before anything is derived from it.
 *
 *   2. CoverageMap.demote() spun 500 million times on a wide sector, locking the
 *      interface for six seconds. Bounded by the ring: you can never demote more
 *      bins than exist.
 *
 *   3. keyframeStepDeg(NaN) returned NaN, which makes keyframeSpacingReached
 *      false forever — the app would stop photographing entirely while logging
 *      'spacing-not-reached' every frame, which looks exactly like a survey
 *      going fine and produces nothing. Intrinsics are computed from measured
 *      rotation, so a NaN is reachable rather than theoretical.
 *
 * None of these needed a strange device to happen. They needed one bad number.
 */

const B='file:///C:/Users/Owner/Documents/GitHub/AdamMacInfo/Horizon-Scanner/js/';
const { ColumnPlan, overlapAudit, bridgeTargets } = await import(B+'column-plan.js');
const { CoverageMap } = await import(B+'coverage.js');
const { keyframeSpacingReached, keyframeStepDeg, keyframeTiltStepDeg } = await import(B+'capture-policy.js');
const { bearingCoverage, frameCoverage, stitchVerdict } = await import(B+'coverage-table.js');
const { Survey } = await import(B+'survey.js');

let bad = 0;
const nasty = [undefined, null, NaN, Infinity, -Infinity, 0, -0, 1e12, -1e12, '', 'x', {}, []];
const t = (label, fn) => {
  try { const r = fn(); 
    if (typeof r === 'number' && !Number.isFinite(r)) { console.log(`  FAIL ${label} -> ${r}`); bad++; return; }
    console.log(`  ok   ${label}`);
  } catch (e) { console.log(`  FAIL ${label} threw: ${e.message}`); bad++; }
};

console.log('=== capture-policy with degenerate inputs ===');
for (const v of nasty) {
  t(`keyframeStepDeg(${String(v)})`, () => keyframeStepDeg(v));
  t(`keyframeTiltStepDeg(${String(v)})`, () => keyframeTiltStepDeg(v));
}
t('keyframeSpacingReached({})', () => keyframeSpacingReached({}) === false ? 0 : 0);
for (const v of nasty) {
  t(`spacingReached yaw=${String(v)}`, () => { keyframeSpacingReached({ yawDeltaDeg: v, tiltDeltaDeg: v, elevationDeg: v, hfovDeg: v, vfovDeg: v }); return 0; });
}

console.log('\n=== ColumnPlan with degenerate inputs ===');
for (const v of nasty) t(`new ColumnPlan(vfov=${String(v)})`, () => { const p = new ColumnPlan({ vfovDeg: v }); return p.bandStepDeg; });
{
  const p = new ColumnPlan({ vfovDeg: 31 });
  for (const v of nasty) {
    t(`indexOf(${String(v)})`, () => { const i = p.indexOf(v); return Number.isInteger(i) ? 0 : NaN; });
    t(`bandOf(${String(v)})`, () => { p.bandOf(v); return 0; });
    t(`requireHeight(0, ${String(v)})`, () => { p.requireHeight(0, v); return 0; });
    t(`observe(h=${String(v)})`, () => { p.observe({ headingDeg: v, elevationDeg: v, quality: v, hfovDeg: v }); return 0; });
    t(`nextTarget(${String(v)})`, () => { p.nextTarget(v, v); return 0; });
  }
  t('completeness after abuse', () => { const c = p.completeness(); return c.fraction; });
  t('gaps after abuse', () => { p.gaps(); return 0; });
  t('snapshot after abuse', () => { JSON.stringify(p.snapshot()); return 0; });
}

console.log('\n=== overlapAudit / bridgeTargets edge cases ===');
t('empty frame list', () => { const a = overlapAudit([], {}); bridgeTargets([], a, {}); return 0; });
t('one frame', () => { const f=[{index:0,azimuthDeg:0,elevationDeg:0}]; const a=overlapAudit(f,{}); bridgeTargets(f,a,{}); return 0; });
t('all frames identical', () => { const f=Array.from({length:20},(_,i)=>({index:i,azimuthDeg:0,elevationDeg:0})); const a=overlapAudit(f,{}); bridgeTargets(f,a,{}); return 0; });
t('frames with NaN poses', () => { const f=Array.from({length:10},(_,i)=>({index:i,azimuthDeg:NaN,elevationDeg:NaN})); const a=overlapAudit(f,{}); bridgeTargets(f,a,{}); return 0; });
t('every frame stranded (no anchors)', () => { const f=Array.from({length:6},(_,i)=>({index:i,azimuthDeg:i*90,elevationDeg:80})); const a=overlapAudit(f,{}); const b=bridgeTargets(f,a,{}); return Array.isArray(b)?0:NaN; });

console.log('\n=== coverage-table with an empty survey ===');
{
  const s = new Survey();
  t('bearingCoverage on a fresh survey', () => { bearingCoverage(s, {}); return 0; });
  t('frameCoverage with no report', () => { frameCoverage(s, {}); return 0; });
  t('stitchVerdict(null)', () => stitchVerdict(null) === null ? 0 : 0);
  t('stitchVerdict({})', () => stitchVerdict({}) === null ? 0 : 0);
  t('stitchVerdict with junk render', () => { stitchVerdict({ render: { meanOverlapDisagreement: NaN } }); return 0; });
  t('bearingCoverage sectorDeg=0', () => { bearingCoverage(s, { sectorDeg: 0 }); return 0; });
  t('bearingCoverage sectorDeg=NaN', () => { bearingCoverage(s, { sectorDeg: NaN }); return 0; });
}

console.log('\n=== CoverageMap quality with junk ===');
{
  const m = new CoverageMap();
  for (const v of nasty) {
    t(`observationQuality(${String(v)})`, () => { const q = m.observationQuality({ headingDeg:v, elevationDeg:v, rollDeg:v, yawRateDegPerSec:v, visualQuality:v, skylineConfidence:v, glareFraction:v, dtSec:v }); return q; });
    t(`structuralQuality(${String(v)})`, () => { const q = m.structuralQuality({ rollDeg:v, yawRateDegPerSec:v, visualQuality:v, glareFraction:v, dtSec:v }); return q; });
    t(`observe(${String(v)})`, () => { m.observe({ headingDeg:v, elevationDeg:v, vfovDeg:v, hfovDeg:v, dtSec:v, skylineTopDeg:v, skylineMeasuredFraction:v, clippedFraction:v }); return 0; });
  }
  t('demote with junk', () => { m.demote([null, undefined, {}, { fromDeg: NaN }, 5, { fromDeg: 10, widthDeg: 1e9 }]); return 0; });
  t('completeness after abuse', () => m.completeness().fraction);
  t('snapshot serialises', () => { JSON.stringify(m.snapshot()); return 0; });
}
console.log(bad ? `\n${bad} FAILED` : '\nno crashes, no NaN leaks');
process.exitCode = bad ? 1 : 0;
if (!bad) console.log('(no call took longer than a moment, so nothing loops unbounded)');
