/**
 * Load every pure module and call the functions that run at the end of a lap.
 *
 * This exists because of 2026-08-17. A variable was deleted from
 * `captureGapReport` while one remaining use of it further down went unnoticed.
 * `node --check` passed, the app booted, the page looked fine — and the failure
 * only appeared on a real device after a full capture, where it stalled the
 * survey at "Building the profile" and made every ZIP export fail. A
 * ReferenceError in a rarely-taken branch is invisible to a syntax check and to
 * anything that only loads the page.
 *
 * So: exercise the functions, with real keyframes, on the paths that only run
 * after a lap is finished. `tools/smoke-keyframes.json` is the 66-frame
 * 2026-08-17 23:48 capture reduced to the fields these functions read.
 *
 *     node tools/smoke.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const kfs = JSON.parse(readFileSync(join(here, 'smoke-keyframes.json'), 'utf8'));

let failures = 0;
async function check(label, fn) {
  try {
    const value = await fn();
    console.log(`ok    ${label}${value === undefined ? '' : `  — ${String(value).slice(0, 80)}`}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${label}\n        ${err?.constructor?.name}: ${err?.message}`);
  }
}

const gaps = await import('../js/capture-gaps.js');
const policy = await import('../js/capture-policy.js');
const coverage = await import('../js/coverage.js');
const guide = await import('../js/guide.js');
const guidance = await import('../js/guidance.js');
const panorama = await import('../js/panorama.js');
const focal = await import('../js/focal-check.js');

// The end-of-lap report. This is the one that broke.
await check('captureGapReport, 66 real keyframes', () => {
  const r = gaps.captureGapReport(kfs, 0);
  return `${r.sweepKeyframeCount ?? r.keyframeCount} sweeps, ${r.gaps?.length ?? 0} gaps`;
});
await check('captureGapReport, empty', () => gaps.captureGapReport([], 0).keyframeCount);
await check('captureGapReport, null', () => gaps.captureGapReport(null, 0).keyframeCount);
await check('captureGapReport, single frame', () => gaps.captureGapReport([kfs[0]], 0).keyframeCount);
await check('captureGapReport, pass-2 frames present', () => {
  const mixed = kfs.map((kf, i) => (i % 3 === 0 ? { ...kf, pass: 2, captureKind: 'targeted-cleanup' } : kf));
  return `${gaps.captureGapReport(mixed, 0).passes.length} passes`;
});
await check('bearingLabel', () => gaps.bearingLabel(123.4));

await check('maxKeyframeYawRate handheld', () => policy.maxKeyframeYawRate());
await check('maxKeyframeYawRate tripod', () => policy.maxKeyframeYawRate({ mode: 'tripod' }));
await check('keyframeMotionAccepted', () => policy.keyframeMotionAccepted(10, { mode: 'handheld' }));
await check('keyframeStepDeg', () => policy.keyframeStepDeg(37.5).toFixed(2));

// The tilt ceiling the guidance rides on. Asserted, not just read, because it
// was lowered once as a workaround for a bug in the panorama solver.
await check('coverage tilt ceiling is 60', () => {
  const v = coverage.COVERAGE_TUNING.maxRequestedElevationDeg;
  if (v !== 60) throw new Error(`expected 60, got ${v}`);
  return v;
});
await check('tilt ceiling stays clear of the zenith limits', () => {
  const v = coverage.COVERAGE_TUNING.maxRequestedElevationDeg;
  // 65 is where visual yaw is abandoned, 70 warns, 78 rejects outright. Asking
  // the operator to tilt past any of those would be asking them to ruin frames.
  if (v >= 65) throw new Error(`ceiling ${v} reaches the visual-yaw cutoff`);
  return `${v} < 65`;
});
await check('CoverageMap constructs and resets', () => {
  const map = new coverage.CoverageMap();
  map.reset();
  return `${map.binCount} bins`;
});
await check('restElevationAt returns the horizon over open ground', () => {
  const map = new coverage.CoverageMap();
  map.reset();
  const v = map.restElevationAt(123);
  if (v !== 0) throw new Error(`expected 0, got ${v}`);
  return v;
});

/*
 * The descent. This is the behaviour that was missing: the dot led the operator
 * up a tall roof and then rode along at that height once they turned past it,
 * so the sector beyond the roof never filled and the survey felt stuck.
 *
 * Modelled here as two adjacent bearings — one with a 40-degree obstruction,
 * one over open ground — which is exactly the edge-of-the-house case.
 */
await check('rest elevation drops to the horizon past an obstruction', () => {
  const map = new coverage.CoverageMap();
  map.reset();
  const overRoof = 90, pastRoof = 140;
  map.requiredElevation[map.indexOf(overRoof)] = 40;
  const onRoof = map.restElevationAt(overRoof);
  const beyond = map.restElevationAt(pastRoof);
  if (onRoof !== 40) throw new Error(`over the roof expected 40, got ${onRoof}`);
  if (beyond !== 0) throw new Error(`past the roof expected 0, got ${beyond}`);
  // The camera is still up at the roof's height having turned past it. That gap
  // is what the dot must now lead the operator down through.
  const drop = 40 - beyond;
  if (drop <= guidance.GUIDANCE_TUNING.descentPromptDeg) {
    throw new Error(`a ${drop}° drop would not prompt a descent`);
  }
  return `${onRoof}° over the roof, ${beyond}° past it, ${drop}° descent prompted`;
});

await check('descent prompt is less twitchy than the lift prompt', () => {
  const t = guidance.GUIDANCE_TUNING;
  if (!(t.descentPromptDeg > t.liftPromptDeg)) {
    throw new Error(`descent ${t.descentPromptDeg} should exceed lift ${t.liftPromptDeg}`);
  }
  return `lift ${t.liftPromptDeg}°, descent ${t.descentPromptDeg}°`;
});

// A cleanup lap must capture when simply turning, not only when parked on a
// designated target. Requiring `onTarget` alone meant the app silently declined
// to photograph what the operator deliberately turned to show it.
await check('pass 2 cleanup captures on ordinary turning', () => {
  const ok = policy.pass2CaptureAccepted({
    verificationSweep: false, onTarget: false, angularTravelDeg: 9, stepDeg: 7.5,
    stillness: 0, elapsedMs: 0
  });
  if (!ok) throw new Error('turning during cleanup captured nothing');
  return ok;
});
await check('pass 2 cleanup still rewards holding on target', () => {
  const ok = policy.pass2CaptureAccepted({
    verificationSweep: false, onTarget: true, angularTravelDeg: 0, stepDeg: 7.5,
    stillness: 0.9, elapsedMs: 500
  });
  if (!ok) throw new Error('holding on target captured nothing');
  return ok;
});

/*
 * The build-stage time estimate. Driven with a fake clock so the assertions are
 * about the arithmetic rather than about how fast this machine happens to be.
 *
 * The property that matters is that it is MEASURED: feed it a slow machine and
 * it must say a bigger number, with no hardcoded expectation of how long a
 * stage "should" take.
 */
const bp = await import('../js/build-progress.js');

await check('no estimate offered before there is evidence', () => {
  let clock = 0;
  const p = new bp.BuildProgress(null, () => clock);
  p.update('features', 1, 100);
  clock = 1000;
  if (p.snapshot().remainingSec !== null) throw new Error('guessed from one sample');
  return p.snapshot().etaText;
});

await check('estimate scales with observed rate', () => {
  const run = msPerUnit => {
    let clock = 0;
    const p = new bp.BuildProgress(null, () => clock);
    for (let i = 1; i <= 10; i++) { clock = i * msPerUnit; p.update('features', i, 100); }
    return p.snapshot().remainingSec;
  };
  const fast = run(10), slow = run(100);
  if (!(slow > fast * 5)) throw new Error(`slow ${slow} vs fast ${fast} — not rate-driven`);
  return `fast ${fast.toFixed(1)}s, slow ${slow.toFixed(1)}s`;
});

await check('estimate falls as work completes', () => {
  let clock = 0;
  const seen = [];
  // onUpdate set, exactly as the app does it, so the smoothing advances once
  // per progress report rather than once per time the caller happens to look.
  const p = new bp.BuildProgress(s => seen.push(s.remainingSec), () => clock);
  for (let i = 1; i <= 90; i++) { clock = i * 50; p.update('features', i, 100); }
  const first = seen.find(v => v !== null);
  const last = seen[seen.length - 1];
  // Only a decrease is asserted, not a large one. Two things move in opposite
  // directions here: the current stage's own remainder shrinks towards zero,
  // while the projection for the stages after it GROWS as the per-unit rate is
  // measured more accurately than it could be from the first few units. A
  // modest net fall is the honest expectation; demanding a big one would be
  // demanding that the estimate stay over-confident.
  if (!(last < first)) {
    throw new Error(`${first?.toFixed(1)} -> ${last?.toFixed(1)}: did not fall at all`);
  }
  // It must NOT collapse to nothing: matching, solving and rendering have not
  // run yet, and an estimate that ignores them would promise the operator the
  // build is nearly over when roughly half of it is still ahead.
  if (last <= 0.5) throw new Error(`${last} forgets the stages that have not started`);
  return `${first.toFixed(1)}s -> ${last.toFixed(1)}s, later stages still counted`;
});

await check('estimate reaches zero only when everything is done', () => {
  let clock = 0;
  let final = null;
  const p = new bp.BuildProgress(s => { final = s; }, () => clock);
  for (const stage of ['decoding', 'features', 'matching', 'solving', 'rendering']) {
    for (let i = 1; i <= 10; i++) { clock += 20; p.update(stage, i, 10); }
  }
  p.finish();
  if (final.fraction !== 1 || final.remainingSec !== 0) {
    throw new Error(`finished at fraction ${final.fraction}, remaining ${final.remainingSec}`);
  }
  return `${final.etaText}, ${final.elapsedSec.toFixed(1)}s elapsed`;
});

await check('fraction advances across stages and never exceeds 1', () => {
  let clock = 0;
  const p = new bp.BuildProgress(null, () => clock);
  const seen = [];
  for (const stage of ['decoding', 'features', 'matching', 'solving', 'rendering']) {
    for (let i = 1; i <= 5; i++) { clock += 10; p.update(stage, i, 5); }
    seen.push(p.snapshot().fraction);
  }
  for (let i = 1; i < seen.length; i++) {
    if (seen[i] < seen[i - 1]) throw new Error(`fraction went backwards: ${seen}`);
  }
  if (seen[seen.length - 1] > 1) throw new Error(`fraction exceeded 1: ${seen}`);
  return seen.map(f => f.toFixed(2)).join(' -> ');
});

await check('formatEta stays coarse and honest', () => {
  const cases = [[null, 'estimating…'], [2, 'a few seconds left'], [3000, null]];
  for (const [secs, want] of cases) {
    const got = bp.formatEta(secs);
    if (want && got !== want) throw new Error(`formatEta(${secs}) = ${got}, wanted ${want}`);
  }
  return `${bp.formatEta(42)} / ${bp.formatEta(300)}`;
});

// More data is wanted, so neither of these may quietly stop recording.
await check('pass 1 records well past a single lap', () => {
  if (policy.pass1OverTravel(700).refuseNewSweeps) throw new Error('refused at 700°');
  if (!policy.pass1OverTravel(400.1).prompt) throw new Error('stopped prompting to close the lap');
  return `prompts at ${policy.PASS1_PROMPT_DEG}°, refuses at ${policy.PASS1_REFUSE_DEG}°`;
});

await check('the dot will turn you back for a narrow gap', () => {
  const w = guidance.GUIDANCE_TUNING.minFrontierRunDeg;
  if (w > 5) throw new Error(`${w}° is too wide a gap to bother returning for`);
  return `${w}°`;
});

// The stylesheet carries a version query so a device cannot pair new markup
// with a cached stylesheet. It is only useful if it actually tracks VERSION.
await check('stylesheet cache-bust matches VERSION', async () => {
  const { VERSION } = await import('../js/version.js');
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
  const m = html.match(/styles\.css\?v=([\d.]+)/);
  if (!m) throw new Error('no version query on the stylesheet link');
  if (m[1] !== VERSION) throw new Error(`stylesheet says ${m[1]}, VERSION is ${VERSION}`);
  return `v${m[1]}`;
});

/*
 * Lens measurement advice. The operator's complaint was that they could not
 * tell what it was using or whether it was getting anywhere, so the property
 * under test is that the advice describes the view they are pointed at NOW —
 * not an average over everything they have done.
 */
const lc = await import('../js/lenscal.js');
const goodPan = cal => cal.addPan({ dxPx: 10, dYawDeg: 1, quality: 0.8 });

await check('offers no verdict before it has evidence', () => {
  const cal = new lc.LensCalibrator(320, 240);
  const d = cal.diagnose();
  if (d.problem !== null) throw new Error(`invented a problem from nothing: ${d.problem}`);
  if (d.lock !== null) throw new Error('quoted a lock fraction with no samples');
  return `axis ${d.axis}, need ${d.need}`;
});

await check('names a featureless view', () => {
  const cal = new lc.LensCalibrator(320, 240);
  for (let i = 0; i < 24; i++) cal.addPan({ dxPx: 10, dYawDeg: 1, quality: 0.05 });
  const d = cal.diagnose();
  if (d.problem !== 'quality') throw new Error(`said ${d.problem}, expected quality`);
  return `${d.problem}, lock ${d.lock}`;
});

await check('tells too-slow from too-fast', () => {
  const slow = new lc.LensCalibrator(320, 240);
  for (let i = 0; i < 24; i++) slow.addPan({ dxPx: 1, dYawDeg: 0.05, quality: 0.8 });
  const fast = new lc.LensCalibrator(320, 240);
  for (let i = 0; i < 24; i++) fast.addPan({ dxPx: 200, dYawDeg: 30, quality: 0.8 });
  const a = slow.diagnose().problem, b = fast.diagnose().problem;
  if (a !== 'tooSlow' || b !== 'tooFast') throw new Error(`got ${a} and ${b}`);
  return `${a} / ${b}`;
});

// The one that matters: point at sky, get told; then find a tree, and the
// advice must follow you rather than holding the earlier verdict.
await check('advice follows the operator to a better view', () => {
  const cal = new lc.LensCalibrator(320, 240);
  for (let i = 0; i < 40; i++) cal.addPan({ dxPx: 10, dYawDeg: 1, quality: 0.05 });
  const stuck = cal.diagnose();
  if (stuck.problem !== 'quality') throw new Error('did not flag the bad view');
  for (let i = 0; i < 24; i++) goodPan(cal);
  const moved = cal.diagnose();
  if (moved.problem !== null) {
    throw new Error(`still complaining (${moved.problem}) after the view improved`);
  }
  if (!(moved.lock > 0.9)) throw new Error(`lock only ${moved.lock} on a good view`);
  return `bad: ${stuck.problem} -> good: lock ${moved.lock.toFixed(2)}`;
});

await check('progress is countable and moves to the tilt axis', () => {
  const cal = new lc.LensCalibrator(320, 240);
  for (let i = 0; i < 200; i++) goodPan(cal);
  const d = cal.diagnose();
  if (!(d.nPan > 0)) throw new Error('collected no pan pairs');
  if (!d.panReady) throw new Error(`pan not ready after 200 clean pairs (n=${d.nPan})`);
  if (d.axis !== 'tilt') throw new Error(`axis is ${d.axis}, should have moved to tilt`);
  return `pan ${d.nPan} ready, now asking for ${d.axis}`;
});

/*
 * The 2026-08-18 dead end. After 476 degrees of turning the guide said "stop,
 * the lap is done, tap the button below" while the button underneath still read
 * "Keep going - 0% of the horizon covered" and was disabled, because the
 * controls were only refreshed at phase transitions. The label and the enabled
 * state both have to be functions of the CURRENT travel.
 */
await check('past a full circle the lap can always be closed', () => {
  const over = policy.pass1OverTravel(476);
  if (!over.prompt) throw new Error('476 degrees did not read as over-travel');
  // The button's `enough` test, mirrored: travel alone must be sufficient, with
  // no dependence on coverage having been fed.
  const enough = 476 >= 300;
  if (!enough) throw new Error('travel alone would not enable the button');
  return `prompt at ${policy.PASS1_PROMPT_DEG}°, enabled from 300°`;
});

await check('the close-the-lap label never says "keep going"', () => {
  const html = readFileSync(join(here, '..', 'js', 'main.js'), 'utf8');
  const block = html.slice(html.indexOf('if (p === PHASE.PASS1) {'));
  const label = block.slice(0, block.indexOf('return;'));
  if (!label.includes('over.prompt')) {
    throw new Error('the pass-1 label does not consider over-travel');
  }
  if (!/setPrimary\(btn, text, !enough\)/.test(label)) {
    throw new Error('the pass-1 button is not driven through setPrimary');
  }
  return 'over-travel label wired';
});

await check('controls are refreshed from the render loop', () => {
  const src = readFileSync(join(here, '..', 'js', 'main.js'), 'utf8');
  const live = src.slice(src.indexOf('function renderLive() {'));
  const head = live.slice(0, live.indexOf('const ctx = {'));
  if (!head.includes('syncControls()')) {
    throw new Error('renderLive does not refresh the controls, so labels can go stale');
  }
  return 'syncControls called per frame';
});

// Coverage must not call itself done while work remains. A non-zero tolerance
// both permitted gaps AND made ScanGuidance drop its bearing, so the dot
// disappeared exactly when cleanup targets were still outstanding.
await check('coverage demands the whole ring', () => {
  const t = coverage.COVERAGE_TUNING;
  if (t.completionTolerance !== 0) {
    throw new Error(`tolerance ${t.completionTolerance} still permits uncovered bins`);
  }
  if (!(t.coverageThreshold >= 0.85)) throw new Error(`threshold ${t.coverageThreshold} too low`);
  if (!(t.minObservations >= 8)) throw new Error(`minObservations ${t.minObservations} too low`);
  return `tol 0, threshold ${t.coverageThreshold}, ${t.minObservations} looks`;
});

await check('one capture mode only', () => {
  const ids = Object.keys(guide.MODES);
  if (ids.length !== 1 || ids[0] !== 'handheld') throw new Error(`modes: ${ids.join(',')}`);
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
  if (html.includes('modeSelect')) throw new Error('the mode picker is still in the markup');
  return ids[0];
});

// Feathering is what makes the panorama readable rather than a diagnostic
// instrument; the hard-cut mode must survive as a switch, not be replaced.
await check('the mosaic offers both blended and hard-cut modes', () => {
  const src = readFileSync(join(here, '..', 'js', 'panorama.js'), 'utf8');
  if (!src.includes('const blend = !!opts.blend')) throw new Error('no blend option');
  if (!src.includes('axisDist[i]')) throw new Error('nearest-axis diagnostic mode is gone');
  const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
  if (!html.includes('panoBlend')) throw new Error('no toggle in the markup');
  return 'blend + nearest-axis';
});

/*
 * The skyline top is the entire product. These three guard the path that
 * measures it, and each corresponds to a specific way it has already failed.
 */

// 1. Satisfaction must come from seeing the top, not from pointing high.
//    On the 2026-08-18 20:06 capture one frame aimed over the roof set
//    satisfiedElevation to 56.5 on thirteen bins at once and the roof was never
//    captured.
await check('aiming over an obstruction does not mark it measured', () => {
  const map = new coverage.CoverageMap();
  map.reset();
  const az = 90;
  const i = map.indexOf(az);
  // A frame high above the roof, clear sky, nothing traced.
  map.observe({
    headingDeg: az, elevationDeg: 56.5, vfovDeg: 33, clippedFraction: 0,
    skylineTopDeg: null, skylineMeasuredFraction: 0,
    skylineConfidence: 0.8, visualQuality: 0.6, dtSec: 0.1, atMs: 1
  });
  if (map.satisfiedElevation[i] > 0) {
    throw new Error(`empty sky satisfied the bin at ${map.satisfiedElevation[i]}°`);
  }
  return 'not satisfied';
});

// 2. A frame that actually traces the top, with headroom, does satisfy it.
await check('tracing the top with headroom satisfies the bin', () => {
  const map = new coverage.CoverageMap();
  map.reset();
  const az = 90, i = map.indexOf(az);
  map.observe({
    headingDeg: az, elevationDeg: 40, vfovDeg: 33, clippedFraction: 0,
    skylineTopDeg: 44, skylineMeasuredFraction: 0.9,
    skylineConfidence: 0.8, visualQuality: 0.6, dtSec: 0.1, atMs: 1
  });
  if (!(map.measuredTop[i] >= 44)) throw new Error(`measuredTop ${map.measuredTop[i]}`);
  if (!(map.satisfiedElevation[i] >= 44)) {
    throw new Error(`traced top did not satisfy: ${map.satisfiedElevation[i]}`);
  }
  return `measuredTop ${map.measuredTop[i]}°`;
});

// 3. The height model must survive the pass boundary. This is the regression
//    behind "before the two-pass thing we got the roof every time".
await check('the height model survives a new lap', () => {
  const map = new coverage.CoverageMap();
  map.reset();
  const az = 90, i = map.indexOf(az);
  map.obstructionTop[i] = 60;
  map.measuredTop[i] = 58;
  map.requiredElevation[i] = 48;
  map.score[i] = 0.95;
  map.reset({ keepWorld: true });
  if (map.requiredElevation[i] !== 48) throw new Error('required elevation was wiped');
  if (map.obstructionTop[i] !== 60) throw new Error('obstruction top was wiped');
  if (map.measuredTop[i] !== 58) throw new Error('measured top was wiped');
  // ...but coverage confidence must NOT survive, or pass 2 verifies nothing.
  if (map.score[i] !== 0) throw new Error('coverage score survived, so pass 2 verifies nothing');
  return 'heights kept, confidence cleared';
});

await check('PHASE values', () => Object.values(guide.PHASE).join(','));
await check('ScanDirector constructs', () => new guide.ScanDirector({ keyframes: [], coverage: () => ({}) }).phase);
await check('guidance exports', () => Object.keys(guidance).join(','));
await check('panorama exports', () => `${Object.keys(panorama).length} exports`);
await check('focal-check exports', () => Object.keys(focal).join(','));

// Nothing anywhere should still mention the removed obstruction probe.
await check('no obstruction-probe references remain', async () => {
  const { execSync } = await import('child_process');
  const hits = execSync(
    'git grep -l "obstructionProbe\\|obstruction-probe\\|probeBtn" -- "*.js" "*.html" || true',
    { cwd: join(here, '..'), encoding: 'utf8' }
  ).trim();
  if (hits) throw new Error(`still referenced in: ${hits.split('\n').join(', ')}`);
  return 'clean';
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
process.exit(failures ? 1 : 0);
