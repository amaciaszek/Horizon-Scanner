/* Where a build spent its time, recorded so it can be compared across devices.
 *
 * "It takes ten to fifteen times longer on Android" was unanswerable for weeks
 * because the archive carried one elapsed figure and nothing else. Two guesses
 * were made and both were wrong — the photographs are the same 640x480 on both
 * devices, and a controlled test showed feature counts comparable and the SIFT
 * contrast threshold worth under 2% of matched inliers.
 *
 * The first run that recorded stages answered it immediately, and not where
 * anyone was looking: of a 2307-second build over 380 photographs, choosing
 * seams took 976.9 s and painting took 895.4 s — 81% rendering, against the 6%
 * the codebase's only prior estimate assumed.
 */

import { BuildProfile, describeEnvironment } from '../js/build-profile.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const section = t => console.log(`\n=== ${t} ===`);

/** A clock the test drives, so stage timings are exact rather than flaky. */
function fakeClock() {
  let t = 0;
  const fn = () => t;
  fn.advance = ms => { t += ms; };
  return fn;
}

section('Time is attributed to the stage that was running');

{
  const now = fakeClock();
  const p = new BuildProfile({ now, env: {} });
  p.start(380);

  // The real sequence from the 2026-09-21 capture, compressed.
  p.enter('Finding features');      now.advance(62800);
  p.enter('Matching overlapping photos'); now.advance(236900);
  p.enter('Solving every camera angle');  now.advance(54000);
  p.enter('Choosing seams');        now.advance(976900);
  p.enter('Panorama painted');      now.advance(895400);
  p.finish();

  const s = p.snapshot();
  check('the total is the wall clock', s.totalSec === 2226.0, `${s.totalSec} s`);
  check('per-frame is reported', s.secPerFrame === 5.86, `${s.secPerFrame} s/frame`);
  check('the slowest stage is named without summing a table',
    s.slowestStage === 'Choosing seams', s.slowestStage);
  check('and its share is given as a percentage',
    Math.abs(s.slowestStagePercent - 43.9) < 0.2, `${s.slowestStagePercent}%`);
  check('stages come back worst-first',
    s.stages[0].stage === 'Choosing seams' && s.stages[1].stage === 'Panorama painted',
    s.stages.slice(0, 2).map(x => x.stage).join(' then '));
  check('rendering dominates, which is the finding',
    s.stages[0].percent + s.stages[1].percent > 80,
    `${(s.stages[0].percent + s.stages[1].percent).toFixed(1)}% in the two render stages`);
  check('the order stages first appeared is kept',
    s.stageOrder.indexOf('Finding features') < s.stageOrder.indexOf('Choosing seams'));
}

section('Repeated and empty labels do not fragment the record');

{
  const now = fakeClock();
  const p = new BuildProfile({ now, env: {} });
  p.start(10);
  p.enter('Matching');  now.advance(1000);
  p.enter('Matching');  now.advance(1000);   // the worker repeats itself
  p.enter('');          now.advance(1000);   // and sometimes says nothing
  p.enter(null);        now.advance(1000);
  p.finish();
  const s = p.snapshot();
  check('one stage, not four', s.stages.length === 1, `${s.stages.length} stage(s)`);
  check('and it holds all of the time', s.stages[0].seconds === 4.0,
    `${s.stages[0].seconds} s`);
}

section('Memory is sampled, and absence is recorded as absence');

{
  const now = fakeClock();
  const p = new BuildProfile({ now, env: {} });
  p.start(5);
  p.enter('Choosing seams');
  p.sample(); now.advance(500); p.sample();
  p.finish();
  const s = p.snapshot();
  // Node has no `performance.memory`, so every reading is null — which is the
  // same situation as Safari, and must not be reported as a heap of zero.
  check('a platform without performance.memory reports unavailable',
    s.memory.available === false && s.memory.peakHeapMb === null,
    `available=${s.memory.available} peak=${s.memory.peakHeapMb}`);
  check('samples are still recorded, tagged with their stage',
    s.memory.samples.length >= 3 && s.memory.samples.some(x => x.stage === 'Choosing seams'),
    `${s.memory.samples.length} samples`);
}

section('The environment answers whether threads are even possible');

{
  const env = describeEnvironment(
    { userAgent: 'test', hardwareConcurrency: 8, deviceMemory: 8 },
    { crossOriginIsolated: false, devicePixelRatio: 3 });
  check('core count and memory class are carried',
    env.hardwareConcurrency === 8 && env.deviceMemoryGb === 8);
  /*
   * The one that decides whether "can we parallelise this" has a yes available.
   * SharedArrayBuffer — and every threaded WASM build, OpenCV's included — is
   * gated behind cross-origin isolation, which needs COOP and COEP headers from
   * the server. A static host that does not send them makes the question moot.
   */
  check('cross-origin isolation is recorded', env.crossOriginIsolated === false);
  check('and the conclusion drawn, so nobody has to remember the rule',
    env.wasmThreadsPossible === false);

  const isolated = describeEnvironment(
    { userAgent: 'test', hardwareConcurrency: 4 }, { crossOriginIsolated: true });
  check('an isolated page only claims threads if SharedArrayBuffer exists too',
    isolated.wasmThreadsPossible === (typeof SharedArrayBuffer !== 'undefined'),
    `SAB present: ${typeof SharedArrayBuffer !== 'undefined'}`);
  check('a platform that cannot answer reports null, not false',
    describeEnvironment({}, {}).crossOriginIsolated === null
    || typeof crossOriginIsolated === 'boolean');
}

section('A build the browser suspended says so, instead of claiming a time');

{
  /*
   * MEASURED, 2026-09-22. The Pixel handed 330 photographs to the stitcher at
   * 22:10:33 and logged nothing until the export fifty-one minutes later, whose
   * first line was "the database connection is closing" — a page the browser
   * had frozen or discarded. Chrome on Android suspends backgrounded tabs. The
   * operator switched apps; the build did not slow down, it stopped.
   */
  const now = fakeClock();
  const p = new BuildProfile({ now, env: {} });
  p.start(330);
  p.enter('Matching overlapping photos');
  now.advance(4000);
  p.noteVisibility(true);          // the operator switches apps
  now.advance(51 * 60 * 1000);     // fifty-one minutes of nothing
  p.noteVisibility(false);
  p.finish();

  const s = p.snapshot();
  check('the hidden time is recorded', s.interrupted.hiddenSec === 3060,
    `${s.interrupted.hiddenSec} s hidden`);
  check('and how many times it happened', s.interrupted.timesHidden === 1);
  check('the verdict warns the elapsed time is not the work',
    /not the work/.test(s.interrupted.verdict), s.interrupted.verdict);
}

section('The sampler doubles as a freeze detector, where heap figures do not exist');

{
  /*
   * Safari has no performance.memory, so peak heap is null on exactly the
   * device this most needed measuring. But samples are taken on a fixed
   * interval, so a gap of minutes between consecutive samples means the timer
   * did not fire — which is what a suspended tab looks like from the inside,
   * and needs no API at all.
   */
  const now = fakeClock();
  const p = new BuildProfile({ now, env: {} });
  p.start(10);
  p.enter('Choosing seams');
  now.advance(2000); p.sample();
  now.advance(2000); p.sample();
  now.advance(600000); p.sample();      // the timer stopped firing for ten minutes
  p.finish();
  const s = p.snapshot();
  check('the longest sampler gap is reported', s.interrupted.longestSamplerGapSec === 600,
    `${s.interrupted.longestSamplerGapSec} s`);
  check('and a gap that large is called a stall', s.interrupted.stalled === true);
  check('even though no heap figure was ever available',
    s.memory.available === false);
}

section('An uninterrupted build says so plainly');

{
  const now = fakeClock();
  const p = new BuildProfile({ now, env: {} });
  p.start(50);
  p.enter('Choosing seams');
  for (let i = 0; i < 5; i++) { now.advance(2000); p.sample(); }
  p.finish();
  const s = p.snapshot();
  check('no hiding, no stall', s.interrupted.timesHidden === 0 && s.interrupted.stalled === false);
  check('and the verdict says the number can be trusted',
    /foreground/.test(s.interrupted.verdict), s.interrupted.verdict);
}

console.log(failures ? `\n${failures} FAILED` : '\nall build-profile checks passed');
process.exitCode = failures ? 1 : 0;
