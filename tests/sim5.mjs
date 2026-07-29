/* Negative controls: the system must REFUSE bad data, not average it away. */
import { Survey, BIN_COUNT, BIN_STEP, STATUS, RULES } from '../js/survey.js';
const obs=(v,n,passes,w=0.9)=>Array.from({length:n},()=>({value:v,weight:w,pass:1}));

function fresh(fill){ const s=new Survey();
  for(let i=0;i<BIN_COUNT;i++){ const b=s.bins[i]; fill(b,i);} s.recompute(); return s; }

// 1. Clean data everywhere
let s=fresh(b=>{b.obs=obs(10,6); b.passes=new Set([1,2]);});
console.log(`1. clean data                 verified ${s.coverage().verifiedBins}/720   spikes ${s.bins.filter(b=>b.spike).length}`);

// 2. A single-bin segmentation blowout at 100 degrees
s=fresh((b,i)=>{ const bad = i===200; b.obs=obs(bad?46:10,6); b.passes=new Set([1,2]); });
console.log(`2. one 36-deg spike at 100deg verified ${s.coverage().verifiedBins}/720   spikes ${s.bins.filter(b=>b.spike).length}   bin200 status ${s.bins[200].status} (3=verified)`);

// 3. A real vertical step: 10 deg jumping to 34 deg at 150 deg and back at 215
s=fresh((b,i)=>{ const az=i*BIN_STEP; const v=(az>150&&az<215)?34:10; b.obs=obs(v,6); b.passes=new Set([1,2]); });
console.log(`3. real 24-deg roof step      verified ${s.coverage().verifiedBins}/720   spikes ${s.bins.filter(b=>b.spike).length}  <- steps must NOT be flagged`);

// 4. Only one pass over a 30-degree arc
s=fresh((b,i)=>{ const az=i*BIN_STEP; b.obs=obs(10,6); b.passes=new Set((az>60&&az<90)?[1]:[1,2]); });
console.log(`4. single-pass arc 60-90      verified ${s.coverage().verifiedBins}/720   weak sectors: ${s.weakSectors().map(w=>`${w.fromDeg.toFixed(1)}-${w.toDeg.toFixed(1)}`).join(', ')}`);

// 5. Low segmentation confidence over an arc
s=fresh((b,i)=>{ const az=i*BIN_STEP; b.obs=obs(10,6,null,(az>250&&az<275)?0.2:0.9); b.passes=new Set([1,2]); });
console.log(`5. low-confidence arc 250-275 verified ${s.coverage().verifiedBins}/720   weak sectors: ${s.weakSectors().map(w=>`${w.fromDeg.toFixed(1)}-${w.toDeg.toFixed(1)}`).join(', ')}`);

// 6. Noisy observations on a flat horizon (should fail the spread test)
s=fresh((b,i)=>{ const az=i*BIN_STEP; const noisy=(az>20&&az<40);
  b.obs = noisy ? [8,12,7,13,9,11].map(v=>({value:v,weight:0.9,pass:1})) : obs(10,6);
  b.passes=new Set([1,2]); });
console.log(`6. noisy arc 20-40            verified ${s.coverage().verifiedBins}/720   weak sectors: ${s.weakSectors().map(w=>`${w.fromDeg.toFixed(1)}-${w.toDeg.toFixed(1)}`).join(', ')}`);

// 7. Gap: no observations at all across an arc
s=fresh((b,i)=>{ const az=i*BIN_STEP; if(az>300&&az<312){b.obs=[];b.passes=new Set();} else {b.obs=obs(10,6);b.passes=new Set([1,2]);} });
const r=s.report();
console.log(`7. hole 300-312               verified ${s.coverage().verifiedBins}/720   grade ${r.grade}   filled by interpolateGaps: ${s.interpolateGaps(3)} bins (gap is 12deg, so 0 expected)`);
console.log(`                              interpolateGaps(15) fills: ${s.interpolateGaps(15)} bins`);
