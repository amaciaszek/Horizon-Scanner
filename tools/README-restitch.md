# The offline restitcher — handoff

Everything needed to rebuild a panorama from an existing capture archive, with
no new survey data. Written for someone picking this up cold.

Status date: 2026-08-19
Tool: `tools/restitch.html`
Reference archives:
`ipad_home-back-yard-capture-debug-2026-08-19-00-05-26.zip` (200 frames)
`pixelphone-home-back-yard-capture-debug-2026-08-18-23-53-45.zip` (102 frames)

**The tool currently produces bad panoramas.** It runs end to end, reports
excellent-looking numbers, and the pictures are smeared and doubled. Section 6
is the honest account of why. Do not trust its residual figure.

---

## 1. The problem in one paragraph

A survey is a few hundred photographs taken by a person turning on the spot,
each stamped with the phone's orientation. Stitching them is a rotation-only
problem: there is one optical centre, so any two overlapping frames differ by
exactly one rotation, and the whole panorama is one rotation per frame plus a
shared focal length. The sensors give a starting pose good to about a degree,
which is enough to say which frames overlap and roughly where a feature lands,
and nowhere near enough to draw with. The job is to refine those poses from the
images and paint the result on an azimuth/altitude panel.

---

## 2. How to run it

### What you need, and where it is NOT

**`tools/restitch.html` is the entire tool.** One file. No build, no libraries,
no network, no dependency on anything else in this repository. If you have that
file and one capture archive, you have everything.

Two warnings, because the first version of this document sent someone looking in
the wrong places:

- **`lab3/` is gitignored and will never appear in a clone.** It is a scratch
  directory on one developer's machine holding copies of the capture archives.
  The archives are 25-50 MB each and are not in git at all. Get them from
  whoever ran the survey; they are the exported capture-debug ZIPs the app
  produces, nothing more.
- **This repository's default branch is `main`, not `master`.** A checkout
  sitting on an unborn `master` has no commits and therefore no files at all,
  which looks exactly like the tool being missing.

### Running it

Serve any directory containing `restitch.html` - a local server is needed only
because browsers refuse module scripts on `file://`. The archive does not have
to be beside it; you can drag one in from anywhere.

```
python -m http.server 8646
```

Open `http://localhost:8646/restitch.html`, drag a capture-debug ZIP onto the
page, press **Rebuild**, then **Save PNG**.


Timing on a desktop, for scale: the Pixel archive at 960 px / 1500 features /
12 px-per-degree takes about a minute; the iPad archive takes about two. Feature
detection dominates and is far slower than it should be — see section 6.

To drive it without the mouse, from the browser console:

```js
const buf = await (await fetch('./pixel.zip')).arrayBuffer();
await window.__restitch.run(buf, 'pixel.zip');
```

`window.__restitch` also exposes `readZip`, `extractFeatures`, `bundleAdjust`
and `renderPanorama` individually, which is the easy way to test one stage.

---

## 3. What the archives contain

Verified against the Pixel archive. Every entry is STORED, not deflated, so a
ZIP reader can subarray straight into the bytes — though `restitch.html`
supports deflate too, via the platform's `DecompressionStream`.

```
README.txt                              human-readable orientation
coverage-map.png                        the survey ring, as an image
logs/field-log.txt                      the operator-facing log
logs/debug-bundle.txt                   the verbose log
photos/keyframe-NNNN.jpg                one per keyframe, 640x480 here
metadata/keyframes.json                 13 MB — the main record, one object per frame
metadata/stitch-manifest.json           purpose-built for offline stitching. START HERE
metadata/scan-coverage.json             per-bearing coverage and the elevation model
metadata/capture-audit.json             every accept/reject decision during capture
metadata/capture-gaps.json              where the photo overlap is too thin
metadata/panorama-optimization.json     what the app's own solver did
metadata/session.json                   app version, device, calibration results
metadata/keyframes.csv                  a flat summary of the same frames
metadata/project.horizon-project        the reopenable project file
```

### 3.1 `stitch-manifest.json` — use this one

It exists precisely for this task and states its own contract:

```
format              "horizon-offline-stitch-manifest"
version             1
coordinateSystem    "right-handed ENU world; camera rays use u right, v up, forward -Z"
imageGeometry       "Photos are already screen-aligned. captureTiming.coverFit
                     records the exact decoded-video rotation/crop/scale."
posePolicy          "placedQuaternion is the sensor pose with yaw datum and loop
                     correction applied. rawQuaternion is the exposure sensor pose
                     before those azimuth corrections. visuallyRefinedQuaternion,
                     when present, is a gravity-constrained rotation-only visual
                     refinement."
intrinsicsPolicy    "tanHalfHorizontal/tanHalfVertical are the optics the photograph
                     was taken through and are never rewritten. renderTanHalf* and
                     appliedFocalScale are present only when a post-capture cross-lap
                     lens measurement changed the panorama render."
yawDatumDeg         329.58...
images[]            one entry per photograph
```

Each `images[]` entry:

```
index, path, capturedAt, width, height
rawQuaternion               sensor pose at exposure
placedQuaternion            ** the pose to start from **
visuallyRefinedQuaternion   the app's own refined pose, or a copy of placed
tanHalfHorizontal/Vertical  the optics actually used
renderTanHalf*/appliedFocalScale   null unless a lens correction was applied
centerAzimuthDeg, centerAltitudeDeg, rollDeg
coverFit { ... }            exact crop/scale from the video frame
```

**`placedQuaternion` is already computed for you.** `restitch.html` currently
rebuilds it from `keyframes.json` by applying `yawBaseCorrectionDeg +
stitchYawCorrectionDeg` to `orientation.quaternion`; that is equivalent but
pointless. Read the manifest.

### 3.2 Quaternion convention — verified, not assumed

**`[w, x, y, z]`**, scalar first, unit norm.

This was checked rather than guessed: building the rotation matrix under this
convention, rotating the camera axis `[0, 0, -1]` into the world, and converting
back to azimuth and altitude reproduces the archive's own
`pointing.centerAltitudeDeg` and `pointing.stitchedAzimuthDeg` to **0.000°**
across 40 frames. Interpreting the same numbers as `[x, y, z, w]` gives a mean
pointing error of **94.9°**. If a reconstruction comes out wildly wrong, check
this first.

The world frame is ENU with z up. A camera ray for image coordinates
`u ∈ [-1,1]` right and `v ∈ [-1,1]` up is `normalise([u·tanH, v·tanV, -1])`,
and the world direction is `R · ray` where `R` is the matrix of the placed
quaternion.

### 3.3 `keyframes.json` — the deep record

A list, one object per frame. The fields that matter for stitching:

```
index, timestampMs, pass, captureKind        1 = first lap, 2 = verification
photo.path/width/height
pointing.centerAltitudeDeg                   elevation of the optical axis
pointing.stitchedAzimuthDeg                  azimuth, after datum and loop closure
pointing.rollDeg                             camera roll from gravity
orientation.quaternion                       raw sensor pose  [w,x,y,z]
orientation.placedQuaternion                 pose to draw with [w,x,y,z]
orientation.visuallyRefinedQuaternion        app's refined pose
orientation.yawBaseCorrectionDeg             datum correction
orientation.stitchYawCorrectionDeg           loop-closure correction
camera.tanHalfHorizontal / tanHalfVertical   the optics
camera.analysisWidth / analysisHeight        384 x 288 — the analysis raster
analysis.boundary[384]                       traced skyline ROW per column, in 288-row space
analysis.confidence[384]                     per-column confidence
analysis.flags[384]                          0 measured, 1 ran off the top, 2 no obstruction
analysis.skylineSamples[384]                 the same skyline already in az/alt degrees
analysis.visualQuality, skyFraction, exposure
gyroscope.* , captureTiming.*                sensor and timing provenance
```

Two things worth knowing about `analysis`:

- `boundary` rows are in the **288-row analysis raster**, not the photo. Scale by
  `photoHeight / 288` to use them against the image.
- `skylineSamples` has already done the projection for you — each entry carries
  `azimuthDeg`, `altitudeDeg`, `confidence` and `flag`. If all you need is the
  skyline, you never have to touch the geometry.

The skyline matters for stitching because **everything above it is sky and
cloud**, which moves between frames. Matching on it drags the solution toward a
fiction. Mask features to below `boundary`.

### 3.4 What the other files are good for

- `scan-coverage.json` — 180 bins of 2°, each with score, observation count, and
  the elevation model (`obstructionTop`, `measuredTop`, `requiredElevation`,
  `satisfiedElevation`, `topSeen`, `beyondTilt`). Tells you where the survey
  believed it was thin.
- `panorama-optimization.json` — what the app's in-browser solver achieved on
  this exact data: pair count, match count, RMS before and after pruning, how
  far each frame moved, the focal check. **This is the baseline to beat.**
- `capture-audit.json` — every frame the capture refused and why.
- `session.json` — app version, and the sensor/lens calibration results.

---

## 4. How `restitch.html` works

Stages, in order. Each prints the number that says whether it helped.

1. **Read the ZIP.** Central directory, ZIP64 fallback, STORED fast path,
   deflate via `DecompressionStream`.
2. **Decode** each photo to at most the working width, via `createImageBitmap`
   into an `OffscreenCanvas`. Scale `analysis.boundary` into that raster.
3. **Detect features.** Shi-Tomasi corners (smaller eigenvalue of the gradient
   covariance) over a three-level Gaussian pyramid, spread across a 16×16 grid
   so one high-contrast structure cannot monopolise the budget, masked to below
   the skyline. Descriptor is a gravity-aligned, contrast-normalised 9×9 patch —
   rotation invariance is unnecessary because roll is known from gravity, and
   normalisation is what survives the phone re-exposing between frames.
4. **Build the match graph.** Only frames the sensor poses say overlap. For each
   pair, project every feature of A into B using the sensor poses and search a
   window around the prediction; grid-bucketed, ratio test on normalised dot
   products. The window is **angular** (7°, converted per frame to pixels)
   because pixel-denominated tolerances are device-dependent — see section 5.
5. **Verify each pair** against a single rotation by Kabsch with a tightening
   trim schedule (6°, 3°, 1.8°, 0.9°). The schedule only ever shrinks; an
   adaptive cut widens when a pair is polluted and keeps exactly the pollution
   it was meant to remove.
6. **Bundle adjust.** Levenberg–Marquardt over three rotation parameters per
   frame plus one shared focal scale. Dense normal equations, Cholesky. Tilt
   prior 100× the yaw prior, because gravity is trustworthy and integrated yaw
   drifts. Frame 0 pinned. Marquardt-scaled damping, a per-iteration rotation
   cap, and a rejection test that undoes any cost-increasing step.
7. **Prune and re-solve.** Drop matches the converged solution disagrees with by
   more than 0.8°, then solve again.
8. **Render.** Equirectangular, feathered with weight `((1-|u|)(1-|v|))²`,
   optional per-frame exposure gains fitted against the consensus. Then azimuth
   and altitude rulers.

Deliberately **not** a per-pair homography: eight parameters will absorb
parallax and drift into a plausible-looking lie, where three angles and a lens
cannot, so when they fail to explain the data the residual says so.

---

## 5. Things already established — do not re-derive

- **Quaternions are `[w,x,y,z]`** (§3.2), verified to 0.000°.
- **Photos are screen-aligned already.** No rotation needed.
- **Skyline masking is necessary.** Cloud moves.
- **The search window must be angular, not pixel.** A flat 48 px is 5° on the
  Pixel's 66° lens and 3° on the iPad's 40° one, while sensor pose disagreement
  runs to 7°. With the pixel window, 1,398 of 1,940 overlapping Pixel pairs
  produced too few matches to use. Making it angular took connectivity from a
  median 7 partners per frame to 14 and correspondences from 7,384 to 15,681.
- **The focal length is poorly observed and must not be left free.** Across runs
  on the same Pixel data it landed at 0.9993, 0.9326 and 0.9183 depending only
  on settings — a 6% spread on the parameter that sets the angular scale of
  every frame. A strong prior hides the problem by dictating the answer; a weak
  one lets it wander. **It needs an independent constraint, and loop closure is
  the obvious unused one: a full lap is exactly 360° by definition.**
- **The two devices differ a lot.** iPad 40.1° × 31.4°, 200 frames; Pixel
  66.0° × 51.9°, 102 frames. Any tolerance expressed in pixels will behave
  differently on the two. Express tolerances in degrees.
- **Exposure varies by a factor of 2.3 across one lap** (fitted gains 0.65–1.51).
  Feathering already absorbs most of the visible step; correcting it explicitly
  measured no better and cost 5× in the app's own renderer.
- **Feature detection no longer blocks iteration.** The original corner loop
  took 6.90 s on a deterministic 960×720 test frame because it repeated 100
  general bilinear samples per candidate. Summed-area gradient products reduce
  that to 0.43 s (16.2×) with identical feature positions and descriptors; the
  maximum Shi–Tomasi response difference was `1.7e-9`. An end-to-end headless
  run rebuilt all 102 Pixel frames in 56.9 s; decoding plus feature extraction
  finished in about 3.3 s, so matching and the two solves are now the dominant
  costs.

---

## 6. Why the output is bad — the honest account

The tool reports `median residual 0.271°` and produces a panorama with the same
roof shingles smeared across the frame at several scales. Both statements are
true, and the gap between them is the whole problem.

### The metric does not measure the picture

The residual is computed **over the matches that survived pruning**. If the
match graph fragments, each fragment can be internally consistent to a tenth of
a degree while sitting somewhere quite wrong relative to the others, and the
average of the fragments is an excellent number describing a ruined panorama.

The tell was in the same output all along: **`frames moved: median 0.00°`** on
the Pixel. Over half the frames never moved from their sensor pose, so the
render mixes solved frames with untouched ones. That is exactly what puts the
same structure in two places.

Two measurements have been added so this cannot recur:

- a **control render** from raw sensor poses through the identical renderer, and
- **sharpness** — mean gradient magnitude over painted pixels. Misalignment does
  not show as a step once frames are feathered; it shows as the same edge
  appearing twice and averaging into a smear, which destroys gradient energy.

The tool now prints both and says outright when the solve made things worse.
**Any future change should be judged on sharpness versus the control, not on the
residual.**

The verdict in the tool follows that rule. Seam step and painted coverage are
still reported, but a small regression in either is labelled as a render
tradeoff rather than allowed to contradict an actual sharpness improvement.

### Known reconstruction defects, in the order worth attacking

1. **Graph connectivity.** The Pixel run leaves 4 frames with no partners at all
   and over half the frames unmoved. A frame with no correspondence keeps its
   sensor pose and is rendered beside frames that moved degrees. Diagnose with
   the `candidate fate` and `connectivity` lines the tool prints.
2. **Focal instability** (§5). Add loop closure as an independent constraint.
3. **Near-nadir frames smear across the whole panel.** In equirectangular a
   frame at −59° elevation with a 52° vertical field reaches −85°, where its
   66° horizontal width covers hundreds of degrees of azimuth. One frame of a
   flower bed paints the entire bottom of the output. Only 1–3% of frames are
   that steep, but each ruins a large area. Exclude or heavily downweight frames
   far from the horizon.

### The baseline to beat

The app's own in-browser solver, on the 200-frame iPad capture,
achieved `rmsDeg 0.207` from 6,841 correspondences over 381 verified pairs
(`metadata/panorama-optimization.json`; the earlier 2026-08-18 capture recorded
0.224 from 3,591). Its panoramas — sensor poses plus light
refinement — currently look **better** than this tool's output. Beating that
picture, not that number, is the target.

For reference, the Python reference implementation (`tools/stitch_lab.py`,
documented in `tools/README-stitch-lab.md`) reaches 0.103° median on a
comparable capture using SIFT at ~1,900 features per frame. It is a working
example of the same pipeline and is the thing to diff against when a stage
misbehaves.

---

## 7. Suggested order of work

1. Fix graph connectivity until no frame is left unmoved, and confirm with the
   `connectivity` line.
2. Constrain the focal with loop closure; verify it is stable across settings.
3. Drop or downweight near-nadir frames in the renderer.
4. Only then consider seam cutting and multi-band blending — feathering already
   drives the measured seam step to zero, so the remaining ugliness is
   misregistration, not blending.

Judge every one of these on **sharpness versus the sensor-pose control**.
