'use strict';
/* Where things are in the sky, for a place and a moment.
 *
 * WHY THIS IS A MODULE AND NOT A FEW LINES IN THE PAGE.
 *
 * `sky/skyline-align.html` exists so an operator can stand outside, look at a
 * real skyline with their own eyes, and compare it against what the survey
 * measured. The comparison is worth exactly as much as the sky positions are
 * correct, and every term below is a term that moves a star by an amount the
 * eye can see against a roofline:
 *
 *   precession        ~0.36 deg by 2026 from a J2000 catalogue
 *   refraction        0.57 deg at the horizon, 0.03 deg at 45 deg altitude
 *   sidereal vs solar 1 deg per four minutes of clock error
 *
 * A tenth of a degree is about a fifth of the Moon's width and is plainly
 * visible against a chimney. So this is tested against published worked
 * examples rather than eyeballed -- see `tests/astro.test.mjs`, which checks
 * every routine here against Meeus, *Astronomical Algorithms* (2nd ed.).
 *
 * WHAT IS DELIBERATELY NOT MODELLED, and what it costs:
 *
 *   nutation          up to 0.005 deg. Invisible here.
 *   aberration        0.006 deg. Invisible here.
 *   proper motion     under 0.07 deg for any naked-eye star since J2000.
 *   dTT - dUT1        about 70 s by 2026, which is 0.0002 deg of Earth
 *                     rotation for the stars, and about 0.001 deg for the
 *                     Moon. Invisible here, and the page uses UTC throughout.
 *
 * Angles are degrees everywhere, in and out. Radians appear only inside a
 * function body. Mixing the two silently is the single easiest way to get this
 * wrong, so the boundary is absolute.
 */

const D = Math.PI / 180;
const R = 180 / Math.PI;

/** Fold into 0..360. */
export const wrap360 = deg => ((deg % 360) + 360) % 360;

/** Fold into -180..180. */
export const wrap180 = deg => {
  const d = wrap360(deg);
  return d > 180 ? d - 360 : d;
};

/**
 * Julian Day from a JavaScript Date, using its UTC fields.
 *
 * Local time is never used. A page that quietly mixed the two would be wrong
 * by the timezone offset, which at one degree per four minutes is fifteen
 * degrees an hour -- an error so large it would look like a broken azimuth
 * datum rather than a broken clock, and would be chased in the wrong place.
 */
export function julianDay(date) {
  let y = date.getUTCFullYear();
  let m = date.getUTCMonth() + 1;
  const day = date.getUTCDate()
    + (date.getUTCHours()
      + (date.getUTCMinutes() + (date.getUTCSeconds() + date.getUTCMilliseconds() / 1000) / 60) / 60) / 24;
  if (m <= 2) { y -= 1; m += 12; }
  // Gregorian only. This app did not exist in 1582 and will not be asked about it.
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + B - 1524.5;
}

/** Julian centuries from J2000.0. */
export const centuries = jd => (jd - 2451545.0) / 36525.0;

/**
 * Greenwich mean sidereal time, in degrees.
 *
 * Meeus (12.4), the form valid for any instant rather than only for 0h UT.
 * Checked against Meeus example 12.1a: 1987 April 10 at 0h UT is 197.693195 deg.
 */
export function gmstDeg(jd) {
  const T = centuries(jd);
  const theta = 280.46061837
    + 360.98564736629 * (jd - 2451545.0)
    + 0.000387933 * T * T
    - (T * T * T) / 38710000.0;
  return wrap360(theta);
}

/** Local mean sidereal time in degrees. East longitude is positive. */
export function lstDeg(jd, longitudeDeg) {
  return wrap360(gmstDeg(jd) + longitudeDeg);
}

/**
 * Precess equatorial coordinates from one epoch to another.
 *
 * The rigorous rotation (Meeus ch. 21), not the approximate per-year drift in
 * RA and Dec. The approximation fails near the pole, and Polaris is precisely
 * the star an operator will use to check an azimuth datum.
 *
 * `jdFrom` defaults to J2000.0, which is the epoch of the shipped catalogue.
 */
export function precess(raDeg, decDeg, jdTo, jdFrom = 2451545.0) {
  const T = (jdFrom - 2451545.0) / 36525.0;
  const t = (jdTo - jdFrom) / 36525.0;
  // Arcseconds (Meeus 21.2), converted to degrees.
  const zeta = ((2306.2181 + 1.39656 * T - 0.000139 * T * T) * t
    + (0.30188 - 0.000344 * T) * t * t + 0.017998 * t * t * t) / 3600;
  const z = ((2306.2181 + 1.39656 * T - 0.000139 * T * T) * t
    + (1.09468 + 0.000066 * T) * t * t + 0.018203 * t * t * t) / 3600;
  const theta = ((2004.3109 - 0.85330 * T - 0.000217 * T * T) * t
    - (0.42665 + 0.000217 * T) * t * t - 0.041833 * t * t * t) / 3600;

  const ra = raDeg * D, dec = decDeg * D;
  const A = Math.cos(dec) * Math.sin(ra + zeta * D);
  const B = Math.cos(theta * D) * Math.cos(dec) * Math.cos(ra + zeta * D)
    - Math.sin(theta * D) * Math.sin(dec);
  const C = Math.sin(theta * D) * Math.cos(dec) * Math.cos(ra + zeta * D)
    + Math.cos(theta * D) * Math.sin(dec);
  return {
    raDeg: wrap360(Math.atan2(A, B) * R + z),
    // asin loses precision within a few arcseconds of the pole; atan2 does not.
    decDeg: Math.atan2(C, Math.hypot(A, B)) * R
  };
}

/**
 * Equatorial to horizontal, for an observer.
 *
 * Azimuth is returned measured from NORTH through EAST, which is what a
 * compass, the survey's 720 bins and every other bearing in this project use.
 * Meeus measures his from the south, so his worked example needs 180 added to
 * compare -- see the test, which does exactly that rather than quietly
 * adopting his convention here.
 */
export function equatorialToHorizontal(raDeg, decDeg, lstDegrees, latitudeDeg) {
  const H = (lstDegrees - raDeg) * D;        // local hour angle
  const dec = decDeg * D, lat = latitudeDeg * D;
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
  const altDeg = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * R;
  const azSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) * R;
  return { altDeg, azDeg: wrap360(azSouth + 180) };
}

/**
 * Atmospheric refraction, in degrees, to ADD to a true altitude.
 *
 * Bennett's formula (Meeus 16.3) for standard conditions. This is not a detail:
 * it lifts an object on the true horizon by 0.57 deg, which is more than a
 * Moon's width, and it is the difference between a rooftop alignment that
 * closes and one that is stubbornly half a degree out near the horizon.
 *
 * Below about -1 deg the formula leaves its domain and the answer would stop
 * being meaningful anyway, so it is clamped there rather than extrapolated.
 */
export function refractionDeg(trueAltDeg) {
  const h = Math.max(-1, trueAltDeg);
  return (1 / Math.tan((h + 7.31 / (h + 4.4)) * D)) / 60;
}

/** Mean obliquity of the ecliptic, degrees (Meeus 22.2). */
export function obliquityDeg(jd) {
  const T = centuries(jd);
  return 23.4392911
    - (46.8150 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600;
}

/** Ecliptic (of date) to equatorial (of date). */
export function eclipticToEquatorial(lonDeg, latDeg, jd) {
  const e = obliquityDeg(jd) * D, l = lonDeg * D, b = latDeg * D;
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.max(-1, Math.min(1,
    Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l))));
  return { raDeg: wrap360(ra * R), decDeg: dec * R };
}

/**
 * The Sun, equatorial coordinates of date.
 *
 * Meeus ch. 25, the "lower accuracy" series, which he gives as good to about
 * 0.01 deg. That is a fiftieth of the Sun's own width and far beyond what this
 * page needs.
 *
 * The Sun matters here for two reasons that have nothing to do with looking at
 * it. It says whether it is dark enough to see anything -- and it is the one
 * object an operator can align against in the afternoon, without waiting for
 * night, by watching where it sets against their own skyline.
 */
export function sunPosition(jd) {
  const T = centuries(jd);
  const L0 = wrap360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = wrap360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const Mr = M * D;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr)
    + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr)
    + 0.000289 * Math.sin(3 * Mr);
  const trueLon = L0 + C;
  const v = M + C;
  const Rau = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(v * D));
  // Apparent longitude: the aberration term and the nutation in longitude that
  // Meeus folds into omega. Without it the Sun sits about 0.005 deg off.
  const omega = 125.04 - 1934.136 * T;
  const apparent = trueLon - 0.00569 - 0.00478 * Math.sin(omega * D);
  const eq = eclipticToEquatorial(apparent, 0, jd);
  return { ...eq, distanceAu: Rau, apparentLonDeg: wrap360(apparent) };
}

/*
 * The Moon: the main terms of Meeus ch. 47.
 *
 * The full ELP-2000/82 truncation Meeus tabulates has sixty terms in longitude
 * and sixty in latitude and is accurate to about ten arcseconds. These are its
 * largest terms, giving roughly 0.02 deg -- a twenty-fifth of the Moon's width,
 * and comfortably better than anyone can judge by eye against a rooftop.
 *
 * Each row is [D, M, M', F, coefficient]. Terms multiplied by M are scaled by
 * the eccentricity correction E, because the Earth's orbit is not the circle
 * the series pretends it is.
 */
const MOON_LON = [
  [0, 0, 1, 0, 6288774], [2, 0, -1, 0, 1274027], [2, 0, 0, 0, 658314],
  [0, 0, 2, 0, 213618], [0, 1, 0, 0, -185116], [0, 0, 0, 2, -114332],
  [2, 0, -2, 0, 58793], [2, -1, -1, 0, 57066], [2, 0, 1, 0, 53322],
  [2, -1, 0, 0, 45758], [0, 1, -1, 0, -40923], [1, 0, 0, 0, -34720],
  [0, 1, 1, 0, -30383], [2, 0, 0, -2, 15327], [0, 0, 1, 2, -12528],
  [0, 0, 1, -2, 10980], [4, 0, -1, 0, 10675], [0, 0, 3, 0, 10034],
  [4, 0, -2, 0, 8548], [2, 1, -1, 0, -7888], [2, 1, 0, 0, -6766],
  [1, 0, -1, 0, -5163], [1, 1, 0, 0, 4987], [2, -1, 1, 0, 4036],
  [2, 0, 2, 0, 3994], [4, 0, 0, 0, 3861], [2, 0, -3, 0, 3665],
  [0, 1, -2, 0, -2689], [2, 0, -1, 2, -2602], [2, -1, -2, 0, 2390],
  [1, 0, 1, 0, -2348], [2, -2, 0, 0, 2236], [0, 1, 2, 0, -2120],
  [0, 2, 0, 0, -2069], [2, -2, -1, 0, 2048], [2, 0, 1, -2, -1773],
  [2, 0, 0, 2, -1595], [4, -1, -1, 0, 1215], [0, 0, 2, 2, -1110],
  [3, 0, -1, 0, -892], [2, 1, 1, 0, -810], [4, -1, -2, 0, 759],
  [0, 2, -1, 0, -713], [2, 2, -1, 0, -700], [2, 1, -2, 0, 691],
  [2, -1, 0, -2, 596], [4, 0, 1, 0, 549], [0, 0, 4, 0, 537],
  [4, -1, 0, 0, 520], [1, 0, -2, 0, -487], [2, 1, 0, -2, -399],
  [0, 0, 2, -2, -381], [1, 1, 1, 0, 351], [3, 0, -2, 0, -340],
  [4, 0, -3, 0, 330], [2, -1, 2, 0, 327], [0, 2, 1, 0, -323],
  [1, 1, -1, 0, 299], [2, 0, 3, 0, 294]
];
const MOON_LAT = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237], [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198], [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211], [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794], [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335],
  [0, 0, 3, 1, 1107], [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833],
  [0, 0, 1, -3, 777], [4, 0, -2, 1, 671], [2, 0, 0, -3, 607],
  [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421],
  [2, 1, -1, 1, -366], [2, 1, 0, 1, -351], [4, 0, 0, 1, 331],
  [2, -1, 1, 1, 315], [2, -2, 0, -1, 302], [0, 0, 1, 3, -283],
  [2, 1, 1, -1, -229], [1, 1, 0, -1, 223], [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220], [2, 1, -1, -1, -220], [1, 0, 1, 1, -185],
  [2, -1, -2, -1, 181], [0, 1, 2, 1, -177], [4, 0, -2, -1, 176],
  [4, -1, -1, -1, 166], [1, 0, 1, -1, -164], [4, 0, 1, -1, 132],
  [1, 0, -1, -1, -119], [4, -1, 0, -1, 115], [2, -2, 0, 1, 107]
];

/**
 * The Moon, equatorial coordinates of date, plus the illuminated fraction.
 *
 * The brightest thing in a night sky and the easiest to point at, so it is the
 * fastest possible check that an azimuth datum is right. The phase is returned
 * because a thin crescent low over a roofline is a different sighting problem
 * from a full Moon, and the page dims the disc accordingly.
 */
export function moonPosition(jd) {
  const T = centuries(jd);
  const Lp = wrap360(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T
    + (T * T * T) / 538841 - (T * T * T * T) / 65194000);
  const Dm = wrap360(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T
    + (T * T * T) / 545868 - (T * T * T * T) / 113065000);
  const M = wrap360(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + (T * T * T) / 24490000);
  const Mp = wrap360(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T
    + (T * T * T) / 69699 - (T * T * T * T) / 14712000);
  const F = wrap360(93.2720950 + 483202.0175233 * T - 0.0036539 * T * T
    - (T * T * T) / 3526000 + (T * T * T * T) / 863310000);
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;

  let sumL = 0, sumB = 0;
  const arg = (d, m, mp, f) => (Dm * d + M * m + Mp * mp + F * f) * D;
  for (const [d, m, mp, f, c] of MOON_LON) {
    const e = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sumL += c * e * Math.sin(arg(d, m, mp, f));
  }
  for (const [d, m, mp, f, c] of MOON_LAT) {
    const e = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sumB += c * e * Math.sin(arg(d, m, mp, f));
  }
  // Additive terms for Venus, Jupiter and the flattening of the Earth.
  const A1 = wrap360(119.75 + 131.849 * T);
  const A2 = wrap360(53.09 + 479264.290 * T);
  const A3 = wrap360(313.45 + 481266.484 * T);
  sumL += 3958 * Math.sin(A1 * D) + 1962 * Math.sin((Lp - F) * D) + 318 * Math.sin(A2 * D);
  sumB += -2235 * Math.sin(Lp * D) + 382 * Math.sin(A3 * D)
    + 175 * Math.sin((A1 - F) * D) + 175 * Math.sin((A1 + F) * D)
    + 127 * Math.sin((Lp - Mp) * D) - 115 * Math.sin((Lp + Mp) * D);

  const lon = wrap360(Lp + sumL / 1000000);
  const lat = sumB / 1000000;
  const eq = eclipticToEquatorial(lon, lat, jd);

  // Illuminated fraction from the elongation (Meeus 48.2, the simple form that
  // is plenty for drawing a disc).
  const sun = sunPosition(jd);
  const elong = Math.acos(Math.max(-1, Math.min(1,
    Math.cos(lat * D) * Math.cos((lon - sun.apparentLonDeg) * D))));
  const illuminated = (1 - Math.cos(elong)) / 2;
  return { ...eq, eclipticLonDeg: lon, eclipticLatDeg: lat, illuminated,
    elongationDeg: elong * R };
}

/*
 * The naked-eye planets, from mean Keplerian elements with linear rates.
 *
 * WHAT THIS IS WORTH, stated plainly because the alternative is someone
 * trusting it further than it goes: elements of this form drift, and over
 * 1800-2050 the error is a few arcminutes for the inner planets and worse for
 * Jupiter and Saturn, where the mutual perturbation between the two reaches
 * about a tenth of a degree. That is a fifth of a Moon's width. It is
 * excellent for "which bright dot is that, and is my azimuth right" -- which
 * is the whole job here -- and it is not an ephemeris. Anything needing real
 * accuracy should use VSOP87.
 *
 * Elements are [a (au), e, i, L, longitude of perihelion, longitude of
 * ascending node] and their per-century rates, for J2000, from the JPL
 * approximate positions of the major planets.
 */
const PLANETS = {
  Mercury: { el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081], mag: -0.4 },
  Venus: { el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418], mag: -4.4 },
  Earth: { el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0], mag: 0 },
  Mars: { el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343], mag: -1.5 },
  Jupiter: { el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106], mag: -2.7 },
  Saturn: { el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794], mag: 0.7 }
};

/** Heliocentric ecliptic rectangular coordinates, J2000 frame, in au. */
function heliocentric(name, jd) {
  const p = PLANETS[name];
  const T = centuries(jd);
  const a = p.el[0] + p.rate[0] * T;
  const e = p.el[1] + p.rate[1] * T;
  const i = (p.el[2] + p.rate[2] * T) * D;
  const L = p.el[3] + p.rate[3] * T;
  const peri = p.el[4] + p.rate[4] * T;
  const node = (p.el[5] + p.rate[5] * T) * D;
  const w = (peri - (p.el[5] + p.rate[5] * T)) * D;      // argument of perihelion
  const M = wrap180(L - peri) * D;

  // Kepler, by Newton. Ten iterations is far past convergence for e < 0.21 and
  // costs nothing; bailing on the residual keeps it honest if that ever changes.
  let E = M + e * Math.sin(M);
  for (let n = 0; n < 10; n++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  // In the orbital plane.
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  // Rotate: argument of perihelion, inclination, ascending node.
  const cw = Math.cos(w), sw = Math.sin(w);
  const cn = Math.cos(node), sn = Math.sin(node);
  const ci = Math.cos(i), si = Math.sin(i);
  const x1 = xv * cw - yv * sw, y1 = xv * sw + yv * cw;
  return {
    x: x1 * cn - y1 * ci * sn,
    y: x1 * sn + y1 * ci * cn,
    z: y1 * si
  };
}

/**
 * A planet, equatorial coordinates of date.
 *
 * Geocentric by subtracting the Earth's own heliocentric position, which is
 * the whole of what makes a planet appear to loop backwards and is therefore
 * not optional.
 */
export function planetPosition(name, jd) {
  if (!PLANETS[name] || name === 'Earth') return null;
  const p = heliocentric(name, jd);
  const earth = heliocentric('Earth', jd);
  const x = p.x - earth.x, y = p.y - earth.y, z = p.z - earth.z;
  const distance = Math.hypot(x, y, z);
  // Elements are referred to the J2000 ecliptic, so the result is J2000 and
  // has to be precessed like the star catalogue rather than treated as of date.
  const lon = wrap360(Math.atan2(y, x) * R);
  const lat = Math.atan2(z, Math.hypot(x, y)) * R;
  const j2000 = eclipticToEquatorial(lon, lat, 2451545.0);
  const eq = precess(j2000.raDeg, j2000.decDeg, jd);
  return { ...eq, distanceAu: distance, magnitude: PLANETS[name].mag };
}

export const PLANET_NAMES = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];

/**
 * Everything needed to place one catalogue star, in one call.
 *
 * Precession then rotation then refraction, in that order, because each one
 * consumes the previous one's output. Refraction is applied last and only to
 * the altitude, which is what it physically does.
 */
export function apparentAltAz(raJ2000, decJ2000, jd, latDeg, lonDeg, { refract = true } = {}) {
  const now = precess(raJ2000, decJ2000, jd);
  const lst = lstDeg(jd, lonDeg);
  const h = equatorialToHorizontal(now.raDeg, now.decDeg, lst, latDeg);
  return {
    azDeg: h.azDeg,
    altDeg: refract ? h.altDeg + refractionDeg(h.altDeg) : h.altDeg,
    trueAltDeg: h.altDeg
  };
}

/**
 * How dark is it? The Sun's altitude, and the name for that band.
 *
 * Worth reporting because this page is useless in daylight for stars and
 * perfectly useful for the Sun, and the operator should be told which one they
 * are in rather than left wondering why the screen is empty.
 */
export function twilight(jd, latDeg, lonDeg) {
  const sun = sunPosition(jd);
  const lst = lstDeg(jd, lonDeg);
  const { altDeg } = equatorialToHorizontal(sun.raDeg, sun.decDeg, lst, latDeg);
  const label = altDeg > -0.833 ? 'daylight'
    : altDeg > -6 ? 'civil twilight'
      : altDeg > -12 ? 'nautical twilight'
        : altDeg > -18 ? 'astronomical twilight' : 'night';
  return { sunAltDeg: altDeg, label };
}
