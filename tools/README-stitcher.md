# Offline panorama proof

This is an intentionally separate Python experiment. It does not alter the
browser panorama builder.

The script reads a Horizon Scanner capture-debug ZIP directly. It uses the
saved quaternion, azimuth datum, lens intrinsics, altitude and gyroscope data to
make an azimuth-preserving equirectangular reference. It then uses OpenCV's
panorama pipeline for visual feature matching, homography estimation, camera
adjustment, spherical warping, seam selection and multiband blending.

The visual result proves whether the photographs can be aligned. It is not yet
the production result: OpenCV's refined camera solution is not mapped back to
the app's absolute azimuth axis, and no single rotation-only model can fully
remove parallax from a close house.

## Setup

```powershell
py -m venv .venv-stitch
& .\.venv-stitch\Scripts\python.exe -m pip install -r tools\requirements-stitch.txt
```

## Run

```powershell
& .\.venv-stitch\Scripts\python.exe tools\stitch_debug_bundle.py `
  "C:\Users\Owner\Downloads\home-back-yard-capture-debug-2026-08-15-21-58-26.zip" `
  --output stitch-output
```

For a 360-degree sweep, the default starts OpenCV at the midpoint of the saved
sensor order. This moves the original end/start loop closure inside the solve.
Override it with `--anchor-index` or `--anchor-azimuth` when the panorama cut
lands on a nearby object.

Outputs:

- `sensor-panorama.png`: sensor-only, absolute-azimuth reference.
- `panorama.png`: transparent visual panorama.
- `panorama-preview.jpg`: visual panorama on a dark background.
- `comparison.jpg`: sensor and visual results stacked.
- `stitch-report.json`: motion, feature, overlap and weak-pair diagnostics.
