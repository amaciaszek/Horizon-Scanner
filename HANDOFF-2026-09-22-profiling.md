# Horizon Scanner — v0.27.0: the build says where its time went

The 2026-09-21 iPad capture — 380 photographs, 2307-second build — is the first
run whose archive records what the build actually did. The answer is not where
anyone had been looking.

---

## 81% of a build is rendering

```
Choosing seams                          976.9 s   42%
Panorama painted                        895.4 s   39%
Matching overlapping photos             236.9 s   10%
Discarding bad matches, solving again    66.8 s    3%
Finding features                         62.8 s    3%
Solving every camera angle               54.0 s    2%
```

The only prior estimate in the codebase — `STAGE_WEIGHT` in
`js/build-progress.js` — assumed features and matching were 70% of the work and
rendering was **6%**. It is out by more than an order of magnitude in the one
place that matters, and it would have driven a progress bar that sat at 94% for
twenty-five minutes. Replaced with the measurement.

Weeks of guessing preceded this. Two of those guesses were wrong and are worth
recording so nobody spends the time again: the photographs are the same 640x480
on both devices, and a controlled test showed SIFT feature counts comparable on
comparable frames with the contrast threshold worth under 2% of matched inliers.

## What is in the archive now

`metadata/build-profile.json`, written whenever a panorama has been built in the
session:

- **stages**, worst-first, in seconds and as a percentage, plus the order they
  first appeared. `slowestStage` and `slowestStagePercent` are called out so a
  reader does not have to sum a table.
- **memory**, sampled every two seconds and tagged with the stage it happened
  in: peak, start and end heap. `available: false` on Safari and every
  non-Chromium browser, where `performance.memory` does not exist — absence is
  recorded as absence, never as a heap of zero.
- **environment**: core count, memory class, JS heap limit, screen, DPR, and
  `crossOriginIsolated` / `sharedArrayBuffer` / `wasmThreadsPossible`.

The stage labels come from the solver's own progress messages, so a label that
reads as a completion notice — "Panorama painted" — collects the time *after*
that message until the next one arrives. Read them as intervals between
announcements, not as named functions.

## Can it be parallelised? Not with threads, as served

`wasmThreadsPossible` is **false**, and it is false for a reason no amount of
code will change: `SharedArrayBuffer`, and therefore every threaded WebAssembly
build including OpenCV's, is gated behind cross-origin isolation. That needs the
server to send

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Nothing in this repo sends them and a static host generally will not. Until that
changes, "use more cores" is not available to the stitcher at all, whatever the
device reports for `hardwareConcurrency` — the iPad reported plenty and used
one.

Two routes remain, and they are very different in risk:

**Eliminate the work.** There is a concrete, large one in
`render_equirect` (`tools/stitch_lab.py`). Inside the per-frame painting loop:

```python
seam = cv2.resize(seam_masks[n], (width, height), interpolation=cv2.INTER_LINEAR)
seam_w = seam[sub].astype(np.float64) / 255.0
```

Each frame's seam mask is enlarged to the **full panorama** — 3240 x 891 on this
capture — and then immediately sliced down to the small region that frame
actually reaches. A frame covers roughly 38 x 28 of the 360 x 99 seam panel, so
almost all of that interpolation is computed and discarded, 357 times: on the
order of a billion pixel operations per build, in the stage that costs 895 s.

The fix is to resize only the region needed. It is NOT a one-line change:
`sub` is `(slice(row0, row1), cols)` where `cols` is `arange(...) % width` and
wraps around the panorama seam, and cropping before resizing is not
pixel-identical to cropping after unless the crop carries a margin wide enough
for the interpolation kernel. So it wants its own pass with a native
before/after on a real archive proving the output is unchanged. **Not attempted
here**: the current render is the one the operator called amazing, and trading
that for an unverified speed-up is the wrong bargain.

**Split the panel across workers.** Output pixels are independent, so several
workers could each paint a slice. But each worker needs its own Pyodide
instance and its own copy of the images — on a phone that is likely to cost more
in memory than it saves in time. The new `memory.peakHeapMb` figure is exactly
what decides whether this is viable, and there is now one run's worth of it.

## What to look at next

1. Run a capture on the Pixel and compare `metadata/build-profile.json` against
   the iPad's. The question "why is Android 10-15x slower" is now a subtraction
   rather than an argument: same stages, same device fields, two numbers each.
2. If rendering dominates on both, the seam-mask crop above is the single
   biggest measured win available and does not need threads.
3. If Android's *peak heap* is close to its limit while the iPad's is not, the
   gap is memory pressure and the worker-splitting idea is dead on arrival.
