import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ROOT = new URL('../', import.meta.url).pathname; const fs=require('fs');
let onmsg=null; const out=[];
const fakeSelf={ set onmessage(f){onmsg=f;}, postMessage:m=>out.push(m) };
new Function('self', fs.readFileSync(ROOT + 'workers/vision.worker.js','utf8'))(fakeSelf);
const W=160,H=120; let seed=7; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff;};
const SW=800,SH=400; const scene=new Float32Array(SW*SH);
for(let y=0;y<SH;y++)for(let x=0;x<SW;x++){
  const sky=y<150+40*Math.sin(x/70)+25*Math.sin(x/23);
  scene[y*SW+x]= sky?190+rnd()*8 : 55+rnd()*45+30*Math.sin(x/9)*Math.sin(y/11);
}
function crop(ox,oy){const f=new Float32Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const fx=x+ox, fy=y+oy, x0=Math.floor(fx), y0=Math.floor(fy), tx=fx-x0, ty=fy-y0;
    const g=(xx,yy)=>scene[Math.min(SH-1,Math.max(0,yy))*SW+Math.min(SW-1,Math.max(0,xx))];
    f[y*W+x]=(g(x0,y0)*(1-tx)+g(x0+1,y0)*tx)*(1-ty)+(g(x0,y0+1)*(1-tx)+g(x0+1,y0+1)*tx)*ty;
  } return f;}
function send(f,hx,hy){const b=f.buffer; onmsg({data:{id:1,w:W,h:H,buffer:b,hintX:hx,hintY:hy}}); return out[out.length-1].result;}

function run(label, hintFn){
  onmsg({data:{cmd:'reset'}});
  let ox=300,oy=140; send(crop(ox,oy),hintFn?hintFn(0):undefined);
  let e=0,n=0,fail=0;
  for(const [tdx,tdy] of [[6,0],[12.4,0],[18,2],[-9.3,0],[3,-3],[25,0],[0,4],[7.7,1.2]]){
    const h=hintFn?hintFn(tdx,tdy):{x:undefined,y:undefined};
    const r=send(crop(ox+tdx,oy+tdy),h.x,h.y);
    if(!r){fail++; ox+=tdx; oy+=tdy; continue;}
    e+=Math.abs(r.dx-(-tdx)); n++; ox+=tdx; oy+=tdy;
  }
  console.log(`${label.padEnd(34)} mean |dx| err ${(e/n).toFixed(3)} px over ${n} pairs, ${fail} refused`);
}
run('no hint at all',           null);
run('accurate hint',            (dx,dy)=>({x:-dx,y:-dy}));
run('hint 30% short',           (dx,dy)=>({x:-dx*0.7,y:-dy*0.7}));
run('hint with wrong sign',     (dx,dy)=>({x:+dx,y:+dy}));
run('hint wildly wrong (+40px)',(dx,dy)=>({x:-dx+40,y:-dy}));
