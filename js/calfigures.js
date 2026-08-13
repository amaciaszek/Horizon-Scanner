'use strict';

/**
 * Calibration figures — what the phone should be doing, drawn.
 *
 * Written text alone could not carry these instructions: "upright" and "flat"
 * mean different things to different hands, and "end over end" reads as three
 * different motions depending on who is holding the phone. Each figure shows
 * the phone in the pose for its test, the axis it turns about, and an arrow in
 * the direction wanted. Axis naming follows the standard phone diagram —
 * device X out the right side, Y out the top, Z out of the screen — so yaw is
 * about Z, roll about Y, and pitch about X.
 *
 * Drawn as inline SVG because the figure sits over the live camera feed, has
 * to stay legible at ~90 px on a phone in daylight, and must not cost a
 * network request in a field app that may be running on one bar of signal.
 */

const S = {
  body: 'fill:#0d171c;stroke:#7d949e;stroke-width:2;stroke-linejoin:round',
  screen: 'fill:#122029;stroke:#2b414b;stroke-width:1',
  screenLit: 'fill:#0f3b46;stroke:#2ec7e6;stroke-width:1.2',
  axis: 'stroke:#2ec7e6;stroke-width:1.6;stroke-dasharray:5 3;stroke-linecap:round',
  arrow: 'fill:none;stroke:#2ec7e6;stroke-width:2.2;stroke-linecap:round',
  ground: 'stroke:#2b414b;stroke-width:1.5;stroke-linecap:round',
  label: 'fill:#a8bfc9;font:600 9px ui-monospace,monospace;letter-spacing:.06em',
  axisLabel: 'fill:#2ec7e6;font:700 9px ui-monospace,monospace;letter-spacing:.06em'
};

const ARROWHEAD = `<marker id="cfhead" viewBox="0 0 10 10" refX="7" refY="5"
    markerWidth="5" markerHeight="5" orient="auto-start-reverse">
  <path d="M0,1 L9,5 L0,9 z" fill="#2ec7e6"/>
</marker>`;

const wrap = (title, inner) =>
  `<svg viewBox="0 0 120 132" role="img" aria-label="${title}" xmlns="http://www.w3.org/2000/svg">
    <defs>${ARROWHEAD}</defs>${inner}
  </svg>`;

/* Yaw — phone flat on its back, screen at the sky, spun about the vertical
 * axis that runs out through the screen. Drawn in perspective so "flat" is
 * unmistakable, with the surface it rests on underneath it. */
const YAW = wrap('Phone flat, screen up, spinning counter-clockwise', `
  <line x1="14" y1="104" x2="106" y2="104" style="${S.ground}"/>
  <g transform="translate(60 78)">
    <path d="M-34,-9 L4,-24 L34,-9 L-4,6 Z" style="${S.body}"/>
    <path d="M-27,-9.5 L3.5,-21.5 L27,-9.5 L-3.5,2.5 Z" style="${S.screenLit}"/>
  </g>
  <line x1="60" y1="20" x2="60" y2="72" style="${S.axis}"/>
  <text x="66" y="26" style="${S.axisLabel}">Z</text>
  <path d="M32,42 A32,13 0 1 0 88,42" style="${S.arrow}" marker-end="url(#cfhead)"/>
  <text x="60" y="124" text-anchor="middle" style="${S.label}">YAW · FLAT</text>
`);

/* Roll — phone upright in the survey pose, top edge at the zenith, turning
 * about its own long axis as the operator turns on the spot. */
const ROLL = wrap('Phone upright, top at the sky, turning counter-clockwise', `
  <line x1="14" y1="104" x2="106" y2="104" style="${S.ground}"/>
  <line x1="60" y1="14" x2="60" y2="96" style="${S.axis}"/>
  <text x="66" y="20" style="${S.axisLabel}">Y</text>
  <g transform="translate(60 58)">
    <rect x="-17" y="-34" width="34" height="68" rx="5" style="${S.body}"/>
    <rect x="-12.5" y="-28" width="25" height="52" rx="2" style="${S.screenLit}"/>
    <circle cx="0" cy="29" r="2.6" style="${S.screen}"/>
  </g>
  <path d="M30,92 A30,11 0 1 0 90,92" style="${S.arrow}" marker-end="url(#cfhead)"/>
  <text x="60" y="124" text-anchor="middle" style="${S.label}">ROLL · UPRIGHT</text>
`);

/* Pitch — the tumble, and the only one that must be drawn from the SIDE.
 * Its axis runs out through the phone's edges, so a face-on view would put the
 * rotation arrow flat in the picture plane, where it reads as roll. Seen from
 * the operator's right the tumble happens in the picture plane and the arrow
 * means what it looks like: over the top and away. The eye fixes which side
 * the operator is on, and the ringed dot is the standard mark for an axis
 * pointing out of the page. */
const PITCH = wrap('Seen from the side: phone tumbling end over end, top edge away from you', `
  <g style="stroke:#7d949e;stroke-width:1.5;fill:none">
    <path d="M13.5,58 q7,-6.5 14,0 q-7,6.5 -14,0"/>
  </g>
  <circle cx="20.5" cy="58" r="2.2" style="fill:#7d949e"/>
  <g opacity="0.3" transform="translate(71.5 58) rotate(90)">
    <rect x="-4.5" y="-28" width="9" height="56" rx="3" style="${S.body}"/>
  </g>
  <g transform="translate(71.5 58)">
    <rect x="-4.5" y="-28" width="9" height="56" rx="3" style="${S.body}"/>
    <rect x="-4" y="-24" width="2.6" height="45" rx="1" style="${S.screenLit}"/>
  </g>
  <circle cx="71.5" cy="58" r="4.5" style="fill:none;stroke:#2ec7e6;stroke-width:1.4"/>
  <circle cx="71.5" cy="58" r="1.5" style="fill:#2ec7e6"/>
  <text x="79.5" y="52" style="${S.axisLabel}">X</text>
  <path d="M41.5,72 A34,34 0 1 1 101.5,72" style="${S.arrow}" marker-end="url(#cfhead)"/>
  <text x="60" y="124" text-anchor="middle" style="${S.label}">PITCH · TUMBLE</text>
`);

/* Freeform — the only figure calibration now shows. There is no pose to adopt
 * and no direction to get right, so it draws the opposite of an instruction:
 * a phone mid-tumble with arrows curling around all three axes at once, and
 * ghosts of it at other angles. The message to read off it in one glance is
 * "every which way", which is the whole of the procedure. */
const FREEFORM = wrap('Turn and tumble the phone in every direction', `
  <g opacity="0.22" transform="translate(34 40) rotate(-52)">
    <rect x="-9" y="-17" width="18" height="34" rx="3" style="${S.body}"/>
  </g>
  <g opacity="0.22" transform="translate(88 76) rotate(34)">
    <rect x="-9" y="-17" width="18" height="34" rx="3" style="${S.body}"/>
  </g>
  <g opacity="0.22" transform="translate(84 30) rotate(78)">
    <rect x="-9" y="-17" width="18" height="34" rx="3" style="${S.body}"/>
  </g>
  <g transform="translate(58 58) rotate(-18)">
    <rect x="-13" y="-25" width="26" height="50" rx="4" style="${S.body}"/>
    <rect x="-9.5" y="-20" width="19" height="38" rx="2" style="${S.screenLit}"/>
    <circle cx="0" cy="21" r="2.2" style="${S.screen}"/>
  </g>
  <path d="M20,58 A38,15 0 1 0 96,58" style="${S.arrow}" marker-end="url(#cfhead)"/>
  <path d="M58,20 A15,38 0 1 0 58,96" style="${S.arrow}" marker-end="url(#cfhead)"/>
  <text x="60" y="124" text-anchor="middle" style="${S.label}">ANY DIRECTION</text>
`);

/* Lens measurement — the phone stays pointed at the scene and sweeps across it
 * and down it, so the figure is a viewfinder with a cross of travel arrows
 * rather than a phone in a pose. The tree stands in for "something with
 * detail", which is the one thing the operator has to choose. */
const LENS = wrap('Sweep the phone across a detailed scene, then up and down', `
  <rect x="16" y="20" width="88" height="66" rx="4" style="${S.body}"/>
  <g opacity="0.85">
    <path d="M60,74 L60,58" style="stroke:#7d949e;stroke-width:2.4;stroke-linecap:round"/>
    <path d="M60,60 q-13,-4 -16,-14 q11,1 16,8 q5,-9 16,-10 q-3,12 -16,16 Z" style="fill:#0f3b46;stroke:#2ec7e6;stroke-width:1.2;stroke-linejoin:round"/>
    <path d="M28,74 L92,74" style="stroke:#2b414b;stroke-width:1.4"/>
  </g>
  <path d="M24,103 L96,103" style="${S.arrow}" marker-start="url(#cfhead)" marker-end="url(#cfhead)"/>
  <path d="M112,26 L112,80" style="${S.arrow}" marker-start="url(#cfhead)" marker-end="url(#cfhead)"/>
  <text x="56" y="124" text-anchor="middle" style="${S.label}">SWEEP BOTH WAYS</text>
`);

const FIGURES = { yaw: YAW, roll: ROLL, pitch: PITCH, freeform: FREEFORM, lens: LENS };

/** SVG markup for a calibration stage, or null when the stage has no figure. */
export function calibrationFigure(name) {
  return FIGURES[name] || null;
}
