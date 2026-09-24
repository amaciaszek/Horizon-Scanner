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

1. **Match during the walk, not after it.** The biggest change available, and
   the numbers are in. The capture takes ~400 s during which the CPU segments
   frames at 10 Hz and does nothing else; matching is the largest remaining
   stage. Measured on the 2026-09-23 capture: **92.7% of verified pairs are
   between frames taken within 60 s of each other**, so almost the whole graph
   can be built incrementally, and ORB descriptors for a 384-frame walk are only
   **11.1 MB** held live. Post-GEMM matching costs 123 ms per keyframe
   single-threaded on the desktop, against a 1040 ms keyframe interval. See §8.
2. **`prune_outliers` shatters graphs that had matched.** Reproduced again on
   2026-09-23, and now characterised: it survives every variable. Pre-prune the
   graph is whole (1-2 components); post-prune it is in 20-63 pieces, at the
   stated lens and the corrected one, with `k1` on and off, and with the focal
   held in the first solve. It drops a pair when fewer than `min_matches` clear
   `keep_deg` **without asking whether that pair was the only edge holding a
   frame on**. Tested remedy: restore, for each stranded frame, the strongest
   pair pruning threw away - 22 pairs out of 2332 turned 24 components / 351
   frames into 2 / 383, with the residual unchanged (0.111 deg vs 0.110 deg
   median). NOTE what that does and does not buy: painted fraction 85.7% to
   87.4%, and overlap disagreement 50.0 to 51.6. **It fills holes; it does not
   sharpen.**
3. **The first bundle adjustment does not converge, and pruning judges against
   it.** In every run on 2026-09-23 the focal marched monotonically for all 40
   iterations and stopped where the iteration budget ran out, still stepping
   ~1.4e-2 - and it landed at ~32 deg from *either* starting lens (38.8 ->
   32.14, 47.1 -> 32.48). It is not measuring the lens: with outliers spread
   over the sphere, shrinking the focal is a free way to shrink every angular
   residual. The second solve, on pruned matches, converges properly. Holding
   the focal in the first solve made the shattering *worse*, so the fix is not
   to freeze it - it is to prune against something other than a runaway.
4. **Ghosting on close scenes is parallax, not solver error.** Measured
   2026-09-23: surviving matches agree to a median of **0.131 deg** while
   overlap disagreement is **50 of 255 per channel**. Those cannot both describe
   solver error. Residual by how far apart in time the two frames were taken:
   0.108 deg under 5 s, 0.138 deg to 20 s, 0.157 deg to 60 s, **0.328 deg past
   60 s** - a 3x climb, with no azimuth pattern at all. An operator turning
   about their body traces a ~0.3-0.6 m circle with the lens; the umbrella is
   ~2 m away and is the worst-ghosted object in the panorama. The remedy is
   capture-side - rotate about the lens, finish in one pass - not solver-side.
5. **Weakly-constrained frames are placed confidently.** Measured datum-free on
   2026-08-25: median neighbour-geometry distortion 2.89 deg, frame 82 at
   **28.87 deg** - a tenfold outlier that the solver kept and painted. That is a
   ghost house across the sky. Refuse to paint a frame whose solved geometry
   disagrees with its sensors by an order of magnitude more than the median.
6. **The Pixel's guided lens measurement is still broken.** It reported
   `hfov 36.33, vfov 41.18`; the working frame is 4:3, so the horizontal must
   exceed the vertical. Ruled out: frame rotation, working-frame scale, crop.
   It collects *more* samples than the iPad and still never converges, so it is
   a systematic vertical bias. Less dangerous now that loop closure's correction
   reaches the archive (v0.30.0), but a brand-new device still depends on it.
7. **Multiple Pyodide workers, not threads - and the gate is now open.**
   `wasmThreadsPossible` is false and no code change alters that;
   `SharedArrayBuffer` is gated behind cross-origin isolation, which a static
   host generally will not provide. But neither matching nor rendering needs
   shared memory: matching shards by candidate-pair list, rendering by azimuth
   wedge. The 2026-09-23 Pixel profile reports `hardwareConcurrency 8`,
   `peakHeapMb 202`, `jsHeapLimitMb 3586`, and a shard holds *fewer* frames
   than the single worker holds today. This item said to gate the decision on
   `peakHeapMb`; the number is in and it says yes.
8. **`k1` is imposed at -0.10, not solved**, and is degenerate with focal
   length. Still true, and still worth fixing - but it is **not** the cause of
   the shattering or the focal runaway. `--k1 0` on the 2026-09-23 capture
   changes the post-prune graph from 24 components/351 frames to 20/363 and the
   solved lens from 36.75 deg to 36.87 deg. Ruled out as the mechanism.

## 8. Match during the walk - the design, and what is still unknown

Read item 1 in section 7 first. The measurements below are from the 2026-09-23
back-yard capture, 384 keyframes, ORB 900, on the desktop with BLAS threading
disabled so the numbers extrapolate honestly to a runtime that has no threads.

| | |
|---|---|
| walk duration | 399 s, 384 keyframes, **1.04 s per keyframe** |
| pair attempts | 9636, **25 per keyframe** |
| matching, after the GEMM change | 47.3 s single-threaded, **123 ms per keyframe** |
| pairs within 60 s of each other | **92.7%** |
| ORB descriptors held for the whole walk | **11.1 MB** |
| SIFT 1200 descriptors, whole walk / 60-frame window | 235.9 MB / 36.9 MB |

**Run the same Python, not a second implementation.** `js/bundle.js` already has
a browser-side matcher, and it is the wrong tool for this: its descriptors are
NCC patches, so a graph built from it would not be the graph the solver was
tuned against, and the project's one architectural rule is that the app and the
desktop run the same bytes. The Pyodide runtime is already downloading in the
background during the walk (`Started downloading the Python stitch runtime`,
19:26:29 on this capture, four minutes before the walk ended). Feed each new
keyframe to the worker as it is taken: decode, `detect_features` on that one
frame, `match_pairs` against the frames it overlaps, keep the pairs.

**Drift argues FOR this, not against it.** The obvious objection is that guided
matching needs poses, and the poses are wrong until loop closure runs at the end
of the lap - this capture logged 548 deg for a 720 deg walk. But guided matching
only uses the RELATIVE pose between two frames, and the frames being matched are
seconds apart. Local relative pose is the most accurate thing the sensors
produce; it is the *accumulated* azimuth that drifts. Matching neighbours live
is better conditioned than matching them from a globally drifted pose set.

**What has to happen after the walk anyway:** the 7.3% of pairs spanning more
than 60 s, which includes the loop-closure pairs that tie the end of the lap to
its beginning. Those genuinely need the closure before they can be predicted.

**The budget.** 123 ms per keyframe against a 1040 ms interval. Pyodide measured
~2.8x the desktop on the matching stage of this capture (310 s of real work
against ~112 s), which puts a live keyframe at roughly **345 ms of a 1040 ms
budget** - three times over. That ratio is the one number here that is an
extrapolation rather than a measurement, and it was taken on the OLD popcount
path; the GEMM path may scale differently under WASM. **Measure it on a device
before building on it.**

**Unknowns worth settling first:**
- Does a second Pyodide worker running flat out during the walk interfere with
  the 10 Hz segmentation, or with the capture policy's frame timing? Eight cores
  says no; thermal throttling on a phone in the sun says maybe.
- SIFT descriptors for a whole walk are 236 MB. Either hold a rolling window and
  accept a post-walk pass for cross-pass pairs, or park them in IndexedDB, which
  the app already uses. ORB at 11 MB needs neither.
- A two-pass survey puts its cross-pass pairs far apart in time. This capture was
  one pass; the 60-second locality figure should be re-measured on a two-pass
  archive before a rolling window is chosen over IndexedDB.

## 9. Skyline Align (sky/), new in v0.30.0

`sky/skyline-align.html`, reached from the `Sky align` chip in the sticky
header and from a second link at the bottom of the Export card. It opens in its
own tab and shares no state with the survey page, because it gets used outside
at night and must not be able to disturb a capture that is part way through.

The header link is not decoration. It went into the Export card first, four
hundred lines down a page that is mostly scrolled past, and was not found.
Adding a third chip to the bar squeezed "Horizon Survey" onto two lines at
375x812 and pushed the header from 84px to 119px, so `.bar-id h1` now refuses to
wrap and the chips take the second row instead -- which gets the header back to
84px, shorter than the two-chip version it replaced.

WHAT IT ANSWERS. The survey's bearings rest on a magnetometer the app itself
does not trust -- 2026-09-23 logged a 34 degree disagreement and warned every
bearing could be out by 17. A star's bearing is calculable to a thousandth of a
degree, so rotating the panorama until the stars sit right MEASURES that error.
The azimuth offset slider reads out the number to put in `azimuthOffsetDeg`.

Pipeline: detect the skyline, punch the sky to transparent, wrap onto a sphere,
draw stars and figures and bodies behind it, two offset sliders in degrees.

- `sky/astro.js` -- positions. Tested in `tests/astro.test.mjs` against Meeus
  worked examples: precession 1e-7 deg, equatorial->horizontal 1.4e-4 deg,
  sidereal time 9e-8, Sun 1e-4, Moon 5e-3. Planets are JPL approximate elements,
  a few arcminutes, checked against geometry they cannot violate (elongation
  bounds, geocentric distance bounds) rather than against an ephemeris.
- `sky/star-catalog.json` -- 260 KB, vendored, no runtime fetch so it works in
  aeroplane mode. 8,969 stars to mag 6.5, 88 constellations, 74 asterisms.
  Rebuild with `tools/build-star-catalog.py`; provenance and licences (both
  CC BY-SA 4.0) are in `sky/README.txt`.
- The skyline detector is `workers/segment.worker.js`, the SAME one the capture
  app runs at 10 Hz. A panorama needs two things a camera frame does not: its
  ends wrapped onto each other before detection, because left and right are the
  same bearing; and unpainted black filled with sky colour first, because black
  is neither blue nor smooth and the detector reads it as ground.

THREE THINGS COST REAL TIME TO FIND, and all three look identical from outside:

1. **Stale vertex attribute arrays silently drop a draw.** The star pass enables
   three attribute arrays; the panorama pass needs one. The other two stayed
   enabled pointing at a 9,018-vertex buffer while the sphere drew 18,721 -- an
   out-of-range read, which the spec calls undefined and this driver answered by
   dropping the draw. No GL error, nothing in the console. `useAttribs()` now
   resets the lot before every pass; attribute state is per-context, not per
   program.
2. **NPOT + REPEAT samples as opaque black in WebGL 1.** The panorama was
   1440x388. Measured in the page's own context: 64x64 REPEAT returned
   rgba(255,0,0,255), the same content at 1440x388 returned rgba(0,0,0,255). It
   renders perfectly, in black, over a black sky -- indistinguishable from a
   draw that never happened. The texture is now rounded up to a power of two.
   REPEAT is kept rather than swapped for CLAMP_TO_EDGE because the filter has
   to blend across the azimuth seam.
3. **The altitude band is not centred on the horizon and guessing that it is was
   30 degrees wrong.** `altitude_bounds` fits the band to the frames, and a
   survey walks the horizon then climbs, so 2026-09-23 came out -18 to +79 on a
   97 degree span -- middle +30.5. The page defaults to a fifth of the span
   below the horizon, which lands within a couple of degrees, and will take
   `report.json` and read `render.altitudeMin/Max` exactly.

IT NEEDS A SERVER. Under file:// every document gets its own opaque origin, so
`fetch` of the catalogue sitting beside it is cross-origin and refused, and
`new Worker` of the segmenter is refused too. Both arrive as ordinary errors,
and the obvious message -- "could not load star-catalog.json" -- sends the
reader to check a file that is perfectly fine. The page now detects `file:` at
boot and says the real cause with the one-line fix. A dead or unstartable
segmentation worker is caught separately and falls back to showing the panorama
uncut, rather than leaving the word "detecting" on screen forever.

TWO THINGS THE FIRST FIELD LOOK CHANGED:

- **The cut is made above the trace, not on it.** The detector errs low on a
  panorama and the verdict was that it removed so much the skyline itself was
  damaged -- the wrong way round, since that edge is what the page aligns. The
  cut now sits `skyMarginDeg` (6 by default) above the trace and fades in
  across the band; a hard horizontal edge in open sky reads as a real object.
- **Stars were too small to see outdoors.** A faintest-magnitude star started
  at 1.1 px at a quarter alpha, which is invisible on a phone at arm's length
  in the dark -- the only place this is used. Floor is now 1.8 px, the slope is
  steeper, faint alpha went 0.25 to 0.36, and there is a size multiplier.

Also added: "Mark unpainted panel". 13.6% of the 2026-09-23 render is unpainted
and 6.4% of the rows below the content top are holes INSIDE the terrain, which
render transparent and look exactly like an over-aggressive cut. The toggle
paints them so the cut stops being blamed for the solver's dropped frames.

KNOWN LIMIT, not yet addressed: the detector is tuned for 384x288 camera frames
and is only fair on a panorama. Re-detect, the cut-line overlay and the margin
slider are all exposed so the operator can see and correct what it did. A better
route exists and is not built: the 720-bin profile in a `.horizon-project` IS
the measured skyline, and using it instead of re-detecting would be both exact
and free.

## 10. State right now

- **v0.30.0 (2026-09-23).** Header must read that; if the stale banner appears,
  `node tools/build-importmap.mjs` was not run after the bump. That tool now
  also stamps the entry `<script>` and the stylesheet, which it never did - a
  bump used to leave `js/main.js?v=` and `styles.css?v=` at the OLD version
  forever, because the import map rewrites specifiers and `js/main.js?v=0.29.0`
  is not the specifier `./js/main.js`. `tests/import-map.test.mjs` already
  guarded this and is what caught it.
- All 37 Node suites (36 plus the new `astro.test.mjs`), 8 sims and the Python
  seam-window test pass. The survey page loads at 375x812 with no console errors
  and no stale banner; Skyline Align renders stars, figures and a real panorama
  with the sky cut out.
- Working tree: everything from v0.30.0 is **uncommitted** -
  `tools/stitch_lab.py`, `tools/build-importmap.mjs`, `js/coverage.js`,
  `js/column-plan.js`, `js/survey.js`, `js/diagnostic-export.js`, `js/main.js`,
  `js/version.js`, `workers/pyodide-stitch.worker.js`, `index.html`,
  `styles.css` and `.claude/launch.json`, plus the new `sky/` directory (`skyline-align.html`,
  `astro.js`, `star-catalog.json`, `README.txt`), `tools/build-star-catalog.py`
  and `tests/astro.test.mjs`.
- `js/build-progress.js` exists, has corrected weights, and **is imported by
  nothing**. `js/build-profile.js` is what actually records builds.
