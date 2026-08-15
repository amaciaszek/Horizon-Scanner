#!/usr/bin/env python3
"""Offline panorama experiment for Horizon Scanner debug bundles.

This intentionally does not share code with the browser stitcher.  It produces:
  * sensor-panorama.png  -- direct equirectangular reprojection from saved poses
  * panorama.png         -- OpenCV visual refinement, spherical warping and blend
  * comparison.jpg       -- the two results stacked for quick inspection
  * stitch-report.json   -- frame, motion and adjacent-match diagnostics

The refined image is a visual proof, not yet an azimuth-calibrated product.  The
sensor image retains the app's absolute azimuth geometry; the OpenCV image uses
the sensor data to order the circular capture and place the weak closure away
from the middle of the solve, then estimates its own visual camera rotations.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

import cv2
import numpy as np


STITCH_STATUS = {
    cv2.Stitcher_OK: "ok",
    cv2.Stitcher_ERR_NEED_MORE_IMGS: "need_more_images",
    cv2.Stitcher_ERR_HOMOGRAPHY_EST_FAIL: "homography_estimation_failed",
    cv2.Stitcher_ERR_CAMERA_PARAMS_ADJUST_FAIL: "camera_adjustment_failed",
}


@dataclass
class Frame:
    index: int
    record: dict[str, Any]
    image: np.ndarray

    @property
    def azimuth(self) -> float:
        return float(self.record["pointing"]["captureAzimuthDeg"])

    @property
    def altitude(self) -> float:
        return float(self.record["pointing"]["centerAltitudeDeg"])

    @property
    def yaw_rate(self) -> float:
        value = self.record.get("gyroscope", {}).get("yawRateDegPerSec")
        return float(value) if value is not None else math.nan


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a visual proof panorama from a Horizon Scanner debug ZIP."
    )
    parser.add_argument("bundle", type=Path, help="capture-debug ZIP from the app")
    parser.add_argument("-o", "--output", type=Path, default=Path("stitch-output"))
    parser.add_argument(
        "--anchor-index",
        type=int,
        help="first image passed to OpenCV; default is the middle of the sweep",
    )
    parser.add_argument(
        "--anchor-azimuth",
        type=float,
        help="choose the first image nearest this saved capture azimuth",
    )
    parser.add_argument("--pano-confidence", type=float, default=0.35)
    parser.add_argument("--pixels-per-degree", type=float, default=4.0)
    parser.add_argument("--alt-min", type=float, default=-12.0)
    parser.add_argument("--alt-max", type=float, default=65.0)
    parser.add_argument("--no-sensor-preview", action="store_true")
    return parser.parse_args()


def load_bundle(path: Path) -> tuple[list[Frame], dict[str, Any]]:
    if not path.is_file():
        raise FileNotFoundError(path)
    with zipfile.ZipFile(path) as archive:
        records = json.loads(archive.read("metadata/keyframes.json"))
        session = json.loads(archive.read("metadata/session.json"))
        frames: list[Frame] = []
        for record in records:
            photo_path = PurePosixPath(record["photo"]["path"])
            if photo_path.is_absolute() or ".." in photo_path.parts:
                raise ValueError(f"unsafe photo path in bundle: {photo_path}")
            encoded = np.frombuffer(archive.read(str(photo_path)), dtype=np.uint8)
            image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError(f"OpenCV could not decode {photo_path}")
            frames.append(Frame(int(record["index"]), record, image))
    frames.sort(key=lambda frame: frame.record.get("timestampMs", frame.index))
    if len(frames) < 2:
        raise ValueError("at least two photographed keyframes are required")
    return frames, session


def angular_difference(a: float, b: float) -> float:
    return (a - b + 180.0) % 360.0 - 180.0


def choose_anchor(frames: list[Frame], args: argparse.Namespace) -> int:
    if args.anchor_index is not None and args.anchor_azimuth is not None:
        raise ValueError("use only one of --anchor-index and --anchor-azimuth")
    if args.anchor_index is not None:
        if not 0 <= args.anchor_index < len(frames):
            raise ValueError("--anchor-index is outside the available frame range")
        return args.anchor_index
    if args.anchor_azimuth is not None:
        return min(
            range(len(frames)),
            key=lambda i: abs(angular_difference(frames[i].azimuth, args.anchor_azimuth)),
        )
    # A full sweep has its weakest visual edge at the original end/start loop
    # closure. Rotating by half a sweep puts that edge inside OpenCV's graph and
    # moves the output boundary to the opposite side of the scene.
    return len(frames) // 2


def below_skyline_mask(frame: Frame) -> np.ndarray:
    height, width = frame.image.shape[:2]
    analysis = frame.record.get("analysis", {})
    boundary = np.asarray(analysis.get("boundary", []), dtype=np.float32)
    if boundary.size < 2:
        return np.full((height, width), 255, dtype=np.uint8)
    analysis_height = float(frame.record.get("camera", {}).get("analysisHeight", 288))
    source_x = np.linspace(0.0, width - 1.0, boundary.size)
    image_x = np.arange(width, dtype=np.float32)
    skyline = np.interp(image_x, source_x, boundary) * height / analysis_height
    rows = np.arange(height, dtype=np.float32)[:, None]
    return np.where(rows >= skyline[None, :], 255, 0).astype(np.uint8)


def feature_diagnostics(frames: list[Frame]) -> tuple[list[dict[str, Any]], list[int]]:
    sift = cv2.SIFT_create(nfeatures=4000, contrastThreshold=0.015)
    keypoints: list[list[cv2.KeyPoint]] = []
    descriptors: list[np.ndarray | None] = []
    feature_counts: list[int] = []
    for frame in frames:
        gray = cv2.cvtColor(frame.image, cv2.COLOR_BGR2GRAY)
        points, desc = sift.detectAndCompute(gray, below_skyline_mask(frame))
        keypoints.append(points)
        descriptors.append(desc)
        feature_counts.append(len(points))

    matcher = cv2.BFMatcher(cv2.NORM_L2)
    pairs: list[dict[str, Any]] = []
    for i in range(len(frames)):
        j = (i + 1) % len(frames)
        left, right = descriptors[i], descriptors[j]
        good: list[cv2.DMatch] = []
        if left is not None and right is not None and len(left) >= 2 and len(right) >= 2:
            for match in matcher.knnMatch(left, right, k=2):
                if len(match) == 2 and match[0].distance < 0.76 * match[1].distance:
                    good.append(match[0])

        inliers = 0
        median_error = None
        if len(good) >= 4:
            src = np.float32([keypoints[i][m.queryIdx].pt for m in good])
            dst = np.float32([keypoints[j][m.trainIdx].pt for m in good])
            homography, mask = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
            if homography is not None and mask is not None:
                keep = mask.ravel().astype(bool)
                inliers = int(keep.sum())
                if inliers:
                    projected = cv2.perspectiveTransform(src[:, None, :], homography)[:, 0, :]
                    errors = np.linalg.norm(projected - dst, axis=1)
                    median_error = float(np.median(errors[keep]))

        pairs.append(
            {
                "from": frames[i].index,
                "to": frames[j].index,
                "sensorAzimuthStepDeg": round(
                    angular_difference(frames[j].azimuth, frames[i].azimuth), 4
                ),
                "ratioMatches": len(good),
                "homographyInliers": inliers,
                "inlierRatio": round(inliers / len(good), 4) if good else 0.0,
                "medianReprojectionErrorPx": (
                    round(median_error, 4) if median_error is not None else None
                ),
                "weak": inliers < 10,
                "loopClosure": i == len(frames) - 1,
            }
        )
    return pairs, feature_counts


def quat_multiply(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        dtype=np.float64,
    )


def quat_matrix(q: np.ndarray) -> np.ndarray:
    q = q / np.linalg.norm(q)
    w, x, y, z = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ],
        dtype=np.float64,
    )


def corrected_quaternion(frame: Frame) -> np.ndarray:
    orientation = frame.record["orientation"]
    pointing = frame.record["pointing"]
    raw = np.asarray(orientation["quaternion"], dtype=np.float64)
    correction = (
        float(orientation.get("yawBaseCorrectionDeg") or 0.0)
        + float(orientation.get("stitchYawCorrectionDeg") or 0.0)
        + float(pointing.get("azimuthDatumDeg") or 0.0)
    )
    half = math.radians(-correction) / 2.0
    yaw = np.array([math.cos(half), 0.0, 0.0, math.sin(half)], dtype=np.float64)
    return quat_multiply(yaw, raw)


def sensor_panorama(
    frames: list[Frame], pixels_per_degree: float, alt_min: float, alt_max: float
) -> np.ndarray:
    width = int(round(360.0 * pixels_per_degree))
    height = int(round((alt_max - alt_min) * pixels_per_degree))
    azimuth = np.deg2rad((np.arange(width, dtype=np.float32) + 0.5) / pixels_per_degree)
    altitude = np.deg2rad(
        alt_max - (np.arange(height, dtype=np.float32) + 0.5) / pixels_per_degree
    )
    az, alt = np.meshgrid(azimuth, altitude)
    cos_alt = np.cos(alt)
    world = np.stack(
        (np.sin(az) * cos_alt, np.cos(az) * cos_alt, np.sin(alt)), axis=-1
    ).astype(np.float32)

    colour_sum = np.zeros((height, width, 3), dtype=np.float32)
    weight_sum = np.zeros((height, width), dtype=np.float32)
    for frame in frames:
        rotation = quat_matrix(corrected_quaternion(frame)).astype(np.float32)
        # Row-vector equivalent of device = transpose(R) * world.
        camera = world @ rotation
        depth = -camera[..., 2]
        intrinsics = frame.record["camera"]
        tan_h = float(intrinsics["tanHalfHorizontal"])
        tan_v = float(intrinsics["tanHalfVertical"])
        u = np.divide(camera[..., 0], depth * tan_h, out=np.zeros_like(depth), where=depth > 1e-6)
        v = np.divide(camera[..., 1], depth * tan_v, out=np.zeros_like(depth), where=depth > 1e-6)
        distance = np.maximum(np.abs(u), np.abs(v))
        valid = (depth > 1e-6) & (distance <= 1.0)
        source_h, source_w = frame.image.shape[:2]
        map_x = ((u + 1.0) * 0.5 * source_w - 0.5).astype(np.float32)
        map_y = ((1.0 - v) * 0.5 * source_h - 0.5).astype(np.float32)
        warped = cv2.remap(
            frame.image,
            map_x,
            map_y,
            cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
        ).astype(np.float32)
        weight = np.where(valid, np.cos(distance * math.pi / 2.0) ** 2, 0.0).astype(np.float32)
        colour_sum += warped * weight[..., None]
        weight_sum += weight

    bgr = np.divide(
        colour_sum,
        weight_sum[..., None],
        out=np.zeros_like(colour_sum),
        where=weight_sum[..., None] > 1e-5,
    ).clip(0, 255).astype(np.uint8)
    alpha = np.where(weight_sum > 1e-5, 255, 0).astype(np.uint8)
    return np.dstack((bgr, alpha))


def refined_panorama(frames: list[Frame], confidence: float) -> tuple[int, np.ndarray | None]:
    stitcher = cv2.Stitcher_create(cv2.Stitcher_PANORAMA)
    stitcher.setPanoConfidenceThresh(confidence)
    stitcher.setWaveCorrection(True)
    # Detect/match on a reduced image, but composite the final source pixels.
    # The saved frames are only 0.31 MP; 0.20/0.10 MP retain ample structure
    # while avoiding a very expensive full-resolution graph-cut seam search.
    stitcher.setRegistrationResol(0.20)
    stitcher.setSeamEstimationResol(0.10)
    stitcher.setCompositingResol(-1)
    status, panorama = stitcher.stitch([frame.image for frame in frames])
    return int(status), panorama


def crop_and_add_alpha(image: np.ndarray) -> np.ndarray:
    mask = np.max(image, axis=2) > 2
    ys, xs = np.where(mask)
    if not len(xs):
        raise ValueError("stitched panorama contains no painted pixels")
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    cropped = image[y0:y1, x0:x1]
    alpha = np.where(np.max(cropped, axis=2) > 2, 255, 0).astype(np.uint8)
    return np.dstack((cropped, alpha))


def opaque_preview(image: np.ndarray, background: tuple[int, int, int] = (18, 18, 18)) -> np.ndarray:
    if image.shape[2] == 3:
        return image
    alpha = image[..., 3:4].astype(np.float32) / 255.0
    bg = np.full(image.shape[:2] + (3,), background, dtype=np.float32)
    return (image[..., :3].astype(np.float32) * alpha + bg * (1.0 - alpha)).astype(np.uint8)


def comparison_image(sensor: np.ndarray | None, refined: np.ndarray) -> np.ndarray:
    rows: list[tuple[str, np.ndarray]] = []
    if sensor is not None:
        rows.append(("SENSOR REPROJECTION (azimuth-preserving)", opaque_preview(sensor)))
    rows.append(("VISUAL REFINEMENT (OpenCV spherical stitch)", opaque_preview(refined)))
    target_width = max(row.shape[1] for _, row in rows)
    rendered: list[np.ndarray] = []
    for label, row in rows:
        scale = target_width / row.shape[1]
        resized = cv2.resize(row, (target_width, max(1, round(row.shape[0] * scale))))
        label_bar = np.full((42, target_width, 3), (13, 23, 28), dtype=np.uint8)
        cv2.putText(label_bar, label, (14, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (232, 244, 248), 2, cv2.LINE_AA)
        rendered.extend((label_bar, resized))
    return np.vstack(rendered)


def main() -> int:
    args = parse_args()
    cv2.setRNGSeed(0)
    started = time.perf_counter()
    frames, session = load_bundle(args.bundle.resolve())
    anchor = choose_anchor(frames, args)
    ordered = frames[anchor:] + frames[:anchor]
    pairs, feature_counts = feature_diagnostics(frames)

    args.output.mkdir(parents=True, exist_ok=True)
    sensor: np.ndarray | None = None
    if not args.no_sensor_preview:
        sensor = sensor_panorama(
            frames, args.pixels_per_degree, args.alt_min, args.alt_max
        )
        cv2.imwrite(str(args.output / "sensor-panorama.png"), sensor)

    status, stitched = refined_panorama(ordered, args.pano_confidence)
    if status != cv2.Stitcher_OK or stitched is None:
        raise RuntimeError(f"OpenCV stitch failed: {STITCH_STATUS.get(status, status)}")
    refined = crop_and_add_alpha(stitched)
    cv2.imwrite(str(args.output / "panorama.png"), refined)
    cv2.imwrite(str(args.output / "panorama-preview.jpg"), opaque_preview(refined))
    cv2.imwrite(str(args.output / "comparison.jpg"), comparison_image(sensor, refined))

    moving = [
        {"index": frame.index, "yawRateDegPerSec": round(frame.yaw_rate, 4)}
        for frame in frames
        if math.isfinite(frame.yaw_rate) and abs(frame.yaw_rate) > 18.0
    ]
    weak_pairs = [pair for pair in pairs if pair["weak"]]
    report = {
        "format": "horizon-offline-stitch-report",
        "version": 1,
        "input": str(args.bundle.resolve()),
        "site": session.get("site"),
        "opencvVersion": cv2.__version__,
        "frameCount": len(frames),
        "sensorGuidance": {
            "anchorPosition": anchor,
            "anchorFrameIndex": ordered[0].index,
            "anchorAzimuthDeg": round(ordered[0].azimuth, 4),
            "orderedFrameIndexes": [frame.index for frame in ordered],
            "sensorPreviewRetainsAbsoluteAzimuth": sensor is not None,
            "visualPanoramaRetainsAbsoluteAzimuth": False,
        },
        "frames": [
            {
                "index": frame.index,
                "azimuthDeg": round(frame.azimuth, 4),
                "altitudeDeg": round(frame.altitude, 4),
                "yawRateDegPerSec": (
                    round(frame.yaw_rate, 4) if math.isfinite(frame.yaw_rate) else None
                ),
                "siftFeaturesBelowSkyline": feature_counts[i],
            }
            for i, frame in enumerate(frames)
        ],
        "adjacentPairs": pairs,
        "summary": {
            "opencvStatus": STITCH_STATUS.get(status, str(status)),
            "weakAdjacentPairs": len(weak_pairs),
            "weakPairIndexes": [[p["from"], p["to"]] for p in weak_pairs],
            "movingFrameCount": len(moving),
            "movingFrames": moving,
            "visualResultWidth": int(refined.shape[1]),
            "visualResultHeight": int(refined.shape[0]),
            "elapsedSeconds": round(time.perf_counter() - started, 3),
        },
        "limitations": [
            "The visual panorama is not yet mapped back onto the saved absolute azimuth axis.",
            "A single global rotation/homography model cannot remove all parallax from a nearby house.",
            "Transparent regions are uncaptured directions, not stitching failures.",
        ],
    }
    (args.output / "stitch-report.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    print(json.dumps(report["summary"], indent=2))
    print(f"Wrote {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
