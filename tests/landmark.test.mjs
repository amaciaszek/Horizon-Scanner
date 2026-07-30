/* Landmark residual analysis: does it separate a datum offset from drift?
 * These two produce identical mean residuals and must never be conflated —
 * an offset is cancelled by the mount with one number, drift is not
 * correctable at all. */
import { landmarkResiduals, pixelToAzAlt, PANO_DEFAULTS } from '../js/panorama.js';
import { wrap360 } from '../js/math3d.js';

let fails = 0;
const check = (n, ok, d) => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}${d ? '  ' + d : ''}`); if (!ok) fails++; };

/* pixel -> bearing round trip, including the ruler offset */
{
  const opts = { ...PANO_DEFAULTS, pxPerDeg: 6, altMax: 60, azStart: 0 };
  let worst = 0;
  for (let az = 0; az < 360; az += 3.7) {
    for (let alt = -8; alt < 58; alt += 6.3) {
      const px = wrap360(az - opts.azStart) * opts.pxPerDeg;
      const py = (opts.altMax - alt) * opts.pxPerDeg + 22;
      const r = pixelToAzAlt(px, py, opts, 22);
      worst = Math.max(worst, Math.abs(wrap360(r.az - az + 180) - 180), Math.abs(r.alt - alt));
    }
  }
  check('pixelToAzAlt round-trips', worst < 1e-9, `max err ${worst.toExponential(2)}`);
}

/* A pure datum offset: same residual everywhere. */
{
  const OFF = 7.5;
  const lm = [10, 95, 180, 260, 330].map((t, i) => ({
    id: `a${i}`, name: `L${i}`, trueAz: t, measuredAz: wrap360(t - OFF)
  }));
  const r = landmarkResiduals(lm);
  check('offset: mean recovers the offset', Math.abs(r.mean - OFF) < 1e-6, `mean ${r.mean.toFixed(3)}°`);
  check('offset: spread is ~zero', r.span < 1e-6, `span ${r.span.toExponential(2)}`);
}

/* Drift: azimuth error grows around the lap. Same mean, large spread. */
{
  const lm = [10, 95, 180, 260, 330].map((t, i) => ({
    id: `b${i}`, name: `L${i}`, trueAz: t, measuredAz: wrap360(t - (t / 360) * 12)
  }));
  const r = landmarkResiduals(lm);
  check('drift: spread is large', r.span > 8, `span ${r.span.toFixed(2)}°`);
  check('drift: worst outlier is at an extreme bearing',
    r.worst.trueAz === 10 || r.worst.trueAz === 330, `at ${r.worst.trueAz}°`);
}

/* The wrap case that silently ruins naive implementations. */
{
  const r = landmarkResiduals([
    { id: 'c0', name: 'A', trueAz: 2, measuredAz: 358 },
    { id: 'c1', name: 'B', trueAz: 358, measuredAz: 2 }
  ]);
  const vals = r.rows.map(x => x.residual);
  check('residuals wrap across north', Math.abs(Math.abs(vals[0]) - 4) < 1e-9 && Math.abs(Math.abs(vals[1]) - 4) < 1e-9,
    `[${vals.map(v => v.toFixed(1)).join(', ')}]`);
  check('opposite-sign wrap residuals cancel in the mean', Math.abs(r.mean) < 1e-9, `mean ${r.mean.toExponential(2)}`);
  check('...but the spread still reports 8°', Math.abs(r.span - 8) < 1e-9, `span ${r.span.toFixed(2)}°`);
}

/* Incomplete rows are ignored, not treated as zero. */
{
  const r = landmarkResiduals([
    { id: 'd0', name: 'A', trueAz: 100, measuredAz: 103 },
    { id: 'd1', name: 'B', trueAz: NaN, measuredAz: 200 },
    { id: 'd2', name: 'C', trueAz: 300, measuredAz: NaN }
  ]);
  check('rows without both bearings are ignored', r.n === 1, `n=${r.n}`);
  check('empty input is safe', landmarkResiduals([]).n === 0);
}

console.log(fails ? `\n${fails} FAILED` : '\nall landmark checks passed');
process.exit(fails ? 1 : 0);
