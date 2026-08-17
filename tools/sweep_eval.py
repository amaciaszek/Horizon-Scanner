"""
Score every sweep configuration against ONE common set of correspondences.

Each run of stitch_lab.py reports its residual over its own matches, and that
comparison is unfair in a way that is easy to miss: a configuration that finds
fewer, cleaner correspondences is being marked on an easier paper. Halving the
feature count removes the weak, low-contrast matches first, so the median falls
even if the recovered geometry is no better — and possibly while it is worse,
since those same weak matches were the only thing tying some frames down.

So: build one evaluation set once, from the richest configuration available, and
measure every solved pose set against it. The poses are what the port has to
reproduce; the matches that produced them are scaffolding.

    .venv-stitch\\Scripts\\python.exe tools\\sweep_eval.py <capture.zip> --runs sweep
"""
import argparse
import json
from pathlib import Path

import numpy as np

from stitch_lab import (load_capture, detect_features, match_pairs, verify_pairs,
                        residual_degrees)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('capture', type=Path)
    ap.add_argument('--runs', type=Path, default=Path('sweep'))
    ap.add_argument('--eval-detector', default='sift')
    ap.add_argument('--eval-features', type=int, default=3000)
    args = ap.parse_args()

    print(f'Building the evaluation set: {args.eval_detector} @ {args.eval_features}')
    frames, _ = load_capture(args.capture)
    detect_features(frames, max_features=args.eval_features, detector=args.eval_detector)
    pairs = verify_pairs(frames, match_pairs(frames, search_px=64))
    # Evaluation matches are verified but NOT pruned. Pruning is done under a
    # particular solution, and a yardstick that has already been trimmed to fit
    # one of the things it is measuring is not a yardstick.
    print(f'  {sum(len(p.pts_i) for p in pairs)} matches over {len(pairs)} pairs\n')

    sensor = residual_degrees(frames, pairs)
    rows = [('sensor poses', None, sensor, None, None)]

    for run in sorted(args.runs.iterdir()):
        npz, rep = run / 'solution.npz', run / 'report.json'
        if not npz.exists() or not rep.exists():
            continue
        sol = np.load(npz)
        meta = json.loads(rep.read_text(encoding='utf-8'))
        index = {int(v): k for k, v in enumerate(sol['index'])}
        R = [sol['R'][index[f.index]] for f in frames]
        errs = residual_degrees(frames, pairs, R, float(sol['scale']))
        rows.append((run.name, meta.get('featuresPerFrame'), errs,
                     meta['residualDeg']['solvedMedian'], float(sol['scale'])))

    w = max(len(r[0]) for r in rows)
    print(f'{"run":<{w}}  {"feat/frame":>10}  {"own median":>10}  '
          f'{"COMMON median":>13}  {"mean":>7}  {"p90":>7}  {"max":>7}  {"focal":>6}')
    for name, feat, errs, own, scale in rows:
        print(f'{name:<{w}}  {feat if feat else "":>10}  '
              f'{f"{own:.3f}" if own is not None else "-":>10}  '
              f'{np.median(errs):>13.3f}  {errs.mean():>7.3f}  '
              f'{np.percentile(errs, 90):>7.3f}  {errs.max():>7.2f}  '
              f'{f"{scale:.4f}" if scale else "-":>6}')


if __name__ == '__main__':
    main()
