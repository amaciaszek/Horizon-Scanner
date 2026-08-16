import { ScanDirector, PHASE } from '../js/guide.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

const tanHalfH = Math.tan(35 / 2 * Math.PI / 180);
const survey = {
  yawDatum: 0,
  keyframes: [0, -10, -20, -80, -90].map((yawFused, index) => ({
    index, t: index * 1000, pass: 2, captureKind: 'sweep', yawFused, tanHalfH
  })),
  weakSectors: () => [],
  coverage: () => ({ verifiedBins: 100 })
};
const director = new ScanDirector(survey);
director.phase = PHASE.PASS2;
director.verificationSweep = false;
director.refreshTargets();
check('one 60 degree hole becomes two actionable capture bearings',
  director.targets.length === 2 && director.targets.every(t => t.kind === 'photo-gap'));
check('capture bearings fill the hole at safe spacing',
  director.targets[0].targetAzimuthDeg === 320 && director.targets[1].targetAzimuthDeg === 300,
  director.targets.map(t => t.targetAzimuthDeg).join(', '));

const instruction = director.directive({
  heading: 280, elevation: 0, roll: 0, rotationRate: 0, stillness: 1,
  overlap: 1, frameStatus: 'ok', visualQuality: 1, sensor: {}, hfovDeg: 35
});
check('field guidance names the exact return bearing',
  instruction.detail.includes('300.0°') || instruction.detail.includes('320.0°'), instruction.detail);

console.log(failures ? `\n${failures} FAILED` : '\nall photo-gap guidance checks passed');
process.exitCode = failures ? 1 : 0;
