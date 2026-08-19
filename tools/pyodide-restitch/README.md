# Pyodide restitch proof

This is the Python/WebAssembly proof for the offline stitcher. It runs the
repository's existing `tools/stitch_lab.py` inside a Pyodide Web Worker with
Pyodide's packaged NumPy and `opencv-python`. The capture stays in the browser.
It returns the solved panorama, the sensor-pose control, the numerical report,
and the solved poses.

## Run

From the repository root:

```powershell
python -m http.server 8646 --directory tools
```

Open <http://localhost:8646/pyodide-restitch/>, choose `lab3/ipad.zip` or
`lab3/pixel.zip`, and press **Rebuild**.

The first load downloads the pinned Pyodide 314.0.3 runtime, NumPy, and OpenCV.
Later work will vendor and cache the required assets for offline startup.

## What changed for pitched frames and ghosting

The first proof used ten candidate neighbours per frame and broad feathering.
That produced a deceptively good residual while the pruned match graph was
split into 14 components; only 153 of 200 frames belonged to the main solution.
It also averaged every overlap, so parallax around the nearby house became
double windows, rooflines, and siding.

The current pipeline:

- tests up to 24 candidate neighbours per frame to retain cross-row bridges;
- measures and reports connected components after pruning;
- renders the largest visually solved component;
- omits every disconnected frame, including unique altitude islands whose pose
  cannot be verified by visual overlap;
- fits a guarded smooth 6×5 residual mesh to connected frames whose matched
  features show a real local perspective improvement; this correction is
  render-only and cannot move the spherical horizon solution;
- chooses low-disagreement seams below the archived skyline while feathering
  the sky, with global exposure compensation;
- derives the vertical output range from the projected frames instead of
  silently cropping everything below -12 degrees.

## Deliberate limitations

- The current Python loader retains decoded 640×480 frames during the solve.
  Streaming feature extraction and a second-pass renderer are required before
  treating this as production-ready on memory-constrained iPads.
- First load requires network access. No capture data is uploaded.

## Measured browser result

The supplied 200-frame `ipad.zip` was rebuilt end to end in headless Edge with
Pyodide 314.0.3, NumPy, and OpenCV. With ORB 500, search radius 64, and degree
24 it completed the full solve, seam calculation, and both renders in 210
seconds:

- 1,145 surviving frame pairs;
- 135,273 correspondences;
- 0.101° median residual and 0.297° p90;
- focal scale 0.9757;
- 182/200 frames in the largest solved graph;
- all disconnected frames omitted to prevent false ghosting;
- output bounds derived only from the visually connected component.

The most downward frame is centered at -43.94° and has zero surviving visual
connections; the next frame is at -11.50°. No offline algorithm can infer an
image-to-image registration across that 32° no-overlap jump. It is now omitted,
and future captures must enforce overlap between tilt rows if that region needs
to join the solved panorama.
