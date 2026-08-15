'use strict';
/* Sky segmentation worker (classic multi-cue, no network dependency).
 *
 * Input : RGBA ImageData at full working resolution (default 384x288).
 * Coarse: score + Otsu + top-connected flood fill at half resolution.
 * Path  : dynamic-programming minimum-cost path across all columns at full
 *         resolution (edge evidence + sky-above/ground-below region evidence,
 *         with a capped per-column transition cost). Continuity is a PRIOR
 *         here: a cloud edge or a wire above the true skyline cannot capture
 *         isolated columns, while a genuine vertical wall edge survives
 *         because a single large jump costs no more than the cap.
 * Refine: subpixel vertical-gradient peak around the DP path.
 * Output: per-column boundary, per-column confidence, and an INDEPENDENT
 *         gradient-only boundary estimate so the caller can cross-check the
 *         two methods instead of trusting one.
 */

let W = 0, H = 0;          // full working resolution
let hw = 0, hh = 0;        // half resolution
let lum, blueness, texture, score, mask, visited, queue;
let colMask, colEdge, colRefined, colConf, colFlag;
let gradV, regionCost, dpPrev, dpCur, dpParent, fwdVal, bwdVal, fwdSrc, bwdSrc, dpPath;

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
  gradV = new Float32Array(W * H);
  regionCost = new Float32Array(hw * (hh + 1));
  dpPrev = new Float32Array(H);
  dpCur = new Float32Array(H);
  dpParent = new Int16Array(W * H);
  fwdVal = new Float32Array(H);
  bwdVal = new Float32Array(H);
  fwdSrc = new Int16Array(H);
  bwdSrc = new Int16Array(H);
  dpPath = new Int16Array(W);
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
      // A dense white cloud is sky, and it used to collect only the blueness
      // FLOOR while the blue beside it collected full marks — so cloud and sky
      // ended up nearly as far apart in this score as sky and ground are. With
      // one threshold to give, that invites the split to land between cloud and
      // sky rather than between sky and ground, which puts the traced horizon
      // on a cloud's underside. Whiteness is therefore counted as sky colour in
      // its own right: bright and unsaturated. Foliage, brick and roofing are
      // none of those things, so nothing on the ground gains from it.
      const nt = Math.min(1, texture[i] * 3.2);
      // ...but ONLY where the region is also smooth. Without that condition
      // this term is a menace: a pale roof and a painted wall are bright and
      // unsaturated too, so a house started scoring as sky and the traced line
      // fell to the BOTTOM of it — 84 px off the ridge in the case below,
      // which is what wrecked the 2026-08-15 survey around the operator's
      // house while the trees stayed fine. Shingles, siding lines and window
      // frames all carry texture; the inside of a cumulus does not. Smoothness
      // is the one axis on which cloud and masonry genuinely differ.
      const nw = Math.max(0, (nl - 0.62) / 0.3)
        * (1 - Math.min(1, Math.abs(blueness[i]) * 4))
        * Math.max(0, 1 - nt * 2.4);
      const nc = Math.max(nb, Math.min(1, nw));
      // Brightness SATURATES once a region is as bright as sky. Being brighter
      // still is not being more sky: a sunlit pale wall out-reads the sky it
      // stands against — 211 against 161 in the case below — and with
      // brightness carrying 0.42 of the score the whole house cleared the
      // threshold and the traced line fell out of the bottom of it. Texture
      // carries the extra weight instead, because smoothness is the one
      // property cloud has and shingles, siding and window frames do not.
      score[i] = 0.26 * Math.min(1, nl / 0.75) + 0.28 * nc + 0.38 * (1 - nt) + 0.08 * (1 - y / hh);
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

  // Full-resolution vertical gradient, and the frame-wide scale that turns it
  // into 0..1 edge evidence for the path cost below.
  let gSumAll = 0, gSum2All = 0, gNAll = 0;
  for (let x = 0; x < W; x++) {
    for (let y = 1; y < H - 1; y++) {
      const g = Math.abs(lum[(y + 1) * W + x] - lum[(y - 1) * W + x]);
      gradV[y * W + x] = g;
      gSumAll += g; gSum2All += g * g; gNAll++;
    }
  }
  const gMeanAll = gSumAll / Math.max(1, gNAll);
  const gSdAll = Math.sqrt(Math.max(0, gSum2All / Math.max(1, gNAll) - gMeanAll * gMeanAll));
  const gRef = Math.max(4, gMeanAll + 2.0 * gSdAll);

  // Independent estimator: STRONGEST vertical gradient per column. The old
  // topmost-above-threshold rule fired on any cloud edge, branch or wire above
  // the true horizon, which drove the cross-check agreement (and with it every
  // column's confidence) to zero on partly cloudy days.
  for (let x = 0; x < W; x++) {
    let bestY = H - 1, bestG = -1;
    for (let y = 2; y < H - 2; y++) {
      const g = gradV[y * W + x];
      if (g > bestG) { bestG = g; bestY = y; }
    }
    colEdge[x] = bestY;
  }

  // Region evidence per half-res column: how well "sky above row, ground below
  // row" fits the score field. Prefix sums make each candidate row O(1).
  for (let hx = 0; hx < hw; hx++) {
    const base = hx * (hh + 1);
    let run = 0;
    regionCost[base] = 0;
    for (let hy = 0; hy < hh; hy++) {
      run += score[hy * hw + hx] - thr;
      regionCost[base + hy + 1] = run;
    }
    const total = run;
    let mMin = Infinity, mMax = -Infinity;
    for (let hy = 0; hy <= hh; hy++) {
      const m = 2 * regionCost[base + hy] - total;   // sky-above minus sky-below
      regionCost[base + hy] = m;
      if (m < mMin) mMin = m;
      if (m > mMax) mMax = m;
    }
    const span = Math.max(1e-6, mMax - mMin);
    for (let hy = 0; hy <= hh; hy++) {
      regionCost[base + hy] = 1 - (regionCost[base + hy] - mMin) / span;  // 0 best, 1 worst
    }
  }

  /* Dynamic-programming skyline: minimum-cost path visiting one row per
   * column. Unary cost favours strong edges with sky above and ground below.
   * The transition cost is linear in the jump but CAPPED, which is the spike
   * versus step distinction expressed as geometry: a wall edge pays the cap
   * once and follows the wall, while a one-column excursion to a cloud pays
   * the cap twice and loses to the continuous path.  O(W*H) via the standard
   * forward/backward min-convolution for capped-linear costs. */
  const LAMBDA = 0.02;   // cost per pixel of vertical movement between columns
  const CAP = 1.0;       // maximum transition cost — the price of one real step
  const W_EDGE = 0.45, W_REGION = 0.55;

  const unary = (x, y) => {
    const e = y >= 1 && y <= H - 2 ? Math.min(1, gradV[y * W + x] / gRef) : 0;
    const hx = Math.min(hw - 1, x >> 1);
    const hy = Math.min(hh, y >> 1);
    return W_EDGE * (1 - e) + W_REGION * regionCost[hx * (hh + 1) + hy];
  };

  for (let y = 0; y < H; y++) dpPrev[y] = unary(0, y);
  for (let x = 1; x < W; x++) {
    // Forward sweep: best predecessor at or above each row, linear cost.
    let v = Infinity, src = 0;
    for (let y = 0; y < H; y++) {
      v += LAMBDA;
      if (dpPrev[y] < v) { v = dpPrev[y]; src = y; }
      fwdVal[y] = v; fwdSrc[y] = src;
    }
    // Backward sweep: best predecessor at or below.
    v = Infinity; src = H - 1;
    for (let y = H - 1; y >= 0; y--) {
      v += LAMBDA;
      if (dpPrev[y] < v) { v = dpPrev[y]; src = y; }
      bwdVal[y] = v; bwdSrc[y] = src;
    }
    // Global minimum: the capped "step anywhere" transition.
    let gMin = Infinity, gArg = 0;
    for (let y = 0; y < H; y++) if (dpPrev[y] < gMin) { gMin = dpPrev[y]; gArg = y; }
    const stepped = gMin + CAP;

    const pBase = x * H;
    for (let y = 0; y < H; y++) {
      let best = fwdVal[y], bestSrc = fwdSrc[y];
      if (bwdVal[y] < best) { best = bwdVal[y]; bestSrc = bwdSrc[y]; }
      if (stepped < best) { best = stepped; bestSrc = gArg; }
      dpCur[y] = best + unary(x, y);
      dpParent[pBase + y] = bestSrc;
    }
    dpPrev.set(dpCur);
  }
  let endY = 0, endV = Infinity;
  for (let y = 0; y < H; y++) if (dpPrev[y] < endV) { endV = dpPrev[y]; endY = y; }
  dpPath[W - 1] = endY;
  for (let x = W - 1; x > 0; x--) dpPath[x - 1] = dpParent[x * H + dpPath[x]];

  // Subpixel refinement around the DP path, plus per-column confidence. The
  // coarse flood-fill boundary keeps its job of flagging columns where the
  // obstruction runs off the top of the frame or no obstruction is visible —
  // the path is forced to SOME row there, but the row means nothing.
  const SEARCH = 4;
  for (let x = 0; x < W; x++) {
    const c = colMask[x];
    colFlag[x] = 0;
    if (c <= 1) { colFlag[x] = 1; colRefined[x] = 0; colConf[x] = 0; continue; }        // obstruction runs off the top
    if (c >= H - 2) { colFlag[x] = 2; colRefined[x] = H - 1; colConf[x] = 0; continue; } // no obstruction in frame

    const p = dpPath[x];
    let bestY = Math.max(2, Math.min(H - 3, p)), bestG = -1, gSum = 0, gN = 0;
    const y0 = Math.max(2, p - SEARCH), y1 = Math.min(H - 3, p + SEARCH);
    for (let y = y0; y <= y1; y++) {
      const g = gradV[y * W + x];
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
    const cContrast = Math.min(1, bestG / Math.max(4, gMean * 1.5));
    const cAgree = Math.exp(-Math.abs(colRefined[x] - colEdge[x]) / 8);
    // Score margin across the boundary, sampled on the coarse grid.
    const hx = Math.min(hw - 1, x >> 1);
    const above = Math.max(0, (bestY >> 1) - 3), below = Math.min(hh - 1, (bestY >> 1) + 3);
    const cMargin = Math.min(1, Math.max(0, score[above * hw + hx] - score[below * hw + hx]) * 3);
    colConf[x] = Math.max(0, Math.min(1, 0.40 * cContrast + 0.35 * cAgree + 0.25 * cMargin));
  }

  return {
    boundary: Float32Array.from(colRefined),
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
