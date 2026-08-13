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

const FIGURES = { yaw: YAW, roll: ROLL, pitch: PITCH };

/** SVG markup for a calibration stage, or null when the stage has no figure. */
export function calibrationFigure(name) {
  return FIGURES[name] || null;
}
