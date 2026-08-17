# The stitching laboratory

Handoff document. Everything a fresh session needs to continue the offline
stitching work, and the constraint that shapes all of it.

Status date: 2026-08-17
Reference capture: `home-back-yard-capture-debug-2026-08-17-21-23-31.zip`
(91 photos, app v0.9.2)

---

## 1. The governing constraint

**Nothing goes in the Python reference that could not be reimplemented in
JavaScript.**

Python is the laboratory, not the product. The point of working here is that
iteration is fast and measurement is easy; the point of the constraint is that
whatever gets proven has to survive the port. An algorithm that is only
practical because OpenCV ships a hand-optimised C++ implementation of it is a
dead end, however good the pictures look.

Judge a candidate on three questions:

1. **Is it a few hundred lines of ordinary code?** Gaussian blur, bilinear
   sampling, dense linear solve, dynamic programming, max-flow — all yes.
2. **Does it need data structures the browser cannot hold?** 91 frames at
   640x480 is 84 MB of RGBA. Fine. A 2880x592 float accumulator is 20 MB. Fine.
3. **Can it be interrupted and resumed?** The browser must yield to keep the
   page alive and report progress. Anything that is one indivisible call into a
   library fails this even if the maths is portable.

`cv2` is currently used for six things, and as of the section 6 sweep **all six
are settled**. Feature detection was the open question; it is now measured, and
the answer is that the detector barely matters. Matching, which looked like the
real cost, is cheap once it is guided by the sensor poses. Nothing in this
pipeline now blocks a JavaScript port.

---

## 2. Environment

Verified working from scratch on Python 3.14.6, Windows.

```
cd C:\Users\Owner\Documents\GitHub\AdamMacInfo\Horizon-Scanner
py -m venv .venv-stitch
.venv-stitch\Scripts\python.exe -m pip install -r tools\requirements-stitch.txt
```

That installs exactly two packages, both as prebuilt wheels with no compiler
needed:

```
numpy==2.5.2
opencv-contrib-python-headless==5.0.0.93
```

`-headless` matters: the normal `opencv-python` drags in GUI libraries that are
useless here and awkward on Windows. `-contrib` is what carries SIFT.

`.venv-stitch/`, `stitch-out/` and `sweep/` are gitignored.

Run it:

```
.venv-stitch\Scripts\python.exe tools\stitch_lab.py <capture.zip> --out stitch-out
```

Options:

| flag | default | |
| --- | --- | --- |
| `--px-per-deg` | 8 | output scale; 8 gives a 2880x592 panorama |
| `--detector` | `sift` | or `orb` |
| `--max-features` | 3000 | per-frame cap |
| `--search-px` | 64 | guided match window half-width, in pixels |
| `--brute` | off | disable guiding; the control, not the method |
| `--ratio` | 0.75 / 0.85 | Lowe ratio; per-detector default |
| `--dump-json` | off | features, matches and poses, for cross-checking JS |
| `--no-render` | off | numbers only, for sweeps |

Roughly 42 seconds end to end for 91 frames on this machine, or 22 seconds at
`--max-features 500`.

`tools/sweep_eval.py` scores every run in a directory against one common set of
correspondences — see section 6 for why each run's own number will mislead you:

```
.venv-stitch\Scripts\python.exe tools\sweep_eval.py <capture.zip> --runs sweep
```

---

## 3. What `tools/stitch_lab.py` does, and what each stage is worth

The order is LOAD, MEASURE, SOLVE, MEASURE, PRUNE, SOLVE, MEASURE, RENDER.
Every stage prints the number that says whether it helped. This is deliberate:
the recurring failure mode on this project has been a change that sounded
principled, made things worse, and went unnoticed for a whole field trip.

### Load

Reads `metadata/keyframes.json` and the photos straight out of the ZIP. The pose
used is the **placed** pose — the sensor quaternion with `yawBaseCorrectionDeg`
and `stitchYawCorrectionDeg` applied — because that is what the app itself draws
with, so a reconstruction that starts anywhere else cannot be compared to it.

### Features

SIFT below each frame's own saved skyline. Cloud moves between frames, so
matching on it drags the solution toward a fiction; everything below the traced
skyline is nailed to the ground.

    159,719 features over 91 frames, median 1,872 per frame

For contrast the browser's `extractFeatures` returns 220 per frame.

An earlier version of this document called that gap "the single largest lever in
the whole pipeline." **It is not, and it never was measured.** 412 features per
frame recover the same geometry as 1,872 — see the sweep in section 6. The
default cap stays at 3000 only because it is the historical reference; ORB @ 500
is the recommendation.

### Match graph

Only frames the sensor poses say overlap, capped at 10 partners each. All-pairs
on 91 frames is 4,095 comparisons, nearly all between views sharing no sky, and
every one is a chance for repeated texture — siding, shingles, fence palings —
to invent a correspondence. Sensor poses are wrong by degrees, not tens of
degrees, so they can be trusted to say who is a neighbour even though they
cannot say exactly where.

    517 pairs kept from 535 matched (1,035 predicted by the sensors)

### Verify

Each pair is fitted to ONE rotation by Kabsch/SVD with a tightening trim
schedule (6.0, 3.0, 1.8, 1.2 degrees). Two overlapping views of a rotating
camera differ by exactly one rotation, so whatever disagrees with the best one
is wrong and goes.

### Solve

`bundle_adjust`. Three angles per frame plus **one shared focal scale**. Nothing
else — no per-pair homography, which has eight parameters and will absorb
parallax and drift into a plausible-looking lie.

- Residual is chordal (`d_i - d_j` as 3-vectors), Huber-weighted at 0.6 degrees.
- Gauss-Newton on dense normal equations. For 91 frames that is a 274x274
  matrix: trivial to solve directly, and **that size is the reason this ports
  cleanly**.
- Gravity is held and azimuth is freed: tilt prior 2.0 against yaw prior 0.02, a
  hundred to one. Down comes from an accelerometer and is the most reliable
  number the device produces; azimuth comes from an integrated gyroscope and
  drifts about ten degrees a lap on these captures.
- Frame 0 is pinned (`H[a,a] += 1e6`) because the whole solution can spin freely
  about any axis and the normal equations are otherwise singular.

### Prune and re-solve

Drop every match beyond 0.8 degrees under the converged solution, then solve
again. A robust loss stops bad matches steering the answer but leaves them in
the render, where nothing protects anything. The converged global solution is a
far better judge of a match than any single pair was, because it has seen the
whole sphere agree.

### Render

Equirectangular, feathered. Each frame's weight is
`((1-|u|)(1-|v|))^2` — zero at the frame edge, one on the optical axis, squared
so the centre wins decisively. Contributions cross-fade across the whole
overlap.

It also renders a second panorama from the **untouched sensor poses** through
the identical renderer, so the difference the solve made is visible rather than
asserted.

---

## 4. Measured results on the reference capture

|                            | sensor poses | solved   |
| -------------------------- | -----------: | -------: |
| median pairwise residual   |     1.046°   | **0.103°** |
| mean                       |     1.336°   |   0.135° |
| p90                        |     2.635°   |   0.264° |
| worst                      |    68.33°    | **0.96°** |
| overlap disagreement (0-255)|      51.8   | **34.0** |
| p95 overlap disagreement   |    140.0     |   97.1   |

Other figures worth carrying forward:

- **Focal scale 0.9916.** The stated lens (39.25° x 27.59°) was right to within
  1%. Lens calibration is not the problem on this device.
- **Frames moved a median 2.2° and a max 7.4°** from the sensor poses, almost
  all of it yaw. That is the gyro drift.
- **144,401 matches over 483 pairs** after pruning.
- `paintedFraction` 56.7%. The unpainted rest is the elevation-band gap, not a
  stitching failure — see section 7.

Outputs land in `--out`: `panorama-solved.png`, `panorama-sensor.png`,
`report.json`, `solution.npz`.

---

## 5. What is still wrong, and why seam cutting is the answer

Overlap disagreement is 34/255 mean and **97 at p95**. That is not noise and it
is not misalignment — the solve has already driven geometric residual to a
tenth of a degree. It is **parallax**.

### Why parallax cannot be solved away

The whole model assumes one fixed optical centre. When the operator pivots
around their own spine rather than around the lens, the camera translates a few
centimetres between frames. For a tree two hundred metres away that is nothing.
For a house twelve metres away it moves the apparent position of the roofline by
a real amount, and no rotation of any frame can put both views of that roofline
in the same place, because they genuinely are not in the same place.

Averaging the two — which is exactly what feathered blending does — produces a
roofline in neither position, slightly transparent, doubled at the edges. That
is the residual softness still visible around the house.

### The idea

**Stop averaging. Choose.**

For every output pixel in an overlap, take the colour from exactly one frame.
Then the only artefact possible is the boundary between regions taken from
different frames — and a boundary can be *hidden* by routing it through places
where the two images already agree.

Think of it as cutting along a line where the two photographs happen to look
identical. Cross a featureless patch of sky, or a flat run of grass, and the
switch is invisible. Cross a window frame and you get a visible step. So: find
the cheapest path.

### Concretely, in three parts

**(a) Exposure compensation, first.** Frames differ in gain because the phone
adjusts exposure constantly. If two frames disagree by a constant brightness
offset, every possible seam is expensive and the seam finder is solving the
wrong problem. Estimate one gain per frame by least squares so that overlapping
regions agree on average, then apply before seam finding. This is a small dense
solve — about 91 unknowns — and is completely portable.

**(b) Seam finding.** Two approaches, both portable, in increasing order of
effort:

*Dynamic programming seam.* Where two frames overlap in a roughly rectangular
band, build the per-pixel difference image `|A - B|`, then find the
minimum-cost monotone path across it. Standard seam-carving DP: one pass
accumulating costs, one pass backtracking. O(pixels), about fifty lines, no
library. This is the right first implementation — it is simple, it is fast, and
on a panorama where frames are laid down in sweep order the overlaps genuinely
are bands.

*Graph cut.* Model every overlap pixel as a node with edges to two terminals
(take from A, take from B) and edges to its four neighbours weighted by how
much A and B differ there. The minimum cut is the globally optimal boundary,
and unlike DP it handles overlaps of any shape and any number of frames at
once. Max-flow is a well-understood algorithm — Boykov-Kolmogorov is the usual
choice — and is a few hundred lines of ordinary code. Portable, but only worth
it if DP proves insufficient.

**(c) Multiband blending, after the seam.** Even a well-placed seam can show a
step if exposure compensation was imperfect. Multiband blending fixes this
without reintroducing ghosting: build Laplacian pyramids of both images, blend
each frequency band over a different width — low frequencies over a wide band
so brightness differences fade out gradually, high frequencies over a band a
pixel or two wide so detail stays sharp and never doubles. It is Gaussian blur,
subtraction and a weighted sum, repeated over five or six pyramid levels.
Entirely portable; the browser already has canvas operations that make the
blurs cheap.

The order matters: **compensate, cut, then blend.** Blending first is what the
renderer does now, and it is why the house is soft.

### How to know it worked

`render_equirect` already reports `meanOverlapDisagreement` and
`p95OverlapDisagreement`. Those are the numbers to move. But note the trap:
seam cutting does not reduce the *disagreement between the source frames* — that
is physical and fixed. It removes the disagreement from the *output*. So the
honest metric after seam cutting is different: measure sharpness across the
seam, or simply compare crops of the house against the current output. Add a
metric before changing the renderer, not after.

---

## 6. Portability audit of the current script

| Used for | cv2 call | Portable? |
| --- | --- | --- |
| JPEG decode | `imdecode` | Yes — the browser decodes JPEGs natively |
| Bilinear resample | `remap` | Yes — about thirty lines, or canvas `drawImage` |
| Greyscale | `cvtColor` | Trivially |
| PNG write | `imwrite` | Trivially |
| **Descriptor matching** | **`BFMatcher.knnMatch`** | **Yes, and cheaper than it looks — see below** |
| **Feature detection** | **`SIFT_create`** | **The open question** |

An earlier version of this table listed four entries and omitted `BFMatcher`
entirely. That was the important omission, because matching — not detection — is
where the cost lives.

### Matching cost, and why brute force is the wrong baseline

Brute-force L2 matching at 1,872 features per frame is 1872 x 1872 x 128 ~ 450M
multiply-adds per pair, and 232 G ops over 517 pairs. In SIMD C++ nobody
notices. In scalar JavaScript that is minutes to an hour, which would indeed
rule out the port.

**But brute force is not required, and the browser already does not do it.**
`matchPair` in `js/bundle.js` uses the sensor pose to predict where each feature
should land in the other frame and searches only within `searchPx` of that
prediction. The pose is wrong by degrees, not tens of degrees, which is exactly
the regime where a prior is useful.

Measured on the reference capture — for every verified match, the distance from
the sensor-predicted landing point to where the feature actually is:

    p50 17.2 px   p90 42.1 px   p95 48.9 px   p99 60.7 px   p99.9 74.2 px

So a 64-pixel search radius captures **99.4% of true matches** while looking at
4.2% of the frame:

| radius | candidates per feature | true matches captured |
| ---: | ---: | ---: |
| 32 px |  19.6 |  80.5% |
| 48 px |  44.1 |  94.5% |
| **64 px** | **78.4** | **99.4%** |
| 96 px | 176.4 | 100.0% |

Which collapses the cost:

| approach | ops over 517 pairs | versus brute force |
| --- | ---: | ---: |
| brute-force SIFT | 231.9 G | 1x |
| **guided SIFT, r=64** | **9.7 G** | **24x less** |
| guided ORB, r=64 | 0.6 G | 382x less |

10 G scalar operations is tens of seconds in JavaScript — comfortably inside an
offline budget with a progress bar. **The detector question and the matching
question are therefore independent.** SIFT in JS is not gated on matching cost.

**Done.** `match_pairs` now guides by default (`--search-px`, default 64);
`--brute` keeps the old path as a control. The box test is `abs(dx)` and
`abs(dy)` separately, matching `matchPair` rather than using a Euclidean radius,
so the two admit the same candidate set and a crossover comparison measures
detectors rather than windows.

Measured, rather than predicted:

| | descriptor comparisons | pairs | matches | solved median |
| --- | ---: | ---: | ---: | ---: |
| brute force | 1.69 G | 517 | 144,401 | 0.103° |
| guided r=64 | 0.16 G | 511 | 161,909 | 0.108° |

Guided matching is **10.6x cheaper**, not the 24x predicted, and the gap is an
implementation detail worth knowing: queries are bucketed into cells the size of
the search window and compared against the 3x3 neighbourhood, which is a
guaranteed superset of the box but about 2.2x its area. The exact box test is
applied afterwards, so the *result* is right and only the *cost* is loose.
Bucketing at half the window would recover most of the difference. Not worth
doing at 0.16 G.

The accuracy is unchanged (0.108 vs 0.103 — see the common-set scoring below,
where the difference disappears entirely). But note what guided matching did to
the **worst** case: max residual under the sensor poses fell from **68.33° to
5.23°**. Brute force was admitting matches hundreds of pixels from anywhere the
geometry allowed — periodic siding finding a convincing impostor across the
frame — and the prune step was cleaning up afterwards. The prior removes them
before they are ever proposed. Guided matching is not merely the cheap option;
it is the more accurate one.

### The detector question, settled

ORB remains worth measuring, but for the honest reason. It is **not** easier to
port — SIFT is convolutions and histograms, which is ordinary code. It is worth
considering because binary descriptors compare as four XORs and four popcounts
instead of 128 float multiply-adds, and because fewer, cheaper features may cost
nothing in final accuracy.

That was a measurement, not an argument, and it has now been run. All four
configurations, guided at r=64:

```
.venv-stitch\Scripts\python.exe tools\stitch_lab.py <zip> --out sweep\orb500 \
    --detector orb --max-features 500 --search-px 64 --no-render
```

### Scoring: why each run's own number is not the answer

Each run reports its residual over **its own** matches, and that comparison is
rigged in a way that is easy to miss. A configuration finding fewer, cleaner
correspondences is being marked on an easier paper: halving the feature cap
removes the weak, low-contrast matches first, so the median falls whether or not
the recovered geometry improved.

It does exactly that. SIFT @ 500 reports **0.079°**, apparently beating SIFT @
3000's 0.108° — and the improvement is entirely an artefact. Scored against one
common set of correspondences it is 0.101°, indistinguishable from the rest.

`tools/sweep_eval.py` builds one evaluation set (SIFT @ 3000, verified but
deliberately **not** pruned — a yardstick already trimmed to fit one of the
things it measures is not a yardstick) and scores every solved pose set against
it:

| run | feat/frame | own median | **common median** | p90 | focal |
| --- | ---: | ---: | ---: | ---: | ---: |
| sensor poses | — | — | 1.046° | 2.600° | — |
| ORB @ 3000 | 2,920 | 0.097° | **0.100°** | 0.354° | 0.9570 |
| ORB @ 500 | 500 | 0.092° | **0.101°** | 0.369° | 0.9910 |
| SIFT @ 500 | 412 | 0.079° | **0.101°** | 0.342° | 0.9981 |
| SIFT @ 3000 | 1,872 | 0.108° | **0.110°** | 0.327° | 0.9855 |

### What this settles

**The detector does not matter.** All four land within 0.01° of each other, which
is well inside the noise of the thing. The premise this document was built on —
that 1,872 SIFT features versus the browser's 220 was "the single largest lever
in the whole pipeline" — is false, and was never measured. Delete that belief.

Consequences:

- **Feature count is not the lever.** 412 features per frame recover the same
  geometry as 1,872. Whatever the browser's weakness is, it is not the count,
  and raising the cap is not the fix.
- **SIFT is not required.** ORB @ 500 matches it. So does SIFT @ 500. There is no
  accuracy argument for 600 lines of JavaScript SIFT.
- **Matching is no longer a cost concern at all.** SIFT @ 500 guided is 0.01 G
  comparisons and ORB @ 500 is 0.03 G — both trivial in JavaScript. The
  eight-minutes-to-an-hour worry is gone twice over: once from guiding, once
  from discovering that the feature count never needed to be high.

One caution. **ORB @ 3000 has the best common median and is the worst-behaved
run.** Its focal scale converged to 0.9570 where the other three agree on
0.985–0.998, and its max residual on the common set is 11.35° against ~5° for
the others. A good median over 407,755 matches is hiding a focal estimate that
drifted 4%. Prefer ORB @ 500, which agrees with everything else at 0.9910.

**Recommendation: ORB @ 500, guided at r=64.** Equal accuracy, binary
descriptors, a fifth of the features, and it is the cheapest thing to write
twice.

### Still open: the browser's own detector

Option 3 from the original three — keep the app's existing corner detector — was
not tested, because it lives in JavaScript and this harness does not run it. But
the sweep has changed its odds considerably. The app's 220 features per frame is
no longer obviously too few, since 412 was enough. The live question is now
**descriptor quality, not feature count**, and it can only be answered on the JS
side.

Two things to measure there, in order:

1. ~~Raise `searchPx` from 40 to 64 in the app.~~ **Tried, and it is worse.**
   The prediction was that 40 px captures only 80–95% of true matches and the
   app was discarding one good match in eight. Measured in `focal-lab.html` on
   the reference capture, 64 px gives **5,185 solver matches at 0.4677° RMS**
   against **5,635 at 0.4528°** — fewer matches and a worse residual.

   The reason is instructive, and it is the one place where the Python reference
   genuinely does not predict the browser. Widening the window admits more
   candidates, and more candidates make the **ratio test harder to pass**,
   because the second-best match gets closer. SIFT's 128-dimension descriptor is
   distinctive enough to stay ahead of the confusers; the app's small patch
   descriptor with `ratio = 0.86` is not. The radius distribution measured on
   SIFT correspondences does not transfer to a weaker descriptor.

   **Reverted.** `searchPx` stays at 26 in `js/bundle.js` and 40 at the callers.
2. **Compare the app's descriptor against ORB @ 500** through the same solver,
   using the JSON dump as the bridge. The searchPx result above sharpens this:
   the app's weakness is descriptor distinctiveness, which is exactly what the
   sweep could not measure from the Python side.

### Keep Python, shrink its job

Its value is not the algorithm — none of this is exotic. Its value is that it is
an **oracle**. Write the JS cold, get 0.4 degrees median, and there is no way to
tell whether that is a weaker detector or a sign error in a Jacobian. Have the
Python dump features, matches and poses as JSON and the stages can be crossed
over: Python features into the JS solver, JS features into the Python solver.
That isolates detector quality from porting bugs and costs almost nothing to
set up.

## 7. Not a stitching problem

`paintedFraction` is 56.7%, and the black bands are not the stitcher's fault.
Coverage in the app is one-dimensional — azimuth only. With a 27.6 degree
vertical field, a camera raised to clear a roof spans roughly 15 to 42 degrees
and sees nothing below, and nothing in the model notices. Filling the panel
needs either two elevation bands or the obstruction probe, and the coverage map
would have to become a grid of azimuth by elevation to guide it.

Tracked in the main `HANDOFF.md`; noted here so nobody spends a day trying to
stitch their way out of it.

---

## 8. Suggested order of work

1. ~~Guided matching in the Python reference.~~ **Done** — `--search-px`,
   default 64, `--brute` for the control.
2. ~~The detector sweep.~~ **Done** — see section 6. The answer is ORB @ 500 and
   the detector was never the lever.
3. ~~Raise `searchPx` to 64 in the app.~~ **Done, measured, reverted** — it is
   worse. See section 6.
4. **Prune and re-solve in the app.** ~~Next~~ **Done** — `pruneMatches` in
   `js/panorama-optimize.js`. First pass 0.4733° RMS, then 1,033 matches dropped
   and re-solved to **0.1882°**. Ported from the Python reference and it
   transferred exactly as predicted, unlike the search radius.
5. ~~Find out why the tilt gate rejects this capture.~~ **Done, and fixed.**

   The app's rotation refinement was being discarded entirely on the reference
   capture — `applied=false`, so the render fell back to sensor poses and only
   the lens correction survived. The cause was not a bad solve. Per-frame tilt
   movement across all 91 frames:

       median 0.282°   p90 0.636°   over 1.0°: 3 frames (89, 86, 11)

   The gate was `maxTiltMovedDeg <= 1` — a maximum over every frame. Three
   weakly-constrained frames, two of them at the end of the lap where there are
   fewest overlapping neighbours, were vetoing the corrections of all 91. The
   gate exists to stop a **leaning horizon**, which is a property of the solution
   as a whole, but it was implemented as a test on any single frame.

   Two changes in `js/panorama-optimize.js`:

   - **Per-frame clamp.** A frame the solver wants to tilt past `tiltClampDeg`
     keeps its yaw correction and gives up its tilt (`yawOnlyCorrection`). This
     is the project's own principle applied per frame — gravity is trusted,
     azimuth is not. Reverting such a frame outright would also throw away its
     yaw correction, and yaw drift runs to several degrees where the unwanted
     tilt is barely one, so reverting costs more than it saves.
   - **Robust global gate.** `medianTiltMovedDeg <= tiltClampDeg`, plus a
     requirement that no more than a quarter of frames were clamped. If the
     *typical* frame wants to tilt materially then the solve really has gone
     wrong, and clamping outliers would be papering over it.

   Measured: `applied=true`, 3 frames clamped (11, 86, 89), median tilt 0.266°,
   max tilt 0.951°, max yaw 2.571°.
6. **Reconcile the two focal measurements.** They disagree and they cannot both
   be right. Cross-lap in the app fits **1.042–1.064**; bundle adjustment in the
   Python fits **0.985–0.998**. That is a 5–8% gap on the quantity that sets the
   scale of everything. The app's method was chosen for a documented reason —
   solving focal inside the bundle descends a surface flattened by parallax — so
   this is not simply a matter of preferring the Python number.
7. **Exposure compensation.** Small, portable, and it must come before seams.
8. **DP seam finding** for pairwise overlaps, with a sharpness metric added
   first so the improvement is measurable.
9. **Multiband blending** over the seams.
10. Only then, graph cut — and only if DP demonstrably falls short.
11. Port, in this order: prune-and-re-solve loop, feathered blend, exposure
   compensation, seams, blending. The first two are small and are worth most of
   what the reference already achieves.
