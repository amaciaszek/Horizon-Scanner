'use strict';
import { clamp, RAD, DEG } from './math3d.js';

export const WORK_W = 384, WORK_H = 288;   // segmentation working frame
export const LUMA_W = 160, LUMA_H = 120;   // registration base frame

/**
 * Camera wrapper.
 *
 * Every downstream stage sees frames that are already rotated into SCREEN
 * orientation, which removes an entire class of sensor-orientation bugs. The
 * rotation is auto-detected from the track aspect ratio versus the screen, and
 * can be overridden in the field.
 */

/**
 * Lenses we simply know, and therefore refuse to guess at.
 *
 * Focal length in VIDEO pixels, because that is the form that survives
 * rotation, cropping and rescaling. Added because measurement kept failing on
 * real hardware and a known device does not need measuring — an operator with
 * an identified iPad should not be made to sweep a garden to discover a number
 * Apple already published.
 *
 * The iPad Air 5 figure: the 12MP rear camera covers about 70 deg diagonally
 * on its 4:3 sensor, giving 58.5 deg across the full width; a 1080x1920
 * portrait stream is a 9:16 crop of that, keeping 0.75 of the width, so the
 * 1080-pixel axis spans 45.6 deg and the focal length is 540/tan(22.8) px.
 * That sits between the two independent measurements this device produced in
 * the field, 41.7 and 49.2 deg, which is the best corroboration available.
 */
const KNOWN_LENSES = [
  {
    label: 'iPad (12MP rear, 1080x1920 stream)',
    match: s => /Macintosh|iPad/.test(navigator.userAgent)
      && (navigator.maxTouchPoints || 0) > 0
      && Math.min(s.width, s.height) === 1080 && Math.max(s.width, s.height) === 1920,
    focalVideoPx: 540 / Math.tan(22.8 * Math.PI / 180)
  }
];

export class CameraSource {
  constructor(videoEl, log) {
    this.video = videoEl;
    this.log = log || (() => {});
    this.stream = null;
    this.settings = null;
    this.frameRotation = 0;      // 0 / 90 / 180 / 270, image -> screen
    this.autoRotation = true;

    this.work = document.createElement('canvas');
    this.work.width = WORK_W; this.work.height = WORK_H;
    this.workCtx = this.work.getContext('2d', { willReadFrequently: true });

    this.luma = document.createElement('canvas');
    this.luma.width = LUMA_W; this.luma.height = LUMA_H;
    this.lumaCtx = this.luma.getContext('2d', { willReadFrequently: true });

    this.keyCanvas = document.createElement('canvas');
    this.keyCanvas.width = 640; this.keyCanvas.height = 480;
    this.keyCtx = this.keyCanvas.getContext('2d');
    this._captureSerial = 0;
    this._videoFrameRequest = null;
    this._lastVideoFrame = null;

    // Intrinsics: horizontal half-FOV tangent. Starts from a sane phone default
    // and is replaced by the self-calibrated value once the scan produces one.
    this.hfovDeg = 66;
    this.focalPx = null;
    this.focalSource = 'default';
    this.measuredFocalV = null;

    // Lens inventory
    this.devices = [];           // [{deviceId, label, hfovDeg|null, isWide}]
    this.activeDeviceId = null;
    this.pinned = false;         // opened by explicit deviceId, not facingMode
    this.lensSwaps = 0;
    this._watch = null;
    this.onLensSwap = null;
  }

  /**
   * Enumerate the rear cameras.
   *
   * Labels are empty until a getUserMedia grant exists, so this is only useful
   * after start(). Android exposes each physical lens as its own videoinput,
   * which is how the ultra-wide becomes reachable at all; iOS usually exposes
   * a single virtual rear camera and switching is a no-op there.
   */
  async enumerate() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    const cams = all.filter(d => d.kind === 'videoinput');
    // Front cameras are useless here and only clutter the picker.
    const rear = cams.filter(d => !/front|user|face|selfie/i.test(d.label || ''));
    this.devices = (rear.length ? rear : cams).map(d => ({
      deviceId: d.deviceId,
      label: d.label || 'Camera',
      hfovDeg: null,
      isWide: /wide|ultra|0\.5|uw/i.test(d.label || '')
    }));
    return this.devices;
  }

  /**
   * Measure each rear lens by opening it briefly and reading its capabilities.
   *
   * This is how "widest" gets decided from evidence rather than from a label
   * string, since vendor labels are inconsistent and often absent. Where the
   * browser exposes nothing useful the entry stays null and the label heuristic
   * is the only signal left.
   */
  async probeLenses() {
    for (const d of this.devices) {
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: d.deviceId }, width: { ideal: 1920 } }, audio: false
        });
        const t = stream.getVideoTracks()[0];
        const caps = t.getCapabilities ? t.getCapabilities() : {};
        const set = t.getSettings ? t.getSettings() : {};
        // Chrome on Android exposes zoom range; a lens whose minimum zoom is
        // below 1 is the ultra-wide of a virtual multi-camera device.
        if (Number.isFinite(caps.zoom?.min) && caps.zoom.min < 1) d.zoomMin = caps.zoom.min;
        d.width = set.width; d.height = set.height;
        this.log('info', `Lens "${d.label}": ${set.width}x${set.height}${d.zoomMin ? `, zoom from ${d.zoomMin}` : ''}.`);
      } catch (err) {
        d.error = err.name || 'unavailable';
      } finally {
        if (stream) stream.getTracks().forEach(t => t.stop());
      }
    }
    return this.devices;
  }

  /** Restart on a specific lens, preserving nothing: intrinsics belong to the
   *  lens, so a switch invalidates any focal length calibrated for the old one. */
  async switchTo(deviceId) {
    this.stop();
    this.activeDeviceId = deviceId;
    this.focalPx = null;
    this.focalSource = 'default';
    this.measuredFocalV = null;
    return this.start(deviceId);
  }

  async start(deviceId = null) {
    if (!window.isSecureContext) {
      throw new Error('Camera access needs HTTPS or localhost. Serve the folder over https and reload.');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not expose a camera API.');
    }
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
        : {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 }, height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        }
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this._startVideoFrameClock();

    const track = this.stream.getVideoTracks()[0];
    this.settings = track.getSettings ? track.getSettings() : {};
    this.log('info', `Camera started: ${this.settings.width}x${this.settings.height} @ ${this.settings.frameRate || '?'} fps, facing ${this.settings.facingMode || 'unknown'}.`);

    // Seed the focal estimate from the reported field of view when the browser
    // exposes it; otherwise keep the default until self-calibration lands.
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps && Number.isFinite(caps.focalLength)) {
        this.log('info', `Track reports focalLength ${caps.focalLength}.`);
      }
    } catch (_) { /* capabilities are optional */ }

    await this._lockOptics();
    this.pinned = !!deviceId;
    this.activeDeviceId = this.settings.deviceId || deviceId || null;
    this._startSwapWatch();
    this.detectRotation();
    this._pinKnownLens();
    return this.settings;
  }

  /**
   * Discourage the platform from changing lens mid-survey.
   *
   * On a Pixel the rear camera is one logical device backed by several physical
   * sensors, and the HAL picks between them mainly on zoom level and focus
   * distance. A horizon survey is the easy case — everything is at infinity and
   * nothing needs zoom — so holding zoom at 1.0 and focus at infinity keeps it
   * on the main lens. Both constraints are best-effort; browsers differ in what
   * they honour, which is why the focal-change detector exists as well.
   */
  async _lockOptics() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track?.getCapabilities) return;
    const caps = track.getCapabilities();
    const advanced = [];
    if (caps.zoom && caps.zoom.min <= 1 && caps.zoom.max >= 1) advanced.push({ zoom: 1 });
    // Deliberately NOT forcing manual focus to the infinity stop. Asking for
    // the lens that focuses furthest is very likely what made the Pixel hand
    // over its ultra-wide in the 2026-07-29 run — a 106 degree field where the
    // app expected 66, which halved every logged rotation. Continuous focus
    // leaves the lens choice alone.
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
      advanced.push({ focusMode: 'continuous' });
    }
    if (!advanced.length) return;
    try {
      await track.applyConstraints({ advanced });
      this.log('info', `Optics locked: ${advanced.map(a => Object.keys(a).join('+')).join(', ')}. This reduces the chance of the platform switching lenses mid-scan.`);
    } catch (err) {
      this.log('warn', `Could not lock zoom or focus (${err.name || err}). The focal-change detector will catch a lens swap if one happens.`);
    }
  }

  /**
   * Watch for the platform swapping physical lenses underneath us.
   *
   * Android exposes a "logical" rear camera that the HAL is free to back with
   * different physical sensors — it will switch to a wider or a low-light lens
   * on its own as the scene changes, which is what produced two frames with
   * completely different focus and framing seconds apart at night. That silently
   * changes the intrinsics mid-survey, so every focal length solved before the
   * swap is wrong afterwards and registration between the two frames is
   * meaningless. Opening by explicit deviceId pins one physical lens; this watch
   * catches it when pinning is unavailable or ignored.
   */
  _startSwapWatch() {
    clearInterval(this._watch);
    const track = this.stream?.getVideoTracks()[0];
    if (!track?.getSettings) return;
    let prev = track.getSettings();
    this._watch = setInterval(() => {
      const t = this.stream?.getVideoTracks()[0];
      if (!t?.getSettings) return;
      const cur = t.getSettings();
      // A pure width/height SWAP is the platform re-orienting the same sensor,
      // not a different lens. iPadOS does this whenever the device turns, and
      // treating it as a lens change threw away the intrinsics twice in one
      // session on 2026-08-14 — including a focal length that had just been
      // self-calibrated. The lens is identified by its deviceId and by the
      // number of pixels it delivers, neither of which a rotation alters.
      const rotatedOnly = cur.deviceId === prev.deviceId
        && cur.width === prev.height && cur.height === prev.width;
      if (rotatedOnly) {
        this.log('info', `Camera stream re-oriented: ${prev.width}x${prev.height} -> ${cur.width}x${cur.height}. Same lens, so the intrinsics are kept.`);
        this.detectRotation(this._lastScreenAngle || 0);
        this._applySensorFocal();
        prev = cur;
        return;
      }
      const changed = cur.deviceId !== prev.deviceId
        || cur.width !== prev.width
        || cur.height !== prev.height;
      if (changed) {
        this.lensSwaps++;
        this.focalPx = null;
        this.focalSource = 'default';
        this.measuredFocalV = null;
        this.sensorFocalPx = null;
        this.log('warn', `Camera changed underneath the survey: ${prev.width}x${prev.height} -> ${cur.width}x${cur.height}. Intrinsics discarded. Pin a lens under Advanced to stop this.`);
        if (this.onLensSwap) this.onLensSwap(prev, cur);
        prev = cur;
      }
    }, 1000);
  }

  stop() {
    clearInterval(this._watch);
    this._watch = null;
    if (this._videoFrameRequest !== null && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this._videoFrameRequest);
    }
    this._videoFrameRequest = null;
    this._lastVideoFrame = null;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  /**
   * Keep the browser's best timestamp for the decoded video frame. Safari does
   * not expose a camera exposure timestamp on every release, but
   * requestVideoFrameCallback still gives us the media time and presentation
   * clock. Saving every field that exists lets an offline stitcher interpolate
   * the gyro onto the photograph instead of assuming "sensor now" == "camera
   * now".
   */
  _startVideoFrameClock() {
    if (!this.video.requestVideoFrameCallback) return;
    const sample = (now, meta = {}) => {
      if (!this.stream) return;
      const finite = value => Number.isFinite(value) ? value : null;
      this._lastVideoFrame = {
        callbackPerformanceMs: finite(now),
        mediaTimeSec: finite(meta.mediaTime),
        expectedDisplayTimeMs: finite(meta.expectedDisplayTime),
        presentationTimeMs: finite(meta.presentationTime),
        captureTimeMs: finite(meta.captureTime),
        receiveTimeMs: finite(meta.receiveTime),
        processingDurationSec: finite(meta.processingDuration),
        presentedFrames: finite(meta.presentedFrames),
        width: finite(meta.width),
        height: finite(meta.height)
      };
      if (this.stream) this._videoFrameRequest = this.video.requestVideoFrameCallback(sample);
    };
    this._videoFrameRequest = this.video.requestVideoFrameCallback(sample);
  }

  /** Mean luminance of the working frame, 0-255. Used to refuse to segment a
   *  scene too dark for a sky boundary to exist in the imagery at all. */
  meanLuma() {
    if (!this.ready) return null;
    this._drawRotated(this.workCtx, WORK_W, WORK_H);
    const d = this.workCtx.getImageData(0, 0, WORK_W, WORK_H).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 64) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return sum / (d.length / 64);
  }

  get ready() {
    return !!this.stream && this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  /** Guess the image->screen rotation from the delivered frame shape. */
  detectRotation(screenAngle = 0) {
    this._lastScreenAngle = screenAngle;
    if (!this.autoRotation || !this.video.videoWidth) return this.frameRotation;
    const imageLandscape = this.video.videoWidth >= this.video.videoHeight;
    const screenLandscape = screenAngle === 90 || screenAngle === -90 || screenAngle === 270;
    // If the delivered frame and the screen disagree about which way is long,
    // the sensor frame is 90° out.
    this.frameRotation = (imageLandscape !== screenLandscape) ? 90 : 0;
    return this.frameRotation;
  }

  setRotation(deg) {
    this.autoRotation = false;
    this.frameRotation = ((deg % 360) + 360) % 360;
    this.log('info', `Frame rotation overridden to ${this.frameRotation}°.`);
  }

  /** Draw the current video frame into ctx, rotated into screen orientation,
   *  filling the destination with a cover fit. */
  _drawRotated(ctx, dw, dh) {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const rot = this.frameRotation;
    const swapped = rot === 90 || rot === 270;
    const srcW = swapped ? vh : vw;
    const srcH = swapped ? vw : vh;
    const scale = Math.max(dw / srcW, dh / srcH);
    const w = srcW * scale, h = srcH * scale;

    ctx.save();
    ctx.translate(dw / 2, dh / 2);
    ctx.rotate(rot * DEG);
    ctx.drawImage(this.video, -(swapped ? h : w) / 2, -(swapped ? w : h) / 2,
      swapped ? h : w, swapped ? w : h);
    ctx.restore();
  }

  /** Working-resolution RGBA frame, screen-aligned. */
  grabWorkFrame() {
    if (!this.ready) return null;
    this._drawRotated(this.workCtx, WORK_W, WORK_H);
    return this.workCtx.getImageData(0, 0, WORK_W, WORK_H);
  }

  /** Registration-resolution luminance, screen-aligned. */
  grabLuma() {
    if (!this.ready) return null;
    this._drawRotated(this.lumaCtx, LUMA_W, LUMA_H);
    const d = this.lumaCtx.getImageData(0, 0, LUMA_W, LUMA_H).data;
    const out = new Float32Array(LUMA_W * LUMA_H);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    }
    return out;
  }

  /**
   * Capture one decoded video frame, then derive every representation from that
   * one canvas. Previously work pixels, luma and the archived JPEG each drew
   * the live video separately; while turning they could describe three
   * different exposures even though they became one keyframe record.
   */
  grabSynchronizedFrame() {
    if (!this.ready) return null;
    const performanceMs = performance.now();
    const wallClockMs = Date.now();
    const videoCurrentTimeSec = Number.isFinite(this.video.currentTime)
      ? this.video.currentTime : null;

    this._drawRotated(this.keyCtx, this.keyCanvas.width, this.keyCanvas.height);
    this.workCtx.drawImage(this.keyCanvas, 0, 0, WORK_W, WORK_H);
    this.lumaCtx.drawImage(this.keyCanvas, 0, 0, LUMA_W, LUMA_H);

    const workFrame = this.workCtx.getImageData(0, 0, WORK_W, WORK_H);
    const rgba = this.lumaCtx.getImageData(0, 0, LUMA_W, LUMA_H).data;
    const luma = new Float32Array(LUMA_W * LUMA_H);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      luma[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    }

    const serial = ++this._captureSerial;
    const settings = this.settings || {};
    return {
      serial,
      workFrame,
      luma,
      timing: {
        wallClockMs,
        performanceMs,
        videoCurrentTimeSec,
        videoFrame: this._lastVideoFrame ? { ...this._lastVideoFrame } : null,
        sourceWidth: this.video.videoWidth || null,
        sourceHeight: this.video.videoHeight || null,
        savedWidth: this.keyCanvas.width,
        savedHeight: this.keyCanvas.height,
        frameRotationDeg: this.frameRotation,
        track: {
          width: settings.width || null,
          height: settings.height || null,
          frameRate: settings.frameRate || null,
          facingMode: settings.facingMode || null,
          resizeMode: settings.resizeMode || null
        }
      }
    };
  }

  /** Encode the key canvas belonging to packet without drawing the live video. */
  async encodeSynchronizedFrame(packet, quality = 0.72) {
    if (!packet || packet.serial !== this._captureSerial) return null;
    return new Promise(res => this.keyCanvas.toBlob(b => res(b), 'image/jpeg', quality));
  }

  /** JPEG thumbnail for the project archive. */
  async grabKeyframeThumb(quality = 0.62) {
    if (!this.ready) return null;
    this._drawRotated(this.keyCtx, this.keyCanvas.width, this.keyCanvas.height);
    return new Promise(res => this.keyCanvas.toBlob(b => res(b), 'image/jpeg', quality));
  }

  /** Adopt a self-calibrated focal length measured in WORK_W pixels. */
  adoptFocal(focalPx) {
    if (!Number.isFinite(focalPx) || focalPx < 60) return false;
    this.focalPx = focalPx;
    this.hfovDeg = 2 * Math.atan((WORK_W / 2) / focalPx) * RAD;
    this.focalSource = 'self-calibrated';
    return true;
  }

  /**
   * Fraction of the video frame that survives the cover-fit crop into the
   * working frame, per axis.
   *
   * This matters more than it looks. The stream is requested at 1920x1080 —
   * 16:9 — and _drawRotated scales it to COVER a 4:3 working canvas, so a
   * quarter of the width is thrown away before anything is measured. Every
   * angle in this app is derived from the working frame, so the field of view
   * that belongs in the projection is the working frame's, not the sensor's.
   * Feeding a sensor spec straight in overstates the horizontal field by
   * 1/0.75 and — because tanHalfV is derived from tanHalfH — overstates every
   * altitude by the same 33%.
   *
   * Returns { w, h, known }. Exactly one of w/h is 1: the limiting axis.
   */
  cropFactor() {
    const vw = this.video && this.video.videoWidth, vh = this.video && this.video.videoHeight;
    if (!vw || !vh) return { w: 1, h: 1, known: false };
    const swapped = this.frameRotation === 90 || this.frameRotation === 270;
    const srcW = swapped ? vh : vw, srcH = swapped ? vw : vh;
    const scale = Math.max(WORK_W / srcW, WORK_H / srcH);
    return {
      w: clamp((WORK_W / scale) / srcW, 0.05, 1),
      h: clamp((WORK_H / scale) / srcH, 0.05, 1),
      known: true
    };
  }

  /**
   * Set the field of view from a SENSOR figure — a spec-sheet number, a preset,
   * or the FOV slider. Converted to the working frame's field of view before
   * use. Also record the sensor value so the status panel can show both and the
   * difference is visible rather than silent.
   */
  setSensorHfov(deg) {
    const sensor = clamp(deg, 30, 160);
    this.sensorHfovDeg = sensor;
    const crop = this.cropFactor();
    const workTan = Math.tan(sensor / 2 * DEG) * crop.w;
    this.setHfov(2 * Math.atan(workTan) * RAD);
    this.focalSource = crop.known
      ? `sensor ${sensor.toFixed(1)}\u00b0 \u00d7 ${crop.w.toFixed(3)} crop`
      : 'manual (crop unmeasured)';
    return { workHfovDeg: this.hfovDeg, crop };
  }

  /**
   * Set the WORKING-FRAME horizontal field of view directly. This is the value
   * projection uses. Loop-closure rescaling and adoptFocal both produce
   * work-frame quantities, so they come through here unmodified.
   */
  setHfov(deg) {
    this.hfovDeg = clamp(deg, 20, 150);
    this.focalPx = (WORK_W / 2) / Math.tan(this.hfovDeg / 2 * DEG);
    this.focalSource = 'manual';
  }

  /**
   * Adopt a lens measured against the sensors — see js/lenscal.js.
   *
   * The vertical is taken as its own measurement rather than being re-derived
   * from the horizontal. Altitude is the quantity this app exists to report and
   * it depends on the VERTICAL half-angle, so leaving that to follow from the
   * horizontal via an assumed pixel aspect and crop puts the most important
   * number in the survey on the one part of the model nothing ever checks.
   */
  setMeasuredLens(focalH, focalV) {
    if (!Number.isFinite(focalH) || focalH < 40) return false;
    this.focalPx = focalH;
    this.hfovDeg = 2 * Math.atan((WORK_W / 2) / focalH) * RAD;
    this.measuredFocalV = Number.isFinite(focalV) && focalV > 40 ? focalV : null;
    this.focalSource = 'measured';
    return true;
  }


  /** Pin a lens from the table if this device is one we know. */
  _pinKnownLens() {
    if (!this.settings) return false;
    const hit = KNOWN_LENSES.find(k => { try { return k.match(this.settings); } catch (_) { return false; } });
    if (!hit) return false;
    if (this.setSensorFocalPx(hit.focalVideoPx, 'known-device')) {
      this.log('info', `Lens known for this device (${hit.label}): ${this.hfovDeg.toFixed(1)}° across the working frame, ${this.intrinsics().vfovDeg.toFixed(1)}° down it. Not measured and not guessed — pinned. Override under Advanced if it looks wrong.`);
      return true;
    }
    return false;
  }

  /** Pin the lens from a known focal length in VIDEO pixels.
   *
   * Focal length in pixels is the one description of a lens that survives
   * everything this pipeline does to a frame: rotating it swaps the axes but
   * not the number, cropping it removes pixels but does not change the angle
   * each remaining pixel subtends, and rescaling it multiplies focal and image
   * size together. So a device whose lens is known can be pinned once here and
   * stay correct through every rotation and re-orientation the platform throws
   * at it — which on an iPad is several per session.
   *
   * Everything else in this file tries to MEASURE the lens. This does not: it
   * is a hardcoded fact about a known device, and it wins over every estimator.
   */
  setSensorFocalPx(focalVideoPx, label) {
    if (!Number.isFinite(focalVideoPx) || focalVideoPx <= 0) return false;
    this.sensorFocalPx = focalVideoPx;
    this.sensorFocalLabel = label || 'pinned';
    return this._applySensorFocal();
  }

  /** Recompute the working-frame focal from the pinned sensor focal and the
   *  cover-fit scale currently in force. Called whenever the stream changes. */
  _applySensorFocal() {
    if (!this.sensorFocalPx) return false;
    const vw = this.video?.videoWidth, vh = this.video?.videoHeight;
    if (!vw || !vh) return false;
    const swapped = this.frameRotation === 90 || this.frameRotation === 270;
    const srcW = swapped ? vh : vw, srcH = swapped ? vw : vh;
    // The same cover fit _drawRotated performs. Resampling scales the focal
    // length by exactly the factor it scales the image by.
    const scale = Math.max(WORK_W / srcW, WORK_H / srcH);
    this.focalPx = this.sensorFocalPx * scale;
    this.hfovDeg = 2 * Math.atan((WORK_W / 2) / this.focalPx) * RAD;
    this.measuredFocalV = this.focalPx;      // square pixels: one focal, both axes
    this.focalSource = this.sensorFocalLabel;
    return true;
  }

  /** Intrinsics for the working frame, in half-image tangent units. */
  intrinsics() {
    const tanHalfH = Math.tan(this.hfovDeg / 2 * DEG);
    const tanHalfV = this.measuredFocalV
      ? (WORK_H / 2) / this.measuredFocalV
      : tanHalfH * (WORK_H / WORK_W);
    const crop = this.cropFactor();
    return {
      tanHalfH, tanHalfV,
      hfovDeg: this.hfovDeg,
      vfovDeg: 2 * Math.atan(tanHalfV) * RAD,
      focalPx: this.focalPx || (WORK_W / 2) / tanHalfH,
      source: this.focalSource,
      // Carried into the archive so a stored keyframe can be re-judged later.
      cropW: crop.w, cropH: crop.h, cropKnown: crop.known,
      sensorHfovDeg: this.sensorHfovDeg ?? null,
      videoW: this.video ? this.video.videoWidth : 0,
      videoH: this.video ? this.video.videoHeight : 0
    };
  }
}
