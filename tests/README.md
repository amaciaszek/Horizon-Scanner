# Test scripts

Run from anywhere with Node 18+. No dependencies.

| Script | What it checks |
|---|---|
| `verify.mjs` | Orientation and projection maths, portrait poses and frame edges |
| `verify2.mjs` | Screen-rotation handling: landscape must equal portrait |
| `sim.mjs` | End-to-end: synthetic frames → segmentation → projection → merge, vs ground truth. Also HZN1/HZN2 byte layout and CRC |
| `sim2.mjs` | Visual registration on integer shifts, refusal on featureless input, loop closure against an anchor |
| `sim3.mjs` | Registration robustness: subpixel shifts, no hint, short hint, wrong-sign hint, wildly wrong hint |
| `sim4.mjs` | Loop-closure drift distribution with a known injected gyro error |
| `sim5.mjs` | Acceptance-rule negative controls: spikes, real steps, single-pass arcs, low confidence, noise, holes |
| `timing.mjs` | Per-frame worker cost |

```bash
for t in verify verify2 sim sim2 sim3 sim4 sim5 timing; do
  echo "== $t"; node tests/$t.mjs
done
```
