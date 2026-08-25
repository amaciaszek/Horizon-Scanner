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

Everything else in this directory is a `*.test.mjs` suite; run them all with

```bash
for f in tests/*.test.mjs; do node "$f" || echo "FAILED $f"; done
```

Three are worth knowing about by name, because each one exists for a field
failure that nothing else could have caught:

| Suite | The failure it guards |
|---|---|
| `dot-leads.test.mjs` | The dot mirroring the phone instead of leading it (2026-08-25 20:03), and lurching from the top of a column to the bottom in one update (2026-08-25 22:23) |
| `serpentine-hold.test.mjs` | A column pinning the dot forever, and the opposite — the dot abandoning a column it should have waited for |
| `import-map.test.mjs` | A version bump that busts `main.js` and nothing it imports, so the device runs a mixture of builds |

`tools/replay-guidance.mjs` is not a test but belongs beside them: it replays a
real capture's recorded poses through the current guidance and prints what the
dot would have done differently. A synthetic operator does what the test author
imagined; a recorded one did what a person actually did.

```bash
for t in verify verify2 sim sim2 sim3 sim4 sim5 timing; do
  echo "== $t"; node tests/$t.mjs
done
```
