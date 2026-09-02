'use strict';

/**
 * The lens this device actually has, remembered between sessions.
 *
 * WHY THIS EXISTS, AS A MEASUREMENT. On 2026-08-25 the same operator ran the
 * same survey minutes apart on two devices and got a perfect panorama from one
 * and a black screen from the other. The whole difference was this:
 *
 *   iPad   `Lens prior loaded for this device (iPad …): 45.6°`  -> guided
 *          measurement succeeded at 40.5°, 198 photographs, 2531 verified
 *          pairs, 196 of 198 frames placed.
 *   Pixel  no prior, so the hardcoded 66° default stood. Guided measurement
 *          never converged. 68 photographs, 42 verified pairs, 3 frames placed.
 *
 * The photographs were not the problem — replayed with brute-force matching the
 * same 68 frames yielded 684 pairs, 29,053 matches and a single connected
 * component containing every frame. What failed was everything that is computed
 * FROM the field of view: the keyframe spacing is a fraction of it, the column
 * band heights are a fraction of it, and the stitcher predicts where each
 * feature should land from it and then searches a small radius around that
 * prediction. At 66° against a true ~42° every prediction lands outside the
 * window.
 *
 * `KNOWN_LENSES` in `js/camera.js` fixed this for exactly one device, by hand.
 * That does not scale to "every device", which is the actual requirement — and
 * it is unnecessary, because every successful survey measures the lens twice:
 * once in the guided calibration, and once again in the bundle adjustment,
 * which reports the focal scale it had to apply to make 300,000 feature matches
 * agree. Either is a better prior than a table someone has to remember to edit.
 *
 * So the app learns. One good run on a device and that device is correct
 * forever after, whoever owns it and whatever it is.
 *
 * STORED IN VIDEO PIXELS, not degrees, for the same reason `setMeasuredLens`
 * does: a focal length in pixels of the decoded video survives rotation,
 * cropping and rescaling into the working frame, and degrees do not.
 */

const STORE_KEY = 'horizon.lens.v1';

/**
 * A signature for "this camera on this device".
 *
 * Deliberately coarse. It has to be stable across sessions and browser
 * restarts, and it must not be so specific that a harmless change — a different
 * window size, a browser update — looks like a different camera. Stream
 * dimensions and facing are included because a device with several cameras has
 * a different lens behind each, and the platform reports them differently.
 *
 * `deviceId` is deliberately NOT used: it is rotated per origin and per session
 * on several browsers, so keying on it would mean never recognising anything.
 */
export function deviceKey(settings = {}, ua = '') {
  const w = Number(settings.width) || 0;
  const h = Number(settings.height) || 0;
  const facing = settings.facingMode || 'unknown';
  // The platform, not the browser build: "Android 10; K", "Macintosh", "iPad".
  const platform = (String(ua).match(/\(([^)]*)\)/)?.[1] || 'unknown')
    .split(';').slice(0, 2).join(';').trim();
  return `${platform}|${Math.min(w, h)}x${Math.max(w, h)}|${facing}`;
}

/**
 * What is known about the lenses this browser has seen.
 *
 * A plain object keyed by `deviceKey`. Each entry records the focal length in
 * video pixels, where the figure came from, and when — so a later, better
 * source can overrule an earlier, weaker one and the archive can say which was
 * used.
 */
export class LensStore {
  constructor(storage = null) {
    this.storage = storage;
    this.entries = {};
    this.load();
  }

  load() {
    try {
      const raw = this.storage?.getItem(STORE_KEY);
      if (raw) this.entries = JSON.parse(raw) || {};
    } catch { this.entries = {}; }
  }

  save() {
    try {
      this.storage?.setItem(STORE_KEY, JSON.stringify(this.entries));
    } catch { /* private mode or quota: the store simply stops learning */ }
  }

  get(key) {
    const e = this.entries[key];
    if (!e || !Number.isFinite(e.focalVideoPx) || e.focalVideoPx < 40) return null;
    return e;
  }

  /**
   * How much a source is trusted, so a weaker one cannot overwrite a stronger.
   *
   * `solved` outranks `measured` because the bundle adjustment fits the focal
   * length to every feature correspondence in the survey — hundreds of
   * thousands of them — while the guided measurement uses a few hundred pairs
   * gathered in under a minute. Both outrank a self-calibrated estimate taken
   * from whatever the survey happened to look at.
   */
  static rank(source) {
    return { solved: 3, measured: 2, 'self-calibrated': 1 }[source] || 0;
  }

  /**
   * Record a lens for this device.
   *
   * Refuses a figure that is not better-sourced than what is already stored, so
   * a fresh session's early self-calibration cannot undo a solved measurement
   * from last week. An equal-ranked source does replace, because the newer
   * measurement is of the camera as it is now.
   */
  remember(key, focalVideoPx, source) {
    if (!key || !Number.isFinite(focalVideoPx) || focalVideoPx < 40) return false;
    const existing = this.entries[key];
    if (existing && LensStore.rank(existing.source) > LensStore.rank(source)) return false;
    this.entries[key] = {
      focalVideoPx,
      source,
      at: new Date().toISOString()
    };
    this.save();
    return true;
  }

  /** Everything known, for the archive. A survey should be able to say where
   *  its idea of the lens came from without anybody having to guess. */
  snapshot() {
    return JSON.parse(JSON.stringify(this.entries));
  }
}
