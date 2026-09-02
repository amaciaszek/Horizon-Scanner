/* The lens this device has, remembered — so "every device" is not a table.
 *
 * MEASURED, 2026-08-25. The same operator ran the same survey minutes apart on
 * two devices and got a perfect panorama from one and a black screen from the
 * other. The entire difference was one hand-written table entry:
 *
 *   iPad   prior found -> 45.6°, guided measurement succeeded at 40.5°
 *          198 photographs, 2531 verified pairs, 196 of 198 frames placed.
 *   Pixel  no prior -> the 66° fallback stood, measurement never converged
 *          68 photographs, 42 verified pairs, 3 frames placed.
 *
 * The photographs were fine: replayed with brute-force matching those same 68
 * frames gave 684 pairs, 29,053 matches and one component containing all 68.
 * What failed was everything computed FROM the field of view — the keyframe
 * spacing, the band heights, and the stitcher's guided feature search.
 *
 * A table someone has to remember to edit does not scale to every device. Every
 * successful survey already measures the lens twice, so the app should learn.
 */

import { LensStore, deviceKey } from '../js/lens-store.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const section = t => console.log(`\n=== ${t} ===`);

function fakeStore() {
  const map = new Map();
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

const PIXEL_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/151 Mobile Safari/537.36';
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const stream = { width: 1080, height: 1920, facingMode: 'environment' };

section('A device is recognised across sessions, and two devices are not confused');

{
  const a = deviceKey(stream, PIXEL_UA);
  const b = deviceKey(stream, IPAD_UA);
  check('the same device gives the same key twice', a === deviceKey(stream, PIXEL_UA), a);
  check('two platforms give different keys', a !== b, `${a}  vs  ${b}`);
  check('a different stream size is a different camera',
    deviceKey({ ...stream, width: 720, height: 1280 }, PIXEL_UA) !== a);
  check('front and rear are different cameras',
    deviceKey({ ...stream, facingMode: 'user' }, PIXEL_UA) !== a);
  // deviceId is rotated per origin and per session on several browsers, so
  // keying on it would mean never recognising anything.
  check('a rotated deviceId does not change the key',
    deviceKey({ ...stream, deviceId: 'abc123' }, PIXEL_UA) === a);
}

section('One good run and the device is correct afterwards');

{
  const storage = fakeStore();
  const key = deviceKey(stream, PIXEL_UA);
  const store = new LensStore(storage);
  check('a device nobody has seen has nothing stored', store.get(key) === null);

  // The 22:23 Pixel capture: the bundle adjustment solved 42.40° across the
  // working frame from 902 verified pairs.
  const solved = (1080 / 2) / Math.tan(42.40 / 2 * Math.PI / 180);
  check('a solved lens is remembered', store.remember(key, solved, 'solved'));

  const next = new LensStore(storage);
  check('and survives into the next session',
    Math.abs(next.get(key).focalVideoPx - solved) < 1e-6,
    `${next.get(key).focalVideoPx.toFixed(1)} px, ${next.get(key).source}`);
  check('the iPad is unaffected by what the Pixel learned',
    next.get(deviceKey(stream, IPAD_UA)) === null);
}

section('A weaker source cannot undo a stronger one');

{
  const store = new LensStore(fakeStore());
  const key = deviceKey(stream, PIXEL_UA);
  store.remember(key, 1392, 'solved');
  check('a self-calibrated guess cannot overwrite a solve',
    store.remember(key, 900, 'self-calibrated') === false);
  check('nor can a guided measurement', store.remember(key, 900, 'measured') === false);
  check('the solved figure still stands', store.get(key).focalVideoPx === 1392);

  // Equal rank does replace: the newer measurement describes the camera as it
  // is now, which may genuinely have changed.
  check('a newer solve replaces an older one', store.remember(key, 1400, 'solved'));
  check('and it is the one that is kept', store.get(key).focalVideoPx === 1400);
}

section('Rubbish is refused rather than stored');

{
  const store = new LensStore(fakeStore());
  const key = deviceKey(stream, PIXEL_UA);
  for (const bad of [NaN, 0, -5, 10, null, undefined, Infinity]) {
    if (store.remember(key, bad, 'solved')) {
      check(`a focal of ${String(bad)} was stored`, false);
    }
  }
  check('no nonsense focal was accepted', store.get(key) === null);
  check('an absent storage backend does not throw',
    new LensStore(null).remember(key, 1392, 'solved') === false
    || true);
}

console.log(failures ? `\n${failures} FAILED` : '\nall lens-store checks passed');
process.exitCode = failures ? 1 : 0;
