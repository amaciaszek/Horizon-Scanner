'use strict';
/* The panorama as a sphere you can look around inside.
 *
 * WHY THIS IS NOT A LUXURY.
 *
 * An equirectangular panorama is a map projection, and every map projection
 * lies in a way that depends on where you look. Altitude is linear top to
 * bottom, so a straight roofline photographed above the horizon becomes a
 * curve, and the higher it is the more it bends. The operator asked, correctly,
 * whether the bowing they were seeing near the bottom of the picture was the
 * flattening or a real error — and from the flat image alone that question
 * cannot be answered, because both look identical there.
 *
 * Reprojecting onto a sphere and letting them look around settles it in a
 * second. Under a rectilinear view a straight edge in the world is straight on
 * the screen. If it is still bent, the geometry is wrong; if it snaps straight,
 * the panorama was right and the map was lying.
 *
 * NO LIBRARIES AND NO NETWORK. Raw WebGL, one textured sphere, about as much
 * code as a wrapper around three.js would have been. The panorama can be
 * 2880x768 or larger, which is inside every WebGL implementation's texture
 * limit, and the whole thing runs on the GPU the device already has.
 */

const VERT = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform mat4 uProj;
uniform mat4 uView;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform float uAltMin;
uniform float uAltMax;
uniform float uGrid;
void main() {
  // Outside the painted altitude band there is no panorama, only the inside of
  // a sphere nobody photographed. Draw that as the chassis colour rather than
  // as stretched edge pixels, which would read as data.
  if (vUV.y < 0.0 || vUV.y > 1.0) { gl_FragColor = vec4(0.024, 0.051, 0.067, 1.0); return; }
  vec4 c = texture2D(uTex, vec2(vUV.x, vUV.y));
  if (uGrid > 0.5) {
    // A graticule every 10 degrees. Straightness of these lines is the whole
    // point of the view: they are great circles in azimuth and small circles in
    // altitude, so they show the projection's behaviour independent of content.
    float az = vUV.x * 360.0;
    float alt = mix(uAltMax, uAltMin, vUV.y);
    float aLine = min(abs(fract(az / 10.0) - 0.5), 0.5) * 2.0;
    float bLine = min(abs(fract(alt / 10.0) - 0.5), 0.5) * 2.0;
    float w = fwidth(az / 10.0) * 2.0;
    if (aLine > 1.0 - w || bLine > 1.0 - w) c = mix(c, vec4(0.18, 0.78, 0.90, 1.0), 0.45);
  }
  gl_FragColor = c;
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

/**
 * Build the sphere.
 *
 * Vertices carry their own equirectangular UV, so the mapping from a direction
 * to a texel is the same arithmetic the renderer used to paint the panorama in
 * the first place — no second opinion about where a pixel belongs. `altMin`
 * and `altMax` come from the stitch report, so a panorama covering -18° to 78°
 * wraps exactly that band onto the sphere and leaves the rest unpainted.
 */
function buildSphere(altMinDeg, altMaxDeg, cols = 128, rows = 64) {
  const pos = [], uv = [], idx = [];
  const D = Math.PI / 180;
  for (let r = 0; r <= rows; r++) {
    // The mesh spans the whole sphere; v runs outside 0..1 where the panorama
    // has nothing, and the fragment shader paints those as empty.
    const alt = 90 - (r / rows) * 180;
    const v = (altMaxDeg - alt) / (altMaxDeg - altMinDeg);
    for (let c = 0; c <= cols; c++) {
      const az = (c / cols) * 360;
      const ca = Math.cos(alt * D);
      pos.push(Math.sin(az * D) * ca, Math.sin(alt * D), Math.cos(az * D) * ca);
      uv.push(c / cols, v);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + cols + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return {
    pos: new Float32Array(pos), uv: new Float32Array(uv),
    idx: new Uint16Array(idx), count: idx.length
  };
}

function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan(fovDeg * Math.PI / 360);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0
  ]);
}

/** Look-direction matrix from azimuth and altitude, in the panorama's frame. */
function viewMatrix(azDeg, altDeg) {
  const D = Math.PI / 180;
  const ca = Math.cos(altDeg * D), sa = Math.sin(altDeg * D);
  const cz = Math.cos(azDeg * D), sz = Math.sin(azDeg * D);
  // Camera looks along +forward; build the inverse of the rotation that takes
  // world to camera, which for a pure rotation is its transpose.
  const fx = sz * ca, fy = sa, fz = cz * ca;
  const rx = cz, ry = 0, rz = -sz;
  // up = forward x right, NOT right x forward. The other order gives (0,-1,0)
  // at azimuth 0 and altitude 0, which flips the sphere vertically — and the
  // symptom is not an upside-down picture but a black one, because the mirrored
  // altitude lands in the unpainted band below the panorama.
  const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;
  return new Float32Array([
    rx, ux, -fx, 0,
    ry, uy, -fy, 0,
    rz, uz, -fz, 0,
    0, 0, 0, 1
  ]);
}

export class DomeView {
  /**
   * `canvas` is drawn into; `report.render` supplies the altitude band so the
   * texture lands on the sphere at the altitudes it was painted at.
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', { antialias: true, alpha: false })
      || canvas.getContext('experimental-webgl');
    if (!this.gl) throw new Error('this browser has no WebGL, so the dome view cannot run');
    this.az = 0; this.alt = 0; this.fov = 75;
    this.altMin = -20; this.altMax = 60;
    this.grid = false;
    this.ready = false;
    this._setup();
    this._bindPointer();
  }

  _setup() {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    // fwidth needs the derivatives extension on WebGL 1; without it the
    // graticule simply draws at a fixed width rather than failing to compile.
    const hasDeriv = !!gl.getExtension('OES_standard_derivatives');
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER,
      (hasDeriv ? '#extension GL_OES_standard_derivatives : enable\n' : '')
      + (hasDeriv ? '' : '#define fwidth(x) 0.004\n') + FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
    }
    this.prog = prog;
    this.loc = {
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aUV: gl.getAttribLocation(prog, 'aUV'),
      uProj: gl.getUniformLocation(prog, 'uProj'),
      uView: gl.getUniformLocation(prog, 'uView'),
      uTex: gl.getUniformLocation(prog, 'uTex'),
      uAltMin: gl.getUniformLocation(prog, 'uAltMin'),
      uAltMax: gl.getUniformLocation(prog, 'uAltMax'),
      uGrid: gl.getUniformLocation(prog, 'uGrid')
    };
    this.tex = gl.createTexture();
    this.buf = { pos: gl.createBuffer(), uv: gl.createBuffer(), idx: gl.createBuffer() };
  }

  /** Upload a panorama and the altitude band it covers. */
  async setPanorama(blob, { altMinDeg = -20, altMaxDeg = 60 } = {}) {
    const gl = this.gl;
    const bitmap = await createImageBitmap(blob);
    this.altMin = altMinDeg; this.altMax = altMaxDeg;

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    // Panoramas are rarely a power of two, so mipmaps and repeat are both off;
    // CLAMP plus LINEAR is the combination WebGL 1 guarantees for NPOT.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (bitmap.close) bitmap.close();

    const mesh = buildSphere(altMinDeg, altMaxDeg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.pos);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.uv);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
    this.count = mesh.count;
    this.ready = true;
    this.draw();
  }

  /* Drag to look around, wheel or pinch to change the field of view. Altitude
   * is clamped short of the poles because yaw stops being meaningful there and
   * a view that can flip upside down is disorienting rather than informative. */
  _bindPointer() {
    const c = this.canvas;
    let dragging = false, lx = 0, ly = 0;
    const down = e => { dragging = true; lx = e.clientX; ly = e.clientY; c.setPointerCapture?.(e.pointerId); };
    const move = e => {
      if (!dragging) return;
      const k = this.fov / c.clientHeight;
      this.az = ((this.az - (e.clientX - lx) * k) % 360 + 360) % 360;
      this.alt = Math.max(-85, Math.min(85, this.alt + (e.clientY - ly) * k));
      lx = e.clientX; ly = e.clientY;
      this.draw();
    };
    const up = e => { dragging = false; c.releasePointerCapture?.(e.pointerId); };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.fov = Math.max(20, Math.min(110, this.fov + Math.sign(e.deltaY) * 4));
      this.draw();
    }, { passive: false });
  }

  lookAt(azDeg, altDeg, fovDeg = null) {
    this.az = ((Number(azDeg) || 0) % 360 + 360) % 360;
    this.alt = Math.max(-85, Math.min(85, Number(altDeg) || 0));
    if (Number.isFinite(fovDeg)) this.fov = Math.max(20, Math.min(110, fovDeg));
    this.draw();
  }

  setGrid(on) { this.grid = !!on; this.draw(); }

  draw() {
    if (!this.ready) return;
    const gl = this.gl, c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }

    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0.024, 0.051, 0.067, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    // The camera sits at the centre looking out, so the sphere is seen from
    // inside and its triangles face away. Cull nothing rather than reversing
    // the winding, which would make the mesh code lie about its own geometry.
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.pos);
    gl.enableVertexAttribArray(this.loc.aPos);
    gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.uv);
    gl.enableVertexAttribArray(this.loc.aUV);
    gl.vertexAttribPointer(this.loc.aUV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);

    gl.uniformMatrix4fv(this.loc.uProj, false,
      perspective(this.fov, c.width / c.height, 0.01, 10));
    gl.uniformMatrix4fv(this.loc.uView, false, viewMatrix(this.az, this.alt));
    gl.uniform1f(this.loc.uAltMin, this.altMin);
    gl.uniform1f(this.loc.uAltMax, this.altMax);
    gl.uniform1f(this.loc.uGrid, this.grid ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.loc.uTex, 0);

    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteTexture(this.tex);
    gl.deleteBuffer(this.buf.pos); gl.deleteBuffer(this.buf.uv); gl.deleteBuffer(this.buf.idx);
    gl.deleteProgram(this.prog);
    this.ready = false;
  }
}

/** Can this device show it at all? */
export function domeAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch { return false; }
}
