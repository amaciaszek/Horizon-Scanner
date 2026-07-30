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
