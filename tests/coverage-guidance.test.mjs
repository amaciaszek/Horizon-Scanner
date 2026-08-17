/* Coverage-guided scanning: the map that records what was seen, and the dot
 * that asks for what was not.
 *
 * The interaction being built is the Pixel panorama one — follow the target,
 * and if the scanner still needs something from a sector the target waits there
 * until it has it. Everything below tests one of the two halves of that:
 *
 *   COVERAGE is the physical truth. It must credit what the camera genuinely
 *   observed, refuse what it did not, and never take coverage away from an
 *   operator for wobbling, reversing or revisiting.
 *
 *   GUIDANCE is an opinion derived from that truth. It must lead when the scan
 *   is going well, wait when it is not, and above all never advance merely
 *   because the phone turned — which is the single behaviour that separates
 *   this from a compass progress meter.
 */
import { CoverageMap, COVERAGE_TUNING } from '../js/coverage.js';
import { ScanGuidance, GUIDANCE_TUNING } from '../js/guidance.js';
import { wrap360, angDiff } from '../js/math3d.js';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

/** A frame that is good in every way, so tests vary one thing at a time. */
const goodFrame = (headingDeg, over = {}) => ({
  headingDeg,
  elevationDeg: 2,
  rollDeg: 1,
  yawRateDegPerSec: 12,
  jitterDeg: 0.2,
  skylineConfidence: 0.7,
  visualQuality: 0.6,
  glareFraction: 0,
  frameStatus: 'ok',
  trackingLost: false,
  hfovDeg: 45.6,
  dtSec: 0.1,
  ...over
});

/**
 * Sweep the camera from one bearing to another at a given rate, feeding frames
 * at 10 Hz — the rate the real pipeline runs at.
 */
function sweep(map, { from, to, rateDegPerSec, direction = -1, frame = {}, hz = 10 }) {
  const dt = 1 / hz;
  const travel = direction < 0
    ? wrap360(from - to) || 360
    : wrap360(to - from) || 360;
  const steps = Math.max(1, Math.round(travel / (rateDegPerSec * dt)));
  for (let i = 0; i <= steps; i++) {
    const heading = wrap360(from + direction * (travel * i / steps));
    map.observe(goodFrame(heading, {
      yawRateDegPerSec: rateDegPerSec, dtSec: dt, ...frame
    }));
  }
  return steps;
}

console.log('=== A steady sweep paints the horizon ===');
{
  const map = new CoverageMap();
  sweep(map, { from: 0, to: 0, rateDegPerSec: 15 });     // a full lap
  const done = map.completeness();
  console.log(`   ${done.coveredBins}/${done.binCount} bins, mean score ${done.meanScore.toFixed(3)}`);
  check('a full unhurried lap completes the scan', done.complete === true,
    `${(done.fraction * 100).toFixed(1)}% covered`);
  check('confidence is high, not marginal', done.meanScore > 0.9,
    done.meanScore.toFixed(3));
}

console.log('\n=== Racing does not count as scanning ===');
{
  // Same full circle, same frames, four times the speed. The turn-rate ramp and
  // the observation-count floor should both bite.
  const fast = new CoverageMap();
  sweep(fast, { from: 0, to: 0, rateDegPerSec: 65 });
  const done = fast.completeness();
  console.log(`   at 65°/s: ${done.coveredBins}/${done.binCount} bins, mean ${done.meanScore.toFixed(3)}`);
  check('a fast lap does not complete the scan', done.complete === false,
    `${(done.fraction * 100).toFixed(1)}% covered`);
  check('but it is not worthless either', done.meanScore > 0,
    done.meanScore.toFixed(3));

  // And a second slow pass over the same ground finishes the job, rather than
  // the operator having to start again.
  sweep(fast, { from: 0, to: 0, rateDegPerSec: 15 });
  check('a second, slower lap completes it', fast.completeness().complete === true,
    `${(fast.completeness().fraction * 100).toFixed(1)}% covered`);
}

console.log('\n=== Frames that observed nothing earn nothing ===');
{
  const cases = [
    ['sky segmentation failed', { frameStatus: 'noSky' }],
    ['nothing but sky', { frameStatus: 'allSky' }],
    ['too dark', { frameStatus: 'tooDark' }],
    ['tracking lost', { trackingLost: true }],
    ['pointed at the zenith', { frameStatus: 'tooHigh' }],
    ['sun in the frame', { glareFraction: 0.09 }],
    ['skyline not confidently traced', { skylineConfidence: 0.12 }]
  ];
  for (const [label, over] of cases) {
    const map = new CoverageMap();
    for (let i = 0; i < 60; i++) map.observe(goodFrame(90, over));
    check(`${label}: no credit`, map.scoreAt(90) === 0, `score ${map.scoreAt(90).toFixed(3)}`);
  }
  // The control: the same sixty frames, but good.
  const control = new CoverageMap();
  for (let i = 0; i < 60; i++) control.observe(goodFrame(90));
  check('the same frames, unimpaired, do earn credit', control.coveredAt(90) === true,
    `score ${control.scoreAt(90).toFixed(3)}`);
}

console.log('\n=== Degraded frames count for less, not for nothing ===');
{
  const measure = over => {
    const map = new CoverageMap();
    for (let i = 0; i < 12; i++) map.observe(goodFrame(180, over));
    return map.scoreAt(180);
  };
  const clean = measure({});
  const tilted = measure({ rollDeg: 28 });
  const high = measure({ elevationDeg: 42 });
  const shaky = measure({ jitterDeg: 1.8 });
  const marginal = measure({ skylineConfidence: 0.36 });
  console.log(`   clean ${clean.toFixed(3)}  rolled ${tilted.toFixed(3)}  ` +
    `high ${high.toFixed(3)}  shaky ${shaky.toFixed(3)}  marginal ${marginal.toFixed(3)}`);
  check('a rolled camera earns less', tilted < clean * 0.9 && tilted > 0);
  check('an over-tilted camera earns less', high < clean * 0.9 && high > 0);
  check('an unstable sensor stream earns less', shaky < clean * 0.9 && shaky > 0);
  check('a marginal skyline earns less', marginal < clean * 0.9 && marginal > 0);
}

console.log('\n=== The field of view is credited, not just the axis ===');
{
  const map = new CoverageMap();
  for (let i = 0; i < 40; i++) map.observe(goodFrame(180, { hfovDeg: 45.6 }));
  // Usable field is 80% of 45.6, so about +/-18 degrees.
  check('the centre is covered', map.coveredAt(180) === true, map.scoreAt(180).toFixed(3));
  check('12° off-axis still gains', map.scoreAt(192) > 0.3, map.scoreAt(192).toFixed(3));
  check('well outside the field gains nothing', map.scoreAt(180 + 40) === 0,
    map.scoreAt(220).toFixed(3));
  check('the centre outscores the edge',
    map.scoreAt(180) > map.scoreAt(196), `${map.scoreAt(180).toFixed(3)} vs ${map.scoreAt(196).toFixed(3)}`);
}

console.log('\n=== Coverage is never taken away ===');
{
  // Cover a sector properly, then abuse it: race through, wobble, point at the
  // sky, lose tracking. None of that may undo work already done.
  const map = new CoverageMap();
  for (let i = 0; i < 40; i++) map.observe(goodFrame(90));
  const earned = map.scoreAt(90);
  check('the sector starts covered', map.coveredAt(90) === true, earned.toFixed(3));
  for (let i = 0; i < 80; i++) {
    map.observe(goodFrame(90, { yawRateDegPerSec: 120, rollDeg: 50, frameStatus: 'noSky' }));
    map.observe(goodFrame(90, { trackingLost: true }));
  }
  check('abuse does not reduce it', map.scoreAt(90) >= earned,
    `${map.scoreAt(90).toFixed(3)} vs ${earned.toFixed(3)}`);
  check('and it stays covered', map.coveredAt(90) === true);
}

console.log('\n=== One brilliant frame is not a scan ===');
{
  const map = new CoverageMap({ minObservations: 5 });
  for (let i = 0; i < 3; i++) map.observe(goodFrame(45, { dtSec: 0.25 }));
  check('score can be high after three frames', map.scoreAt(45) > 0.5, map.scoreAt(45).toFixed(3));
  check('but the sector is not covered yet', map.coveredAt(45) === false,
    `${map.observations[map.indexOf(45)]} observations`);
  for (let i = 0; i < 4; i++) map.observe(goodFrame(45, { dtSec: 0.25 }));
  check('enough observations completes it', map.coveredAt(45) === true);
}

console.log('\n=== Gaps are found, including across north ===');
{
  const map = new CoverageMap();
  sweep(map, { from: 0, to: 0, rateDegPerSec: 15 });
  // Wipe a run that straddles 0 degrees, the case a naive scan splits in two.
  for (let deg = 350; deg < 360 + 12; deg += map.binSizeDeg) {
    const i = map.indexOf(deg);
    map.score[i] = 0; map.observations[i] = 0;
  }
  const gaps = map.gaps();
  console.log(`   ${gaps.length} gap(s); largest ${gaps[0]?.widthDeg}° from ${gaps[0]?.fromDeg}°`);
  check('the gap is found as one run, not two', gaps.length === 1, `${gaps.length}`);
  check('its width is right', Math.abs(gaps[0].widthDeg - 22) <= map.binSizeDeg * 1.5,
    `${gaps[0].widthDeg}°`);
  check('the scan is no longer complete', map.completeness().complete === false);
}

console.log('\n=== The dot does not advance just because the phone turned ===');
{
  // The defining test. The operator sweeps a full circle feeding frames that
  // earn nothing at all. If the dot moves, this is a compass, not a scanner.
  const map = new CoverageMap();
  const guide = new ScanGuidance();
  let heading = 0;
  guide.update({ coverage: map, headingDeg: heading, dtSec: 0.1 });
  const started = guide.rawBearingDeg;
  for (let i = 0; i < 200; i++) {
    heading = wrap360(heading - 1.8);
    map.observe(goodFrame(heading, { frameStatus: 'noSky' }));   // no credit
    guide.update({ coverage: map, headingDeg: heading, dtSec: 0.1 });
  }
  console.log(`   phone turned 360°; target moved ${Math.abs(angDiff(guide.rawBearingDeg, started)).toFixed(1)}°`);
  check('the target did not chase the phone',
    Math.abs(angDiff(guide.rawBearingDeg, started)) < 30,
    `${Math.abs(angDiff(guide.rawBearingDeg, started)).toFixed(1)}°`);
  check('and it reports that it is waiting',
    guide.state === 'waiting' || guide.state === 'behind', guide.state);
}

console.log('\n=== The dot leads a scan that is going well ===');
{
  const map = new CoverageMap();
  const guide = new ScanGuidance();
  let heading = 0;
  let advanced = 0, previous = null;
  for (let i = 0; i < 240; i++) {
    map.observe(goodFrame(heading, { dtSec: 0.1, yawRateDegPerSec: 15 }));
    const g = guide.update({ coverage: map, headingDeg: heading, dtSec: 0.1 });
    if (previous !== null && Math.abs(angDiff(g.rawBearingDeg, previous)) > 0.5) advanced++;
    previous = g.rawBearingDeg;
    heading = wrap360(heading - 1.5);
  }
  check('the target moved on repeatedly', advanced > 20, `${advanced} advances`);
  check('and stayed ahead of the operator, not behind',
    guide.state !== 'behind', guide.state);
}

console.log('\n=== Racing past leaves the dot behind, and going back fixes it ===');
{
  const map = new CoverageMap();
  const guide = new ScanGuidance();
  // Cover the first sector properly so there is a frontier to leave behind.
  let heading = 0;
  for (let i = 0; i < 60; i++) {
    map.observe(goodFrame(heading, { dtSec: 0.1, yawRateDegPerSec: 12 }));
    guide.update({ coverage: map, headingDeg: heading, dtSec: 0.1 });
    heading = wrap360(heading - 0.6);
  }
  const frontier = guide.rawBearingDeg;

  // Now bolt: 90 degrees at speed, contributing little.
  for (let i = 0; i < 30; i++) {
    heading = wrap360(heading - 3);
    map.observe(goodFrame(heading, { dtSec: 0.1, yawRateDegPerSec: 90 }));
    guide.update({ coverage: map, headingDeg: heading, dtSec: 0.1 });
  }
  const behindBy = Math.abs(angDiff(guide.rawBearingDeg, heading));
  console.log(`   after bolting 90°, the target sits ${behindBy.toFixed(0)}° from the camera`);
  check('the target did not follow them', behindBy > 20, `${behindBy.toFixed(1)}°`);
  check('the uncovered ground is genuinely uncovered',
    map.coveredAt(guide.rawBearingDeg) === false);

  // Turn back and do it properly. The gap must fill and the dot move on.
  const target = guide.rawBearingDeg;
  for (let i = 0; i < 80; i++) {
    map.observe(goodFrame(target, { dtSec: 0.1, yawRateDegPerSec: 6 }));
    guide.update({ coverage: map, headingDeg: target, dtSec: 0.1 });
  }
  check('coming back fills it in', map.coveredAt(target) === true,
    map.scoreAt(target).toFixed(3));
  check('and the target moves on', Math.abs(angDiff(guide.rawBearingDeg, target)) > 2,
    `moved ${Math.abs(angDiff(guide.rawBearingDeg, target)).toFixed(1)}°`);
}

console.log('\n=== Reversing direction is not punished ===');
{
  const map = new CoverageMap();
  const guide = new ScanGuidance();
  let heading = 0;
  for (let i = 0; i < 40; i++) {           // counter-clockwise
    map.observe(goodFrame(heading, { dtSec: 0.1 }));
    guide.update({ coverage: map, headingDeg: heading, dtSec: 0.1 });
    heading = wrap360(heading - 1);
  }
  const before = map.completeness().meanScore;
  for (let i = 0; i < 40; i++) {           // and back clockwise over the same ground
    heading = wrap360(heading + 1);
    map.observe(goodFrame(heading, { dtSec: 0.1 }));
    guide.update({ coverage: map, headingDeg: heading, dtSec: 0.1 });
  }
  check('reversing still accumulates coverage',
    map.completeness().meanScore >= before, `${before.toFixed(3)} -> ${map.completeness().meanScore.toFixed(3)}`);
  check('nothing was reset', map.completeness().coveredBins > 0);
}

console.log('\n=== The dot moves with intent, never in jumps ===');
{
  const map = new CoverageMap();
  const guide = new ScanGuidance();
  // A map with two widely separated holes, to tempt it into teleporting.
  sweep(map, { from: 0, to: 0, rateDegPerSec: 15 });
  for (const centre of [30, 200]) {
    for (let d = -8; d <= 8; d += map.binSizeDeg) {
      const i = map.indexOf(centre + d);
      map.score[i] = 0; map.observations[i] = 0;
    }
  }
  let heading = 30, worst = 0;
  let previous = null;
  const dt = 1 / 30;
  for (let i = 0; i < 400; i++) {
    const g = guide.update({ coverage: map, headingDeg: heading, dtSec: dt });
    if (previous !== null && g.bearingDeg !== null) {
      worst = Math.max(worst, Math.abs(angDiff(g.bearingDeg, previous)));
    }
    previous = g.bearingDeg;
    heading = wrap360(heading - 0.5);       // drift past both holes
  }
  const cap = GUIDANCE_TUNING.maxSlewDegPerSec * dt;
  console.log(`   largest single-frame move ${worst.toFixed(2)}° (slew cap ${cap.toFixed(2)}°)`);
  check('the drawn dot never jumps further than the slew limit', worst <= cap + 1e-6,
    `${worst.toFixed(3)}° vs ${cap.toFixed(3)}°`);
}

console.log('\n=== Completion is coverage, not rotation ===');
{
  const map = new CoverageMap();
  const guide = new ScanGuidance();
  // Two full rotations of useless frames.
  let heading = 0;
  for (let i = 0; i < 400; i++) {
    heading = wrap360(heading - 1.8);
    map.observe(goodFrame(heading, { skylineConfidence: 0.1 }));
    guide.update({ coverage: map, headingDeg: heading, dtSec: 0.1 });
  }
  check('720° of rotation does not complete a scan',
    map.completeness().complete === false && guide.complete === false,
    `${(map.completeness().fraction * 100).toFixed(1)}% covered`);

  // Now actually scan it.
  sweep(map, { from: 0, to: 0, rateDegPerSec: 15 });
  const g = guide.update({ coverage: map, headingDeg: 0, dtSec: 0.1 });
  check('covering the horizon does', map.completeness().complete === true);
  check('and the guidance says so and stops asking',
    g.state === 'complete' && g.rawBearingDeg === null, g.state);
}

console.log('\n=== A sliver at a seam does not hold the survey hostage ===');
{
  const map = new CoverageMap();
  sweep(map, { from: 0, to: 0, rateDegPerSec: 15 });
  const i = map.indexOf(123);
  map.score[i] = 0; map.observations[i] = 0;     // one 2° bin missing
  check('one bin short of perfect still completes',
    map.completeness().complete === true,
    `${map.completeness().remainingDeg}° remaining, tolerance ${(COVERAGE_TUNING.completionTolerance * 360).toFixed(1)}°`);
  for (let d = 0; d < 16; d += map.binSizeDeg) {
    const j = map.indexOf(140 + d);
    map.score[j] = 0; map.observations[j] = 0;
  }
  check('a real hole does not', map.completeness().complete === false,
    `${map.completeness().remainingDeg}° remaining`);
}

console.log('\n=== Everything is tunable from one object ===');
{
  const coarse = new CoverageMap({ binSizeDeg: 5, coverageThreshold: 0.5, minObservations: 2 });
  check('bin size is honoured', coarse.binCount === 72, `${coarse.binCount} bins`);
  check('thresholds are honoured',
    coarse.tuning.coverageThreshold === 0.5 && coarse.tuning.minObservations === 2);
  const eager = new ScanGuidance({ leadDeg: 20, sweepDirection: 1 });
  check('guidance tuning is honoured',
    eager.tuning.leadDeg === 20 && eager.tuning.sweepDirection === 1);

  // Sweeping the other way must work symmetrically.
  const map = new CoverageMap();
  const guide = new ScanGuidance({ sweepDirection: 1 });
  let heading = 0;
  for (let i = 0; i < 120; i++) {
    map.observe(goodFrame(heading, { dtSec: 0.1 }));
    guide.update({ coverage: map, headingDeg: heading, dtSec: 0.1 });
    heading = wrap360(heading + 1);
  }
  check('a clockwise sweep advances the target too',
    guide.rawBearingDeg !== null && guide.state !== 'behind', guide.state);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
