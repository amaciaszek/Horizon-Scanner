/* Tell the operator how long this will take, before it takes it.
 *
 * The 2026-08-25 back-yard survey was 2m37s of capture and 16m20s of building,
 * and the operator learned that by watching it happen. The build is the half
 * that matters: it needs the phone awake and left alone for a quarter of an
 * hour, and a screen that sleeps partway through throws away the walk.
 *
 * What is checked here is not the numbers — those are measurements and will
 * move — but the properties that make an estimate worth reading: that it learns
 * from this device rather than quoting a table, that it costs the serpentine
 * the way the serpentine is actually flown, and that it never rounds a real
 * wait down to nothing.
 */

import {
  SurveyRates, estimateSurvey, estimateFrameCount, describeSurveyPlan, roughMinutes
} from '../js/survey-estimate.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const section = t => console.log(`\n=== ${t} ===`);

/** A localStorage stand-in, so persistence can be tested without a browser. */
function fakeStore() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map
  };
}

section('The estimate is measured on this device, not looked up');

{
  const store = fakeStore();
  const fresh = new SurveyRates(store);
  check('a device that has done nothing says so', fresh.measured === false);
  const before = estimateSurvey({ rates: fresh, frames: 115 });

  // The reference capture, replayed: 115 photographs, 156.8 s walking,
  // 979.9 s building.
  fresh.recordCapture(115, 156.8);
  fresh.recordBuild(115, 979.9);
  check('after one run it is measured', fresh.measured === true);

  const after = estimateSurvey({ rates: fresh, frames: 115 });
  check('and it now predicts the run it just watched',
    Math.abs(after.buildSec - 979.9) < 1,
    `${after.buildSec.toFixed(0)} s vs the 980 s it took`);
  check('the wording changes to say where the figure came from',
    /actually done before/.test(describeSurveyPlan(after))
    && /reference device/.test(describeSurveyPlan(before)));

  const reloaded = new SurveyRates(store);
  check('the measurement survives to the next session',
    Math.abs(reloaded.buildSecPerFrame - fresh.buildSecPerFrame) < 1e-9,
    `${reloaded.buildSecPerFrame.toFixed(2)} s per frame`);
}

section('One freak run does not become the quoted figure forever');

{
  const rates = new SurveyRates(fakeStore());
  rates.recordBuild(115, 900);           // a normal build
  const normal = rates.buildSecPerFrame;
  rates.recordBuild(115, 5000);          // the phone was doing something else
  check('an outlier moves the estimate without taking it over',
    rates.buildSecPerFrame > normal && rates.buildSecPerFrame < 5000 / 115,
    `${normal.toFixed(1)} → ${rates.buildSecPerFrame.toFixed(1)} s per frame`);
}

section('Rubbish in does not corrupt the estimate');

{
  const rates = new SurveyRates(fakeStore());
  const seeded = rates.buildSecPerFrame;
  for (const [n, s] of [[0, 100], [115, 0], [NaN, 100], [115, NaN], [-5, -5]]) {
    rates.recordBuild(n, s);
  }
  check('a nonsense measurement is refused rather than stored',
    rates.buildSecPerFrame === seeded && rates.measured === false,
    `${rates.buildSecPerFrame.toFixed(2)} s per frame`);
}

section('The serpentine is costed the way it is actually flown');

{
  // Upper bands are sampled every `columnStepDeg` of bearing, not at the dense
  // horizontal step: the camera climbs one column, steps sideways, climbs the
  // next. Costing them at the horizontal step overstated this back yard by
  // about 40%, which turns a 15-minute warning into a 25-minute one and teaches
  // the operator to discount every number the app shows them.
  const dense = estimateFrameCount({ stepAcrossDeg: 4.84, columnStepDeg: 4.84 });
  const real = estimateFrameCount({ stepAcrossDeg: 4.84, columnStepDeg: 9 });
  check('wider column spacing costs fewer frames', real < dense,
    `${real} vs ${dense} frames`);
  check('a flat site costs one lap and no more',
    estimateFrameCount({ stepAcrossDeg: 4.84, tallFraction: 0 })
      === Math.round(360 / 4.84),
    `${estimateFrameCount({ stepAcrossDeg: 4.84, tallFraction: 0 })} frames`);
  check('the back-yard estimate lands near what that site really costs',
    real > 90 && real < 200, `${real} frames`);
}

section('It is quoted the way a person would say it');

{
  check('a short wait is not "0 minutes"', roughMinutes(20) === 'about a minute',
    roughMinutes(20));
  check('a few minutes is quoted to the minute', roughMinutes(240) === 'about 4 minutes',
    roughMinutes(240));
  // Past ten minutes the difference between 16 and 17 is not information.
  check('a long wait is quoted coarsely', roughMinutes(980) === 'about 15 minutes',
    roughMinutes(980));
  const plan = describeSurveyPlan(estimateSurvey({
    rates: new SurveyRates(fakeStore()), frames: 115
  }));
  check('and the screen setting is named, since that is the point of saying any of it',
    /screen to stay on/i.test(plan), plan.slice(0, 60) + '…');
}

console.log(failures ? `\n${failures} FAILED` : '\nall survey-estimate checks passed');
process.exitCode = failures ? 1 : 0;
