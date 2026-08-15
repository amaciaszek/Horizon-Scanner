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

const { CameraSource } = await import('../js/camera.js');
const video = {
  videoWidth: 1920,
  videoHeight: 1080,
  readyState: 2,
  currentTime: 12.5
};
const camera = new CameraSource(video);
camera.stream = { getTracks: () => [] };
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
check('encoding the synchronized packet does not redraw live video', blob?.type === 'image/jpeg'
  && created.reduce((sum, canvas) => sum + canvas.ctx.draws.filter(source => source === video).length, 0) === 1);

console.log(failures ? `\n${failures} FAILED` : '\nall synchronized-camera checks passed');
process.exitCode = failures ? 1 : 0;
