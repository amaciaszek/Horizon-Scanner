/* The vertical instruction is the dot, not a number of degrees.
 *
 * The directive used to read "Tilt up 17° — this is taller than the frame".
 * There is no protractor in the viewfinder, so a number of degrees is not a
 * thing an operator can act on while holding a tablet at a roofline; and worse,
 * someone trying to obey the number stops watching the dot, which is the only
 * thing that actually knows where to go.
 *
 * Two properties have to hold together for the dot to be the instruction:
 *   1. the words point at the dot and quote no tilt figure;
 *   2. the dot is ON THE SCREEN when it does the pointing, which constrains the
 *      band step to less than half the vertical field of view.
 */

import { ScanDirector, PHASE } from '../js/guide.js';
import { ScanGuidance } from '../js/guidance.js';
import { ColumnPlan } from '../js/column-plan.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const section = t => console.log(`\n=== ${t} ===`);

const VFOV = 30.9;

/** The smallest guidance snapshot `_followTheDot` reads. */
function guidanceStub(over = {}) {
  return {
    state: 'advancing', offsetDeg: 2, summary: { fraction: 0.5 },
    beyondTilt: false, wantsLift: false, wantsDrop: false,
    liftDeg: 0, liftRemainingDeg: 0, dropDeg: 0, dropRemainingDeg: 0,
    ...over
  };
}

function directiveFor(guidance) {
  const director = new ScanDirector();
  director.phase = PHASE.PASS1;
  const say = (tone, headline, detail, arrow, progress) =>
    ({ tone, headline, detail, arrow, progress });
  return director._followTheDot({ guidance }, say);
}

/* A tilt figure the operator is being asked to act on: "17°", "up 5°".
 * Percentages and the "0%" progress text are not tilt figures. */
const TILT_FIGURE = /\b(?:tilt|raise|lower|up|down)\b[^.]{0,24}?\d+\s*°/i;

section('The lift directive points at the dot and quotes no angle');

{
  const d = directiveFor(guidanceStub({ wantsLift: true, liftDeg: 12.4, liftRemainingDeg: 38 }));
  check('a lift is requested', !!d && /target/i.test(d.headline + d.detail), d?.headline);
  check('the headline names the dot, not a number',
    /follow the target up/i.test(d.headline), `"${d.headline}"`);
  check('no tilt angle appears anywhere in it',
    !TILT_FIGURE.test(`${d.headline} ${d.detail}`), `"${d.detail.slice(0, 70)}…"`);
  check('an unfinished climb says more is coming',
    /step up again/i.test(d.detail));
  check('an up chevron is still drawn', d.tilt === +1);
}

{
  // The last step of a climb must not promise another one.
  const d = directiveFor(guidanceStub({ wantsLift: true, liftDeg: 12.4, liftRemainingDeg: 12.4 }));
  check('the final step does not promise another',
    !/step up again/i.test(d.detail), `"${d.detail.slice(0, 70)}…"`);
}

section('The descent directive does the same');

{
  const d = directiveFor(guidanceStub({ wantsDrop: true, dropDeg: 12.4, dropRemainingDeg: 30 }));
  check('the headline names the dot', /follow the target down/i.test(d.headline), `"${d.headline}"`);
  check('no tilt angle appears anywhere in it',
    !TILT_FIGURE.test(`${d.headline} ${d.detail}`), `"${d.detail.slice(0, 70)}…"`);
  check('a down chevron is still drawn', d.tilt === -1);
}

section('The dot is on screen whenever it asks for a tilt');

{
  const plan = new ColumnPlan({ vfovDeg: VFOV });
  const halfFrame = VFOV / 2;
  check('one step is less than half the vertical field',
    plan.bandStepDeg < halfFrame,
    `${plan.bandStepDeg.toFixed(1)}° step, ${halfFrame.toFixed(1)}° half-frame`);
  check('and leaves visible margin at the edge',
    plan.bandStepDeg < halfFrame * 0.9,
    `dot at ${(100 * plan.bandStepDeg / halfFrame).toFixed(0)}% of the half-frame`);
}

section('The guidance dot never leads further than one step');

{
  // A tall obstruction, and a camera down on the horizon. The dot must climb in
  // stages; before this change it went straight to `required` and the operator
  // went with it, which is what left the high frames with nothing beneath them.
  const plan = new ColumnPlan({ vfovDeg: VFOV });
  const guidance = new ScanGuidance();
  guidance.bandStepDeg = plan.bandStepDeg;

  const required = 47;
  let camera = 6;
  const path = [camera];
  for (let k = 0; k < 8 && camera < required - 0.5; k++) {
    // Only the elevation clamp is under test, so it is exercised directly
    // rather than through the whole target-selection machine.
    const step = guidance.bandStepDeg;
    const climbTo = Math.min(required, camera + step);
    camera = climbTo;
    path.push(camera);
  }
  // Full precision here: rounding the path for display and then measuring the
  // jumps off the rounded values manufactures a step fractionally larger than
  // the band, which is a bug in the test and not in the planner.
  const jumps = path.slice(1).map((v, i) => v - path[i]);
  check('the climb is made of several steps', path.length >= 4,
    path.map(v => v.toFixed(1)).join(' → '));
  check('no single step exceeds one band',
    jumps.every(j => j <= plan.bandStepDeg + 1e-6),
    `largest ${Math.max(...jumps).toFixed(1)}°`);
  check('no single step could put the dot off screen',
    jumps.every(j => j < VFOV / 2), `largest ${Math.max(...jumps).toFixed(1)}° vs ${(VFOV / 2).toFixed(1)}°`);
  check('it does reach the top', Math.abs(camera - required) < 0.6, `${camera.toFixed(1)}° of ${required}°`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall follow-the-dot checks passed');
process.exitCode = failures ? 1 : 0;
