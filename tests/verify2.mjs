import {quatFromEuler, screenQuat, quatMul, quatFromAxisAngle, quatRotate, vecToAzAlt, cameraRay, DEG} from '../js/math3d.js';
const tH = Math.tan(32.5*DEG), tV = Math.tan(24*DEG);
function show(name,q,u=0,v=0){
  const w = quatRotate(q, cameraRay(u,v,tH,tV));
  const r = vecToAzAlt(w);
  console.log(`${name.padEnd(52)} az=${r.az.toFixed(1).padStart(6)} alt=${r.alt.toFixed(1).padStart(6)}`);
}
const qPortrait = quatFromEuler(0,90,0);          // rear cam -> north, verified
const qLand     = quatMul(qPortrait, quatFromAxisAngle(0,0,1, +90*DEG)); // device rotated CCW 90
console.log('screen-aligned frame after screenQuat(qLand, 90):');
const s = screenQuat(qLand, 90);
show('  center',      s);
show('  screen right (u=+1)', s, 1, 0);
show('  screen up    (v=+1)', s, 0, 1);
console.log('control: portrait via screenQuat(qPortrait,0)');
const p = screenQuat(qPortrait, 0);
show('  screen right (u=+1)', p, 1, 0);
show('  screen up    (v=+1)', p, 0, 1);
