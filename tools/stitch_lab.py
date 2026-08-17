"""
Stitch a Horizon Scanner capture properly, and measure every step.

This is the offline laboratory. It exists to find out what a correct panorama
from this data costs, using tools the browser does not have — SIFT, a real
solver, proper blending — so that whatever turns out to matter can be ported
back into JavaScript knowing it was worth porting.

The order is deliberate: LOAD, MEASURE, SOLVE, MEASURE AGAIN, RENDER. Every
stage prints the number that says whether it helped. Across this project the
recurring mistake has been a change that looked principled and made things
worse without anyone noticing, so nothing here is trusted because it sounds
right.

WHAT THE GEOMETRY ACTUALLY IS. The operator turns a camera about a point. That
makes every frame a rotation of the same view sphere, so the model is three
angles per frame plus one shared focal length — not a homography per pair, which
has eight parameters and will happily absorb parallax, drift and noise into a
plausible-looking lie. Rotation-only is both fewer unknowns and the truth.

    py -m venv .venv-stitch
    .venv-stitch\\Scripts\\python.exe -m pip install -r tools\\requirements-stitch.txt
    .venv-stitch\\Scripts\\python.exe tools\\stitch_lab.py <capture.zip> --out stitch-out
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

DEG = math.pi / 180.0
RAD = 180.0 / math.pi


# --------------------------------------------------------------------------
# Quaternions. The app stores [w, x, y, z] rotating DEVICE vectors into WORLD,
# with world X=east, Y=north, Z=up, and the rear camera looking along -Z.
# --------------------------------------------------------------------------

def quat_mul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ])


def quat_to_matrix(q):
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def yaw_quat(deg):
    """Rotation about world up. Matches math3d.yawQuat, including its sign."""
    h = -deg * DEG / 2
    return np.array([math.cos(h), 0.0, 0.0, math.sin(h)])


def rotvec_to_matrix(v):
    theta = float(np.linalg.norm(v))
    if theta < 1e-12:
        return np.eye(3)
    k = v / theta
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(theta) * K + (1 - math.cos(theta)) * (K @ K)


def matrix_to_rotvec(R):
    cos = (np.trace(R) - 1) / 2
    cos = max(-1.0, min(1.0, cos))
    theta = math.acos(cos)
    if theta < 1e-9:
        return np.zeros(3)
    if abs(math.pi - theta) < 1e-6:
        # Near 180 degrees the skew part vanishes; recover the axis from R + I.
        A = (R + np.eye(3)) / 2
        axis = np.sqrt(np.maximum(np.diag(A), 0))
        if axis[0] > 0:
            axis[1] = math.copysign(axis[1], A[0, 1])
            axis[2] = math.copysign(axis[2], A[0, 2])
        return axis * theta
    w = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    return w * (theta / (2 * math.sin(theta)))


# --------------------------------------------------------------------------
# The capture
# --------------------------------------------------------------------------

@dataclass
class Frame:
    index: int
    image: np.ndarray            # BGR, as saved
    R: np.ndarray                # camera -> world, from the sensors
    azimuth: float
    altitude: float
    roll: float
    tan_h: float
    tan_v: float
    timestamp: float
    boundary: np.ndarray | None  # skyline row per column, in analysis space
    kp: list = field(default_factory=list)
    desc: np.ndarray | None = None


def load_capture(zip_path: Path):
    """Photos plus the pose each was taken at."""
    with zipfile.ZipFile(zip_path) as z:
        names = set(z.namelist())
        meta_name = 'metadata/keyframes.json'
        if meta_name not in names:
            raise SystemExit(f'{zip_path} has no {meta_name}')
        records = json.loads(z.read(meta_name))
        session = json.loads(z.read('metadata/session.json')) if 'metadata/session.json' in names else {}

        frames = []
        for rec in records:
            photo = rec.get('photo') or {}
            path = photo.get('path')
            if not path or path not in names:
                continue
            buf = np.frombuffer(z.read(path), dtype=np.uint8)
            image = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if image is None:
                continue

            cam = rec['camera']
            orient = rec['orientation']
            point = rec['pointing']

            # The placed pose: sensor attitude carried into the survey's own
            # azimuth frame. This is what the app draws with, so it is what an
            # offline reconstruction has to start from if the two are to agree.
            q = np.array(orient['quaternion'], dtype=float)
            total_yaw = (orient.get('yawBaseCorrectionDeg') or 0.0) \
                + (orient.get('stitchYawCorrectionDeg') or 0.0)
            if abs(total_yaw) > 1e-9:
                q = quat_mul(yaw_quat(total_yaw), q)

            analysis = rec.get('analysis') or {}
            boundary = analysis.get('boundary')
            frames.append(Frame(
                index=rec['index'],
                image=image,
                R=quat_to_matrix(q),
                azimuth=point['stitchedAzimuthDeg'],
                altitude=point['centerAltitudeDeg'],
                roll=point.get('rollDeg') or 0.0,
                tan_h=cam['tanHalfHorizontal'],
                tan_v=cam['tanHalfVertical'],
                timestamp=rec.get('timestampMs') or 0.0,
                boundary=np.asarray(boundary, dtype=np.float32) if boundary else None,
            ))
    frames.sort(key=lambda f: f.timestamp)
    return frames, session


# --------------------------------------------------------------------------
# Rays. A pixel is a direction; that is the whole camera model.
# --------------------------------------------------------------------------

def pixels_to_rays(pts, frame: Frame):
    """Image points -> unit directions in the CAMERA frame."""
    h, w = frame.image.shape[:2]
    u = (pts[:, 0] + 0.5) / w * 2 - 1
    v = 1 - (pts[:, 1] + 0.5) / h * 2
    d = np.stack([u * frame.tan_h, v * frame.tan_v, -np.ones_like(u)], axis=1)
    return d / np.linalg.norm(d, axis=1, keepdims=True)


def rays_to_pixels(dirs, frame: Frame, w, h):
    """Camera-frame directions -> image points, and a validity mask."""
    depth = -dirs[:, 2]
    ok = depth > 1e-6
    safe = np.where(ok, depth, 1.0)
    u = dirs[:, 0] / safe / frame.tan_h
    v = dirs[:, 1] / safe / frame.tan_v
    ok &= (np.abs(u) <= 1) & (np.abs(v) <= 1)
    x = (u + 1) / 2 * w - 0.5
    y = (1 - v) / 2 * h - 0.5
    return np.stack([x, y], axis=1), ok


def detect_features(frames, sky_margin_rows=3, max_features=3000,
                    detector='sift', log=print):
    """
    Features below each frame's own skyline.

    Cloud moves between one frame and the next, so matching on it drags the
    solution toward a fiction. Everything below the traced skyline is nailed to
    the ground and is exactly what should line up. Where no skyline was saved
    the whole frame is used and the corner threshold does most of that work.

    Two detectors, because the port has to choose one. SIFT is the accuracy
    reference. ORB is FAST corners plus rotated BRIEF, and its descriptor is 256
    bits rather than 128 floats, so a comparison is four XORs and four popcounts
    instead of 128 multiply-adds. That is the only reason it is here: matching
    cost, not portability. Both are ordinary code.
    """
    if detector == 'sift':
        engine = cv2.SIFT_create(nfeatures=max_features, contrastThreshold=0.012)
    elif detector == 'orb':
        # fastThreshold is dropped from the default 20 because these frames are
        # mostly siding and foliage at low contrast, and the default starves.
        engine = cv2.ORB_create(nfeatures=max_features, fastThreshold=12,
                                scaleFactor=1.2, nlevels=8)
    else:
        raise SystemExit(f'unknown detector {detector!r}')
    total = 0
    for f in frames:
        gray = cv2.cvtColor(f.image, cv2.COLOR_BGR2GRAY)
        mask = None
        if f.boundary is not None and len(f.boundary):
            h, w = gray.shape
            mask = np.zeros((h, w), np.uint8)
            cols = np.linspace(0, len(f.boundary) - 1, w)
            # The boundary is stored in analysis rows; scale it to the photo.
            rows = np.interp(cols, np.arange(len(f.boundary)), f.boundary)
            rows = rows / max(f.boundary.max(), 1.0) * 0 + rows  # keep units
            scale = h / 288.0                     # analysis frame height
            for x in range(w):
                y0 = int(min(h - 1, max(0, rows[x] * scale + sky_margin_rows)))
                mask[y0:, x] = 255
            if mask.sum() < 0.05 * 255 * h * w:
                mask = None                        # almost nothing below: use it all
        kp, desc = engine.detectAndCompute(gray, mask)
        f.kp = kp
        f.desc = desc
        total += 0 if desc is None else len(kp)
    log(f'  features: {total} over {len(frames)} frames, median '
        f'{int(np.median([len(f.kp) for f in frames]))} per frame')
    return frames


def angular_separation(a: Frame, b: Frame):
    axis_a = a.R @ np.array([0.0, 0.0, -1.0])
    axis_b = b.R @ np.array([0.0, 0.0, -1.0])
    return math.acos(max(-1.0, min(1.0, float(axis_a @ axis_b)))) * RAD


@dataclass
class Pair:
    i: int
    j: int
    pts_i: np.ndarray
    pts_j: np.ndarray
    sep: float


POPCOUNT = np.unpackbits(
    np.arange(256, dtype=np.uint8)[:, None], axis=1).sum(1).astype(np.float32)


def _distances(qd, cd):
    """Descriptor distance matrix: Hamming for uint8 codes, L2 for floats."""
    if qd.dtype == np.uint8:
        out = np.empty((len(qd), len(cd)), np.float32)
        for s in range(0, len(qd), 256):        # keep the XOR broadcast bounded
            e = min(s + 256, len(qd))
            out[s:e] = POPCOUNT[np.bitwise_xor(qd[s:e, None, :], cd[None, :, :])].sum(2)
        return out
    d2 = (qd * qd).sum(1)[:, None] + (cd * cd).sum(1)[None, :] - 2.0 * (qd @ cd.T)
    return np.sqrt(np.maximum(d2, 0.0, out=d2))


def _two_nearest(dist):
    """Best and second-best column per row, as (values, indices)."""
    n = dist.shape[1]
    if n == 1:
        v = np.concatenate([dist, np.full((len(dist), 1), np.inf, np.float32)], 1)
        i = np.zeros((len(dist), 2), np.int32)
        return v, i
    order = np.argpartition(dist, 1, axis=1)[:, :2]
    v = np.take_along_axis(dist, order, 1)
    swap = v[:, 0] > v[:, 1]
    v[swap] = v[swap][:, ::-1]
    order[swap] = order[swap][:, ::-1]
    return v, order.astype(np.int32)


def _guided_knn(pred, ok, qdesc, cpts, cdesc, search_px):
    """
    The two nearest descriptors among candidates inside a +/- search_px box of
    where the sensor pose says the query feature lands.

    The box rather than a circle is deliberate: the browser's matchPair tests
    abs(dx) and abs(dy) separately, and if the two implementations admit
    different candidate sets then a crossover comparison measures the difference
    between the windows rather than between the detectors.

    Queries are grouped by grid cell so that every query in a cell shares one
    candidate set and one matrix multiply. With a cell the size of the search
    window the 3x3 neighbourhood is guaranteed to be a superset of the box, and
    the exact test is applied afterwards.
    """
    n = len(pred)
    vals = np.full((n, 2), np.inf, np.float32)
    idx = np.full((n, 2), -1, np.int32)
    compared = 0
    if n == 0 or len(cpts) == 0:
        return vals, idx, compared

    cell = max(float(search_px), 1.0)
    buckets = {}
    for k, (cx, cy) in enumerate(np.floor(cpts / cell).astype(np.int64)):
        buckets.setdefault((int(cx), int(cy)), []).append(k)
    groups = {}
    for k, (cx, cy) in enumerate(np.floor(pred / cell).astype(np.int64)):
        if ok[k]:
            groups.setdefault((int(cx), int(cy)), []).append(k)

    for (cx, cy), qlist in groups.items():
        cand = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                cand.extend(buckets.get((cx + dx, cy + dy), ()))
        if not cand:
            continue
        cand = np.asarray(cand, np.int32)
        qi = np.asarray(qlist, np.int32)
        dist = _distances(qdesc[qi], cdesc[cand])
        compared += dist.size
        off = np.abs(cpts[cand][None, :, :] - pred[qi][:, None, :])
        dist[(off[:, :, 0] > search_px) | (off[:, :, 1] > search_px)] = np.inf
        v, o = _two_nearest(dist)
        vals[qi] = v
        idx[qi] = cand[o]
    return vals, idx, compared


def _brute_knn(qdesc, cdesc):
    """Every query against every candidate. The control, not the method."""
    vals = np.full((len(qdesc), 2), np.inf, np.float32)
    idx = np.full((len(qdesc), 2), -1, np.int32)
    for s in range(0, len(qdesc), 512):
        e = min(s + 512, len(qdesc))
        v, o = _two_nearest(_distances(qdesc[s:e], cdesc))
        vals[s:e], idx[s:e] = v, o
    return vals, idx


def match_pairs(frames, max_sep_scale=0.85, min_sep=1.5, max_degree=10,
                ratio=0.75, min_matches=12, search_px=64, guided=True, log=print):
    """
    Match only frames the sensors say overlap, and within those, only where the
    sensors say a feature lands.

    All-pairs matching on 91 frames is 4095 comparisons, nearly all of them
    between views that share no sky at all, and every one is a chance for a
    repeated texture — siding, shingles, fence palings — to invent a
    correspondence. The sensor poses are wrong by degrees, not by tens of
    degrees, so they can be trusted to say which frames are neighbours even
    though they cannot say exactly where those neighbours are.

    The same argument applies a second time inside each pair. A pose wrong by a
    degree puts a feature wrong by tens of pixels, not hundreds, so searching the
    whole frame for its partner spends almost all of its effort on candidates
    that were never geometrically possible — and, worse, gives periodic texture
    the whole frame in which to find a convincing impostor. Guided matching is
    therefore both the cheaper and the more accurate choice, and it is what the
    browser already does.
    """
    half_diag = [math.atan(math.hypot(f.tan_h, f.tan_v)) * RAD for f in frames]
    candidates = []
    for i in range(len(frames)):
        for j in range(i + 1, len(frames)):
            sep = angular_separation(frames[i], frames[j])
            if min_sep < sep < (half_diag[i] + half_diag[j]) * max_sep_scale:
                candidates.append((sep, i, j))
    candidates.sort()

    degree = [0] * len(frames)
    pairs = []
    considered = 0
    compared = 0                       # descriptor comparisons actually performed
    for sep, i, j in candidates:
        if degree[i] >= max_degree and degree[j] >= max_degree:
            continue
        fi, fj = frames[i], frames[j]
        if fi.desc is None or fj.desc is None:
            continue
        considered += 1
        pts_i = np.float32([k.pt for k in fi.kp])
        pts_j = np.float32([k.pt for k in fj.kp])

        if guided:
            h, w = fj.image.shape[:2]
            # Where frame i's features land in frame j under the sensor poses.
            world = pixels_to_rays(pts_i, fi) @ fi.R.T
            pred, ok = rays_to_pixels(world @ fj.R, fj, w, h)
            vals, idx, n = _guided_knn(pred, ok, fi.desc, pts_j, fj.desc, search_px)
            compared += n
        else:
            vals, idx = _brute_knn(fi.desc, fj.desc)
            compared += len(fi.desc) * len(fj.desc)

        keep = (idx[:, 0] >= 0) & (vals[:, 0] < ratio * vals[:, 1])
        if int(keep.sum()) < min_matches:
            continue
        q = np.nonzero(keep)[0]
        pairs.append(Pair(i, j, pts_i[q], pts_j[idx[q, 0]], sep))
        degree[i] += 1
        degree[j] += 1
    log(f'  pairs: {len(pairs)} kept from {considered} matched '
        f'({len(candidates)} predicted by the sensors)')
    log(f'  matching: {"guided r=%d" % search_px if guided else "brute force"}, '
        f'{compared / 1e9:.2f} G descriptor comparisons')
    return pairs


def verify_pairs(frames, pairs, tol_deg=1.2, min_inliers=10, log=print):
    """
    Keep only the matches consistent with ONE rotation between the two frames.

    Descriptor similarity is not enough on the things this app photographs.
    Clapboard, shingles, window rows and fence palings are periodic, so a patch
    matches its neighbour's neighbour with complete confidence, and a handful of
    those will drag a solve degrees out of true. Two overlapping views of a
    rotating camera differ by exactly one rotation, so fitting that rotation and
    discarding whatever disagrees removes them wholesale.
    """
    kept = []
    dropped = 0
    for p in pairs:
        di = pixels_to_rays(p.pts_i, frames[p.i])
        dj = pixels_to_rays(p.pts_j, frames[p.j])
        # World directions under the sensor poses, then the best rotation
        # carrying one set onto the other, by Kabsch with RANSAC-ish trimming.
        wi = di @ frames[p.i].R.T
        wj = dj @ frames[p.j].R.T
        mask = np.ones(len(wi), bool)
        for cut in (6.0, 3.0, 1.8, tol_deg):
            if mask.sum() < min_inliers:
                break
            H = wi[mask].T @ wj[mask]
            U, _, Vt = np.linalg.svd(H)
            d = np.sign(np.linalg.det(Vt.T @ U.T))
            R = Vt.T @ np.diag([1, 1, d]) @ U.T
            err = np.degrees(np.arccos(np.clip(np.sum((wi @ R.T) * wj, axis=1), -1, 1)))
            nxt = err <= cut
            if nxt.sum() < min_inliers:
                break
            mask = nxt
        if mask.sum() >= min_inliers:
            kept.append(Pair(p.i, p.j, p.pts_i[mask], p.pts_j[mask], p.sep))
        else:
            dropped += 1
    total = sum(len(p.pts_i) for p in kept)
    log(f'  verified: {len(kept)} pairs, {total} matches ({dropped} pairs rejected)')
    return kept


def residual_degrees(frames, pairs, rotations=None, focal_scale=1.0):
    """Angle between where each pair's two views put the same feature."""
    errs = []
    for p in pairs:
        Ri = rotations[p.i] if rotations is not None else frames[p.i].R
        Rj = rotations[p.j] if rotations is not None else frames[p.j].R
        di = pixels_to_rays(p.pts_i, frames[p.i])
        dj = pixels_to_rays(p.pts_j, frames[p.j])
        if focal_scale != 1.0:
            di = _rescale(di, frames[p.i], focal_scale)
            dj = _rescale(dj, frames[p.j], focal_scale)
        wi = di @ Ri.T
        wj = dj @ Rj.T
        errs.append(np.degrees(np.arccos(np.clip(np.sum(wi * wj, axis=1), -1, 1))))
    if not errs:
        return np.array([0.0])
    return np.concatenate(errs)


def _rescale(dirs, frame: Frame, scale):
    """Re-project unit rays through a camera whose focal length changed."""
    depth = -dirs[:, 2]
    u = dirs[:, 0] / depth / frame.tan_h
    v = dirs[:, 1] / depth / frame.tan_v
    d = np.stack([u * frame.tan_h * scale, v * frame.tan_v * scale, -np.ones_like(u)], axis=1)
    return d / np.linalg.norm(d, axis=1, keepdims=True)


# --------------------------------------------------------------------------
# The solve
# --------------------------------------------------------------------------

def bundle_adjust(frames, pairs, iterations=40, huber_deg=0.6,
                  tilt_prior=2.0, yaw_prior=0.02, focal_prior=50.0,
                  solve_focal=True, log=print):
    """
    Nudge every frame's rotation, and one shared focal length, until matched
    features agree about where they are.

    Three angles per frame and one focal for the whole survey. That is the
    entire model, because a camera turning about a point has nothing else to
    solve for — no translation, no per-pair homography, no eight-parameter
    licence to explain away parallax as geometry.

    GRAVITY IS HELD, AZIMUTH IS FREED. The correction for each frame is split
    into a turn about world vertical and a tilt away from it. Which way is down
    comes from an accelerometer and is the most reliable number the device
    produces; azimuth comes from an integrated gyroscope and is the one that
    drifts, by about ten degrees a lap on these captures. So the tilt prior is a
    hundred times the yaw prior: vision may fix the azimuths and may not tip the
    horizon over.

    THE FOCAL IS SOLVED HERE AND NOT IN THE BROWSER. In JavaScript this was
    tried and abandoned — measured on a real capture the cost surface was flat,
    because a hundred-odd NCC matches from a close house are dominated by
    parallax. With SIFT giving a hundred and fifty thousand matches spread over
    the whole sphere, the same parameter is properly constrained.
    """
    n = len(frames)
    R = [f.R.copy() for f in frames]
    log_scale = 0.0
    huber = math.radians(huber_deg)

    # Precompute camera-frame rays once; only the rotations and scale change.
    rays_i = [pixels_to_rays(p.pts_i, frames[p.i]) for p in pairs]
    rays_j = [pixels_to_rays(p.pts_j, frames[p.j]) for p in pairs]
    uv_i = [_to_uv(rays_i[k], frames[p.i]) for k, p in enumerate(pairs)]
    uv_j = [_to_uv(rays_j[k], frames[p.j]) for k, p in enumerate(pairs)]

    N = 3 * n + (1 if solve_focal else 0)
    last = None
    for it in range(iterations):
        scale = math.exp(log_scale)
        H = np.zeros((N, N))
        g = np.zeros(N)
        cost = 0.0
        total = 0

        for k, p in enumerate(pairs):
            di, ddi = _rays_and_dscale(uv_i[k], frames[p.i], scale)
            dj, ddj = _rays_and_dscale(uv_j[k], frames[p.j], scale)
            wi = di @ R[p.i].T
            wj = dj @ R[p.j].T
            res = wi - wj                                   # m x 3
            norm = np.linalg.norm(res, axis=1)
            w = np.where(norm <= huber, 1.0, huber / np.maximum(norm, 1e-12))
            cost += float(np.sum(w * norm * norm))
            total += len(norm)

            # d(residual)/d(omega) = -[w]x for i, +[w]x for j, applied in WORLD.
            Ji = -_skew_stack(wi)
            Jj = _skew_stack(wj)
            bi, bj = 3 * p.i, 3 * p.j
            _accumulate(H, g, bi, Ji, bj, Jj, res, w)

            if solve_focal:
                # Chain the scale derivative through the rotation into world.
                fi = (ddi @ R[p.i].T) * scale
                fj = (ddj @ R[p.j].T) * scale
                jf = fi - fj                                # m x 3
                _accumulate_focal(H, g, 3 * n, jf, bi, Ji, bj, Jj, res, w)

        # Priors. In the world frame the correction about z is yaw; the other
        # two are tilt.
        for i in range(n):
            b = 3 * i
            H[b + 0, b + 0] += tilt_prior
            H[b + 1, b + 1] += tilt_prior
            H[b + 2, b + 2] += yaw_prior
        if solve_focal:
            H[3 * n, 3 * n] += focal_prior
            g[3 * n] -= focal_prior * log_scale

        # Gauge: the whole solution can spin freely about any axis, so pin the
        # first frame. Without this the normal equations are singular.
        for a in range(3):
            H[a, a] += 1e6

        try:
            delta = np.linalg.solve(H + np.eye(N) * 1e-9, g)
        except np.linalg.LinAlgError:
            log('  solver: normal equations singular, stopping')
            break

        step = 0.0
        for i in range(n):
            w = delta[3 * i:3 * i + 3]
            step = max(step, float(np.linalg.norm(w)))
            R[i] = rotvec_to_matrix(w) @ R[i]
        if solve_focal:
            d = float(np.clip(delta[3 * n], -0.05, 0.05))
            log_scale += d
            step = max(step, abs(d))

        rms = math.degrees(math.sqrt(cost / max(total, 1)))
        if it % 5 == 0 or step < 1e-7:
            log(f'    iter {it:3d}  rms {rms:6.4f}°  focal x{math.exp(log_scale):.4f}  step {step:.2e}')
        if last is not None and abs(last - cost) < 1e-12:
            break
        last = cost
        if step < 1e-7:
            break

    return R, math.exp(log_scale)


def _to_uv(dirs, frame):
    depth = -dirs[:, 2]
    return np.stack([dirs[:, 0] / depth / frame.tan_h,
                     dirs[:, 1] / depth / frame.tan_v], axis=1)


def _rays_and_dscale(uv, frame, scale):
    """Unit rays at this focal scale, and their derivative with respect to it."""
    a = uv[:, 0] * frame.tan_h
    b = uv[:, 1] * frame.tan_v
    x, y = a * scale, b * scale
    L = np.sqrt(x * x + y * y + 1.0)
    d = np.stack([x / L, y / L, -1.0 / L], axis=1)
    dot = (a * x + b * y) / (L ** 3)
    dd = np.stack([a / L - x * dot, b / L - y * dot, dot], axis=1)
    return d, dd


def _skew_stack(v):
    m = len(v)
    J = np.zeros((m, 3, 3))
    J[:, 0, 1] = -v[:, 2]; J[:, 0, 2] = v[:, 1]
    J[:, 1, 0] = v[:, 2];  J[:, 1, 2] = -v[:, 0]
    J[:, 2, 0] = -v[:, 1]; J[:, 2, 1] = v[:, 0]
    return J


def _accumulate(H, g, bi, Ji, bj, Jj, res, w):
    wi = w[:, None, None]
    Hii = np.einsum('mki,mkj->ij', Ji * wi, Ji)
    Hjj = np.einsum('mki,mkj->ij', Jj * wi, Jj)
    Hij = np.einsum('mki,mkj->ij', Ji * wi, Jj)
    H[bi:bi + 3, bi:bi + 3] += Hii
    H[bj:bj + 3, bj:bj + 3] += Hjj
    H[bi:bi + 3, bj:bj + 3] += Hij
    H[bj:bj + 3, bi:bi + 3] += Hij.T
    g[bi:bi + 3] -= np.einsum('mki,mk->i', Ji, res * w[:, None])
    g[bj:bj + 3] -= np.einsum('mki,mk->i', Jj, res * w[:, None])


def _accumulate_focal(H, g, fi, jf, bi, Ji, bj, Jj, res, w):
    H[fi, fi] += float(np.sum(w * np.sum(jf * jf, axis=1)))
    g[fi] -= float(np.sum(w * np.sum(jf * res, axis=1)))
    ci = np.einsum('mki,mk->i', Ji, jf * w[:, None])
    cj = np.einsum('mki,mk->i', Jj, jf * w[:, None])
    H[bi:bi + 3, fi] += ci
    H[fi, bi:bi + 3] += ci
    H[bj:bj + 3, fi] += cj
    H[fi, bj:bj + 3] += cj


def prune_outliers(frames, pairs, R, scale, keep_deg=0.8, min_matches=10, log=print):
    """
    Throw out the matches the converged solution says are impossible, then let
    the caller solve again on what survives.

    Even after a per-pair rotation check, some correspondences are simply wrong
    — repeated brickwork, a window that looks like the window two along, a leaf
    that looks like every other leaf. A robust loss stops them steering the
    answer but does not remove them, and they go on to smear the render, where
    there is no Huber weight to protect anything. The global solution is a much
    better judge of them than any single pair was, because it has seen the whole
    sphere agree.
    """
    kept, dropped_pairs, dropped_matches, before = [], 0, 0, 0
    for p in pairs:
        di = _rescale(pixels_to_rays(p.pts_i, frames[p.i]), frames[p.i], scale)
        dj = _rescale(pixels_to_rays(p.pts_j, frames[p.j]), frames[p.j], scale)
        err = np.degrees(np.arccos(np.clip(
            np.sum((di @ R[p.i].T) * (dj @ R[p.j].T), axis=1), -1, 1)))
        good = err <= keep_deg
        before += len(err)
        if good.sum() >= min_matches:
            kept.append(Pair(p.i, p.j, p.pts_i[good], p.pts_j[good], p.sep))
            dropped_matches += int((~good).sum())
        else:
            dropped_pairs += 1
            dropped_matches += len(err)
    after = sum(len(p.pts_i) for p in kept)
    log(f'  pruned: {before - after} matches and {dropped_pairs} pairs dropped, '
        f'{after} matches over {len(kept)} pairs remain')
    return kept


def report(name, errs, log=print):
    log(f'  {name:34s} mean {errs.mean():6.3f}°  median {np.median(errs):6.3f}°  '
        f'p90 {np.percentile(errs, 90):6.3f}°  max {errs.max():6.2f}°  n={len(errs)}')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('capture', type=Path)
    ap.add_argument('--out', type=Path, default=Path('stitch-out'))
    ap.add_argument('--px-per-deg', type=float, default=8.0)
    ap.add_argument('--detector', choices=('sift', 'orb'), default='sift')
    ap.add_argument('--max-features', type=int, default=3000)
    ap.add_argument('--search-px', type=int, default=64,
                    help='half-width of the guided match window, in pixels')
    ap.add_argument('--brute', action='store_true',
                    help='disable guided matching; the control, not the method')
    ap.add_argument('--ratio', type=float, default=None,
                    help='Lowe ratio (default 0.75 for SIFT, 0.85 for ORB)')
    ap.add_argument('--dump-json', action='store_true',
                    help='write features, matches and poses for cross-checking '
                         'against a JavaScript implementation')
    ap.add_argument('--no-render', action='store_true',
                    help='skip the panoramas; for sweeps where only numbers matter')
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    # Hamming distances on 256-bit codes spread differently from L2 on 128
    # floats, so one ratio cannot serve both without handicapping one of them.
    ratio = args.ratio if args.ratio is not None else (0.75 if args.detector == 'sift' else 0.85)

    t0 = time.time()
    print(f'Loading {args.capture.name}')
    frames, session = load_capture(args.capture)
    print(f'  {len(frames)} photos, app {session.get("appVersion")}')
    hfov = 2 * math.atan(frames[0].tan_h) * RAD
    vfov = 2 * math.atan(frames[0].tan_v) * RAD
    print(f'  stated lens {hfov:.2f}° x {vfov:.2f}°, '
          f'elevation {min(f.altitude for f in frames):.1f}° to '
          f'{max(f.altitude for f in frames):.1f}°')

    print(f'Detecting features ({args.detector}, cap {args.max_features})')
    detect_features(frames, max_features=args.max_features, detector=args.detector)

    print('Matching')
    pairs = match_pairs(frames, ratio=ratio, search_px=args.search_px,
                        guided=not args.brute)
    pairs = verify_pairs(frames, pairs)

    print('Starting point (sensor poses):')
    before = residual_degrees(frames, pairs)
    report('sensor residual', before)

    print('Solving rotations + focal')
    R, scale = bundle_adjust(frames, pairs)
    print('Result:')
    report('after bundle adjustment', residual_degrees(frames, pairs, R, scale))
    hf = 2 * math.atan(frames[0].tan_h * scale) * RAD
    vf = 2 * math.atan(frames[0].tan_v * scale) * RAD
    print(f'  focal scale x{scale:.4f}  ->  lens {hf:.2f}° x {vf:.2f}°')
    moved = [math.degrees(np.linalg.norm(matrix_to_rotvec(R[i] @ frames[i].R.T)))
             for i in range(len(frames))]
    print(f'  frames moved: median {np.median(moved):.2f}°  max {max(moved):.2f}°')

    print('Pruning and re-solving')
    pairs = prune_outliers(frames, pairs, R, scale)
    R, scale = bundle_adjust(frames, pairs)
    final = residual_degrees(frames, pairs, R, scale)
    report('after prune + re-solve', final)
    hf = 2 * math.atan(frames[0].tan_h * scale) * RAD
    vf = 2 * math.atan(frames[0].tan_v * scale) * RAD
    print(f'  focal scale x{scale:.4f}  ->  lens {hf:.2f}° x {vf:.2f}°')
    moved = [math.degrees(np.linalg.norm(matrix_to_rotvec(R[i] @ frames[i].R.T)))
             for i in range(len(frames))]
    print(f'  frames moved from the sensors: median {np.median(moved):.2f}°  max {max(moved):.2f}°')

    stats = sensor_stats = None
    if not args.no_render:
        print('Rendering')
        solved, stats, _ = render_equirect(frames, R, scale, px_per_deg=args.px_per_deg)
        cv2.imwrite(str(args.out / 'panorama-solved.png'), solved)

        # The same renderer on the untouched sensor poses, so the difference the
        # solve actually made is visible rather than asserted.
        sensor, sensor_stats, _ = render_equirect(
            frames, [f.R for f in frames], 1.0, px_per_deg=args.px_per_deg, log=lambda *_: None)
        cv2.imwrite(str(args.out / 'panorama-sensor.png'), sensor)

    if args.dump_json:
        # Enough for a JavaScript implementation to be checked stage by stage:
        # its features against these, or its solver against these matches. A
        # number that disagrees is then attributable to one stage rather than to
        # the pipeline as a whole.
        dump = {
            'capture': args.capture.name,
            'detector': args.detector,
            'frames': [{
                'index': f.index,
                'width': int(f.image.shape[1]), 'height': int(f.image.shape[0]),
                'tanHalfHorizontal': f.tan_h, 'tanHalfVertical': f.tan_v,
                'sensorR': [list(map(float, row)) for row in f.R],
                'solvedR': [list(map(float, row)) for row in R[k]],
                'features': [[round(float(p.pt[0]), 3), round(float(p.pt[1]), 3)]
                             for p in f.kp],
            } for k, f in enumerate(frames)],
            'focalScale': float(scale),
            'pairs': [{
                'i': p.i, 'j': p.j,
                'ptsI': [[round(float(x), 3), round(float(y), 3)] for x, y in p.pts_i],
                'ptsJ': [[round(float(x), 3), round(float(y), 3)] for x, y in p.pts_j],
            } for p in pairs],
        }
        (args.out / 'dump.json').write_text(json.dumps(dump), encoding='utf-8')
        print(f'  dumped {sum(len(f["features"]) for f in dump["frames"])} features '
              f'and {sum(len(p["ptsI"]) for p in dump["pairs"])} matches')

    np.savez(args.out / 'solution.npz', R=np.array(R), scale=scale,
             index=np.array([f.index for f in frames]))
    (args.out / 'report.json').write_text(json.dumps({
        'capture': args.capture.name,
        'appVersion': session.get('appVersion'),
        'detector': args.detector,
        'maxFeatures': args.max_features,
        'matching': 'brute' if args.brute else f'guided-{args.search_px}px',
        'ratio': ratio,
        'featuresPerFrame': int(np.median([len(f.kp) for f in frames])),
        'frames': len(frames),
        'pairs': len(pairs),
        'matches': int(sum(len(p.pts_i) for p in pairs)),
        'residualDeg': {
            'sensorMedian': float(np.median(before)), 'sensorMean': float(before.mean()),
            'solvedMedian': float(np.median(final)), 'solvedMean': float(final.mean()),
            'solvedP90': float(np.percentile(final, 90)), 'solvedMax': float(final.max()),
        },
        'focalScale': float(scale),
        'lensDeg': {'horizontal': hf, 'vertical': vf},
        'framesMovedDeg': {'median': float(np.median(moved)), 'max': float(max(moved))},
        'render': stats,
        'renderFromSensorPoses': sensor_stats,
    }, indent=2), encoding='utf-8')

    print(f'\nWrote {args.out}')
    print(f'Elapsed {time.time() - t0:.1f}s')
    return frames, pairs, R, scale




# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

def render_equirect(frames, R, scale, px_per_deg=8.0, alt_min=-12.0, alt_max=62.0,
                    feather=True, log=print):
    """
    Paint the sphere.

    The browser picks, for each output pixel, whichever frame sees it closest to
    its own optical axis, and writes that pixel with no blending whatsoever.
    That was a deliberate diagnostic choice — it makes a geometry error show up
    as a hard step instead of hiding inside a smooth gradient — and it is the
    wrong choice for a finished picture, where the same decision turns every
    frame boundary into a visible tear.

    Here each frame is weighted instead. The weight falls to zero at the frame
    edge and peaks at the optical axis, so contributions cross-fade over the
    whole overlap, and the centre of a frame — where the lens is best behaved
    and the pose most trustworthy — always dominates the edge of its neighbour.

    Blending is the right tool for everything at infinity. It is the wrong tool
    for a house twelve metres away, where two views genuinely disagree about
    where the roofline is and averaging them yields a roofline in neither place.
    That case wants a seam, and the seam wants to run where the images already
    agree. This function reports the disagreement it blended over so that the
    need for seam-cutting is a measurement rather than an opinion.
    """
    width = int(round(360.0 * px_per_deg))
    height = int(round((alt_max - alt_min) * px_per_deg))
    accum = np.zeros((height, width, 3), np.float64)
    weight = np.zeros((height, width), np.float64)
    disagreement = np.zeros((height, width), np.float64)
    painted_by = np.zeros((height, width), np.int16)

    az_axis = (np.arange(width) + 0.5) / px_per_deg
    alt_axis = alt_max - (np.arange(height) + 0.5) / px_per_deg

    for n, f in enumerate(frames):
        img = f.image
        ih, iw = img.shape[:2]
        Rt = R[n].T

        # Only visit the slice of canvas this frame could possibly reach.
        axis = R[n] @ np.array([0.0, 0.0, -1.0])
        c_az = math.degrees(math.atan2(axis[0], axis[1])) % 360.0
        c_alt = math.degrees(math.asin(max(-1.0, min(1.0, axis[2]))))
        reach = math.degrees(math.atan(math.hypot(f.tan_h, f.tan_v) * scale)) + 1.0
        alt_lo = max(alt_min, c_alt - reach)
        alt_hi = min(alt_max, c_alt + reach)
        if alt_hi <= alt_lo:
            continue
        row0 = int(max(0, math.floor((alt_max - alt_hi) * px_per_deg)))
        row1 = int(min(height, math.ceil((alt_max - alt_lo) * px_per_deg)))
        span = reach / max(math.cos(math.radians(min(85.0, abs(c_alt)))), 0.05)
        col_span = int(math.ceil(span * px_per_deg))
        centre_col = int(round(c_az * px_per_deg))
        cols = (np.arange(centre_col - col_span, centre_col + col_span + 1)) % width
        if row1 <= row0 or len(cols) == 0:
            continue

        az = np.radians(az_axis[cols])[None, :]
        alt = np.radians(alt_axis[row0:row1])[:, None]
        ca = np.cos(alt)
        world = np.stack([np.broadcast_to(np.sin(az) * ca, (row1 - row0, len(cols))),
                          np.broadcast_to(np.cos(az) * ca, (row1 - row0, len(cols))),
                          np.broadcast_to(np.sin(alt) * np.ones_like(az), (row1 - row0, len(cols)))],
                         axis=-1)
        cam = world @ Rt.T
        depth = -cam[..., 2]
        ok = depth > 1e-6
        safe = np.where(ok, depth, 1.0)
        u = cam[..., 0] / safe / (f.tan_h * scale)
        v = cam[..., 1] / safe / (f.tan_v * scale)
        ok &= (np.abs(u) <= 1) & (np.abs(v) <= 1)
        if not ok.any():
            continue

        x = ((u + 1) / 2 * iw - 0.5).astype(np.float32)
        y = ((1 - v) / 2 * ih - 0.5).astype(np.float32)
        sampled = cv2.remap(img, x, y, cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))

        if feather:
            # Zero at the frame edge, one on the axis. Squared so the centre
            # wins decisively rather than merely narrowly.
            w = np.clip((1 - np.abs(u)) * (1 - np.abs(v)), 0, 1) ** 2
        else:
            w = np.ones_like(u)
        w = np.where(ok, w, 0.0)

        sub = (slice(row0, row1), cols)
        prev_w = weight[sub]
        prev = np.divide(accum[sub], np.maximum(prev_w, 1e-9)[..., None],
                         out=np.zeros_like(accum[sub]), where=prev_w[..., None] > 1e-9)
        overlap = (prev_w > 1e-6) & (w > 1e-6)
        if overlap.any():
            diff = np.abs(prev - sampled.astype(np.float64)).mean(axis=-1)
            disagreement[sub] = np.where(overlap,
                                         np.maximum(disagreement[sub], diff),
                                         disagreement[sub])

        accum[sub] += sampled.astype(np.float64) * w[..., None]
        weight[sub] += w
        painted_by[sub] = np.where(w > 1e-6, painted_by[sub] + 1, painted_by[sub])

    out = np.zeros((height, width, 3), np.uint8)
    filled = weight > 1e-6
    out[filled] = np.clip(accum[filled] / weight[filled][..., None], 0, 255).astype(np.uint8)

    overlapped = painted_by >= 2
    stats = {
        'width': width, 'height': height,
        'paintedFraction': float(filled.mean()),
        'overlapFraction': float(overlapped.mean()),
        'meanOverlapDisagreement': float(disagreement[overlapped].mean()) if overlapped.any() else 0.0,
        'p95OverlapDisagreement': float(np.percentile(disagreement[overlapped], 95)) if overlapped.any() else 0.0,
    }
    log(f'  painted {stats["paintedFraction"]*100:.1f}% of the panel, '
        f'{stats["overlapFraction"]*100:.1f}% seen by 2+ frames')
    log(f'  overlap disagreement: mean {stats["meanOverlapDisagreement"]:.1f} '
        f'p95 {stats["p95OverlapDisagreement"]:.1f} (0-255 per channel)')
    return out, stats, filled


if __name__ == '__main__':
    main()
