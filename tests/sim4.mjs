/* Loop-closure verification: inject a known gyro drift and confirm the
   distributed correction removes it. */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { quatFromEuler, screenQuat, quatRotate, cameraRay, vecToAzAlt, wrap360, DEG } from '../js/math3d.js';
import { Survey, BIN_COUNT, BIN_STEP } from '../js/survey.js';
const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../', import.meta.url)); const fs=require('fs');
let onmsg=null; const fakeSelf={ set onmessage(f){onmsg=f;}, postMessage:m=>fakeSelf._last=m };
new Function('self', fs.readFileSync(ROOT + 'workers/segment.worker.js','utf8'))(fakeSelf);

const W=384,H=288,HFOV=66;
const tanH=Math.tan(HFOV/2*DEG), tanV=tanH*(H/W);
const I={tanHalfH:tanH,tanHalfV:tanV};
const seg=r=>{const b=r.buffer.slice(0); onmsg({data:{id:1,width:W,height:H,buffer:b}}); return fakeSelf._last;};

let seed=99; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff;};
function truth(az){const a=wrap360(az); let alt=9+3*Math.sin(a*DEG*3)+2*Math.sin(a*DEG*5+2);
  if(a>150&&a<215) alt=30+6*Math.sin((a-150)/65*Math.PI); if(a>292&&a<312) alt+=18*Math.sin((a-292)/20*Math.PI);
  return Math.max(0,alt);}
function frame(azTrue, el){
  const q=screenQuat(quatFromEuler(wrap360(360-azTrue), 90+el, 0), 0);
  const rgba=new Uint8ClampedArray(W*H*4);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const u=(x+.5)/W*2-1, v=1-(y+.5)/H*2;
    const {az,alt}=vecToAzAlt(quatRotate(q,cameraRay(u,v,tanH,tanV)));
    const p=(y*W+x)*4;
    if(alt>truth(az)){const t=Math.min(1,alt/50); rgba[p]=168-46*t+rnd()*5; rgba[p+1]=190-30*t+rnd()*5; rgba[p+2]=214+24*t+rnd()*5;}
    else{const n=rnd(),b=alt>20?62:48; rgba[p]=b+n*34; rgba[p+1]=b-4+n*30; rgba[p+2]=b-10+n*26;}
    rgba[p+3]=255;
  } return rgba;
}

const DRIFT = 5.0;                       // degrees of gyro error accumulated over one full turn
const survey=new Survey();
const steps=[]; for(let a=0;a<360;a+=10) steps.push(a);
steps.forEach((azTrue,i)=>{
  const el=(azTrue>150&&azTrue<215)?26:(azTrue>290&&azTrue<315)?24:12;
  const s=seg(frame(azTrue,el));
  const drifted = azTrue + DRIFT*(i/steps.length);       // what the gyro *thinks*
  const q=screenQuat(quatFromEuler(wrap360(360-drifted), 90+el, 0), 0);
  const kf=survey.addKeyframe({t:0,pass:1,quat:q,screenAngle:0,yawRaw:wrap360(drifted),yawFused:drifted,yawBase:0,
    elevation:el,roll:0,compass:null,visualQuality:.9,skyFraction:s.skyFraction,height:H,
    boundary:s.boundary,confidence:s.confidence,flags:s.flags});
});
function err(){
  let e=[],miss=0;
  for(let i=0;i<BIN_COUNT;i++){const b=survey.bins[i]; if(!Number.isFinite(b.alt)){miss++;continue;} e.push(Math.abs(b.alt-truth(i*BIN_STEP)));}
  e.sort((a,b)=>a-b);
  return {med:e[Math.floor(e.length/2)], p95:e[Math.floor(e.length*0.95)], miss};
}
survey.reproject(I);
const before=err();
console.log(`Injected gyro drift: ${DRIFT.toFixed(2)}° over the full turn`);
console.log(`Accumulated yaw reported by the chain: ${survey.accumulatedYaw().toFixed(2)}°`);
console.log('');
console.log(`Before loop closure: median err ${before.med.toFixed(3)}°  p95 ${before.p95.toFixed(3)}°  unfilled bins ${before.miss}`);

// The visual matcher measures the angle from the final view back to the anchor.
// Here the true remaining sweep is 360 - 350 = 10.00 degrees.
const residual = 10.0;
const accumulated = survey.accumulatedYaw();
const closure = accumulated + residual;
const k = Math.round(closure / 360) || 1;
const loopError = closure - 360 * k;
console.log(`Gyro accumulated rotation: ${accumulated.toFixed(2)}°`);
console.log(`Visual loop closure:       ${closure.toFixed(2)}°`);
console.log(`Residual error:            ${loopError >= 0 ? '+' : ''}${loopError.toFixed(2)}°`);
console.log('');
survey.applyLoopClosure(loopError);
survey.reproject(I);
const after=err();
console.log(`After  loop closure: median err ${after.med.toFixed(3)}°  p95 ${after.p95.toFixed(3)}°  unfilled bins ${after.miss}`);
console.log('');
console.log(`Per-keyframe corrections applied: first ${survey.keyframes[0].yawCorrection.toFixed(3)}°, last ${survey.keyframes[survey.keyframes.length-1].yawCorrection.toFixed(3)}°`);
