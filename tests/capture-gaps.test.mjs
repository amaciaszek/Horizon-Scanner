import { captureGapReport, bearingLabel } from '../js/capture-gaps.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

const fov = Math.tan(35 / 2 * Math.PI / 180);
const frames = [0, -10, -20, -80, -90].map((yawFused, index) => ({
  index, t: index * 1000, pass: 1, captureKind: 'sweep', yawFused,
  yawCorrection: 0, tanHalfH: fov
}));
const report = captureGapReport(frames);
check('one large gap is found between consecutive accepted photos', report.gapCount === 1);
check('gap reports its exact source frames', report.gaps[0].fromFrame === 2 && report.gaps[0].toFrame === 3);
check('gap target is the midpoint along the direction of travel', Math.abs(report.gaps[0].targetAzimuthDeg - 310) < 0.01,
  JSON.stringify(report.gaps[0]));
check('true no-overlap region is measured', Math.abs(report.gaps[0].uncoveredDeg - 25) < 0.01);
check('gap recommends enough intermediate photos to restore safe overlap',
  report.gaps[0].recommendedPhotoCount === 2
  && report.gaps[0].recaptureAzimuthsDeg[0] === 320
  && report.gaps[0].recaptureAzimuthsDeg[1] === 300);
check('bearing label is field-readable', bearingLabel(310).includes('NW'));

const twoPass = captureGapReport([
  ...frames,
  { index: 5, t: 6000, pass: 2, captureKind: 'sweep', yawFused: 15, tanHalfH: fov },
  { index: 6, t: 7000, pass: 2, captureKind: 'sweep', yawFused: 5, tanHalfH: fov }
]);
check('laps are measured independently', twoPass.passCount === 2 && twoPass.passes[1].gapCount === 0);

const dense = captureGapReport([0, 10, 20, 30].map((yawFused, index) => ({
  index, t: index, pass: 1, yawFused, tanHalfH: fov
})));
check('dense photographs do not create false gaps', dense.gapCount === 0);

const bridged = captureGapReport([
  ...frames,
  { index: 5, t: 6000, pass: 2, captureKind: 'targeted-cleanup', yawFused: -40, tanHalfH: fov },
  { index: 6, t: 7000, pass: 2, captureKind: 'targeted-cleanup', yawFused: -60, tanHalfH: fov }
]);
check('targeted cleanup photos resolve an old chronological gap', bridged.gapCount === 0);

console.log(failures ? `\n${failures} FAILED` : '\nall capture-gap checks passed');
process.exitCode = failures ? 1 : 0;
