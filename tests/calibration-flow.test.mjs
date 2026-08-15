/* Walk the calibration state machine exactly as the primary button drives it.
 * main.js cannot be imported (it needs the DOM and starts the app), so the
 * transition table is extracted from the source and executed. This exists
 * because a bad bulk edit made startBriefedStage re-brief its own stage, which
 * every static check passed and which read to the operator as a dead button. */
import { readFileSync } from 'fs';
const src = readFileSync('js/main.js', 'utf8');
const strip = s => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fn = name => {
  const a = src.indexOf('function ' + name);
  if (a < 0) throw new Error('missing ' + name);
  return strip(src.slice(a, src.indexOf('\nfunction ', a + 10)));
};

const starter = fn('startBriefedStage');
let failures = 0;
const check = (n, ok, d) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  ' + d : ''}`); if (!ok) failures++; };

// Which stage does pressing Start actually land on, per briefing target?
const lands = target => {
  const key = target === 'freeform' ? 'FREEFORM_STAGE'
    : target === 'lens' ? 'LENS_STAGE' : `'${target}'`;
  const i = starter.indexOf(`next === ${key}`);
  const branch = i < 0
    ? starter.slice(starter.indexOf('} else {'))            // the settle fallback
    : starter.slice(i, starter.indexOf('} else', i) + 1 || undefined);
  if (/beginLensMeasurement\(\)/.test(branch)) return 'lens';
  const m = branch.match(/stage:\s*(?:'([a-z]+)'|([A-Z_]+))/);
  const raw = m ? (m[1] || m[2]) : null;
  return raw === 'FREEFORM_STAGE' ? 'freeform' : raw === 'LENS_STAGE' ? 'lens' : raw;
};

console.log('=== Pressing Start must leave the briefing, every time ===');
for (const t of ['stationary', 'freeform', 'lens', 'settle']) {
  const got = lands(t);
  check(`brief('${t}') then Start -> ${t}`, got === t, `landed on ${got}`);
  check(`  and never back on a briefing`, got !== 'brief' && got !== null, `${got}`);
}

console.log('=== Each start arms the thing it is about to measure ===');
check('stationary arms the bias diagnostic', /next === 'stationary'[\s\S]{0,200}beginStationaryDiagnostic\(\)/.test(starter));
check('freeform arms a fresh spin', /FREEFORM_STAGE[\s\S]{0,200}resetSpinEvidence\(\)[\s\S]{0,120}beginSpinDiagnostic/.test(starter));
check('lens resets the calibrator', /beginLensMeasurement/.test(starter) && /lensCal\.reset\(\)/.test(fn('beginLensMeasurement')));

console.log('=== Nothing is recorded while a briefing is up ===');
check('tickCalibration returns on BRIEF_STAGE', /BRIEF_STAGE\) return;/.test(strip(fn('tickCalibration'))));

console.log('=== The button reaches the starter ===');
const primary = strip(fn('onPrimary'));
const iBrief = primary.indexOf('BRIEF_STAGE');
const iPass1 = primary.indexOf('PHASE.PASS1');
check('onPrimary handles BRIEF_STAGE', iBrief > 0 && /BRIEF_STAGE\) return startBriefedStage\(\)/.test(primary));
check('and reaches it before the later phases', iBrief < iPass1);

if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exitCode = 1; }
else console.log('\ncalibration flow ok');
