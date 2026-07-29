/* Pre-flight sweep: does it correctly classify magnetic environments?
 *
 * The measurement is a compass swing. Turn through headings, compare compass
 * against fused visual+inertial rotation, and report the SPREAD of the residual
 * rather than its mean — a constant offset is just the datum and is harmless.
 *
 * The verdict must survive a constant offset, must catch a direction-dependent
 * swing, and must refuse to rule at all on a sweep too short to distinguish the
 * two.
 */
import { PreflightSweep, VERDICT, MIN_SWEEP_DEG } from '../js/preflight.js';

let seed = 987654321;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

/**
 * Sweep through `arcDeg`, with the compass distorted by:
 *   offset  — a constant bias, which must NOT be penalised
 *   swing   — amplitude of a heading-dependent distortion, which must be
 *   noise   — random scatter
 */
function run(arcDeg, { offset = 0, swing = 0, noise = 0, compass = true, n = 300 } = {}) {
  const pf = new PreflightSweep();
  pf.start();
  for (let i = 0; i < n; i++) {
    const truth = (i / (n - 1)) * arcDeg;
    const distortion = swing * Math.sin(truth * Math.PI / 180 * 2);
    pf.add({
      compass: compass ? truth + offset + distortion + rnd() * noise : null,
      integrated: truth,
      jitter: 0.4,
      quality: 0.8
    });
  }
  return pf.result();
}

const show = (name, r) => {
  const dev = r.deviationDeg === null ? '   —  ' : `${r.deviationDeg.toFixed(1).padStart(5)}°`;
  console.log(`  ${name.padEnd(42)} ${String(r.verdict).padEnd(13)} swing ${dev}`);
};

console.log('--- environments the survey should trust ---');
show('clean field, 180° sweep', run(180));
show('constant 40° offset (bias only, harmless)', run(180, { offset: 40 }));
show('clean field with 1° of compass noise', run(180, { noise: 1 }));

console.log('\n--- environments the survey should distrust ---');
show('phone beside steel tripod, 12° swing', run(180, { swing: 12 }));
show('severe distortion, 30° swing', run(180, { swing: 30 }));
show('mild distortion, 4° swing', run(180, { swing: 4 }));

console.log('\n--- cases where no verdict may be offered ---');
show('sweep only 30°, below the 60° floor', run(30));
show('browser reports no compass', run(180, { compass: false }));
show('too few samples', run(180, { n: 20 }));

console.log('\n--- the offset must not leak into the verdict ---');
const a = run(180, { swing: 12, offset: 0 });
const b = run(180, { swing: 12, offset: 137 });
console.log(`  swing 12° with no offset : ${a.deviationDeg.toFixed(2)}°`);
console.log(`  swing 12° with 137° offset: ${b.deviationDeg.toFixed(2)}°`);
console.log(`  ${Math.abs(a.deviationDeg - b.deviationDeg) < 0.5 ? 'PASS' : 'FAIL'} - a constant bias must not change the verdict`);

console.log('\n--- swing table should localise the distortion ---');
const r = run(360, { swing: 20, n: 720 });
const worst = r.swingTable.filter(x => x.n).sort((x, y) => Math.abs(y.residualDeg) - Math.abs(x.residualDeg))[0];
console.log(`  worst 30° sector: ${worst.fromDeg}°–${worst.fromDeg + 30}° at ${worst.residualDeg.toFixed(1)}°`);
console.log(`  ${Math.abs(worst.residualDeg) > 10 ? 'PASS' : 'FAIL'} - distortion must be attributable to a direction`);

console.log('\n--- a single bad frame must not set the verdict ---');
const pf = new PreflightSweep();
pf.start();
for (let i = 0; i < 300; i++) pf.add({ compass: i * 0.6, integrated: i * 0.6, jitter: 0.3, quality: 0.9 });
pf.add({ compass: 200, integrated: 10, jitter: 0.3, quality: 0.9 });   // one wild outlier
const rr = pf.result();
console.log(`  verdict with one outlier: ${rr.verdict}, swing ${rr.deviationDeg.toFixed(2)}°`);
console.log(`  ${rr.verdict === VERDICT.GOOD ? 'PASS' : 'FAIL'} - percentile span must reject the outlier`);
