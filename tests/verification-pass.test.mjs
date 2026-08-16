import { ScanDirector } from '../js/guide.js';
import { Survey, STATUS } from '../js/survey.js';

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}`);
  if (!ok) failures++;
}

const survey = new Survey();
for (const bin of survey.bins) bin.status = STATUS.WEAK;
const director = new ScanDirector(survey);
director.beginPass2();
check('an unverified first lap starts a dense verification sweep',
  director.verificationSweep && survey.pass === 2 && director.pass2Travel === 0);
director.notePass2Travel(-180);
const context = {
  heading: 180,
  elevation: 10,
  roll: 0,
  rotationRate: 8,
  stillness: 0,
  overlap: 0.8,
  frameStatus: 'ok',
  visualQuality: 0.8,
  hfovDeg: 45.6
};
check('the second lap reports dense sweep progress',
  director.directive(context).headline === 'Collecting verification lap');
director.notePass2Travel(-180);
check('the dense verification sweep reaches a clear completion state',
  director.directive(context).headline === 'Verification lap complete');

const cleanupSurvey = new Survey();
for (const bin of cleanupSurvey.bins) bin.status = STATUS.VERIFIED;
cleanupSurvey.bins[50].status = STATUS.WEAK;
const cleanup = new ScanDirector(cleanupSurvey);
cleanup.beginPass2();
check('partially verified data keeps targeted cleanup mode', !cleanup.verificationSweep);

console.log(failures ? `\n${failures} FAILED` : '\nall verification-pass checks passed');
process.exitCode = failures ? 1 : 0;
