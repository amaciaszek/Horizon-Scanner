# Horizon Scanner — v0.24.0: why the iPad worked and the phone did not

Two surveys, same operator, same back yard, minutes apart. One produced 198
photographs and a panorama with no notes. The other produced 68 and a black
screen. The difference was not the app version — both versions worked on the
iPad. It was one hand-written table entry.

---

## The measurement

```
iPad    "Lens prior loaded for this device (iPad …): 45.6°"
        -> guided measurement SUCCEEDED at 40.51° x 31.32°, squarePixelRatio 0.987
        -> 198 photographs, 2531 verified pairs, 297,806 matches, 196/198 placed

Pixel   no prior -> the hardcoded 66° fallback stood
        -> guided measurement TIMED OUT, squarePixelRatio 0.655
        -> 68 photographs, 42 verified pairs, 3,422 matches, 3/68 placed
```

**The photographs were fine.** Re-run with brute-force matching, which ignores
the sensor-predicted position entirely, those same 68 frames gave **684 pairs,
29,053 matches, and a single connected component containing all 68**. Feature
count was 1330 per frame, the same as the iPad's. `visual_quality` was a median
0.250 on both devices — the phone's p10 was actually *better* (0.214 vs 0.193).

So nothing was wrong with the phone's data. What failed was everything computed
*from* the field of view:

- the keyframe step is a fraction of it, so at 66° against a true 42° the
  photographs were spaced 57% too far apart — 68 frames where the iPad took 198;
- the column band height is a fraction of it;
- and fatally, the stitcher predicts where each feature should land from these
  intrinsics and searches a small radius around the prediction. Wrong by 57%,
  every prediction fell outside the window. Guided matching kept 42 pairs where
  brute force found 684.

## What was actually wrong

`KNOWN_LENSES` in `js/camera.js` had exactly one entry, for the iPad. Any device
not in that table fell back to `hfovDeg = 66`, which is not a plausible
working-frame field of view for anything — it is roughly the *diagonal* of a
phone camera before the cover-fit crop into the 4:3 working frame, which is
probably where the number came from.

A table someone has to remember to edit does not scale to "every device".

## What changed

**Every device learns its own lens** (`js/lens-store.js`). Every successful
survey already measures the camera twice — once in the guided calibration, and
again in the bundle adjustment, which fits the focal length to every verified
correspondence in the survey. The solve is by far the better measurement: 108,585
matches on one capture, 297,806 on another, against a few hundred pairs gathered
in under a minute by the guided pass. Both are now written back to a per-device
store in `localStorage` and recalled when the camera starts.

Precedence is `solved` > `measured` > `self-calibrated`, so a fresh session's
early guess can never undo last week's solve. Learning from a solve is gated on
the solve being worth believing — at least 200 verified pairs and 60% of frames
placed — because the 23:53 Pixel build reported a confident-looking focal scale
of 0.9868 off 42 pairs while being wrong by 57%, and burning that in would have
made the error permanent instead of letting the next run fix it.

**The phone is in the table too**, at 42.40°, so it is correct on the very next
run without waiting to learn. That figure is not a spec sheet: it is what the
bundle adjustment solved from 902 verified pairs on the 22:23 capture.

**The blind fallback is 45°, not 66°.** Both devices this app has ever measured
land near 40°. An unknown device now starts within about 10% instead of 57% off.

**The pre-walk warning no longer cries wolf** — a lens recalled from a solved
store entry is not announced as a guess, because it is better evidence than the
guided measurement would produce.

## Caught in the browser, not by the tests

The first version of this put `camera.lensStore = lensStore` above the `const
camera = …` that declares it. That is a temporal dead zone error, it killed the
entire module graph before a frame was drawn, and **all 35 test suites passed
anyway** — every suite imports the modules it exercises directly and none of
them loads `main.js`, which needs a DOM, a camera and motion sensors. It was
found by loading the page and reading the header, which said `—` instead of a
version.

Worth knowing for next time: a green suite says nothing about whether the app
starts. `tests/module-references.test.mjs` catches undefined names; it does not
catch ordering.

## Still open: the phone's guided lens measurement is broken

Independent of everything above, and worth fixing because it is the fallback for
a device nobody has measured yet.

The working frame is 384x288 — 4:3 — so the horizontal field must exceed the
vertical. The Pixel measured `hfovDeg 36.33, vfovDeg 41.18`. That is
geometrically impossible, and it is why `squarePixelRatio` came out at 0.655
instead of the iPad's 0.987 and the cross-check refused the result.

`focalV = dyPx / tan(dPitch)` with `dPitch` taken from gravity. Coming out ~35%
low means either the vertical image shift is under-measured or the pitch change
is over-measured on that device. Ruled out so far: frame rotation (0 on both
devices), the working-frame scale factor (2.4 on both axes), and the crop (equal
scaling on both axes, `cropW: 1`, `cropH: 0.42`). The Pixel collected *more*
samples than the iPad (248 pan / 147 tilt vs 161 / 114) and still never got
`scatterV` below 0.677, so it is a systematic bias, not a sample shortage.

The lens store makes this non-fatal — one good solve and the device is correct
forever — but a device on its first run still depends on it.

## Reading the next capture

1. Header must read **v0.24.0**. After any VERSION change run
   `node tools/build-importmap.mjs`; the import-map test fails if you forget,
   and it did exactly that when `lens-store.js` was added.
2. At camera start the log should say either **"Lens recalled for this device"**
   (learned) or **"Lens prior loaded"** (table). If it says neither, that device
   is on the 45° fallback and the pre-walk warning will name the figure.
3. After a good build, look for **"Lens learned from this solve"**. That is the
   line that makes the device permanently correct.
4. If a run still goes wrong, the decisive test is one command:
   `python tools/stitch_lab.py <capture>.zip --brute --no-render` — if brute
   force finds many times more pairs than the in-app build did, the intrinsics
   are wrong and nothing else is.
