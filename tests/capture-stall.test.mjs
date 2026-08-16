/* Knowing, out loud, that coverage is being lost.
 *
 * On 2026-08-15 the app swept 68.9 degrees over 14.2 seconds without accepting
 * a single photograph, and said nothing about it. The operator saw an ordinary
 * frame-level complaint, kept walking, and cut the same hole into both laps at
 * the same bearing — which is what finally disconnected the visual feature
 * graph and stopped any stitcher from closing the circle.
 *
 * Every input needed to have caught that already existed: the time of the last
 * accepted keyframe, the yaw at that keyframe, the current yaw, and the audit
 * reason for the most recent rejection. Nothing new had to be measured. It only
 * had to be checked, and said.
 */
import { captureStall, maxUsableStepDeg, MIN_PHOTO_OVERLAP } from '../js/capture-policy.js';
import { ScanDirector, PHASE } from '../js/guide.js';
import { Survey } from '../js/survey.js';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

console.log('=== The threshold matches the gap report exactly ===');
{
  // If these two disagreed, the live warning and the end-of-pass gap list would
  // describe different worlds, and the operator would be sent back for photos
  // the report did not want — or worse, not sent back for ones it did.
  const fov = 45.6;
  check('desired maximum step mirrors captureGapReport',
    Math.abs(maxUsableStepDeg(fov) - fov * (1 - MIN_PHOTO_OVERLAP)) < 1e-9,
    `${maxUsableStepDeg(fov).toFixed(2)}°`);
  check('minimum overlap is the 35% the gap report requires', MIN_PHOTO_OVERLAP === 0.35);
}

console.log('\n=== Normal dense capture never trips it ===');
{
  // Sweep spacing is 20% of the field of view, about 9.1 degrees on this lens.
  // The stall threshold sits at 29.6. There must be a wide margin between the
  // two or the warning becomes noise and gets ignored, which is worse than
  // having no warning at all.
  const s = captureStall({ sinceMs: 900, travelDeg: -9.1, hfovDeg: 45.6, reason: 'spacing-not-reached' });
  check('a normal 9.1° step is not a stall', s.stalled === false, `${s.sweptDeg.toFixed(1)}°`);
  const pause = captureStall({ sinceMs: 4000, travelDeg: -0.2, hfovDeg: 45.6, reason: 'spacing-not-reached' });
  check('standing still between keyframes is not a stall', pause.stalled === false);
}

console.log('\n=== The 2026-08-15 gap is caught ===');
{
  const s = captureStall({ sinceMs: 14232, travelDeg: -68.94, hfovDeg: 45.6, reason: 'frame-noSky' });
  check('it fires', s.stalled === true, s.kind);
  check('it is classified as lost coverage', s.kind === 'coverage-lost');
  check('it reports the uncovered arc', Math.abs(s.uncoveredDeg - 23.34) < 0.1,
    `${s.uncoveredDeg.toFixed(2)}° with no image at all`);
  // The recovery bearing is the EDGE of what is still recoverable, not the
  // middle of the hole. Turning back to the midpoint leaves the far side just
  // as unmatched as it was.
  check('it asks for a return to the edge of recoverable overlap',
    Math.abs(s.returnDeg - (68.94 - 45.6 * 0.65)) < 0.01, `${s.returnDeg.toFixed(2)}°`);
  check('it carries the reason through', s.reason === 'frame-noSky');
}

console.log('\n=== Waiting on a fault is a stall; waiting on spacing is not ===');
{
  const faulted = captureStall({ sinceMs: 4000, travelDeg: 0.3, hfovDeg: 45.6, reason: 'frame-allSky' });
  check('a stationary fault fires after a few seconds', faulted.stalled === true, faulted.kind);
  check('and is classified as waiting', faulted.kind === 'waiting');
  const benign = captureStall({ sinceMs: 9000, travelDeg: 0.3, hfovDeg: 45.6, reason: 'accepted' });
  check('a recent acceptance is never a stall', benign.stalled === false);
  const none = captureStall({ sinceMs: 9000, travelDeg: 0.3, hfovDeg: 45.6, reason: null });
  check('no recorded reason is not treated as a fault', none.stalled === false);
}

console.log('\n=== Before the first photograph there is nothing to lose ===');
{
  const s = captureStall({
    sinceMs: 20000, travelDeg: -90, hfovDeg: 45.6,
    reason: 'frame-noSky', hasAcceptedFrame: false
  });
  check('does not claim lost coverage with no prior frame', s.kind !== 'coverage-lost', `${s.kind}`);
}

console.log('\n=== The director says it in words, with a bearing ===');
{
  const director = new ScanDirector(new Survey());
  director.beginPass1(0);
  director.pass1Travel = -120;
  const d = director.directive({
    heading: 296.4, elevation: 9, roll: -1, rotationRate: 12, stillness: 0.5,
    overlap: 0.1, frameStatus: 'noSky', visualQuality: 0.4, jitterDeg: 0.2,
    hfovDeg: 45.6, hasAcceptedFrame: true,
    sinceKeyframeMs: 14232, travelSinceKeyframeDeg: -68.94,
    lastRejectReason: 'frame-noSky', glareFraction: 0.001
  });
  console.log(`   "${d.headline}" — ${d.detail}`);
  check('it is a corrective instruction, not a status line', d.tone === 'fix');
  check('the headline says how far to turn back', /Turn back 39/.test(d.headline), d.headline);
  check('the detail states how far was swept for nothing',
    /69° swept with no photograph accepted/.test(d.detail), d.detail);
  check('the detail states how much of the circle has no image',
    /23° of the circle now has no image/.test(d.detail));
  check('the detail names a bearing to return to', /back to about 335\.7° NNW/.test(d.detail));
  check('the arrow points clockwise, back the way they came', d.arrow > 0, `${d.arrow}`);
  check('it outranks the plain frame complaint', !/No sky visible/.test(d.headline));
}

console.log('\n=== Sun in the frame is named as the cause ===');
{
  const director = new ScanDirector(new Survey());
  director.beginPass1(0);
  director.pass1Travel = -120;
  const d = director.directive({
    heading: 296.4, elevation: 9, roll: -1, rotationRate: 12, stillness: 0.5,
    overlap: 0.1, frameStatus: 'noSky', visualQuality: 0.4, jitterDeg: 0.2,
    hfovDeg: 45.6, hasAcceptedFrame: true,
    sinceKeyframeMs: 14232, travelSinceKeyframeDeg: -68.94,
    lastRejectReason: 'frame-noSky', glareFraction: 0.08
  });
  console.log(`   "${d.headline}" — ${d.detail}`);
  check('glare is preferred over the generic frame reason',
    /sun is in the frame/.test(d.detail), d.detail);
  check('it suggests something the operator can actually do',
    /Shade the lens|behind a tree/.test(d.detail));
}

console.log('\n=== A lap that will not close is stopped anyway ===');
{
  // Pass 1 had no upper bound of its own. "Keep turning until the view matches
  // where you started" is an instruction to turn forever when loop closure
  // never lands, and one capture ran it to 714 degrees — which put both
  // physical laps inside pass 1 and left the survey with zero verified bins.
  const director = new ScanDirector(new Survey());
  director.beginPass1(0);
  director.pass1Travel = -714.4;
  const d = director.directive({
    heading: 7, elevation: 0.2, roll: 0, rotationRate: 9, stillness: 0.6,
    overlap: 0.8, frameStatus: 'ok', visualQuality: 0.5, jitterDeg: 0.2,
    hfovDeg: 45.6, hasAcceptedFrame: true,
    sinceKeyframeMs: 800, travelSinceKeyframeDeg: -8, lastRejectReason: 'spacing-not-reached',
    glareFraction: 0
  });
  console.log(`   "${d.headline}" — ${d.detail}`);
  check('it tells the operator to stop', /Stop/.test(d.headline), d.headline);
  check('it says how far they have actually gone', /714°/.test(d.detail));
  check('it explains that closure failed rather than blaming them',
    /never matched visually/.test(d.detail));
  const fine = new ScanDirector(new Survey());
  fine.beginPass1(0);
  fine.pass1Travel = -350;
  const ok = fine.directive({
    heading: 7, elevation: 0, roll: 0, rotationRate: 9, stillness: 0.6, overlap: 0.8,
    frameStatus: 'ok', visualQuality: 0.5, jitterDeg: 0.2, hfovDeg: 45.6,
    hasAcceptedFrame: true, sinceKeyframeMs: 800, travelSinceKeyframeDeg: -8,
    lastRejectReason: 'spacing-not-reached', glareFraction: 0
  });
  check('a normal lap in progress is left alone', !/Stop/.test(ok.headline), ok.headline);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
