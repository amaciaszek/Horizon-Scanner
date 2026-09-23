# Horizon Scanner — how it works, at v0.29.0 (2026-09-23)

Written to start a fresh conversation from. Everything here is measured from
real captures, not remembered; every number names the capture it came from.

Read this first, then `HANDOFF.md` for the long-form architecture. The dated
`HANDOFF-*.md` files are a chronological record of individual field sessions and
are useful mainly for the reasoning behind a specific constant.

---

## 1. What the thing is

A static, browser-only field app. The operator stands where a telescope will go,
turns slowly through a full circle holding a phone or tablet, and the app
produces two products from the same photographs:

1. **A 720-bin horizon profile** — one skyline altitude every 0.5° of azimuth,
   for OnStep telescope limits.
2. **An azimuth/altitude-aware panorama**, built by a real bundle adjustment.

No server. No upload. Everything runs in the page, including the stitcher, which
is Python (`tools/stitch_lab.py`) executed under Pyodide in a Web Worker. The
same file runs on the desktop for debugging, over the same debug ZIP, so a
disagreement between app and desktop is a runtime bug and never a pipeline
difference.

## 2. The capture loop, in one paragraph

`js/main.js` drives a per-frame pipeline at ~10 Hz. Each frame is segmented for
a skyline, scored, and offered to two independent maps: **`js/coverage.js`** (the
horizon ring — has this bearing been looked at enough?) and
**`js/column-plan.js`** (the vertical half — has this bearing been looked at at
every needed HEIGHT?). **`js/guidance.js`** turns those two maps into one white
dot, which is the entire user interface for "where to point next".
**`js/capture-policy.js`** decides whether the current frame becomes a
photograph. `js/guide.js` turns the same state into words.

The dot is the product. If the dot is wrong, everything downstream is wrong,
because the operator follows it.

## 3. Facts that are load-bearing — do not re-derive these

Each of these cost a field session to learn. They are also written as comments
beside the code they justify; that is the house style and new work should match
it (see `memory/horizon-scanner-comment-style.md`).

**The dot must lead, never mirror.** For a while it took the operator's own
bearing as its target, so it could only shadow the phone. Measured on the
2026-08-25 20:03 capture: the dot sat within 2° of the operator's own pose for
**80%** of the session. It now holds a *column index* it picks and keeps.

**The dot must travel, never teleport.** `gapBand` once returned the far end of
a column, so from the top of the house it sent the operator straight to the
horizon and back — 18 jumps over 20° in one survey, several of the full 59.5°.
It now asks for the nearest unfilled band *in the direction of travel*, and the
drawn dot is slew-limited (45°/s horizontal, 30°/s vertical). Worst single move
went 35.8° → 9.2°.

**A look is not a glimpse.** `ColumnPlan.observe` credits every bearing a wide
photograph can see, and the independent-look counter used to tick for the
outermost edge of the fan as hard as for the middle. Result on 2026-09-03:
**83 of 180 columns marked complete with zero photographs aimed at them.** A
frame must now land within `centreWeight` (0.6) of full weight to count.

**The lens is the whole ballgame.** Everything is computed from the field of
view: keyframe spacing, band heights, and — fatally — the stitcher's guided
feature search, which predicts where a feature should land and searches a small
radius around it. On 2026-08-25 the Pixel ran a whole survey at the hardcoded
66° default against a true ~42°, and guided matching kept **42 pairs where
brute force found 684**. 3 of 68 frames placed; the panorama was mostly black.
`js/lens-store.js` now learns each device's lens from its own bundle adjustment
and remembers it; `KNOWN_LENSES` in `js/camera.js` seeds the two known devices.

**The vertical half of a lens measurement must earn its place.** The guided
calibration measures sideways against the gyroscope and up-and-down against
gravity; on a square-pixel sensor both must agree. When they disagreed the app
said so in the log and then used the disagreeing vertical anyway, recording a
vertical field 16% too tall. A contradicted vertical is now discarded and
derived from the horizontal.

**A backgrounded build does not run.** Chrome on Android suspends a hidden tab:
timers clamp, workers freeze, the page can be discarded. On 2026-09-22 the Pixel
handed 330 photographs to the stitcher and logged **nothing for fifty-one
minutes**, then "the database connection is closing". The build did not run
slowly; it stopped. A screen wake lock is now held and interruptions are
recorded in the profile.

**Rendering is four fifths of a build.** Not features, not matching. Measured
2026-09-21, 380 photographs, 2307 s: choosing seams 42%, painting 39%. The only
prior estimate in the codebase said rendering was 6%.

**Denser capture does not cause ghosting.** Tested controlled on identical data
(2026-08-25): 152 frames vs the same capture thinned to 125 gave disagreement
34.9 vs 36.0 — denser is very slightly *better*, with identical painted and
double-covered fractions. Ghosting is misplaced frames, not crowded ones.

## 4. The stitcher, and the 5.7× that just landed

`tools/stitch_lab.py` — features (SIFT) → guided matching → bundle adjustment →
prune and re-solve → seam finding → painting.

Two pieces of pure waste were removed on 2026-09-23:

- `find_seam_masks` warped every frame across the **entire panel** and handed
  OpenCV `corners = [(0,0)] * len(images)`, telling `detail_DpSeamFinder` that
  all 340 images overlap completely — 57,630 pairs instead of the ~5,000 that
  really do, on tiles that were mostly black padding. Each frame now carries a
  real ROI and corner. Frames that wrap the panorama seam keep full width (58 of
  340 on the reference capture) because a wrapped run is not a rectangle.
- The painting loop enlarged each seam mask to the full 3240×891 panorama and
  then kept about a fortieth of it, once per frame.

Measured end to end, same archive, same flags, same machine:

| | baseline | optimised |
|---|---|---|
| elapsed | **4564.0 s** | **801.9 s** |
| overlap disagreement | 19.0 mean / 49.2 p95 | **14.9 / 45.1** |
| painted | 79.3%, 57.8% seen by 2+ | 79.5%, 59.3% |
| graph | 41 components, largest 300/340 | *identical* |
| frames moved from sensors | median 2.88°, max 10.05° | *identical* |

The identical graph and pose deltas are the proof that only rendering changed.
The picture got slightly *better* because the exposure compensator had been
fitting gains against black padding.

**Caveat that matters:** desktop OpenCV is multi-threaded, Pyodide's is not, so
the absolute 802 s will not transfer to a phone. The work removed is algorithmic,
so the ratio should hold — but that is a prediction, not a measurement, until a
device reports it.

## 5. The progress bar

`js/pyodide-stitch.js` owns it. `stitch_lab.py` emits
`@@PROGRESS|stage|done|total` per frame and per candidate pair; the client maps
those onto **measured** stage shares (seams 0.36, painting 0.39, matching 0.11,
summing to 1.00) and computes two ETAs from the rate the device is actually
achieving. The UI shows an overall bar with a three-decimal percentage, a second
bar for the current stage, and both estimates.

Three decimals is not decoration: at 340 frames one painted frame is 0.115% of
the build, so that is the resolution at which every unit of real work is visible.
The old bar reached 90% and sat motionless for twenty-five minutes because its
weights gave all of rendering the span 0.90–0.98.

## 6. How to work on this

**Always open the archive before proposing anything.** The user runs real
captures and hands over a debug ZIP. Inside:

| file | what it answers |
|---|---|
| `logs/field-log.txt` | the narrative — lens, calibration, warnings, build result |
| `metadata/scan-coverage.json` → `trail` | per-sample guidance state; the dot's own diary |
| `metadata/column-plan.json` | per-column band requirements and what filled |
| `metadata/capture-audit.json` | why frames were refused, with counts |
| `metadata/build-profile.json` | stage timings, memory, device, interruptions |
| `logs/stitch-log.txt` | the solver's own account, graph before and after pruning |

Tools:

```bash
# Replay a capture's recorded poses through the current dot logic.
node tools/replay-guidance.mjs <capture>/metadata/scan-coverage.json

# Rebuild the import map. REQUIRED after any VERSION change.
node tools/build-importmap.mjs

# Stitch an archive on the desktop, same code the app runs.
.venv-stitch/Scripts/python.exe tools/stitch_lab.py <capture>.zip --out <dir> \
  --detector sift --max-features 1500 --search-px 112 --max-degree 32 \
  --px-per-deg 9 --blend seam

# Decisive test when a build goes wrong: if brute force finds many times more
# pairs than the app did, the intrinsics are wrong and nothing else is.
.venv-stitch/Scripts/python.exe tools/stitch_lab.py <capture>.zip --brute --no-render
```

Tests — 36 Node suites plus one Python:

```bash
for f in tests/*.test.mjs; do node "$f" || echo "FAILED $f"; done
for t in verify verify2 sim sim2 sim3 sim4 sim5 timing; do node tests/$t.mjs; done
.venv-stitch/Scripts/python.exe tests/seam-window.test.py
```

**A green suite does not mean the app starts.** No test loads `main.js` — it
needs a DOM, a camera and motion sensors. A `camera.lensStore = …` placed above
the `const camera` that declares it killed the entire module graph while all 35
suites passed. Load the page and read the header before believing anything.

## 7. Open, in rough priority order

1. **Confirm the 5.7× on a device.** Build once on the iPad and once on the
   Pixel *without switching apps*, and compare the two `build-profile.json`
   files. That settles both the speed-up and the long-running "Android is 10–15×
   slower" question, which is now suspected to have been mostly tab suspension.
2. **`prune_outliers` shatters graphs that had matched.** Reproduced on three
   independent captures: the pre-prune graph is one component containing every
   frame, and pruning splits it into dozens with frames isolated. This is the
   biggest remaining cause of holes in an otherwise good panorama.
3. **Weakly-constrained frames are placed confidently.** Measured datum-free on
   2026-08-25: median neighbour-geometry distortion 2.89°, frame 82 at
   **28.87°** — a tenfold outlier that the solver kept and painted. That is a
   ghost house across the sky. Refuse to paint a frame whose solved geometry
   disagrees with its sensors by an order of magnitude more than the median.
4. **The Pixel's guided lens measurement is still broken.** It reported
   `hfov 36.33, vfov 41.18`; the working frame is 4:3, so the horizontal must
   exceed the vertical. Ruled out: frame rotation, working-frame scale, crop.
   It collects *more* samples than the iPad and still never converges, so it is
   a systematic vertical bias. Non-fatal now that the lens store exists, but a
   brand-new device still depends on it on its first run.
5. **True parallelism needs COOP/COEP.** `wasmThreadsPossible` is false and no
   code change alters that; `SharedArrayBuffer` is gated behind cross-origin
   isolation, which a static host generally will not provide. The remaining
   option is splitting the render across multiple Pyodide workers, each needing
   its own runtime and image copy — gate that decision on the `peakHeapMb` now
   recorded in `build-profile.json`.
6. **`k1` is imposed at −0.10, not solved**, and is degenerate with focal
   length. The post-prune focal has swung 16% between solves on the same data.

## 8. State right now

- **v0.29.0 (2026-09-23).** Header must read that; if the stale banner appears,
  `node tools/build-importmap.mjs` was not run after the bump.
- All 36 Node suites, 8 sims and the Python seam-window test pass.
- Working tree: `js/version.js` and `tools/stitch_lab.py` carry uncommitted
  edits — the release note and the recorded 4564→802 measurement. Everything
  else is committed.
- `js/build-progress.js` exists, has corrected weights, and **is imported by
  nothing**. `js/build-profile.js` is what actually records builds.
