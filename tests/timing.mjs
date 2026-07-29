import { createRequire } from 'module';
const require=createRequire(import.meta.url);
const ROOT = new URL('../', import.meta.url).pathname; const fs=require('fs');
let onmsg=null; const fake={set onmessage(f){onmsg=f;},postMessage:m=>fake._l=m};
new Function('self',fs.readFileSync(ROOT + 'workers/segment.worker.js','utf8'))(fake);
const W=384,H=288; let seed=3; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
const img=new Uint8ClampedArray(W*H*4);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const p=(y*W+x)*4; const sky=y<120+18*Math.sin(x/40);
  if(sky){img[p]=170+rnd()*6;img[p+1]=192+rnd()*6;img[p+2]=216+rnd()*6;} else {const n=rnd();img[p]=50+n*40;img[p+1]=48+n*36;img[p+2]=42+n*30;} img[p+3]=255;}
onmsg({data:{id:1,width:W,height:H,buffer:img.buffer.slice(0)}});
const N=60,t0=process.hrtime.bigint();
for(let i=0;i<N;i++) onmsg({data:{id:i,width:W,height:H,buffer:img.buffer.slice(0)}});
const ms=Number(process.hrtime.bigint()-t0)/1e6/N;
console.log(`segmentation: ${ms.toFixed(2)} ms per 384x288 frame on this container CPU`);

let v=null; const fv={set onmessage(f){v=f;},postMessage:m=>fv._l=m};
new Function('self',fs.readFileSync(ROOT + 'workers/vision.worker.js','utf8'))(fv);
const LW=160,LH=120; const l=new Float32Array(LW*LH); for(let i=0;i<l.length;i++) l[i]=100+60*Math.sin(i/17)+rnd()*20;
v({data:{cmd:'reset'}}); v({data:{id:0,w:LW,h:LH,buffer:l.slice().buffer}});
const t1=process.hrtime.bigint();
for(let i=0;i<200;i++) v({data:{id:i,w:LW,h:LH,buffer:l.slice().buffer,hintX:0}});
console.log(`registration: ${(Number(process.hrtime.bigint()-t1)/1e6/200).toFixed(2)} ms per pair`);
