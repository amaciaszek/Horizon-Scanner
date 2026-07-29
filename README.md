# Horizon Survey

A guided, multi-pass, on-device horizon survey for the OnStep Advanced Telescope
Controller. Runs entirely in the browser with no network dependency and no
imagery leaving the phone.

This replaces the earlier live-threshold prototype. The threshold detector is
gone; nothing in this build commits a sample to the profile without at least two
independent estimates agreeing on it.

---

## What it actually does

**Guided capture.** The app directs the scan rather than watching it. It issues
one instruction at a time — rotate clockwise, slow down, return 8°
counter-clockwise for overlap, tilt up because the obstruction reaches the frame
edge — and every instruction is derived from a measured quantity, not a timer.

**Four independent estimates, cross-checked.**

1. *Multi-cue sky segmentation* — brightness, chroma, texture smoothness, and a
   weak height prior, combined and Otsu-thresholded, then restricted to the
   connected component that touches the top of the frame. That connectivity rule
   is what stops a sunlit wall or a pale roof from being called sky.
2. *Independent gradient edge detection* — computed from scratch per column,
   sharing no state with the mask. Disagreement between the two lowers the
   column's confidence rather than being silently resolved.
3. *Visual registration* — coarse-to-fine normalised cross-correlation between
   consecutive frames with a subpixel peak fit. This is the primary source of
   relative rotation.
4. *Orientation sensors* — used for the rotation structure and to prime the
   visual search. The compass is audited continuously and demoted to "poor" when
   its short-term motion disagrees with the orientation stream; it only ever
   supplies a slowly-updated absolute yaw datum.

**Two capture modes.** *Handheld* assumes you pivot your body around the phone;
the optical centre wanders a few centimetres, which is irrelevant for a treeline
and not irrelevant for a house at 12 m, so the roll and rate gates stay loose and
overlap absorbs the rest. *Tripod / mount* assumes the phone is clamped with its
rear camera on the azimuth axis. The optical centre is genuinely fixed, there is
no parallax to absorb, and the gates tighten to match: 9°/s instead of 14, roll
within ±8° instead of ±18, and 45% minimum frame overlap instead of 30%. The mode
is locked once capture starts and is recorded in the archive, so reopening a
tripod survey does not re-judge it against handheld thresholds.

**Nothing is committed irreversibly.** Every keyframe stores its skyline in
*image* coordinates alongside its orientation. The whole profile is reprojected
from keyframes after loop closure and after focal-length calibration, so
improving either retroactively improves every sample.

**Focal length is measured, not assumed.** The FOV slider is a seed value. Once
the scan produces enough motion, the app compares visual pixel shift against
orientation change and solves for the focal length directly from the imagery.

**Loop closure.** At the end of pass 1 the current view is matched back against
the anchor frame from the start. The residual is distributed across the keyframe
chain in proportion to distance travelled, the same way a traverse is closed in
survey work.

**Two passes, then acceptance.** Pass 1 is a broad sweep. The app then computes
which sectors lack evidence and navigates the operator back to each one by
name — turn right 37°, nudge left 4°, hold still. Export is gated on an
acceptance report, not on the operator's confidence.

**Archive format.** The compact `.hzn` is the controller payload. The
`.horizon-project` archive keeps the keyframes, per-column boundaries and
confidences, sensor health, intrinsics, and the report, so the profile can be
recomputed years later with a better algorithm or compared season to season.

---

## Verified numerically

These come from headless simulations that render synthetic camera frames of a
known horizon, push them through the real worker code and the real projection
and merge logic, and compare against ground truth. Reproduce with the scripts in
the parent folder.

**Projection maths** — portrait and landscape agree exactly; the screen-rotation
handling is verified to produce identical results in both. Also available in-app
under Advanced → Run projection self-test.

**End-to-end reconstruction** (two passes, 58 keyframes, 66° FOV, synthetic
overcast sky with a house and a tree):

| | |
|---|---|
| Bins with a value | 720 / 720 |
| Verified bins | 720 / 720 |
| Median absolute error | **0.090°** |
| 95th percentile error | 0.123° |
| Max within-bin spread | 6.73° (at the roof edges, correctly allowed) |
| Mean segmentation confidence | 84.1% |

**Visual registration** — 0.049 px mean error on subpixel shifts, exact on
integer shifts, correct with no hint, a 30%-short hint, or a 40 px-wrong hint.
Featureless input is refused (`null`) rather than guessed.

**Loop closure** — with 4.86° of gyro drift injected over a full turn, median
error drops from 0.301° to 0.090° and 95th percentile from 6.079° to 0.134°.

**Acceptance rules, negative controls:**

| Injected fault | Result |
|---|---|
| One 36° segmentation blowout | flagged as a spike, bin demoted |
| Real 24° roofline step | **not** flagged — steps are not spikes |
| Single-pass arc 60–90° | weak sector reported as 60.5–90.0° |
| Low-confidence arc 250–275° | weak sector reported as 250.5–275.0° |
| Noisy observations 20–40° | weak sector reported as 21.0–39.5° |
| 12° hole | grade INSUFFICIENT, not silently interpolated |

**Performance** — 7.9 ms segmentation per 384×288 frame and 3.0 ms registration
per pair on a container CPU, against a 110 ms processing budget. Both workers
are single-flight; frames are dropped rather than queued, and the drop counts
appear in the report.

---

## Not verified, and stated as such

- **No hardware run.** Everything above is simulation. The orientation
  convention, the camera's delivered frame orientation, and real-world
  segmentation behaviour under sun, rain, and dusk are untested on a device.
- **Sensor orientation conventions vary.** The app normalises every frame into
  screen orientation before analysis and auto-detects the rotation, but if the
  detected skyline overlay appears sideways relative to the live view, set it
  manually under Advanced → Frame rotation.
- **Segmentation is classical, not neural.** The design brief called for a
  MediaPipe semantic segmentation model. This build does not include one: it
  would add a CDN dependency and a large download to a tool meant to work in a
  field with no signal, and I could not test the model's behaviour here. The
  multi-cue + connectivity approach is what the code actually does, and the
  numbers above are what it actually achieves on synthetic data. A neural mask
  would slot in as a fifth source feeding the same confidence machinery; the
  interface for that is `workers/segment.worker.js` returning `boundary`,
  `confidence`, and `flags`.
- **Registration is translational, not a full homography.** It recovers yaw and
  pitch between frames, not roll or scale. Roll comes from the accelerometer and
  high-roll frames are rejected rather than registered. Full feature matching
  with bundle adjustment would be the next accuracy step.
- **Camera path optimisation is a single-parameter closure**, not a global
  bundle adjustment over all keyframes.
- **Reopening a project archive** restores the profile, keyframes, and report,
  but reconstitutes per-bin observation lists approximately. Reprojecting from
  keyframes (Recompute from keyframes) is the exact path.

---

## Running it

Camera and motion sensors both require a secure context.

```bash
python3 -m http.server 8000
```

`http://localhost:8000` works for desktop development. For a phone, deploy over
HTTPS — Cloudflare Pages or GitHub Pages both work, and the whole thing is
static.

On iOS you will be prompted for Motion & Orientation access. If the prompt never
appears, check Settings → Safari → Motion & Orientation Access.

### Field procedure

1. Stand where the telescope sits, phone at roughly the optical height.
2. Hold it upright and still until calibration completes.
3. Turn clockwise at about 7°/s, following the instructions. Rotate your body
   around the phone rather than swinging the phone around you.
4. Close the loop, then work through the verification pass.
5. Read the report before exporting.

A tripod or a phone clamp on the mount gives a genuinely fixed optical centre and
is the highest-accuracy option, especially with a house close by.

---

## File formats

### HZN1 — 764 bytes, unchanged

Byte-compatible with the existing firmware.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | `HZN1` |
| 4 | 2 | sample count, uint16 LE |
| 6 | 2 | azimuth offset ×10, int16 LE |
| 8 | 4 | latitude, float32 LE |
| 12 | 4 | longitude, float32 LE |
| 16 | 4 | Unix epoch, uint32 LE |
| 20 | 24 | UTF-8 site name, zero padded |
| 44 | 720 | altitude ×2, uint8 |

The format cannot represent a missing sample — an unsurveyed bin would export as
0° and the mount would happily slew into a tree. The app therefore refuses to
write a `.hzn` until every bin holds a value and the report passes, unless the
override is ticked.

### HZN2 — 1504 bytes

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | `HZN2` |
| 4 | 2 | sample count, uint16 LE |
| 6 | 2 | azimuth offset ×10, int16 LE |
| 8 | 4 | latitude, float32 LE |
| 12 | 4 | longitude, float32 LE |
| 16 | 4 | Unix epoch, uint32 LE |
| 20 | 24 | UTF-8 site name, zero padded |
| 44 | 2 | site elevation, metres, uint16 LE |
| 46 | 1 | quality grade, 0–3 |
| 47 | 1 | format minor version |
| 48 | 2 | loop error ×100, uint16 LE |
| 50 | 2 | keyframe count, uint16 LE |
| 52 | 8 | reserved |
| 60 | 4 | CRC32 of the payload, uint32 LE |
| 64 | 720 | altitude ×2, uint8. **255 = not surveyed** |
| 784 | 720 | status in bits 7–6, confidence in bits 5–0 |

CRC verification is exercised in the test suite.

### `.horizon-project`

JSON. Site metadata, capture parameters, sensor health, the full report,
per-bin statistics, and every keyframe with its quaternion, corrections,
per-column boundary, per-column confidence, and flags. Optionally embeds
keyframe JPEGs.

---

## Layout

```
index.html          shell
styles.css          instrument styling
js/math3d.js        quaternions, projection, robust statistics
js/orientation.js   sensor fusion, compass auditing, yaw datum
js/camera.js        capture, frame normalisation, intrinsics
js/pipeline.js      worker orchestration with backpressure
js/survey.js        bins, observations, keyframes, loop closure, acceptance
js/guide.js         scan director state machine
js/render.js        survey ring, profile chart, live overlay
js/storage.js       IndexedDB sessions
js/exporters.js     HZN1 / HZN2 / project archive
js/log.js           field log
js/main.js          orchestration and UI wiring
workers/segment.worker.js   sky segmentation and boundary refinement
workers/vision.worker.js    visual registration
```


---

## Field fix log

### 2026-07-28 — calibration never completed

Symptom: turn rate read 371–2586°/s with the phone held still, so stillness never
rose, calibration never finished, and zero keyframes were captured. The log showed
orientation reporting frame-to-frame yaw deltas near ±175° while visual registration
correctly reported 0.5°.

Cause: `rawYaw()` read the DeviceOrientation `alpha` scalar. The ZXY Euler
decomposition is singular at beta = ±90° — which is precisely the pose this app is
held in. Two triples describe the same physical orientation there and the browser
alternates between them; `(30, 88, -3.4)` and `(210, 92, 176.6)` are the same pose,
and alpha-derived yaw differs between them by 180°.

Fix: yaw is now the azimuth of the camera forward axis taken from the quaternion,
which is continuous across that alias. Convention is unchanged, so datums and
keyframes recorded before and after remain comparable. Pitch rate no longer reads
`beta`, which flips across the same alias. A rate above 400°/s is now rejected as a
glitch rather than smoothed into the estimate. Covered by `tests/sim6.mjs`.

This one bug also explains why focal self-calibration never landed: it solves focal
length from visual shift against *measured rotation*, and the rotation was garbage.

### Lens selection

`Find lenses` enumerates the rear cameras and opens each briefly to read its
capabilities. `Use widest` prefers measured evidence — a zoom range starting below
1.0 identifies an ultra-wide — and falls back to the label only when the browser
exposed nothing to measure, saying which of the two it used. Android exposes each
physical lens separately; iOS generally presents one virtual rear camera, where
switching is a no-op. Switching discards the calibrated focal length, because
intrinsics belong to the lens.

### Field-of-view calibration

The FOV slider was always a seed, never a measurement. `Calibrate field of view`
now makes the solve explicit: pan slowly across a textured scene and the app
compares measured pixel shift against measured rotation. It reports sample count
and interquartile spread live, and refuses to adopt a result until the spread is
under 8% across at least 25 samples — a lens solved from consistent geometry
tightens, one solved from a drifting sensor or a textureless wall does not.
