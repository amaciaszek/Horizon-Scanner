'use strict';
/* The inside of a sphere: a panorama, some points, some lines, and a 2D layer
 * over the top for anything with words in it.
 *
 * WHY THIS IS A MODULE. `sky/skyline-align.html` grew this renderer and
 * `sky/planetarium.html` needs the same one. Two copies would be two answers:
 * a shader fixed in one and not the other puts the silhouette in a different
 * place on each page, and the offsets measured on the first page would then be
 * wrong on the second. The chain only holds if every page draws the sky the
 * same way, so there is one renderer and the pages differ only in what they
 * hand it.
 *
 * Raw GL, no library, for the reason js/dome-view.js gives: this is one
 * textured sphere, a few thousand points and a few hundred lines, which is less
 * code than a wrapper around a scene graph would be and has no download.
 *
 * Angles are degrees everywhere at the boundary, as in sky/astro.js.
 */

const D = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const wrap360 = deg => ((deg % 360) + 360) % 360;

/** A direction on the unit sphere from horizontal coordinates. */
export const dirOf = (azDeg, altDeg) => {
  const ca = Math.cos(altDeg * D);
  return [Math.sin(azDeg * D) * ca, Math.sin(altDeg * D), Math.cos(azDeg * D) * ca];
};

/*
 * Star colour from the B-V index.
 *
 * Not a blackbody fit -- a piecewise ramp through the colours the eye actually
 * reports for the few stars whose colour is obvious at all: Rigel blue-white,
 * Vega white, Capella yellow, Betelgeuse and Antares orange-red. Everything
 * fainter than about magnitude 2 looks white to a dark-adapted eye anyway, so
 * accuracy past that would be dishonest.
 */
export function colourOf(ci) {
  const t = clamp((ci + 0.35) / 2.1, 0, 1);
  const stops = [
    [0.00, [0.61, 0.72, 1.00]],
    [0.22, [0.79, 0.86, 1.00]],
    [0.36, [1.00, 1.00, 1.00]],
    [0.52, [1.00, 0.96, 0.82]],
    [0.72, [1.00, 0.84, 0.62]],
    [1.00, [1.00, 0.68, 0.50]]
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const k = (t - a) / (b - a || 1);
      return [0, 1, 2].map(j => ca[j] + (cb[j] - ca[j]) * k);
    }
  }
  return stops[stops.length - 1][1];
}

function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan(fovDeg * D / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0, 0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0
  ]);
}

/** Look-direction matrix, same convention as js/dome-view.js. */
function viewMatrix(azDeg, altDeg) {
  const ca = Math.cos(altDeg * D), sa = Math.sin(altDeg * D);
  const cz = Math.cos(azDeg * D), sz = Math.sin(azDeg * D);
  const fx = sz * ca, fy = sa, fz = cz * ca;
  const rx = cz, ry = 0, rz = -sz;
  const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;
  return new Float32Array([
    rx, ux, -fx, 0, ry, uy, -fy, 0, rz, uz, -fz, 0, 0, 0, 0, 1
  ]);
}

/** Full sphere, positions only. Direction-based UV means nothing else is needed. */
function buildSphere(cols = 192, rows = 96) {
  const pos = [], idx = [];
  for (let r = 0; r <= rows; r++) {
    const alt = 90 - (r / rows) * 180;
    const ca = Math.cos(alt * D), sa = Math.sin(alt * D);
    for (let c = 0; c <= cols; c++) {
      const az = (c / cols) * 360;
      pos.push(Math.sin(az * D) * ca, sa, Math.cos(az * D) * ca);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + cols + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { pos: new Float32Array(pos), idx: new Uint16Array(idx), count: idx.length };
}

const STAR_VS = `
attribute vec3 aDir;
attribute float aMag;
attribute vec3 aColor;
uniform mat4 uProj, uView;
uniform float uMagLimit, uScale, uStarSize;
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_Position = uProj * uView * vec4(aDir, 1.0);
  float room = uMagLimit - aMag;
  // Below the cut-off the point is pushed off-screen rather than drawn at zero
  // size: a zero-size GL point is not reliably culled on every driver.
  if (room < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
  /*
   * SIZED TO BE SEEN, NOT TO BE PHOTOMETRICALLY HONEST.
   *
   * The first version started a faintest-magnitude star at 1.1 pixels and the
   * operator's verdict was simply that the stars were too small. They were: a
   * one-pixel dot at a quarter alpha is invisible against a panorama on a phone
   * held at arm's length outdoors, and these pages are USED outdoors. A star
   * chart that cannot be read beside the real sky fails at its only job.
   *
   * The floor is now a shade under two pixels, the slope is steeper, and the
   * faintest star keeps a third of its alpha instead of a quarter, so the
   * brightness ORDER still reads while nothing drops below the visible. The
   * size slider multiplies all of it, because how big is big enough depends on
   * the screen, the darkness and the eyes.
   */
  gl_PointSize = clamp(1.8 + room * 1.3, 1.4, 26.0) * uScale * uStarSize;
  vAlpha = clamp(0.36 + room * 0.24, 0.0, 1.0);
  vColor = aColor;
}`;

const STAR_FS = `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  // A round star with a soft edge. Square stars read as pixels, and the eye is
  // being asked to compare this against real ones.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  float a = smoothstep(1.0, 0.25, r) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
}`;

/* Figure lines and the compass graticule share one flat-colour program. */
const LINE_VS = `
attribute vec3 aDir;
uniform mat4 uProj, uView;
void main() { gl_Position = uProj * uView * vec4(aDir, 1.0); }`;

const LINE_FS = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

/*
 * The panorama, as the inside of a sphere.
 *
 * UV IS COMPUTED FROM THE DIRECTION IN THE FRAGMENT SHADER, not baked into the
 * mesh the way js/dome-view.js does it. That is the whole trick that makes the
 * two offset sliders free: turning the panorama is a change to one uniform, not
 * a rebuild of a 128x64 mesh sixty times a second while a finger is moving.
 */
const DOME_VS = `
attribute vec3 aPos;
uniform mat4 uProj, uView;
varying vec3 vDir;
void main() { vDir = aPos; gl_Position = uProj * uView * vec4(aPos, 1.0); }`;

const DOME_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vDir;
uniform sampler2D uTex;
uniform float uAzOffset, uAltOffset, uAltMin, uAltMax;
uniform float uShowCut, uDim;
uniform vec4 uGround;
void main() {
  vec3 d = normalize(vDir);
  float alt = degrees(asin(clamp(d.y, -1.0, 1.0)));
  float az = degrees(atan(d.x, d.z));
  // The offsets move the PICTURE, so they are subtracted from the direction
  // being looked up rather than added to it.
  float u = fract((az - uAzOffset) / 360.0 + 1.0);
  float v = (uAltMax - (alt - uAltOffset)) / (uAltMax - uAltMin);
  if (v < 0.0) { discard; }                       // above the picture: open sky
  if (v > 1.0) { gl_FragColor = uGround; return; } // below it: ground, not sky
  vec4 c = texture2D(uTex, vec2(u, v));
  if (uShowCut > 0.5) {
    // Mark the cut itself: the first opaque texel below a transparent one.
    float above = texture2D(uTex, vec2(u, v - 0.004)).a;
    if (c.a > 0.5 && above < 0.5) { gl_FragColor = vec4(0.18, 0.78, 0.90, 1.0); return; }
  }
  if (c.a < 0.02) discard;
  // uDim darkens the terrain without making it transparent. The planetarium
  // wants the silhouette to read as a silhouette at night, not as a daylit
  // photograph pasted under the stars.
  gl_FragColor = vec4(c.rgb * uDim, c.a);
}`;

export class SkyView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {(ctx: CanvasRenderingContext2D, api: object) => void} opts.onOverlay
   *   Called at the end of every frame with the 2D context stacked over the GL
   *   canvas and `{project, dpr, width, height}`. Text in WebGL means a glyph
   *   atlas, and there is no reason to build one for a few dozen names.
   */
  constructor(canvas, { onOverlay = null, onCameraChange = null } = {}) {
    this.canvas = canvas;
    this.onOverlay = onOverlay;
    this.onCameraChange = onCameraChange;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('this browser gave no WebGL context');
    this.gl = gl;

    this.starProg = this._program(STAR_VS, STAR_FS);
    this.lineProg = this._program(LINE_VS, LINE_FS);
    this.domeProg = this._program(DOME_VS, DOME_FS);
    this.maxVertexAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
    this.maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    this.sphere = buildSphere();
    this.spherePos = gl.createBuffer();
    this.sphereIdx = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spherePos);
    gl.bufferData(gl.ARRAY_BUFFER, this.sphere.pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.sphereIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.sphere.idx, gl.STATIC_DRAW);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.points = new Map();     // name -> {dir, mag, col, count}
    this.lines = new Map();      // name -> {buf, count}

    this.camera = { azDeg: 0, altDeg: 10, fovDeg: 70 };
    this.starSize = 1.6;
    this.dome = {
      ready: false, azOffset: 0, altOffset: 0, topDeg: 48.5, spanDeg: 97,
      showCut: false, dim: 1, ground: [0.02, 0.035, 0.045, 1.0]
    };

    this.overlay = document.createElement('canvas');
    this.overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;width:100%;height:100%';
    canvas.insertAdjacentElement('afterend', this.overlay);
    this.overlayCtx = this.overlay.getContext('2d');

    this._frameQueued = false;
    this._proj = null;
    this._view = null;
    this._bindPointer();
    window.addEventListener('resize', () => this.requestDraw());
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) + '\n' + src);
    }
    return sh;
  }

  _program(vs, fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  /*
   * Bind exactly the attributes a draw needs, and turn every other one OFF.
   *
   * MEASURED THE HARD WAY. The star pass enables three attribute arrays; the
   * panorama pass needs one. Leaving the other two enabled leaves them pointed
   * at the star buffers, which hold 9,018 vertices, while the sphere draws
   * 18,721 -- so the driver is asked to read an attribute array off its end.
   * The spec calls that undefined and the driver here simply DROPPED THE DRAW:
   * a full sky, no panorama, no GL error, nothing in the console. The stars
   * were fine, so everything pointed at the panorama code, which was correct
   * all along.
   *
   * Attribute state is global to the context, not to the program. Anything that
   * switches programs has to reset it, so no draw can inherit the last one's.
   */
  _useAttribs(prog, spec) {
    const gl = this.gl;
    const wanted = new Set();
    for (const [name, buffer, size] of spec) {
      const loc = gl.getAttribLocation(prog, name);
      if (loc < 0) continue;
      wanted.add(loc);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    for (let i = 0; i < this.maxVertexAttribs; i++) {
      if (!wanted.has(i)) gl.disableVertexAttribArray(i);
    }
  }

  /* ----------------------------------------------------------- contents */

  /** A set of magnitude-sized points. `dirs` is 3N, `mags` N, `colors` 3N. */
  setPoints(name, { dirs, mags, colors }) {
    const gl = this.gl;
    let slot = this.points.get(name);
    if (!slot) {
      slot = { dir: gl.createBuffer(), mag: gl.createBuffer(), col: gl.createBuffer(), count: 0 };
      this.points.set(name, slot);
    }
    slot.count = mags.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, slot.dir); gl.bufferData(gl.ARRAY_BUFFER, dirs, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, slot.mag); gl.bufferData(gl.ARRAY_BUFFER, mags, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, slot.col); gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
  }

  /** A set of GL_LINES vertices, 3 floats each, pairs making segments. The
   *  same store backs `mesh` layers, which read it as GL_TRIANGLES. */
  setLines(name, verts, usage = 'dynamic') {
    const gl = this.gl;
    let slot = this.lines.get(name);
    if (!slot) { slot = { buf: gl.createBuffer(), count: 0 }; this.lines.set(name, slot); }
    slot.count = verts.length / 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, slot.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, usage === 'static' ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
  }

  /**
   * Upload the cut panorama. Takes the canvas `cutSkyTexture` returns.
   *
   * MIPMAPS, AND WHY THEY ARE NOT AN OPTIMISATION EITHER.
   *
   * MEASURED on the 2026-09-23 render at 3240x891, shown at 120 degrees of
   * field on a 1000-pixel canvas: that is four texels per pixel across, and a
   * plain LINEAR minification filter reads ONE of those four. The treeline
   * came out as a comb of bright vertical streaks shooting up into the sky,
   * which reads exactly like the sky cut having torn chunks out of the
   * terrain -- and it is not the cut at all, it is undersampling. The cut is
   * jagged by nature, because a traced treetop is jagged, and a jagged alpha
   * edge is the worst possible thing to point a single-sample filter at.
   *
   * The texture is already a power of two in both directions for the REPEAT
   * wrap (see `cutSkyTexture`), which is the same condition WebGL 1 puts on
   * mipmapping, so this costs a third of the memory and nothing else. The
   * check is kept anyway: a non-POT texture with a mipmapping filter is
   * incomplete and samples as opaque black, which is the same silent failure
   * documented over there.
   */
  setTexture(source) {
    const gl = this.gl;
    const pot = n => (n & (n - 1)) === 0 && n > 0;
    const mip = pot(source.width) && pot(source.height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
      mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    this.dome.ready = true;
    this.requestDraw();
  }

  /* --------------------------------------------------------------- draw */

  get dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

  /** The composition, kept until it is replaced. `draw` with no argument uses
   *  it, so a redraw provoked by a drag does not have to rebuild the list. */
  setLayers(layers) { this._layers = layers; }

  requestDraw() {
    if (this._frameQueued) return;
    this._frameQueued = true;
    requestAnimationFrame(() => { this._frameQueued = false; this.draw(); });
  }

  /**
   * One frame.
   *
   * `layers` is an ordered list, because the order is the whole composition:
   * marks behind figures behind stars, and the panorama LAST so its opaque
   * ground covers the stars that are underground.
   *
   *   {type:'lines',  name, color:[r,g,b,a]}
   *   {type:'mesh',   name, color:[r,g,b,a]}   -- same buffer, as triangles
   *   {type:'points', name, magLimit, scale}
   *   {type:'dome'}
   */
  draw(layers = this._layers || []) {
    this._layers = layers;
    const gl = this.gl, canvas = this.canvas, dpr = this.dpr;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

    gl.viewport(0, 0, w, h);
    gl.clearColor(0.004, 0.012, 0.024, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const proj = perspective(this.camera.fovDeg, w / h, 0.01, 10);
    const view = viewMatrix(this.camera.azDeg, this.camera.altDeg);
    this._proj = proj; this._view = view;

    // A narrow field means the eye is closer in, so points grow with the zoom
    // -- otherwise a 15-degree view shows the same speck sizes as a 120-degree one.
    const zoomScale = clamp(70 / this.camera.fovDeg, 0.7, 2.4) * dpr;

    for (const layer of layers) {
      if (layer.type === 'lines' || layer.type === 'mesh') this._drawLines(layer, proj, view);
      else if (layer.type === 'points') this._drawPoints(layer, proj, view, zoomScale);
      else if (layer.type === 'dome') this._drawDome(proj, view);
    }

    this.overlay.width = w; this.overlay.height = h;
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, w, h);
    if (this.onOverlay) {
      this.onOverlay(ctx, { project: (az, alt) => this.project(az, alt), dpr, width: w, height: h });
    }
  }

  _drawLines(layer, proj, view) {
    const slot = this.lines.get(layer.name);
    if (!slot || !slot.count) return;
    const gl = this.gl, p = this.lineProg;
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uProj'), false, proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uView'), false, view);
    gl.uniform4fv(gl.getUniformLocation(p, 'uColor'), layer.color);
    this._useAttribs(p, [['aDir', slot.buf, 3]]);
    gl.drawArrays(layer.type === 'mesh' ? gl.TRIANGLES : gl.LINES, 0, slot.count);
  }

  _drawPoints(layer, proj, view, zoomScale) {
    const slot = this.points.get(layer.name);
    if (!slot || !slot.count) return;
    const gl = this.gl, p = this.starProg;
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uProj'), false, proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uView'), false, view);
    gl.uniform1f(gl.getUniformLocation(p, 'uMagLimit'), layer.magLimit);
    gl.uniform1f(gl.getUniformLocation(p, 'uScale'), zoomScale * (layer.scale || 1));
    gl.uniform1f(gl.getUniformLocation(p, 'uStarSize'), this.starSize);
    this._useAttribs(p, [['aDir', slot.dir, 3], ['aMag', slot.mag, 1], ['aColor', slot.col, 3]]);
    gl.drawArrays(gl.POINTS, 0, slot.count);
  }

  _drawDome(proj, view) {
    if (!this.dome.ready) return;
    const gl = this.gl, p = this.domeProg, dome = this.dome;
    gl.useProgram(p);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uProj'), false, proj);
    gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uView'), false, view);
    gl.uniform1f(gl.getUniformLocation(p, 'uAzOffset'), dome.azOffset);
    gl.uniform1f(gl.getUniformLocation(p, 'uAltOffset'), dome.altOffset);
    gl.uniform1f(gl.getUniformLocation(p, 'uAltMin'), dome.topDeg - dome.spanDeg);
    gl.uniform1f(gl.getUniformLocation(p, 'uAltMax'), dome.topDeg);
    gl.uniform1f(gl.getUniformLocation(p, 'uShowCut'), dome.showCut ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(p, 'uDim'), dome.dim);
    gl.uniform4fv(gl.getUniformLocation(p, 'uGround'), dome.ground);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(p, 'uTex'), 0);
    this._useAttribs(p, [['aPos', this.spherePos, 3]]);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.sphereIdx);
    gl.drawElements(gl.TRIANGLES, this.sphere.count, gl.UNSIGNED_SHORT, 0);
  }

  /**
   * Where a bearing lands on the canvas, in device pixels, or null if it is
   * behind the camera or outside the frame. Valid after a `draw`.
   */
  project(azDeg, altDeg) {
    const proj = this._proj, view = this._view;
    if (!proj) return null;
    const d = dirOf(azDeg, altDeg);
    const vx = view[0] * d[0] + view[4] * d[1] + view[8] * d[2];
    const vy = view[1] * d[0] + view[5] * d[1] + view[9] * d[2];
    const vz = view[2] * d[0] + view[6] * d[1] + view[10] * d[2];
    if (vz > -0.001) return null;                 // behind the camera
    const cx = proj[0] * vx / -vz, cy = proj[5] * vy / -vz;
    if (Math.abs(cx) > 1.08 || Math.abs(cy) > 1.08) return null;
    return [(cx * 0.5 + 0.5) * this.overlay.width, (0.5 - cy * 0.5) * this.overlay.height];
  }

  /* ------------------------------------------------------------- camera */

  lookAt(azDeg, altDeg) {
    this.camera.azDeg = wrap360(azDeg);
    this.camera.altDeg = clamp(altDeg, -85, 85);
    if (this.onCameraChange) this.onCameraChange();
    this.requestDraw();
  }

  setFov(fovDeg) {
    this.camera.fovDeg = clamp(fovDeg, 4, 120);
    if (this.onCameraChange) this.onCameraChange();
    this.requestDraw();
  }

  /** Drag to look around, wheel to zoom. Pointer events so a finger and a
   *  mouse are the same code. */
  _bindPointer() {
    const canvas = this.canvas;
    let dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', e => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', e => {
      if (!dragging) return;
      // Degrees per pixel scales with the field of view, so the drag feels the
      // same whether zoomed in or out.
      //
      // The floor on the height is not defensive clutter. A canvas in a
      // collapsed or hidden pane reports clientHeight 0, which makes k
      // Infinity; the altitude then clamps to -85 and the azimuth becomes
      // 0 * Infinity = NaN, which is a camera nothing can recover from and a
      // black screen with no error anywhere.
      const k = this.camera.fovDeg / Math.max(1, canvas.clientHeight);
      this.lookAt(this.camera.azDeg - (e.clientX - lastX) * k,
        this.camera.altDeg + (e.clientY - lastY) * k);
      lastX = e.clientX; lastY = e.clientY;
    });
    const stop = () => { dragging = false; canvas.classList.remove('dragging'); };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.setFov(this.camera.fovDeg * (e.deltaY > 0 ? 1.08 : 1 / 1.08));
    }, { passive: false });
  }
}

/** Compass marks: a vertical tick at every 10 degrees, taller at the cardinals,
 *  plus a horizon ring -- the line the panorama's own horizon should land on. */
export function compassMarks() {
  const v = [];
  for (let az = 0; az < 360; az += 10) {
    const cardinal = az % 90 === 0;
    const top = cardinal ? 12 : 4;
    for (let a = -6; a < top; a += 2) {
      const d1 = dirOf(az, a), d2 = dirOf(az, a + 2);
      v.push(d1[0], d1[1], d1[2], d2[0], d2[1], d2[2]);
    }
  }
  for (let az = 0; az < 360; az += 1) {
    const d1 = dirOf(az, 0), d2 = dirOf(az + 1, 0);
    v.push(d1[0], d1[1], d1[2], d2[0], d2[1], d2[2]);
  }
  return new Float32Array(v);
}

export const CARDINALS = [[0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW']];
