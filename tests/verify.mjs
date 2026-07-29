import {quatFromEuler, screenQuat, quatRotate, vecToAzAlt, cameraRay} from '../js/math3d.js';

function pose(name, a,b,g, screen, u=0, v=0){
  const q = screenQuat(quatFromEuler(a,b,g), screen);
  const ray = cameraRay(u, v, Math.tan(32.5*Math.PI/180), Math.tan(24*Math.PI/180));
  const w = quatRotate(q, ray);
  const r = vecToAzAlt(w);
  console.log(`${name.padEnd(46)} az=${r.az.toFixed(1).padStart(6)}  alt=${r.alt.toFixed(1).padStart(6)}`);
}
console.log('--- alpha is yaw datum; 0 = device Y toward north when flat ---');
pose('upright portrait, alpha=0 (rear cam -> N)',      0, 90, 0, 0);
pose('upright portrait, alpha=90 (rear cam -> W?)',   90, 90, 0, 0);
pose('upright portrait, alpha=270',                  270, 90, 0, 0);
pose('portrait tilted up 20deg (beta=110)',            0,110, 0, 0);
pose('portrait tilted down 20deg (beta=70)',           0, 70, 0, 0);
pose('flat on table screen up',                        0,  0, 0, 0);
console.log('--- pixel offsets, portrait, beta=90, hfov 65 vfov 48 ---');
pose('right edge of frame (u=+1)',                     0, 90, 0, 0,  1, 0);
pose('left edge  of frame (u=-1)',                     0, 90, 0, 0, -1, 0);
pose('top edge   of frame (v=+1)',                     0, 90, 0, 0,  0, 1);
pose('bottom edge of frame (v=-1)',                    0, 90, 0, 0,  0,-1);
console.log('--- landscape: device rotated -90 about its Z, screen.angle=90 ---');
pose('landscape (gamma=-90 from upright), screen 90',  0, 90,-90, 90);
pose('  same, right edge u=+1',                        0, 90,-90, 90, 1, 0);
