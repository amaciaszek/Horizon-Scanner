const created = [];

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.draws = [];
  }
  save() {}
  restore() {}
  translate() {}
  rotate() {}
  drawImage(source) { this.draws.push(source); }
  getImageData(_x, _y, width, height) {
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  }
}

class FakeCanvas {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.ctx = new FakeContext(this);
    created.push(this);
  }
  getContext() { return this.ctx; }
  toBlob(callback, type) { callback(new Blob([Uint8Array.of(1, 2, 3)], { type })); }
}

globalThis.document = { createElement: () => new FakeCanvas() };
globalThis.window = { innerWidth: 820, innerHeight: 1073, devicePixelRatio: 2 };

const { CameraSource } = await import('../js/camera.js');
const video = {
  videoWidth: 1920,
  videoHeight: 1080,
  readyState: 2,
  currentTime: 12.5
};
const camera = new CameraSource(video);
camera.stream = {
  getTracks: () => [],
  getVideoTracks: () => [{
    getSettings: () => ({
      width: 1920, height: 1080, frameRate: 30, facingMode: 'environment',
      exposureMode: 'continuous', exposureTime: 0.01, iso: 80, focusMode: 'continuous'
    })
  }]
};
camera.settings = { width: 1920, height: 1080, frameRate: 30, facingMode: 'environment' };

const packet = camera.grabSynchronizedFrame();
const liveVideoDraws = created.reduce(
  (sum, canvas) => sum + canvas.ctx.draws.filter(source => source === video).length, 0
);
const derivedFromKeyCanvas = camera.workCtx.draws.at(-1) === camera.keyCanvas
  && camera.lumaCtx.draws.at(-1) === camera.keyCanvas;
const blob = await camera.encodeSynchronizedFrame(packet);

let failures = 0;
function check(name, ok) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}`);
  if (!ok) failures++;
}

check('live video is drawn exactly once for a synchronized packet', liveVideoDraws === 1);
check('analysis and registration images derive from the archived key canvas', derivedFromKeyCanvas);
check('packet carries video and source timing', packet.timing.videoCurrentTimeSec === 12.5
  && packet.timing.sourceWidth === 1920 && Number.isFinite(packet.timing.performanceMs));
check('packet carries the live exposure and focus settings', packet.timing.track.exposureTime === 0.01
  && packet.timing.track.iso === 80 && packet.timing.track.focusMode === 'continuous');
check('encoding the synchronized packet does not redraw live video', blob?.type === 'image/jpeg'
  && created.reduce((sum, canvas) => sum + canvas.ctx.draws.filter(source => source === video).length, 0) === 1);

// Exact field regression: iPad reports angle 90 even though both viewport and
// decoded frame are portrait. A stale camera rotation must be corrected before
// pixels are analysed or archived.
video.videoWidth = 1080;
video.videoHeight = 1920;
camera.frameRotation = 90;
camera._lastScreenAngle = 90;
const portraitPacket = camera.grabSynchronizedFrame();
check('portrait viewport overrides the stale iPad 90 degree report',
  portraitPacket.timing.frameRotationDeg === 0);
check('exact cover-fit crop is attached to the exposure',
  Math.abs(portraitPacket.timing.coverFit.visibleRectScreenAligned.y - 555) < 0.01
  && Math.abs(portraitPacket.timing.coverFit.retainedFraction.height - 0.421875) < 1e-9
  && portraitPacket.timing.coverFit.retainedFraction.width === 1);
check('viewport geometry is attached to the exposure',
  portraitPacket.timing.viewport.width === 820 && portraitPacket.timing.viewport.devicePixelRatio === 2);

camera.setMeasuredLens(500, 520);
camera._applySensorFocal();
check('a field lens measurement replaces and survives the device prior',
  camera.focalSource === 'measured' && Math.abs(camera.focalPx - 500) < 1e-9
  && Math.abs(camera.measuredFocalV - 520) < 1e-9);

console.log(failures ? `\n${failures} FAILED` : '\nall synchronized-camera checks passed');
process.exitCode = failures ? 1 : 0;
