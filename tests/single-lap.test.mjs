/* The single-lap verification route, and the tables that report it.
 *
 * The rule under test exists because of a measurement, not a preference. On the
 * 2026-08-18 iPad capture, two frames in the same lap disagreed by 0.084° after
 * the best possible rotation was removed; two frames in different laps by
 * 0.203°, and by 1.215° at the 90th percentile. That residue is parallax from
 * the operator standing somewhere slightly different, and a rotation-only
 * stitcher can only average it. So a second lap buys confirmation and sells
 * sharpness, and a bin that can be finished inside one lap should be.
 *
 * The danger in that change is obvious: it must not become a way for a thin
 * survey to call itself verified. Most of what follows is that negative test.
 */

import { Survey, STATUS, RULES } from '../js/survey.js';
import { bearingCoverage, frameCoverage, stitchVerdict } from '../js/coverage-table.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const section = t => console.log(`\n=== ${t} ===`);

/** A bin with n observations of the same altitude, all from one pass. */
function fillBin(bin, { n, pass = 1, alt = 10, spread = 0, conf = 0.8 }) {
  bin.obs = Array.from({ length: n }, (_, i) => ({
    alt: alt + (i % 2 ? spread : -spread), conf, pass
  }));
  bin.alt = alt;
  bin.spread = spread;
  bin.conf = conf;
  bin.passes = new Set([pass]);
  return bin;
}

section('One lap can verify a bin, but only on better evidence');

{
  const s = new Survey();
  // Exactly what the two-pass route would accept, minus the second pass.
  const b = fillBin(s.bins[0], { n: RULES.minObservations, conf: RULES.minConfidence });
  b.status = s._grade(b);
  check('four looks on one lap is NOT enough',
    b.status === STATUS.WEAK && b.route === null, `status=${b.status}`);

  const c = fillBin(s.bins[1], { n: RULES.singleLapObservations, conf: RULES.singleLapConfidence });
  c.status = s._grade(c);
  check('eight tight, confident looks on one lap IS enough',
    c.status === STATUS.VERIFIED && c.route === 'single-lap', `route=${c.route}`);
}

{
  const s = new Survey();
  // Enough looks, but they disagree by more than the tightened allowance.
  const b = fillBin(s.bins[0], {
    n: RULES.singleLapObservations, conf: 0.9,
    spread: RULES.maxSpreadDeg * RULES.singleLapSpreadScale + 0.2
  });
  b.spread = RULES.maxSpreadDeg * RULES.singleLapSpreadScale + 0.2;
  b.status = s._grade(b);
  check('a loose spread is refused even with plenty of looks',
    b.status === STATUS.WEAK, `spread=${b.spread.toFixed(2)}`);

  // Enough looks and tight, but the segmenter was unsure.
  const c = fillBin(s.bins[1], {
    n: RULES.singleLapObservations, conf: RULES.singleLapConfidence - 0.05
  });
  c.status = s._grade(c);
  check('low confidence is refused even with plenty of looks',
    c.status === STATUS.WEAK, `conf=${c.conf}`);
}

section('The single-lap route never rescues a contradiction');

{
  const s = new Survey();
  // Seen on BOTH laps, densely and tightly — but the two laps disagree, so the
  // spread is wide. Dense sampling within one lap is not an answer to having
  // been contradicted by another, and the route must not be offered.
  const b = fillBin(s.bins[0], { n: 20, conf: 0.9 });
  b.passes = new Set([1, 2]);
  b.spread = RULES.maxSpreadDeg + 2;
  b.status = s._grade(b);
  check('a bin contradicted across two laps stays unverified',
    b.status === STATUS.WEAK && b.route === null, `route=${b.route}`);
}

section('The two-pass route still works and is still labelled');

{
  const s = new Survey();
  const b = fillBin(s.bins[0], { n: RULES.minObservations, conf: 0.8 });
  b.passes = new Set([1, 2]);
  b.status = s._grade(b);
  check('four looks across two passes verifies as before',
    b.status === STATUS.VERIFIED && b.route === 'two-pass', `route=${b.route}`);
}

section('A thin survey still cannot call itself finished');

{
  const s = new Survey();
  // Every bin seen twice — the old bar for "two passes per bin" — but only
  // twice, which is below minObservations and below the single-lap bar too.
  for (const b of s.bins) fillBin(b, { n: 2, conf: 0.8 });
  s.bins.forEach(b => { b.status = s._grade(b); });
  const verified = s.bins.filter(b => b.status === STATUS.VERIFIED).length;
  check('two looks per bin verifies nothing', verified === 0, `${verified} verified`);
}

section('The bearing table reports the route and names the blocker');

{
  const s = new Survey();
  // First 30 bins (0-15°) finished on one lap; the rest never seen.
  for (let i = 0; i < 30; i++) {
    const b = fillBin(s.bins[i], { n: RULES.singleLapObservations, conf: 0.8 });
    b.status = s._grade(b);
  }
  const rows = bearingCoverage(s, { sectorDeg: 15 });
  check('sector count matches the requested size', rows.length === 24, `${rows.length} rows`);

  const first = rows[0];
  check('the finished sector is complete and credited to one lap',
    first.complete && first.singleLap === 30 && first.twoPass === 0,
    `singleLap=${first.singleLap} complete=${first.complete}`);
  check('a finished sector has no blocker', first.blocker === null);

  const empty = rows[5];
  check('an unsurveyed sector says so',
    empty.observed === 0 && /never pointed at/.test(empty.blocker), `"${empty.blocker}"`);
}

{
  const s = new Survey();
  // Seen, but thinly: the blocker should name the observation count, and should
  // quote the number that would actually clear it on one lap.
  for (let i = 0; i < 30; i++) {
    const b = fillBin(s.bins[i], { n: 3, conf: 0.8 });
    b.status = s._grade(b);
  }
  const row = bearingCoverage(s, { sectorDeg: 15 })
    .find(r => r.fromDeg === 0);
  check('a thin sector blames the look count and quotes the target',
    /looks per bin/.test(row.blocker) && row.blocker.includes(String(RULES.singleLapObservations)),
    `"${row.blocker}"`);
}

section('The frame table joins against what the stitcher did');

{
  const s = new Survey();
  for (let i = 0; i < 5; i++) {
    s.addKeyframe({
      quat: [0, 0, 0, 1], elevation: i * 3, roll: 0, yawRaw: i * 20, yawBase: 0,
      pass: i < 3 ? 1 : 2, confidence: [0.7, 0.8], visualQuality: 0.6, tanHalfH: 0.36
    });
  }

  const before = frameCoverage(s, { report: null });
  check('with no build, every frame reads "not built"',
    before.every(f => f.use === 'not built'), `${before.length} frames`);

  const after = frameCoverage(s, {
    report: { graph: { excludedFrameIndices: [3] } }
  });
  check('an excluded frame is marked omitted',
    after[3].use === 'omitted' && after.filter(f => f.use === 'used').length === 4,
    `frame 3 = ${after[3].use}`);
  check('an omitted frame carries a reason', typeof after[3].omissionHint === 'string'
    && after[3].omissionHint.length > 10, `"${after[3].omissionHint}"`);
  check('lap membership survives into the table',
    after.filter(f => f.pass === 1).length === 3);
}

section('The verdict grades on disagreement, not on the pruned residual');

{
  // These are the two real builds measured on 2026-08-18: one lap versus both,
  // same code and settings. The residual says the two-lap build is very slightly
  // BETTER; the picture is visibly worse. The verdict must follow the picture.
  const oneLap = stitchVerdict({
    frames: 110, focalScale: 0.9892,
    residualDeg: { solvedMedian: 0.1024 },
    graph: { excludedFrameIndices: [1, 2, 3, 4, 5, 6] },
    render: {
      meanOverlapDisagreement: 17.73, p95OverlapDisagreement: 51.45,
      paintedFraction: 0.655, overlapFraction: 0.404, renderedFrames: 104
    }
  });
  const bothLaps = stitchVerdict({
    frames: 200, focalScale: 0.9757,
    residualDeg: { solvedMedian: 0.1012 },
    graph: { excludedFrameIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    render: {
      meanOverlapDisagreement: 24.06, p95OverlapDisagreement: 79.67,
      paintedFraction: 0.685, overlapFraction: 0.472, renderedFrames: 191
    }
  });

  check('the pruned residual really does prefer the worse build',
    bothLaps.prunedResidualDeg < oneLap.prunedResidualDeg,
    `${bothLaps.prunedResidualDeg} < ${oneLap.prunedResidualDeg}`);
  check('the verdict prefers the one-lap build',
    oneLap.meanDisagreement < bothLaps.meanDisagreement,
    `${oneLap.grade} vs ${bothLaps.grade}`);
  check('one lap grades better than two', oneLap.grade === 'GOOD' && bothLaps.grade === 'SOFT',
    `${oneLap.grade} / ${bothLaps.grade}`);

  // And the real in-browser build of the same two-lap capture.
  const measured = stitchVerdict({
    frames: 200, focalScale: 0.9853,
    residualDeg: { solvedMedian: 0.1000 },
    graph: { excludedFrameIndices: Array(9).fill(0) },
    render: {
      meanOverlapDisagreement: 30.92, p95OverlapDisagreement: 104.94,
      paintedFraction: 0.710, overlapFraction: 0.503, renderedFrames: 191
    }
  });
  check('a 0.100 deg residual can still be a GHOSTED panorama',
    measured.grade === 'GHOSTED' && measured.prunedResidualDeg < 0.11,
    `${measured.grade} at ${measured.prunedResidualDeg}°`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall single-lap and coverage-table checks passed');
process.exitCode = failures ? 1 : 0;
