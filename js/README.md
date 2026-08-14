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
js/panorama.js      diagnostic stitched panorama, reprojection + overlays
js/main.js          orchestration and UI wiring
workers/segment.worker.js   sky segmentation and boundary refinement
workers/vision.worker.js    visual registration
```


---

## Field fix log

### 2026-07-29 — startup stationary and physical-turn diagnostics

Startup now measures the sensors before any survey keyframes can be accepted.
The phone first rests screen-up and untouched for four seconds. The app records
raw x/y/z gyroscope mean, standard deviation and peak-to-peak noise, gravity on
all three device axes, gravity magnitude, sampling rate, orientation scatter,
and the measured angle between the screen plane and horizontal. A sufficiently
sampled stationary mean is removed as device-frame gyro bias.

The operator then rotates the still-flat phone clockwise through one physical
lap and presses Finish when it returns approximately to its starting direction.
The log records integrated gyro degrees, direction/sign, duration, compass and
orientation closure, flatness throughout the gesture, and the implied gyro
scale. Only an implied correction between 0.8 and 1.2 is applied; a larger
disagreement is evidence of an axis/pose/browser problem and is reported rather
than silently hidden. The phone is then lifted upright and held still to set the
normal survey datum.

`Copy log + sensor snapshot` now appends a complete current sensor, camera,
pipeline, capture, pre-flight, and platform snapshot before copying. The field
log retains 5,000 entries and renders its latest 1,000.

The deterministic regression is `tests/sensor-calibration.test.mjs`.

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


### 2026-07-28, 02:16 — still stuck on "Hold still", now on a tripod

Symptom: phone clamped to a tripod. Elevation 11.8° and roll −0.1° dead steady,
azimuth a stable 296.9° — and turn rate reporting 44.7°/s. Stillness stayed at
zero, calibration never completed, keyframes 0. The camera also swapped between
physical lenses mid-session, producing two frames seconds apart with completely
different focus and framing.

Cause, and it is a different bug from the one above: `rotationRate` was a
derivative between consecutive orientation samples. At 30–60 Hz that dt is
16–33 ms, so roughly a degree of ordinary magnetometer jitter becomes tens of
degrees per second. Position was fine; only its derivative was noise. A stable
reading with an unstable derivative is the signature.

Fix: rate is now a least-squares slope over a ~450 ms window, which divides the
noise by both a longer time base and √N. Residual scatter about that fit is kept
as `jitterDeg`, so the guide can say *"Sensor noise, not you"* instead of telling
someone on a tripod to hold still. Verified in `tests/sim7.mjs`: 1° of jitter now
reads 0.25°/s instead of 44.7, a real 7°/s rotation still measures 7.4°/s, and a
genuine stop registers within 800 ms.

**Calibration no longer blocks forever.** Calibration exists only to fix the
compass yaw datum — and the compass is the input this whole design already
treats as suspect, with the mount supplying the real azimuth afterwards. A phone
clamped to a steel mount head may never produce a quiet magnetometer, so
refusing to start blocks the entire tool on the one number that does not have to
be right. After 12 s it now proceeds on a relative datum, marks the compass poor,
and says so in the log.

**Lens swapping.** Android exposes a logical rear camera that the HAL may back
with different physical sensors, switching on its own as the scene changes. That
silently changes the intrinsics mid-survey: every focal length solved before the
swap is wrong after it, and registration across the swap is meaningless. Opening
by explicit `deviceId` (Advanced → Lens) pins one physical lens. A watchdog also
polls `getSettings()` once a second and, on a change, discards the calibrated
focal length and warns rather than carrying on with stale intrinsics.

**Night capture is now refused, not attempted.** Both field sessions were after
dark, and the traced lines in them are noise in black pixels. At night the
premise inverts — the sky is the dark region and the ground carries the bright
lights — so every cue the segmenter uses points the wrong way. Mean working-frame
luminance below 26/255 now raises `tooDark`, and the overlay draws nothing at all
in that state, because a line on screen reads as a measurement no matter what the
confidence chip says. Daylight, ideally flat overcast, is a requirement rather
than a preference.


### Pre-flight sweep — measuring the compass instead of calibrating it

A figure-8 gesture calibrates hard and soft iron: a constant bias and a fixed
distortion **in the device frame**. That is the one error this design already
discards, because the mount supplies real azimuth afterwards. It is also
uncorrectable in the case that matters most — a phone standing beside a steel
tripod sits in a distortion fixed in the **world** frame, which changes as the
phone moves through it and which no device-frame calibration can model. The
browser cannot trigger the platform's magnetometer calibration or read whether it
converged, so a gesture sold as calibration would be an unverifiable ritual.

`Run pre-flight sweep` measures instead. It is a compass swing, the same
procedure a ship's compass gets on a swinging berth: turn through at least 60°
across a textured scene while the app compares compass heading against its own
fused visual + inertial rotation — the reference the scan itself trusts. It
reports the **spread** of the residual across headings, not its mean, because a
constant offset is just the datum and is harmless; a residual that swings as you
turn is magnetic distortion, and that is what rotates parts of the profile
relative to others. The 5th–95th percentile span is used so one bad frame cannot
set the verdict, and a per-30° swing table says *which directions* are distorted,
distinguishing iron (varies smoothly with heading) from noise (scatters without
pattern).

Verdicts: under 5° good, under 15° fair — a rough starting azimuth only — and
above that the compass is dropped for a relative datum, because a
direction-dependent error is worse than no compass at all. The sweep never
blocks the survey.

The same gesture solves the focal length, since pixel shift against measured
rotation needs exactly the same motion over exactly the same kind of scene. The
separate FOV calibration button is gone; one sweep now returns compass verdict,
orientation jitter, and field of view with its spread.

Classification is verified in `tests/sim8.mjs` against synthetic environments:
a constant 137° bias does not change the verdict by more than 0.5°, a 12° swing
is caught, a 30° sweep correctly refuses to rule, and a single wild outlier is
rejected by the percentile span.


### 2026-07-29 — the first full survey, and why its profile is not usable

The report read 360.0° of 360.0° observed, 39 534 observations, 54 per bin — and
0 of 720 verified, 19.74° maximum spread, 13 spike bins. The pass-1 counter said
"0° of 360°" the whole way round while the ring filled completely.

That combination has one explanation: **azimuth was advancing on a random walk.**
The log recorded orientation jitter of ±57°, a compass datum spread of 154.8°,
and 7913 of 7956 compass samples rejected. The app knew the magnetometer was dead
and still blended 25% of it into every fused step, and fell back to *100%* of it
whenever visual registration failed — which at 50–86°/s was often, because motion
blur kills registration. Zero-mean noise integrates into a walk that eventually
visits every azimuth, so coverage looks complete while no bin points where it
claims. Signed travel stays near zero, which is why the counter never moved: it
was the one honest number on the screen, and the acceptance report was right to
grade the result INSUFFICIENT.

Cause: the app had no gyroscope. It derived "gyro" rotation from
`deviceorientationabsolute`, which fuses the magnetometer, so its yaw swings by
tens of degrees while the phone sits still. Relative rotation was being taken
from the one sensor that cannot supply it in a back yard full of gutters,
wiring, cars, and a steel mount head.

Fix: a `devicemotion` listener now integrates `rotationRate` — the raw
gyroscope, which no magnet touches — projected onto the world vertical. It
drifts, and drift is precisely what loop closure already exists to distribute; a
slow bias is recoverable in a way that a magnetometer swinging by 69° is not.
Where there is no gyroscope *and* the compass is condemned, azimuth no longer
advances at all: the frame is marked `trackingLost`, no keyframe is written, no
observation is recorded, and the overlay draws nothing while the operator is
told to stop turning. Reproduced and verified in `tests/sim9.mjs` — the old
fusion manufactures 99.3% coverage from pure noise, the new one tracks real
rotation to within 1°.

**What did work.** Segmentation in daylight was solid: 73.4% mean confidence,
and the roofline traces in the field screenshots are clean across the sky-facing
portions. Frames dropped: zero on both workers. The failure was geometry, not
vision.


### Multiple lenses behind one logical camera

The Pixel exposes a single rear `videoinput` — the field log shows exactly one,
"camera 0, facing back" — backed by several physical sensors that the platform
picks between on its own. So lens pinning by `deviceId` does nothing here, and a
swap changes nothing that `getSettings()` reports. This is handled in three
layers rather than one:

1. **Reduce the chance.** The HAL chooses mainly on zoom level and focus
distance, and a horizon survey is the easy case: everything is at infinity and
nothing needs zoom. Zoom is now pinned at 1.0 and focus at the lens's infinity
stop where the browser honours those constraints.

2. **Detect it from the imagery.** Main and ultra-wide differ in focal length by
30–40%, so the pixel shift produced by a given rotation changes by that factor
the instant a swap happens. A step of more than 18% in the running focal
estimate is a lens change. This only works because rotation now comes from a
gyroscope — `tests/sim10.mjs` shows the same detector firing six false alarms
against magnetometer-grade rotation noise, and exactly once with a clean gyro.

3. **Survive it.** Every keyframe stores the intrinsics it was captured with, and
reprojection uses those rather than one global focal length. A swap at 200° no
longer misprojects the first 200°; it just starts a new focal segment. The count
and ratio of any swaps appear in the report.

The FOV presets (Pixel main 82°, ultra-wide 107°) are seeds only. The pre-flight
sweep still measures the real value, and 82° versus the old 66° default is a 24%
error in every altitude — worth setting even before the sweep runs.


### 2026-07-29, 21:27 — a physical lap logged as 176°, and constant "sensor noise"

Four faults, three of them mine and one of them mine twice.

**1. The lens was the ultra-wide, and the app was told 66°.** Invert the ratio:
176/360 = 0.489, which against an assumed 66° field implies a true field of about
**106°**. That is not the main camera. The `_lockOptics` call added the day before
asked for manual focus at the lens's *furthest* focus distance — and the Pixel
answered with the lens that focuses closest to infinity. My own "reduce the
chance of a lens swap" change caused a lens swap. It now requests continuous
focus only and leaves lens choice alone.

**2. My FOV preset button was wrong.** A camera advertised at 82° is quoting the
**long** sensor axis. Held portrait — which is correct, and what the app assumes —
the horizontal axis of the frame is the **short** one, about 52°. Neither 66 nor
82 belonged in that slot. The presets now read 52° and 76° and say which axis
they mean.

**3. Vision was setting the scale, which it cannot do.** The gyroscope reports
real degrees per second with no unknown scale. Vision reports *pixels*, and
pixels become degrees only through the focal length — the one quantity nobody
knows at the start. Running vision at 75% weight multiplied every azimuth by an
unknown constant. The gyroscope now sets the magnitude outright and vision gets a
veto, not a vote: `tests/sim11.mjs` shows a lap holding at exactly 360° across
assumed fields from 40° to 107°, where the old scheme ranged from 291° to 834°.
An intermediate version of this fix that blended in 15% of the visual term still
stretched a lap to 455°, which is why the weight is now zero rather than small.

**4. "Sensor noise" the whole time.** Stillness and jitter were still being
measured from the magnetometer-fused yaw — a signal the survey had stopped using
for rotation entirely. It reported ±46° of jitter on a phone standing still and
then told the operator to hold still about it. Motion is now measured from the
gyroscope where there is one.

**The speed limit was invented, and it was wrong by most of an order of
magnitude.** The real constraints are frame-to-frame overlap and motion blur. At
~10 Hz processing through a 52° field, even 90°/s leaves 83% overlap, and daylight
exposure of ~1/500 s smears a feature by half a pixel in the 160 px registration
frame. Neither is remotely threatened at 7°/s. Ideal is now 25°/s — a lap in about
fifteen seconds — with a hard stop at 70°/s, and the actual gate is measured
registration quality rather than a number.

**A finished lap is now a result.** Two acceptance checks cannot pass until a
second pass has been walked, so a complete first lap was being graded
INSUFFICIENT — telling the operator their work was worthless when it was usable
and merely unconfirmed. A full circle that passes every structural check now
grades **PROVISIONAL**. The "close the loop" button also unlocks on bins observed
as well as on the travel counter, so a covered ring is never trapped behind an
accumulator.

**And the fix that makes the field of view stop mattering: one physical lap is
360° by definition.** So a lap logged as 176° is not off by an offset, it is off
by a *factor* of 2.045 — and since the only thing that scales a visually derived
rotation is the focal length, that ratio hands back the true focal length for
free. Loop closure now rescales the survey and adopts the derived field of view,
recovering 106.1° from exactly the numbers your run produced. Implausible ratios
are refused rather than baked in.

On the suggestion of laying the phone flat and turning a circle to calibrate: that
is a sound instinct, and it is what the pre-flight sweep does — but it calibrates
the *compass*, and the compass no longer sets rotation. With the gyroscope
leading, the magnetic environment stops mattering for anything except the
starting azimuth, which the mount supplies anyway.

### 2026-07-29, later — the analysis frame is not the sensor, and a stitched view to prove it

**The field of view was wrong by the aspect crop, and it inflated every
altitude by a third.** The stream is requested at 1920x1080 and `_drawRotated`
scales it with a *cover* fit into the 384x288 analysis frame. 16:9 into 4:3
discards 25% of the width before anything is measured, so the analysis frame
spans 0.75x the sensor's horizontal field. `intrinsics()` treated `hfovDeg` as
the sensor figure regardless, and since `tanHalfV` is derived from `tanHalfH`,
the error landed squarely on altitude:

| | true, analysis frame | as computed |
|---|---|---|
| tanHalfH at the 76° preset | 0.586 | 0.781 |
| tanHalfV | 0.439 | 0.586 |
| vertical field of view | 47.1° | 60.3° |

Every altitude read 1.33x high. A 15° treeline logged as 20°.

The fix is at the input boundary, not in the projection. Everything that
*measures* the frame was already right: `adoptFocal` solves focal length in
`WORK_W` pixels, the overlap and step calculations use the analysis frame, and
loop-closure rescaling derives the analysis frame's field from the lap ratio.
Only the two human-input paths — the slider and the presets — were feeding a
spec-sheet number straight into a frame-relative quantity. `cropFactor()` now
measures the surviving fraction per axis from the live video dimensions, and
`setSensorHfov()` converts a sensor figure into the frame's before storing it.
`setHfov()` keeps its old meaning, so the measuring paths are untouched. The
readout shows both numbers, and the log records the crop when a preset is
tapped. This also explains part of the old 176° lap: some of that factor was
the crop, being absorbed into the focal estimate as though it were optics.

Not verified on hardware. The crop factor is computed from
`videoWidth/videoHeight`, so if a browser hands back a resolution that differs
from what it actually streams, this is wrong in a new way.

**A stitched diagnostic, because a confidence number cannot be argued with and
a picture can be.** `js/panorama.js` reprojects the stored keyframe JPEGs into
an equirectangular azimuth/altitude mosaic through the identical path as
`Survey._projectKeyframe`, then draws every skyline the survey believed on top
of the imagery it came from, with the committed profile, the bin-status strip,
and an azimuth ruler with cardinals.

Each output pixel is taken from **one** keyframe — whichever saw it nearest its
optical axis — and not from a blend. This is the whole design. Blending averages
a geometry error into a smooth surface that looks correct; leaving the frames
unblended turns the same error into a hard step whose size reads off the
azimuth scale. Three faults become distinguishable by eye: a step at a frame
boundary is geometry, a fanned band is detection, an early wrap is scale.

Verified in `tests/panorama.test.mjs`. `worldToImage` inverts `cameraRay` to
1.3e-15. Against a known horizon the painted skyline lands at median 0.086°,
p95 0.220°, max 0.420° — the wall columns at 150° and 215° are excluded and
counted separately, since at a vertical discontinuity a pointwise comparison
measures which side of the wall the sample fell on rather than projection
accuracy. The overlay sits on the mosaic's own painted boundary for 98.0% of
13 529 sampled points.

`tests/panorama-render.mjs` injects the crop bug and renders both cases:
inter-frame skyline disagreement goes from **0.18° median to 4.32° median**
(p95 25.6°), a 24x separation obtained **without any ground truth**. A focal
error cannot be made self-consistent, so frames that overlap disagree, and the
disagreement is the signal. `disagreementByBin()` reports it per azimuth and
the findings panel prints the worst directions as a re-walk shortlist.

Geometry-only mode works when no thumbnails were stored, so existing archives
can be re-examined; the numbers hold, but the picture cannot show why.

**Also fixed:** `index.html` had a `<div class="row">` closed by `</label>`,
which left the document unbalanced. The five duplicated field-of-view readout
updates are now one `syncFovReadout()` that maps the analysis frame's value
back to sensor terms before writing it to the slider — writing the frame value
straight into a sensor control would have been a fresh instance of the same
confusion.

### 2026-07-29, still later — the scan now keeps its own pictures, and the profile can be checked against the world

Two gaps in the panorama as first written.

**It was gated on a checkbox about something else.** Keyframe images were only
stored when "Embed keyframe images in archive" was ticked — a decision about
export size — so a survey run with it off could not be diagnosed afterwards at
all. Storage and export are now separate: every keyframe records an image
regardless, and the checkbox only decides whether those images travel inside the
`.horizon-project` file. The budget is explicit rather than discovered: 600
frames or 40 MB, whichever comes first, and reaching it is logged, because a
survey that quietly filled the origin's quota would take the profile down with
it.

**And the picture could not be checked against anything outside itself.** The
mosaic, the ring and the profile are all rendered from the same azimuth
estimate, so they agree with each other no matter how wrong that estimate is.
Imagery is painted at the azimuth the app believes; a uniformly offset or slowly
drifting azimuth therefore produces a panorama that looks entirely correct while
pointing the wrong way. The seam analysis catches errors of *scale*, because a
wrong focal length cannot be made self-consistent, but it is blind to this.

Tapping a recognisable landmark in the stitched view now records the azimuth the
survey assigned it, and a true bearing taken off a map can be typed beside it.
The residual is the survey's error in that direction.

The mean and the spread of those residuals are reported separately and must not
be averaged into one verdict, because they mean opposite things:

- a **constant** residual is the datum. The mount cancels it with one azimuth
  offset and the geometry underneath is sound.
- a residual that **varies with bearing** is drift or magnetic distortion. It
  rotates parts of the profile relative to other parts, so no single correction
  fixes it, and the profile is not usable as a pointing limit however complete
  it looks.

One landmark cannot tell these apart — any single residual is explained equally
well by either — so the summary refuses to interpret until there are two, and
says why.

`tests/landmark.test.mjs` covers the separation and the wrap case that would
otherwise pass silently: landmarks at true 2° and 358° measured at 358° and 2°
give residuals of +4° and −4°, so the **mean is exactly zero** while the spread
correctly reports 8°. A mean-only check would have called that survey perfect.
Also verified: a 7.5° pure offset recovers as mean 7.5° with zero spread; 12° of
drift around the lap recovers as a 10.7° spread with the worst outlier at an
extreme bearing; rows missing either bearing are ignored rather than counted as
zero.

Landmarks carry the geometry they were placed against. If the yaw datum, the
keyframe count or either end's focal length changes afterwards — loop closure, a
lens change, a fresh self-calibration — the stored azimuths no longer describe
the same physical objects, and both the summary and the log say STALE rather
than showing a quietly wrong residual.

Not verified on hardware: the true bearings are only as good as what a map gives
you, and a landmark a few metres away has its own parallax between the map
position and the phone position. Distant landmarks are worth much more here than
close ones.

### 2026-08-12 — the skyline gets a continuity prior, and calibration stops dead-ending

The headline open problem (each image column solved independently) is closed.
`segment.worker.js` now runs a dynamic-programming minimum-cost path across all
384 columns: unary cost from edge strength plus a sky-above/ground-below region
term, transition cost linear in the jump but capped. The cap is the spike/step
distinction expressed as geometry — a real wall edge pays the cap once and
follows the wall; a one-column excursion to a cloud pays it twice and loses.
The old 7-tap median veto, which replaced any column deviating more than ~23 px
from its neighbours (i.e. flattened real building edges at the frame level,
before survey.js ever got to judge them), is gone; the DP prior replaces it.

The independent cross-check estimator (`colEdge`) now takes the *strongest*
vertical gradient per column instead of the *topmost* one over a threshold.
The topmost rule fired on any cloud edge, wire or branch above the true
horizon, which collapsed `cAgree` and with it every column's confidence — the
suspected cause of "0 of 720 verified" on partly cloudy days.

`tests/sim12.mjs` is the ground-truth stress test: bright cloud with a hard
under-edge, tall wall, dark storm cloud, and the compound scene. The dark
cloud is the decisive case — it breaks the top-connected sky component, so the
old detector put the horizon at the cloud top, 126 px (~40°) above truth; the
DP path holds to 0.7 px. Verified both ways: the old worker fails this test,
the new one passes, and all pre-existing sims still pass (sim.mjs: 720/720
verified, p95 error 0.123°; segmentation 10.5 ms/frame, was 5.6).

Calibration no longer dead-ends into a page reload, which in the field cost
the camera grant, the lens pin, and any preflight work. A failed rotation test
now offers Retry in place; a full *clockwise* upright turn (magnitude, raw
axis and closure all valid, sign positive) is recognised as a wrong-way turn
and redoes only that step with a "turn LEFT" prompt. The escape hatch from the
handoff (§4.7) is restored as a secondary "Continue anyway — azimuth
unverified" button, offered only while the gyro is producing samples, logged
loudly as SENSOR_TEST_SKIPPED.

Diagnostics: a "Share debug bundle" button in the field-log card builds one
plain-text file — state snapshot, lens inventory, acceptance report, complete
field log — and hands it to the Android share sheet (`navigator.share` with
files), falling back to a download. This is the one-tap path from a failed
field run to a file another engineer can actually diagnose.

Also: the five sim tests that loaded workers via `new URL(...).pathname` broke
on Windows (`C:\C:\...`); they use `fileURLToPath` now.

Not verified on hardware: the DP path on real imagery (synthetic scenes have
cleaner statistics than a real sensor at dusk), and the share sheet on the
target phone.

### 2026-08-12, later — first hardware run: the axis permutation is real, and so is a fake bias

The first field run on the target phone (Android 10, Chrome 151) produced the
exact §4.2 signature on fresh data: the flat spin integrated +330° on raw
gyro y where flat-on-a-table physics demands z, and the upright sweep +376° on
raw z where it must be y. The operator's turns were fine; the projection onto
world vertical caught only -43°/-135° of them, calibration failed, and — via
the skip path — one physical lap logged as 660°, spread 56°, 78 spike bins,
0/720 verified, and a scrambled panorama. Segmentation confidence was 65% at
dusk; the detector was not the problem this run. Azimuth was.

Two fixes, both verified against the run's own logged vectors:

`solveGyroAxisMap()` now exists (the handoff described it, but it had never
been implemented here). During a spin about vertical the angular-velocity
vector in the device frame must be parallel to vertical in the device frame;
both come from the same event stream, so disagreement is the frame error. All
48 signed permutations are scored against the mean gravity direction of each
spin; ties on axes that carried no rotation break toward the spec mapping. On
the logged vectors it recovers the y/z swap ([0,2,1], all +) and both spins
project to 330°/376°. It is invoked as a recovery path when the upright
validation fails, applies the map to all subsequent rates (after bias
subtraction, which stays in the raw frame), and re-derives the gyro scale from
the remapped flat turn. Sign assumption: both turns counter-clockwise as
instructed — a CW-turning operator on a permuted device is undetectable from
gyro+gravity alone and lands on the landmark check, which is logged with the
map. `tests/gyro-axis.test.mjs` feeds the actual field vectors.

The stationary bias gate: the same run measured "bias" of 8.6°/s with
25-31°/s of noise, because the phone was in the operator's hand at ~59° tilt
for the whole "lay flat, don't touch" stage — the old gate checked one
instant and passed on a null gravity reading. The stage now requires 4 s of
SUSTAINED flat-and-still (a null reading waits instead of passing), the UI
says "put the phone DOWN" and explains the timer only runs while it is still,
and `finishStationaryDiagnostic` refuses any bias measured with noise over
6°/s, pose wobble over 4°, or magnitude over 3°/s — zero bias plus loop
closure beats a hand-tremor bias every time. If no flat surface exists, it
proceeds after 25 s without a bias rather than trapping the operator.

The calibration turns explicitly do not need to be exact and the UI now says
so: axis identification needs direction, not magnitude; scale tolerates ±25%
and loop closure absorbs the rest.

Not verified on hardware: the solved map driving a real survey end to end.
The next run at the same site is the test — expect pass-1 travel near 360°,
spread collapsing, and a panorama that reads left to right.

### 2026-08-12, night — humans are not robots: the calibration bends to the operator

Two more field bundles (23:37, 23:41), five clean turns, zero surveys started.
Every turn the operator made was a full circle on the correct raw axis —
330-411° — and the app failed all of them. Three causes, all ours:

1. The "held still" timer only armed if the phone had been UN-still at least
   once. Set it down before tapping Start — the diligent case — and it waited
   out the full 25 s fallback, then printed "never settled" at a phone whose
   gyro noise was 0.02°/s. Fixed: the timer arms on the first still tick.

2. The axis solver averaged gravity over the whole spin window. A human picks
   the phone up, turns while holding it tilted ~40° toward their face, lowers
   it to press Finish; averaged flat idle seconds swamped the tilted turning
   seconds and both spins looked like the same pose ("poses-too-similar",
   five times). The solver now accumulates alignment PER SAMPLE, weighted by
   rotation rate — the pose during the turn is the only pose that counts. No
   flatness requirement, no exact 360, no robot poses; the two turns just
   have to be in noticeably different holds, which they naturally are.

3. The old identity-path validation (projected magnitude + closure + CCW
   sign) is gone entirely; the solver judges every device the same way, with
   identity as just another candidate. Acceptance is 240-500° of aligned turn
   carrying at least 45% of the total rotation. A sign-only flip on a
   spec-compliant device is handed back as "you turned clockwise" rather than
   silently mirroring azimuth.

Also: the flat-spin log no longer proposes a "scale" of 215x when the
projection misses a permuted turn (it says what is actually happening), and a
worker that fails to LOAD (stale cache right after a deploy — seen once in
the 23:37 run) now says to refresh instead of "failed: undefined".

`tests/gyro-axis.test.mjs` reconstructs the human gesture — idle, tilted
turn, idle — against the swapped-axis device model and requires it to solve.

Not verified on hardware: this solver on the target phone. The bar for the
next run: put the phone down at Start (4-5 s, not 25), two casual left-hand
circles, and the log should show SENSOR_AXIS_SOLVE status "remapped" with
both projections near 360.

### 2026-08-13 — three axes, and the end of the precision exam

Two more bundles (23:37, 23:41) and still no survey. Five clean turns across
them, every one refused. The operator's verdict was correct and worth writing
down: *"these tests are done by human beings not robots, you need to accept
some error and not deal with these tests as absolute truth."*

Three things were wrong, and only the third was subtle.

1. The stillness timer only armed once the phone had been UN-still. Set it
   down before tapping Start — the careful thing to do — and it waited out the
   full 25 s fallback and then said "never settled" at a phone reading 0.02°/s
   of noise. One line.

2. The upright turn had been mislabelled "pitch" in the guidance. Upright, top
   at the zenith, turning on the spot is rotation about the phone's LONG axis,
   which is roll. Pitch is the only motion that had never been tested, because
   pitch requires going end over end.

3. That omission mattered far more than the naming. During both turns about
   vertical, gravity sits still in the device frame, so those motions can only
   ever say "the rotation was about the up axis" — never which way it pointed,
   and never how big a degree is. Everything else was being reconstructed from
   the assumption that the operator turned exactly 360° exactly counter-
   clockwise, which is the assumption that made the whole thing feel like an
   exam. In an end-over-end tumble gravity SWEEPS through the device frame,
   and that sweep is ground truth.

So calibration is now three motions, one per device axis, named as the
standard phone diagram names them — yaw about Z, roll about Y, pitch about X —
and each is shown as a drawn figure of the phone in its pose, because "upright"
and "end over end" do not survive being written down.

The solver was rewritten around one equation of rigid-body kinematics:

    du/dt = -(ω × u)

where u is world-up in the device frame. Every motion sample is one equation;
u comes from the orientation stream and ω from the gyro, two independent
sensors that must agree, so where they disagree IS the frame error. All 48
signed permutations are scored on total violation, normalised by rotation.
On the field phone's y/z swap the correct map scores 0.007 against 0.51 for
the next-best axis order — a factor of seventy, from motions with ±9°/s of
simulated hand wobble and circles of 340° and 385°.

What this bought, concretely:

- **No target angle.** 250° and 470° circles solve identically. Nothing is
  scaled from "that was meant to be 360°" any more.
- **Gyro scale measured, not assumed.** The tumble's gravity sweep is the
  reference: a gyro reading 10% high is recovered as 0.9092 against a true
  0.9091, from ragged circles that were never near 360°.
- **No pose requirement.** The flat/tilted pair that produced five straight
  "poses-too-similar" refusals now solves at residual 0.007. The flatness
  gates are gone entirely.
- **Turning the wrong way stops being a failure.** Any real hold wobbles, and
  two degrees per second is enough for the kinematics to fix every sign on its
  own; the direction turned is then merely noted in the log. Only on a hold
  steady enough to have no wobble at all do the signs genuinely tie, and there
  the map leans on the instruction and says so (`assumedDirection`).
- **No test passes or fails alone.** Evidence is collected from all three and
  judged once. The Finish button is never disabled.

Honest limits, since they are real. Two turns about vertical with zero wobble
are mathematically indistinguishable from the same turns the other way with
two axes inverted — no cleverness recovers that, only the instruction. And a
browser whose sensor fusion cannot track a fast tumble will produce a large
residual for every candidate and be told "unsolved, turn more slowly", which
is why the figure asks for a few seconds per turn.

Not verified on hardware: all of the above is simulator work, against a
rigid-body model integrating a quaternion so the gyro reading and the gravity
direction come from one consistent state. The bar for the next field run is a
log line reading `SENSOR_AXIS_SOLVE` with status remapped, `decidedBy`
kinematics, and a residual under about 0.2.

### 2026-08-13, 01:29 — confirmed on hardware, and my prediction was wrong

First calibration this phone has ever completed. `SENSOR_AXIS_SOLVE` reported
status `remapped`, `decidedBy: "kinematics"`, `assumedDirection: false`,
residual 0.23 against 0.70 for the next-best axis order, scale 1.0112 applied
from the tumble's gravity sweep. The stationary stage took 3.97 s instead of
timing out at 25.

The wiring is NOT the y/z swap predicted from the 23:37 logs. It is a
three-way cyclic rotation, `perm [2,0,1]`:

    reported beta  carries ω_y
    reported gamma carries ω_z
    reported alpha carries ω_x

Each of the three motions lands on exactly the axis it should once that map is
applied — yaw's 356° on device Z, roll's 341° on device Y, pitch's 378° on
device X — and the alignment about vertical comes out 372° / 344° / 14°, the
last being the tumble, which must be ~0 and is. Determinant +1, so this is a
real mounting rotation and not a mirrored triad.

Why the earlier guess was wrong is worth keeping: it was read off two motions
that were never as distinct as their labels claimed. The old "upright" spin
logged `flatnessMean 12°` with `meanGravity` still 0.80 along device Z — the
phone was nearly flat for both tests, so the pair genuinely could not tell a
transposition from a rotation. Three deliberately different motions can. That
is the whole argument for the third test, restated as evidence.

Real-world residual floor is around 0.2, an order of magnitude above the
simulator's 0.007, and the causes are visible in the bundle: gravity is
quantised to 0.1 m/s² (~0.6° of angle) and the gyro to 0.1°/s, the motion
stream runs at 34-43 Hz, and the browser's fusion lags a fast tumble. The
`unsolved` gate at 0.6 leaves comfortable headroom, and the discriminator that
actually matters — the gap to the next axis order — was 3x.

Also fixed here: `lockDatum` logged a 56.3° compass spread as a quiet INFO
line. That number is the accuracy of every absolute bearing in the finished
profile (±28° in this run) while the survey otherwise reads healthy. It is now
a WARN naming the consequence and pointing at the landmark tool, and the
acceptance report carries a `Bearing datum` line so it survives into the
export.

### 2026-08-13, later — the three tests become one: wave the phone about

Calibration had just succeeded on hardware for the first time, and the
operator's verdict was still *"the way to spin it end over end was very
confusing, i may have spun it the wrong way, its a lot."* Both halves of that
are worth separating.

The worry was unfounded: the tumble's direction never mattered. That run logged
`assumedDirection: false`, meaning the sign came from the way gravity swept and
not from any instruction. But an instruction the operator has to worry about is
a bad instruction even when it is ignorable, and "a lot" is a straightforward
design failure.

So the three posed tests are gone, replaced by one unchoreographed motion:
hold the phone and turn and tip it every which way. No poses, no directions, no
circles to count, no naming of axes.

The physics prefers this, which is the part worth recording. The solver only
ever needed every reported gyro axis to turn a little while gravity moved. In
the posed version gravity sat *still* through two tests out of three — that was
why signs could tie and why the "turn left" assumption existed at all. Waved,
gravity moves continuously, so every sign is pinned by kinematics on every run.
Measured over the simulation grid: `assumedDirection` was false in 20 runs out
of 20, and the median residual fell from 0.23 (posed, on hardware) to 0.013.

Two solver changes were needed, both found by simulating what the field bundles
actually show this hardware doing — 0.1 quantisation on both streams, and a
fused orientation estimate that lags and jitters:

- **A rate floor.** Below ~20°/s the orientation stream's own jitter produces
  more apparent gravity movement than the real motion does. A degree of jitter
  across a 20 ms step reads as 50°/s of phantom du/dt. Those intervals are now
  skipped, which also discards the idle seconds at either end of any motion.
- **A wide gravity baseline.** Gravity's movement is measured across ~100 ms
  rather than between neighbouring samples, so jitter falls by the ratio of the
  spans while the signal does not. This was the big one: gentle waving at high
  sensor lag went from 21/30 to 30/30, the whole grid from 155/200 to 195/200,
  worst residual roughly halved, and the measured gyro scale error dropped from
  0.031 to 0.003. The cost is a chord-versus-arc approximation, under 1% even
  at 200°/s.

The app now solves live, several times a second, on the samples arriving as the
operator waves — thinned to ~260 intervals, 3 ms a call against 8 ms for the
full set for an identical answer. So there is no button to press at the right
moment and no way to finish too early: it watches, says what is still missing,
and stops when it is sure. Median time to convergence in simulation is 4
seconds.

The property that governs all of it, asserted in `tests/gyro-freeform.test.mjs`
across 200 runs spanning 25-220°/s and 0-220 ms of orientation lag: **a wrong
map is never returned.** Every failure is a refusal. That is what makes it safe
to remove the instructions — a silently transposed axis map would corrupt every
azimuth in a survey while the report still read healthy, so the only acceptable
failure is one that asks the operator to wave again.

Guidance inverted along the way, and the old advice was actively wrong: brisk
waving is *better* than slow, because jitter is a fixed angular error while the
signal scales with rate. The screen now says so.

Not verified on hardware. The bar for the next run is `SENSOR_AXIS_SOLVE` with
`decidedBy: "kinematics"`, `assumedDirection: false`, and the same
`perm [2,0,1]` this phone has already produced once.

### 2026-08-13, 22:46 — a 5% gyro scale is a 26° azimuth error

First run to reach the far side: 356° of 360° covered, 712/720 bins, 5291
observations, calibration solving to the same `perm [2,0,1]` with margin 0.768.
What remained was ugly: maximum spread 66°, 87 spike bins, and a panorama in
which the neighbouring house fanned out across a third of the circle.

Both trace back to one number. `gyroScale` came out **1.0538** here against
**1.0112** from the same phone four hours earlier. Gyro scale is a fixed
property of a device; a 4% swing between runs is a measurement fault, and it
multiplies every azimuth the survey records. Pass 1 travelled 489° — 1.36 laps
— so bins near the start were visited twice with up to 26° of accumulated
azimuth error between visits. At the vertical edge of a close, tall house the
true skyline falls from ~45° to ~5° within two or three degrees of azimuth, so
a 26° misplacement writes roof altitudes into open-sky bins. That is the 66°
spread and the 87 spikes, and it is not a detector failure: mean segmentation
confidence was 60% and the clipped-column and no-sky gates all did their jobs.

Why the scale was wrong: it was a ratio of sums over the tumble, and that run's
tumble peaked at 396°/s. Two errors compound at that speed — the fused
orientation stream cannot keep up, and `du` measures the CHORD across gravity's
arc rather than the arc itself, which understates fast motion. Fixed by:

- taking the weighted **median of per-interval ratios** rather than a ratio of
  sums, so a handful of badly tracked instants cannot set the answer;
- correcting chord to arc explicitly — `arc = chord · (θ/2)/sin(θ/2)`, where θ
  is the angle turned across the gravity baseline, known from the gyro. The
  first instinct, rejecting the fast intervals, made things *worse*: it keeps
  only the slow ones, where jitter dominates. Measured: median error at 450°/s
  went 1.3% high under rejection versus 1.1% with correction, and the low bias
  at speed disappeared;
- reporting `scaleSpread` and refusing a scale whose own intervals disagree.

Measured across paces and sensor lags, median error is now **0.32%** at normal
speed and 1.1% at a violent 450°/s, against the 4% swing the field produced.

What is NOT fixed, because it cannot be: the near house fans in the panorama
because of **parallax**. Turning on the spot orbits the camera around the
operator's spine, perhaps 0.4 m out; a house 4 m away therefore shifts about 6°
between adjacent keyframes, and no stitcher recovers that from a single
viewpoint. It is a property of the geometry, not a bug, and it affects imagery
only — altitudes come from camera geometry and gravity and are untouched.

Not verified on hardware.

### 2026-08-13, 23:06 — a full lap, and the field of view is the last big error

First complete survey: **360.0° of 360.0°**, 720/720 bins observed, 5737
observations. The one-motion calibration worked on the first try — five seconds
of waving, `decidedBy: kinematics`, `assumedDirection: false`, the same
`perm [2,0,1]` this phone has now produced three times, residual 0.208 against
0.706 for the next axis order.

Two of the new guards fired correctly and are worth recording as successes: the
bias was **refused** (`not-still, gyro noise 27.8°/s`) because the phone was
never set down, and the scale was **refused** (`scaleSpread 0.1455`) because the
motion was frantic — 1598° of turning in 5 s, peaking at 645°/s, far past what
the fused orientation stream can track. Both refusals are the right call, and
both cost nothing: zero bias and unit scale are the safe defaults. The screen
now needs to say "briskly, not frantically"; the previous advice only had a
lower bound.

What remains is one number, and it is large. `visualScale` settled at **2.642**:
the imagery and the gyroscope, measuring the same rotation, disagree by that
factor. Since `dVis = atan(dx / focalAssumed)`, a ratio above 1 means the true
focal is LONGER than assumed — the frame spans about **27.6°**, not the 66° in
use. The sanity check lands in the same place: 66° is a LANDSCAPE figure, and
this stream is portrait 1080×1920, so the short side of a nominal 66° lens
subtends about 40°. The app has been applying a long-side number to a short
side.

That single error explains the rest of the report:

- Altitudes are overstated by roughly 2.6x — a point 60% up the frame is
  reported at 16.3° when it is really 6.3°. The house reading 55-60° is not.
- The error GROWS toward the frame edges, so the same skyline point read from
  two keyframes that happened to catch it at different in-frame positions
  disagrees by tens of degrees. That is what the 50.13° maximum spread and the
  51 spike bins are made of — not detector failure, not azimuth drift.
- Loop closure could not match, because the visual search hint is scaled by the
  same wrong focal length.
- The panorama's fanning near the house: frames projected 2.6x too wide cannot
  align with their neighbours. Parallax is real but second order next to this.
- Azimuth is untouched, because it comes from the gyroscope.

The app had measured all of this and said so in one ambiguous report line
("field of view is understated by 164%") while the profile looked plausible.
Now it warns during the scan, names the measured figure in degrees, states the
consequence, and says which control to set. The self-calibration path
(`survey.addFocalSample`) never adopted it because its gate needs
`quality >= 0.6` on twelve samples and this scan mostly ran at 0.25; the
`visualScale` estimator, gated only on confident frames but not on the other
four conditions, accumulated fine. Adopting from `visualScale` automatically is
the obvious next step and is deliberately NOT taken here — it multiplies every
altitude, so it should be verified against a lens scan on hardware first.

Not verified on hardware.

### 2026-08-13, later — measuring the lens instead of guessing it

The operator's objection to being handed "set it to 28°" was correct, and it
was the right instinct twice over: a number inferred passively from a survey
that was mostly running at 0.25 match quality is not a measurement, and nobody
should have to take it on faith.

So `js/lenscal.js` measures it, from the oldest relation there is:

    pixels = focal · tan(angle)

Rotate the camera by a known angle, see how far the picture moved. What makes
it trustworthy is where "known angle" comes from, and the two axes deliberately
take it from different places:

- **Horizontal**, from panning: the angle comes from the gyroscope, which by
  this point has had its axes solved and its scale checked.
- **Vertical**, from tilting: the angle comes from **gravity**. Nothing in this
  app is more trustworthy than which way is down — it needs no calibration,
  cannot drift, and no magnetic junk can reach it.

That second one is the point. Altitude is the quantity this whole app exists to
report, and altitude depends on the VERTICAL half-angle, which until now was
never measured at all: `tanHalfV = tanHalfH · (WORK_H/WORK_W)`, derived from the
horizontal through an assumed pixel aspect and crop. The most important number
in the survey rested on the one part of the model nothing ever checked. It is
now measured directly against gravity, and `camera.setMeasuredLens` keeps the
two independent.

Measured against a simulated pinhole camera with realistic matcher noise:

| true FOV | recovered | uncertainty |
|---|---|---|
| 27.6° (the field lens) | 27.51° | ±0.18% |
| 40° | 40.27° | ±0.26% |
| 66° | 66.79° | ±0.47% |
| 95° | 94.42° | ±0.93% |

With one pair in five being a bad match and double the noise, worst error across
twelve sessions was 0.70°. A camera whose vertical does not follow from its
horizontal (50° by 20°) is recovered on both axes, where the derived model would
have claimed 39.2° against a truth of 20° — which is the failure mode this
exists to catch. Thin evidence is refused rather than guessed: a still phone
yields nothing, two seconds is not enough, and panning without tilting leaves
the vertical explicitly unready, because that is the axis altitudes depend on.

Two subtleties were worth the trouble, both found by the tests disagreeing with
the first implementation:

- **Cut on the predicted shift, never the measured one.** Rejecting pairs whose
  measured pixel shift was small keeps exactly those the noise happened to push
  over the threshold, which biases the focal length up and the field of view
  down — 3.3° of a 95° lens. Predicting the shift from a provisional fit breaks
  the dependence.
- **Gate on the uncertainty of the estimate, not the scatter of the pairs.** At
  30 fps a 66° lens moves the image ~5 px between frames, so each pair is
  individually good to maybe 8% while the median of two hundred is good to 0.5%.
  Gating on per-pair scatter rejected sound measurements of ordinary lenses and
  accepted only long ones.

Built and tested here: the estimator, and the camera support for an independent
vertical. NOT yet wired: the guided on-screen step that collects the pairs. That
is the next piece, and until it exists the measurement has nothing to feed it.

### 2026-08-13, later still — the lens step is wired

`LENS_STAGE` now runs straight after the axis solve, because the horizontal
half of the measurement compares the picture against the gyroscope and the
gyroscope is only metric once its axes are known.

There are no sub-steps. The coaching follows the evidence instead: it asks for
detail in the scene while there are no pairs at all, for panning until the
horizontal is ready, then for tilting, then it stops. Progress is the weaker of
the two axes, so the bar cannot read finished while the VERTICAL is still
missing — that being the axis altitudes depend on. It ends on its own the
moment both are solid, times out after a minute rather than trapping an
operator in front of a blank wall, and can be skipped, though never silently:
the log then states that altitudes are only as good as the default and that the
error grows toward the frame edges.

Two ordering rules that matter:

- The passive self-calibrator must not overwrite a deliberate measurement. It
  runs on whatever imagery a survey happened to produce; the guided one ran on
  a scene chosen for the job and measured the vertical against gravity.
- `camera.setMeasuredLens` keeps the two axes independent, so nothing
  downstream re-derives the vertical from the horizontal.

Verified through the real modules in the browser, driven exactly as the capture
loop drives them — including the registration-frame to working-frame pixel
conversion, which is the one place a wiring slip could hide and produce a
confident wrong answer. Feeding it the field lens: measured **27.45° against a
true 27.6°, ±0.19%**, and the camera moved from its 66°/51.9° default to
27.45°/20.7° with `verticalIsIndependent` true.

The acceptance report now states both axes and says which way the vertical was
obtained, so a profile can never again look healthy while resting on a derived
number nothing checked.

Still not verified on hardware — in particular whether the registration worker
reports vertical shift as cleanly as horizontal, since nothing has needed `dy`
before now. If the vertical never reaches ready in the field, that is where to
look first.

### 2026-08-14 — retracting the field-of-view diagnosis

The operator's instinct that the field-of-view work had made things worse was
right to be suspicious, and the log settles it. It did not corrupt any data —
but the diagnosis behind it was unsound and I stated it far too confidently.

`visualScale`, the estimator the whole 27.6° claim rested on, read **2.642** at
23:06 and **0.426** at 23:33 on the same phone. A factor of 6.2. One run said
the lens was far narrower than the assumed 66°, the next said far wider. That
is not a measurement, and no conclusion should ever have been drawn from a
single reading of it.

Three separate faults, worth keeping apart:

1. **The claim was unfounded.** Retracted. The 66° default may well be fine;
   the honest position is that the field of view is still unknown. The report
   line now prints the ratio and the range it wandered over during the scan,
   labelled diagnostic only, and instructs nothing.
2. **A bug I introduced.** The report's "measured field of view" used
   `camera.focalPx`, which is `null` until something sets it — so the arithmetic
   was `atan(192/0)`, and that is where the alarming "180.0° horizontal" in the
   bundle came from. Gone with the claim.
3. **The guided measurement never ran.** It rejected **335 of about 440** frames
   on `quality >= 0.45` and timed out after a full minute with 20 pairs. That
   phone's matcher runs at 0.25-0.31, so the gate was unreachable and the step
   could not have succeeded on this hardware at all. Gating on match quality was
   the wrong instinct: quality is a proxy, and this fit has a far better arbiter
   in the uncertainty of its own answer. Threshold dropped to 0.2, with the
   weighted median and the uncertainty gate doing the real work. Simulated at
   0.28 quality, it now measures a 66° lens 10 times out of 10.

Also added, because it is the difference between a measurement and an
assertion: the two halves are compared against each other. Focal length in
pixels is ONE number for both axes on a square-pixel sensor, so the horizontal
(measured against the gyroscope) and the vertical (measured against gravity)
must agree — two different sensors converging on one lens. `squarePixelRatio`
reports it, and the log says plainly whether they agreed or not. Had this
existed earlier it would have caught the bad claim on its own.

What is still unexplained, and should not be attributed to the lens until
something actually measures it: maximum spread of 50-64° with 51-82 spike bins,
persisting across runs where the projection was byte-identical. Worth noting
that "maximum spread" is a worst-case over 720 bins and a single bad bin sets
it — at the vertical edge of a close tall house the true skyline falls 45° in
about three degrees of azimuth, so a couple of degrees of pointing error there
produces exactly this. A median and a 90th percentile would say far more about
whether the profile is sound than the maximum does.

The next idea worth trying is matcher-free and uses data the survey already
has: choose the field of view that MINIMISES the disagreement between
overlapping observations of the same bin. A wrong focal length makes the same
skyline point read differently depending on where in the frame it fell, so the
spread itself is a function of the field of view with a minimum at the truth.
It needs no visual matcher, runs offline against stored keyframes, and would
optimise exactly the quantity that is currently failing.

### 2026-08-14 — an iPad could not finish calibration, and the reason was one number

The operator moved to an iPad (A2588) to get away from the multi-lens problem
and could not get past "hold still upright". The bundle shows why, and it is a
better bug than the one they were escaping.

Safari reported `screen.orientation.angle = 90` while the viewport was plainly
**820x1180 — portrait**. That angle is measured from each platform's own idea of
a natural orientation, and tablets do not agree with phones about what that is.
Nothing about it is cosmetic:

    screenQuat(q, 90)  maps screen-right onto device -Y
    device -Y's tilt out of horizontal IS beta
    => roll = -beta, exactly, at every sample in the log

Both snapshots confirm it to fifteen decimal places. And roll is what two gates
are built on:

- the settle stage needed `|roll| <= 12`, so it could only be satisfied lying
  flat, screen up — while the instruction on screen said to hold it upright;
- its own 12-second escape hatch ALSO tested level, so there was no way out
  that the interface admitted to. The operator was stuck for 56 seconds;
- `maybeKeyframe` rejects above 20°, so once pass 1 finally started, **every
  frame was thrown away — keyframes 0, coverage 0**.

Fixed in two places, deliberately:

1. **Root cause.** `_onScreen` now cross-checks the reported angle against the
   viewport and trusts the viewport, because a viewport's shape is a
   measurement and an angle is a convention. Only the portrait direction is
   corrected — a portrait viewport means the angle is 0 or 180 and 0 is
   overwhelmingly the common case, whereas 90 and 270 are indistinguishable
   from shape and guessing could turn the picture upside down. It says so in
   the log when it intervenes.
2. **Defence in depth.** The settle stage no longer tests level at all, nor
   does its escape hatch. Collecting compass samples while the device is held
   steady has nothing to do with how it is rotated about its own view axis —
   roll is carried through the full quaternion by every projection downstream.
   A stage whose only job is to hold still must not be gated on a derived angle
   that can be wrong.

Verified against the iPad's own logged attitudes: at 22:48:59 roll goes from
-60.1° to 10.0°, at 22:50:08 from -20.9° to -15.2°, elevation unchanged in
both. Both now clear the settle and keyframe gates. Checked that a device
genuinely in landscape (90 or 270 with a landscape viewport) is left alone, and
that the Android phone's 0°/portrait case is untouched.

Worth recording separately, because it is the best news in the file: **the
iPad's compass is good.** 27 rejects out of 1584, datum spread 8.3°, bearing
datum ±4°. The Android phone has been rejecting 8404 of 8448 with an 84° spread
and a ±42° datum. If absolute bearings matter — and for a telescope horizon
they do — the iPad is the better instrument by a wide margin, and it has one
rear camera. The axis solve also came out cleaner there: residual 0.117 against
the phone's 0.208-0.249, and the gyro scale passed its spread guard for the
first time at 0.9857.

The lens step timed out again at 681 quality rejections, but that bundle
predates the threshold fix, so it is not yet evidence either way. Its partial
answer is at least self-consistent: focalH 98.9 against focalV 99.7, a
square-pixel ratio of 1.0085, which is the cross-check working as intended.
