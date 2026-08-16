import fs from 'node:fs';

const source = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const maybe = source.slice(source.indexOf('function maybeKeyframe'), source.indexOf('function currentHeading'));
const thumb = source.slice(source.indexOf('function captureThumb'), source.indexOf('let panoBuilt'));

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}`);
  if (!ok) failures++;
}

check('accepted decisions are recorded while pose and exposure time are in scope',
  maybe.includes("recordCaptureDecision('accepted'"));
check('thumbnail storage does not reference capture-loop pose or time variables',
  !thumb.includes("recordCaptureDecision('accepted'") && !/\bpose\b/.test(thumb));

console.log(failures ? `\n${failures} FAILED` : '\nall capture-audit flow checks passed');
process.exitCode = failures ? 1 : 0;
