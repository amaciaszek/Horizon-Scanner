import { optimisePanoramaRotations } from '../js/panorama-optimize.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

const keyframes = [{ quat: [1, 0, 0, 0], tanHalfH: 0.4, tanHalfV: 0.3 }];
const noPhotos = await optimisePanoramaRotations({ keyframes, sources: [], yawDatum: 7 });
check('optimizer leaves geometry untouched without enough photographs',
  !noPhotos.diagnostics.applied && noPhotos.keyframes === keyframes && noPhotos.yawDatum === 7);
check('optimizer explains why it did not run', noPhotos.diagnostics.reason === 'not-enough-source-photos');

console.log(failures ? `\n${failures} FAILED` : '\nall panorama-optimizer checks passed');
process.exitCode = failures ? 1 : 0;
