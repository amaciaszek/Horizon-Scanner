'use strict';
/* Per-bearing and per-frame coverage, as tables.
 *
 * The ring says where the survey is thin and the profile says how high the
 * horizon is, but neither answers the two questions an operator actually has
 * when a build comes out wrong: WHICH bearings are weak and why, and WHICH
 * photographs the stitcher used. Both answers exist inside the survey already;
 * they have simply never been written down.
 *
 * These are deliberately tables of measurements, not verdicts. A row says what
 * was observed and by what route it was accepted; the operator decides what to
 * do about it. The one opinion here is the ordering — worst first — because a
 * 720-row list sorted by azimuth is a list nobody reads.
 */

import { BIN_COUNT, BIN_STEP, STATUS, RULES } from './survey.js';
import { wrap360 } from './math3d.js';

const STATUS_NAME = {
  [STATUS.EMPTY]: 'not surveyed',
  [STATUS.THIN]: 'single observation',
  [STATUS.WEAK]: 'needs more evidence',
  [STATUS.VERIFIED]: 'verified'
};

const median = xs => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Roll the 720 half-degree bins up into readable sectors.
 *
 * Fifteen degrees by default: twenty-four rows, which fits on a phone and is
 * still fine enough that a single bad building edge does not disappear into an
 * average. `sectorDeg` must divide 360.
 */
export function bearingCoverage(survey, { sectorDeg = 15 } = {}) {
  const perSector = Math.max(1, Math.round(sectorDeg / BIN_STEP));
  const rows = [];
  for (let start = 0; start < BIN_COUNT; start += perSector) {
    const slice = survey.bins.slice(start, start + perSector);
    const seen = slice.filter(b => b.obs.length);
    const obsCounts = seen.map(b => b.obs.length);
    const spreads = seen.map(b => b.spread).filter(Number.isFinite);
    const confs = seen.map(b => b.conf).filter(Number.isFinite);
    const alts = seen.map(b => b.alt).filter(Number.isFinite);
    const passes = new Set();
    for (const b of seen) for (const p of b.passes) passes.add(p);

    const verified = slice.filter(b => b.status === STATUS.VERIFIED).length;
    const singleLap = slice.filter(b => b.route === 'single-lap').length;
    const twoPass = slice.filter(b => b.route === 'two-pass').length;
    const empty = slice.length - seen.length;
    const spike = slice.filter(b => b.spike).length;

    // What one thing is holding this sector back? Reported as the first unmet
    // condition in the order an operator can act on them: you cannot fix a
    // spread problem by standing there longer if the sector was never seen.
    let blocker = null;
    if (empty === slice.length) blocker = 'never pointed at';
    else if (empty) blocker = `${empty} of ${slice.length} bins unseen`;
    else if (verified === slice.length) blocker = null;
    else if (median(obsCounts) < RULES.singleLapObservations && passes.size < RULES.minPasses) {
      blocker = `${median(obsCounts).toFixed(0)} looks per bin; ${RULES.singleLapObservations} clears it on one lap`;
    } else if (median(spreads) > RULES.maxSpreadDeg) {
      blocker = `altitudes disagree by ${median(spreads).toFixed(2)}°`;
    } else if (median(confs) < RULES.singleLapConfidence) {
      blocker = `skyline confidence ${(median(confs) * 100).toFixed(0)}%`;
    } else blocker = 'short of the confidence or spread bar';

    rows.push({
      fromDeg: start * BIN_STEP,
      toDeg: (start + slice.length) * BIN_STEP,
      bins: slice.length,
      observed: seen.length,
      verified, singleLap, twoPass, empty, spike,
      passes: passes.size,
      medianObs: obsCounts.length ? median(obsCounts) : 0,
      medianSpread: spreads.length ? median(spreads) : NaN,
      meanConf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : NaN,
      medianAlt: alts.length ? median(alts) : NaN,
      complete: verified === slice.length,
      blocker
    });
  }
  return rows;
}

/**
 * One row per photograph, joined against what the stitcher did with it.
 *
 * `report` is the stitch_lab report.json when a build has been run. Its
 * `graph.excludedFrameIndices` is the interesting column: a frame the solver
 * could not connect to the rest by visual overlap is omitted from the panorama
 * entirely, and until now that decision was invisible outside the log.
 */
export function frameCoverage(survey, { report = null, photos = null } = {}) {
  const excluded = new Set(report?.graph?.excludedFrameIndices || []);
  const built = !!report;
  const havePhoto = photos instanceof Map ? photos : null;

  return survey.keyframes.map(kf => {
    const conf = Array.from(kf.confidence || []);
    const meanConf = conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : NaN;
    const flags = Array.from(kf.flags || []);
    const clipped = flags.filter(f => f).length;
    const heading = Number.isFinite(kf.yawFused)
      ? kf.yawFused + (survey.yawDatum || 0)
      : (kf.yawRaw || 0) + (kf.yawBase || 0) + (survey.yawDatum || 0);

    let use = 'not built';
    if (built) use = excluded.has(kf.index) ? 'omitted' : 'used';

    return {
      index: kf.index,
      pass: kf.pass ?? 1,
      azimuth: wrap360(heading + (kf.yawCorrection || 0)),
      altitude: Number(kf.elevation) || 0,
      roll: Number(kf.roll) || 0,
      columns: conf.length,
      meanConf,
      clippedColumns: clipped,
      skyFraction: Number(kf.skyFraction),
      quality: Number(kf.visualQuality),
      movedDeg: Number(kf.bundleMovedDeg),
      hasPhoto: havePhoto ? havePhoto.has(kf.index) : null,
      use,
      // Why a frame was dropped. The solver only ever reports THAT it could not
      // connect one, so the reason is inferred here from the geometry — and
      // labelled as inference, because a guess presented as a finding is worse
      // than no finding.
      omissionHint: use === 'omitted' ? omissionHint(kf, survey) : null
    };
  });
}

function omissionHint(kf, survey) {
  const alt = Number(kf.elevation) || 0;
  const neighbours = survey.keyframes.filter(o =>
    o.index !== kf.index && Math.abs((Number(o.elevation) || 0) - alt) < 12);
  if (!neighbours.length) {
    return `no other frame within 12° of ${alt.toFixed(1)}° elevation to overlap with`;
  }
  if (Number(kf.visualQuality) < 0.25) return 'too little texture to match';
  return 'no verified visual overlap survived';
}

/**
 * The headline the panorama card should lead with.
 *
 * NOT the post-prune residual. On the 2026-08-18 capture that number said the
 * two-lap build (0.1012°) was very slightly BETTER than the one-lap build
 * (0.1024°) while the picture was visibly worse, because pruning deletes the
 * matches that disagree and the survivors then score beautifully. 27.7% of
 * cross-lap matches were deleted against 2.2% of same-lap ones, so the metric
 * is measuring what it chose to keep.
 *
 * Overlap disagreement is what tracked the ghosting: 17.7 for one lap, 24.1 for
 * two. It is the mean absolute difference, per channel, between what two
 * photographs say the same direction looks like — so it cannot be improved by
 * throwing evidence away.
 */
export function stitchVerdict(report) {
  if (!report) return null;
  const r = report.render || {};
  const mean = Number(r.meanOverlapDisagreement);
  const p95 = Number(r.p95OverlapDisagreement);
  if (!Number.isFinite(mean)) return null;

  let grade, plain;
  if (mean < 14) { grade = 'SHARP'; plain = 'Overlapping photographs agree closely. Edges should be single and clean.'; }
  else if (mean < 20) { grade = 'GOOD'; plain = 'Minor disagreement in the overlaps, at about the level of ordinary hand movement.'; }
  else if (mean < 28) { grade = 'SOFT'; plain = 'Overlaps disagree enough to show as doubling on near objects — windows, rooflines, siding.'; }
  else { grade = 'GHOSTED'; plain = 'Overlapping photographs disagree badly. Expect visible double images on anything close.'; }

  return {
    grade, plain,
    meanDisagreement: mean,
    p95Disagreement: p95,
    paintedFraction: Number(r.paintedFraction),
    overlapFraction: Number(r.overlapFraction),
    renderedFrames: Number(r.renderedFrames),
    totalFrames: Number(report.frames),
    excluded: (report.graph?.excludedFrameIndices || []).length,
    focalScale: Number(report.focalScale),
    // Kept, but demoted, and labelled for what it is.
    prunedResidualDeg: Number(report.residualDeg?.solvedMedian)
  };
}
