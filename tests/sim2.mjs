import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ROOT = new URL('../', import.meta.url).pathname;
const fs = require('fs');

/* ---- where are the errors? (rerun the reconstruction quickly) ---- */
// Re-import sim pieces by re-running with a flag would be messy; instead test
// the vision worker in isolation, which sim.mjs did not cover.

let onmsg=null; const out=[];
const fakeSelf={ set onmessage(f){onmsg=f;}, postMessage:m=>out.push(m) };
new Function('self', fs.readFileSync(ROOT + 'workers/vision.worker.js','utf8'))(fakeSelf);

const W=160,H=120;
let seed=7; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff;};
// A textured scene: blobs + a skyline step, so it is not trivially periodic.
const scene=new Float32Array(600*400);
for(let y=0;y<400;y++)for(let x=0;x<600;x++){
  const sky = y < 150 + 40*Math.sin(x/70) + 25*Math.sin(x/23);
  scene[y*600+x] = sky ? 190+rnd()*8 : 55+rnd()*45 + 30*Math.sin(x/9)*Math.sin(y/11);
}
function crop(ox,oy){
  const f=new Float32Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const sx=Math.min(599,Math.max(0,x+ox)), sy=Math.min(399,Math.max(0,y+oy));
    f[y*W+x]=scene[sy*600+sx];
  }
  return f;
}
function send(f,cmd,hx,hy){ const b=f.buffer; onmsg({data:{id:1,w:W,h:H,buffer:b,cmd,hintX:hx,hintY:hy}}); return out[out.length-1]; }

console.log('=== Visual registration: recovered shift vs true shift ===');
onmsg({data:{cmd:'reset'}});
let prevOx=200, prevOy=140;
send(crop(prevOx,prevOy));           // seed
let cumErr=0, n=0;
for(const [tdx,tdy] of [[6,0],[12,0],[18,2],[-9,0],[3,-3],[25,0],[0,4]]){
  const r=send(crop(prevOx+tdx, prevOy+tdy), undefined, -tdx*0.8, -tdy*0.8); // gyro hint, deliberately 20% wrong
  const res=r.result;
  // worker reports dx such that prev(x) is found at cur(x+dx); cropping forward
  // by tdx means content moved to x-tdx, so expected dx = -tdx
  const err=Math.abs(res.dx-(-tdx));
  cumErr+=err; n++;
  console.log(`  true (${String(tdx).padStart(3)},${String(tdy).padStart(3)})  ->  dx ${res.dx.toFixed(2).padStart(7)} dy ${res.dy.toFixed(2).padStart(6)}  peak ${res.peak.toFixed(3)} q ${res.quality.toFixed(2)}  |err| ${err.toFixed(2)} px`);
  prevOx+=tdx; prevOy+=tdy;
}
console.log(`  mean |dx| error: ${(cumErr/n).toFixed(3)} px`);

console.log('');
console.log('=== Featureless frame must be refused, not guessed ===');
onmsg({data:{cmd:'reset'}});
const flat=new Float32Array(W*H).fill(128);
send(flat);
const r2=send(new Float32Array(W*H).fill(128));
console.log('  result on flat gray:', r2.result===null?'refused (null)':JSON.stringify(r2.result));

console.log('');
console.log('=== Loop closure against an anchor ===');
onmsg({data:{cmd:'reset'}});
const a=crop(200,140); onmsg({data:{cmd:'anchor',w:W,h:H,buffer:a.buffer}});
const back=crop(204,140);
onmsg({data:{cmd:'closeLoop',id:9,w:W,h:H,buffer:back.buffer,hintX:0,hintY:0}});
const lc=out[out.length-1];
console.log(`  anchor offset 0, returned 4 px late -> dx ${lc.result.dx.toFixed(2)} (expect -4.00), q ${lc.result.quality.toFixed(2)}`);
