import { Survey, STATUS } from '../js/survey.js';

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}`);
  if (!ok) failures++;
}

const survey = new Survey();
for (const bin of survey.bins) bin.status = STATUS.WEAK;
const allWeak = survey.weakSectors();
check('an entirely unverified ring remains a 360 degree weak sector',
  allWeak.length === 1 && allWeak[0].widthDeg === 360);

survey.bins[20].status = STATUS.VERIFIED;
const interrupted = survey.weakSectors();
check('a verified bin closes the circular weak run',
  interrupted.length >= 1 && interrupted[0].widthDeg < 360);

console.log(failures ? `\n${failures} FAILED` : '\nall weak-sector checks passed');
process.exitCode = failures ? 1 : 0;
