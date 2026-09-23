"""The windowed seam-mask resize must be the same picture, not a similar one.

MEASURED, 2026-09-22. `render_equirect` enlarged each frame's low-resolution
seam mask to the FULL panorama — 3240 x 891 on a 380-frame build — and then kept
only the slice that frame touches, roughly a fortieth of it. Once per frame, in
the stage that cost 895 s of a 2307 s build.

Enlarging a crop is not automatically the same as cropping an enlargement:
bilinear interpolation reads a source pixel either side, so a crop taken flush
to its edge interpolates against the boundary rather than against its true
neighbours, and the error lands exactly on the frame edges where a seam is most
visible. This asserts equality rather than assuming it.

Run:  .venv-stitch/Scripts/python.exe tests/seam-window.test.py
"""
import math
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tools'))
import stitch_lab as sl  # noqa: E402

FAILURES = 0


def check(name, ok, detail=''):
    global FAILURES
    print(f"{'  ok  ' if ok else '  FAIL'} {name}{('  ' + detail) if detail else ''}")
    if not ok:
        FAILURES += 1


def old_path(mask, sub, width, height):
    """What the code did before: enlarge everything, then throw most away."""
    return cv2.resize(mask, (width, height),
                      interpolation=cv2.INTER_LINEAR)[sub].astype(np.float64) / 255.0


print('=== The windowed resize equals the full resize, exactly ===')

rng = np.random.default_rng(7)
WIDTH, HEIGHT, SW, SH = 3240, 891, 360, 99
worst = 0.0
wrapped = 0
trials = 0
for _ in range(600):
    mask = (rng.random((SH, SW)) * 255).astype(np.uint8)
    row0 = int(rng.integers(0, HEIGHT - 40))
    row1 = min(HEIGHT, row0 + int(rng.integers(10, 250)))
    c0 = int(rng.integers(0, WIDTH))
    span = int(rng.integers(20, 600))
    cols = (np.arange(c0, c0 + span)) % WIDTH
    if np.any(np.diff(cols.astype(np.int64)) != 1):
        wrapped += 1
    sub = (slice(row0, row1), cols)
    old = old_path(mask, sub, WIDTH, HEIGHT)
    new = sl._seam_window(mask, sub, row0, row1, cols, WIDTH, HEIGHT, 9.0)
    if new.shape != old.shape:
        check('shapes match', False, f'{new.shape} vs {old.shape}')
        break
    worst = max(worst, float(np.abs(new - old).max()))
    trials += 1

check('every slice is bit-identical to the full-resize path', worst == 0.0,
      f'{trials} slices, {wrapped} of them wrapping the panorama seam, '
      f'worst difference {worst * 255:.4f} of a 0-255 level')

print('\n=== Degenerate slices do not throw or change shape ===')

mask = (rng.random((SH, SW)) * 255).astype(np.uint8)
for name, (row0, row1, cols) in {
    'an empty row range': (100, 100, np.arange(10)),
    'a single row': (100, 101, np.arange(10)),
    'a single column': (100, 140, np.arange(1)),
    'the whole panel': (0, HEIGHT, np.arange(WIDTH)),
    'the last row': (HEIGHT - 1, HEIGHT, np.arange(5)),
}.items():
    sub = (slice(row0, row1), cols)
    got = sl._seam_window(mask, sub, row0, row1, cols, WIDTH, HEIGHT, 9.0)
    want = (row1 - row0, len(cols))
    ok = got.shape == want
    if ok and row1 > row0:
        ok = float(np.abs(got - old_path(mask, sub, WIDTH, HEIGHT)).max()) == 0.0
    check(name, ok, f'shape {got.shape}')

print(f"\n{FAILURES} FAILED" if FAILURES else '\nall seam-window checks passed')
sys.exit(1 if FAILURES else 0)
