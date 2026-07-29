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

    // Intrinsics: horizontal half-FOV tangent. Starts from a sane phone default
    // and is replaced by the self-calibrated value once the scan produces one.
    this.hfovDeg = 66;
    this.focalPx = null;
    this.focalSource = 'default';

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

    this.pinned = !!deviceId;
    this.activeDeviceId = this.settings.deviceId || deviceId || null;
    this._startSwapWatch();
    this.detectRotation();
    return this.settings;
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
      const changed = cur.deviceId !== prev.deviceId
        || cur.width !== prev.width
        || cur.height !== prev.height;
      if (changed) {
        this.lensSwaps++;
        this.focalPx = null;
        this.focalSource = 'default';
        this.log('warn', `Camera changed underneath the survey: ${prev.width}x${prev.height} -> ${cur.width}x${cur.height}. Intrinsics discarded. Pin a lens under Advanced to stop this.`);
        if (this.onLensSwap) this.onLensSwap(prev, cur);
        prev = cur;
      }
    }, 1000);
  }

  stop() {
    clearInterval(this._watch);
    this._watch = null;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
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

  setHfov(deg) {
    this.hfovDeg = clamp(deg, 35, 110);
    this.focalPx = (WORK_W / 2) / Math.tan(this.hfovDeg / 2 * DEG);
    this.focalSource = 'manual';
  }

  /** Intrinsics for the working frame, in half-image tangent units. */
  intrinsics() {
    const tanHalfH = Math.tan(this.hfovDeg / 2 * DEG);
    const tanHalfV = tanHalfH * (WORK_H / WORK_W);
    return {
      tanHalfH, tanHalfV,
      hfovDeg: this.hfovDeg,
      vfovDeg: 2 * Math.atan(tanHalfV) * RAD,
      focalPx: this.focalPx || (WORK_W / 2) / tanHalfH,
      source: this.focalSource
    };
  }
}
