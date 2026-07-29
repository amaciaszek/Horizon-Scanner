'use strict';
/* Sky segmentation worker (classic multi-cue, no network dependency).
 *
 * Input : RGBA ImageData at full working resolution (default 384x288).
 * Coarse: score + Otsu + top-connected flood fill at half resolution.
 * Refine: subpixel vertical-gradient peak at full resolution.
 * Output: per-column boundary, per-column confidence, and an INDEPENDENT
 *         gradient-only boundary estimate so the caller can cross-check the
 *         two methods instead of trusting one.
 */

let W = 0, H = 0;          // full working resolution
let hw = 0, hh = 0;        // half resolution
let lum, blueness, texture, score, mask, visited, queue;
let colMask, colEdge, colRefined, colConf, colFlag;

function alloc(w, h) {
  W = w; H = h; hw = w >> 1; hh = h >> 1;
  lum = new Float32Array(W * H);
  blueness = new Float32Array(hw * hh);
  texture = new Float32Array(hw * hh);
  score = new Float32Array(hw * hh);
  mask = new Uint8Array(hw * hh);
  visited = new Uint8Array(hw * hh);
  queue = new Int32Array(hw * hh);
  colMask = new Float32Array(W);
  colEdge = new Float32Array(W);
  colRefined = new Float32Array(W);
  colConf = new Float32Array(W);
  colFlag = new Uint8Array(W);
}

function otsu(values, lo, hi) {
  const BINS = 64;
  const hist = new Float64Array(BINS);
  const span = hi - lo || 1;
  for (let i = 0; i < values.length; i++) {
    let b = Math.floor((values[i] - lo) / span * BINS);
    if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
    hist[b]++;
  }
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < BINS; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, thr = BINS / 2;
  for (let i = 0; i < BINS; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = i; }
  }
  return lo + (thr + 0.5) / BINS * span;
}

function analyse(data, width, height) {
  if (width !== W || height !== H) alloc(width, height);

  // Full-resolution luminance.
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  // Half-resolution cues.
  let lumMin = 1e9, lumMax = -1e9;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const p = ((y * 2) * W + x * 2) * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const i = y * hw + x;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (l < lumMin) lumMin = l;
      if (l > lumMax) lumMax = l;
      blueness[i] = (b - r) / (b + r + 8);
      score[i] = l; // temporarily hold luminance
      void g;
    }
  }
  const lumSpan = Math.max(1, lumMax - lumMin);

  // Texture energy: Sobel magnitude on the half-res luminance, box blurred.
  const grad = new Float32Array(hw * hh);
  let gMax = 1e-6;
  for (let y = 1; y < hh - 1; y++) {
    for (let x = 1; x < hw - 1; x++) {
      const i = y * hw + x;
      const gx = score[i - hw + 1] + 2 * score[i + 1] + score[i + hw + 1]
               - score[i - hw - 1] - 2 * score[i - 1] - score[i + hw - 1];
      const gy = score[i + hw - 1] + 2 * score[i + hw] + score[i + hw + 1]
               - score[i - hw - 1] - 2 * score[i - hw] - score[i - hw + 1];
      const m = Math.hypot(gx, gy);
      grad[i] = m;
      if (m > gMax) gMax = m;
    }
  }
  for (let y = 1; y < hh - 1; y++) {
    for (let x = 1; x < hw - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += grad[(y + dy) * hw + x + dx];
      texture[y * hw + x] = s / 9 / gMax;
    }
  }

  // Sky likelihood. Overcast sky scores through brightness + smoothness;
  // blue sky adds the chroma term; the height prior is deliberately weak so a
  // high obstruction is not penalised out of existence.
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const i = y * hw + x;
      const nl = (score[i] - lumMin) / lumSpan;
      const nb = Math.max(0, Math.min(1, blueness[i] * 2.2 + 0.28));
      const nt = Math.min(1, texture[i] * 3.2);
      score[i] = 0.42 * nl + 0.26 * nb + 0.24 * (1 - nt) + 0.08 * (1 - y / hh);
    }
  }

  let thr = otsu(score, 0, 1);
  thr = Math.max(0.36, Math.min(0.76, thr));
  for (let i = 0; i < hw * hh; i++) mask[i] = score[i] >= thr ? 1 : 0;

  // 3x3 median to kill speckle.
  const tmp = new Uint8Array(hw * hh);
  tmp.set(mask);
  for (let y = 1; y < hh - 1; y++) {
    for (let x = 1; x < hw - 1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += tmp[(y + dy) * hw + x + dx];
      mask[y * hw + x] = n >= 5 ? 1 : 0;
    }
  }

  // Keep only the sky component connected to the top of the frame. This is the
  // rule that stops a sunlit wall or a bright roof from being called sky.
  visited.fill(0);
  let qh = 0, qt = 0;
  for (let x = 0; x < hw; x++) {
    for (let y = 0; y < 2; y++) {
      const i = y * hw + x;
      if (mask[i] && !visited[i]) { visited[i] = 1; queue[qt++] = i; }
    }
  }
  let skyCount = 0;
  while (qh < qt) {
    const i = queue[qh++]; skyCount++;
    const x = i % hw, y = (i / hw) | 0;
    if (x > 0 && mask[i - 1] && !visited[i - 1]) { visited[i - 1] = 1; queue[qt++] = i - 1; }
    if (x < hw - 1 && mask[i + 1] && !visited[i + 1]) { visited[i + 1] = 1; queue[qt++] = i + 1; }
    if (y > 0 && mask[i - hw] && !visited[i - hw]) { visited[i - hw] = 1; queue[qt++] = i - hw; }
    if (y < hh - 1 && mask[i + hw] && !visited[i + hw]) { visited[i + hw] = 1; queue[qt++] = i + hw; }
  }
  const skyFraction = skyCount / (hw * hh);

  // Coarse per-column boundary: first row from the top that leaves the sky
  // component and stays out for two consecutive rows.
  for (let x = 0; x < hw; x++) {
    let b = hh;
    for (let y = 0; y < hh - 1; y++) {
      if (!visited[y * hw + x] && !visited[(y + 1) * hw + x]) { b = y; break; }
    }
    const xa = x * 2, xb = Math.min(W - 1, x * 2 + 1);
    colMask[xa] = b * 2;
    colMask[xb] = b * 2;
  }

  // Independent estimator: topmost strong vertical gradient per column at full
  // resolution. Deliberately shares no state with the mask above.
  for (let x = 0; x < W; x++) {
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 2; y < H - 2; y++) {
      const g = Math.abs(lum[(y + 1) * W + x] - lum[(y - 1) * W + x]);
      sum += g; sum2 += g * g; n++;
    }
    const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const cut = mean + 2.0 * sd;
    let found = H - 1;
    for (let y = 2; y < H - 2; y++) {
      const g = Math.abs(lum[(y + 1) * W + x] - lum[(y - 1) * W + x]);
      if (g > cut) { found = y; break; }
    }
    colEdge[x] = found;
  }

  // Full-resolution subpixel refinement around the coarse boundary.
  const SEARCH = 10;
  for (let x = 0; x < W; x++) {
    const c = colMask[x];
    colFlag[x] = 0;
    if (c <= 1) { colFlag[x] = 1; colRefined[x] = 0; colConf[x] = 0; continue; }        // obstruction runs off the top
    if (c >= H - 2) { colFlag[x] = 2; colRefined[x] = H - 1; colConf[x] = 0; continue; } // no obstruction in frame

    let bestY = c, bestG = -1, gSum = 0, gN = 0;
    const y0 = Math.max(2, c - SEARCH), y1 = Math.min(H - 3, c + SEARCH);
    for (let y = y0; y <= y1; y++) {
      const g = Math.abs(lum[(y + 1) * W + x] - lum[(y - 1) * W + x]);
      gSum += g; gN++;
      if (g > bestG) { bestG = g; bestY = y; }
    }
    // Parabolic subpixel fit on the gradient peak.
    const gm = Math.abs(lum[(bestY) * W + x] - lum[(bestY - 2) * W + x]);
    const gp = Math.abs(lum[(bestY + 2) * W + x] - lum[(bestY) * W + x]);
    const denom = (gm - 2 * bestG + gp);
    const sub = Math.abs(denom) > 1e-6 ? 0.5 * (gm - gp) / denom : 0;
    colRefined[x] = bestY + Math.max(-1, Math.min(1, sub));

    const gMean = gN ? gSum / gN : 1;
    const cContrast = Math.min(1, bestG / Math.max(4, gMean * 3.5));
    const cAgree = Math.exp(-Math.abs(colMask[x] - colEdge[x]) / 8);
    // Score margin across the boundary, sampled on the coarse grid.
    const hx = Math.min(hw - 1, x >> 1);
    const above = Math.max(0, (colMask[x] >> 1) - 3), below = Math.min(hh - 1, (colMask[x] >> 1) + 3);
    const cMargin = Math.min(1, Math.max(0, score[above * hw + hx] - score[below * hw + hx]) * 3);
    colConf[x] = Math.max(0, Math.min(1, 0.40 * cContrast + 0.35 * cAgree + 0.25 * cMargin));
  }

  // Local smoothness veto: a column that disagrees wildly with its neighbours
  // is almost always a mis-segmentation, not a real spike.
  const smoothed = Float32Array.from(colRefined);
  for (let x = 3; x < W - 3; x++) {
    const win = [colRefined[x - 3], colRefined[x - 2], colRefined[x - 1], colRefined[x], colRefined[x + 1], colRefined[x + 2], colRefined[x + 3]].sort((a, b) => a - b);
    const med = win[3];
    if (Math.abs(colRefined[x] - med) > H * 0.08) {
      colConf[x] *= 0.25;
      smoothed[x] = med;
    }
  }

  return {
    boundary: smoothed,
    confidence: colConf,
    edgeOnly: colEdge,
    maskOnly: colMask,
    flags: colFlag,
    skyFraction,
    threshold: thr,
    noSky: skyFraction < 0.02,
    allSky: skyFraction > 0.985
  };
}

self.onmessage = (e) => {
  const { id, width, height, buffer } = e.data;
  const data = new Uint8ClampedArray(buffer);
  let out;
  try {
    out = analyse(data, width, height);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
    return;
  }
  const boundary = Float32Array.from(out.boundary);
  const confidence = Float32Array.from(out.confidence);
  const edgeOnly = Float32Array.from(out.edgeOnly);
  const flags = Uint8Array.from(out.flags);
  self.postMessage({
    id,
    width, height,
    boundary, confidence, edgeOnly, flags,
    skyFraction: out.skyFraction,
    threshold: out.threshold,
    noSky: out.noSky,
    allSky: out.allSky
  }, [boundary.buffer, confidence.buffer, edgeOnly.buffer, flags.buffer]);
};
