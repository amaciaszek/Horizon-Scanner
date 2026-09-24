/* sky/astro.js against published worked examples.
 *
 * Every reference below is Meeus, *Astronomical Algorithms*, 2nd edition. They
 * are used because this module's output is impossible to eyeball: a tenth of a
 * degree is invisible in a number and obvious against a chimney, which is
 * exactly the error this page would otherwise ship.
 *
 * Tolerances are stated per check and are the accuracy the method claims, not
 * a number chosen to make the test pass.
 */
import {
  julianDay, gmstDeg, lstDeg, precess, equatorialToHorizontal, refractionDeg,
  obliquityDeg, sunPosition, moonPosition, planetPosition, apparentAltAz,
  twilight, wrap180, wrap360
} from '../sky/astro.js';

let failures = 0;
function check(name, pass, detail = '') {
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!pass) failures++;
}
function near(name, got, want, tol, unit = 'deg') {
  const d = Math.abs(got - want);
  check(name, d <= tol, `got ${got.toFixed(6)}, want ${want.toFixed(6)}, off ${d.toExponential(2)} ${unit} (tol ${tol})`);
}
/** Angular difference that knows 359.9 and 0.1 are close. */
function nearAngle(name, got, want, tol) {
  const d = Math.abs(wrap180(got - want));
  check(name, d <= tol, `got ${got.toFixed(5)}, want ${want.toFixed(5)}, off ${d.toExponential(2)} deg (tol ${tol})`);
}
const hms = (h, m, s) => (h + m / 60 + s / 3600) * 15;
const dms = (d, m, s) => Math.sign(d || 1) * (Math.abs(d) + m / 60 + s / 3600);

console.log('=== Julian Day (Meeus ch. 7) ===');
near('1957 Oct 4.81 UT, Sputnik launch', julianDay(new Date(Date.UTC(1957, 9, 4, 19, 26, 24))),
  2436116.31, 1e-4, 'd');
near('2000 Jan 1.5 is J2000.0', julianDay(new Date(Date.UTC(2000, 0, 1, 12, 0, 0))), 2451545.0, 1e-6, 'd');
near('1987 Apr 10.0', julianDay(new Date(Date.UTC(1987, 3, 10, 0, 0, 0))), 2446895.5, 1e-6, 'd');
near('1600 Dec 31.0', julianDay(new Date(Date.UTC(1600, 11, 31, 0, 0, 0))), 2305812.5, 1e-6, 'd');

console.log('\n=== Sidereal time (Meeus example 12.1a and 12.1b) ===');
// 12.1a: 1987 April 10 at 0h UT -> 13h10m46.3668s
near('GMST 1987 Apr 10 0h UT', gmstDeg(2446895.5), 197.693195, 1e-5);
// 12.1b: 1987 April 10 at 19h21m00s UT -> 8h34m57.0896s
near('GMST 1987 Apr 10 19:21 UT', gmstDeg(julianDay(new Date(Date.UTC(1987, 3, 10, 19, 21, 0)))),
  hms(8, 34, 57.0896), 1e-4);
check('LST adds east longitude',
  Math.abs(wrap180(lstDeg(2446895.5, 15) - gmstDeg(2446895.5) - 15)) < 1e-9);

console.log('\n=== Obliquity (Meeus example 22.a) ===');
// 1987 April 10, 0h TD: mean obliquity 23 deg 26' 27.407"
near('mean obliquity 1987 Apr 10', obliquityDeg(2446895.5), dms(23, 26, 27.407), 1e-5);

console.log('\n=== Precession (Meeus example 21.b, theta Persei to 2028) ===');
{
  /* Meeus applies PROPER MOTION first and precesses the result. This module
   * does not carry proper motion -- see the header for why it does not matter
   * for a naked-eye star over 26 years -- so the test does that step itself and
   * hands the precession routine exactly what Meeus hands his.
   *
   * J2000: 2h44m11.986s, +49d13'42.48", mu_ra 0.03425 s/yr, mu_dec -0.0895"/yr.
   * At JDE 2462088.69 that is 2h44m12.975s, +49d13'39.90", which Meeus
   * precesses to 2h46m11.331s, +49d20'54.54". */
  const to = 2462088.69;
  const years = (to - 2451545.0) / 365.25;
  const ra0 = hms(2, 44, 11.986) + 0.03425 * years * 15 / 3600;
  const dec0 = dms(49, 13, 42.48) - 0.0895 * years / 3600;
  near('  proper motion reproduces Meeus\'s starting RA', ra0, hms(2, 44, 12.975), 1e-5);
  near('  ...and his starting declination', dec0, dms(49, 13, 39.90), 1e-5);
  const p = precess(ra0, dec0, to);
  near('  precessed right ascension', p.raDeg, hms(2, 46, 11.331), 3e-4);
  near('  precessed declination', p.decDeg, dms(49, 20, 54.54), 3e-4);
}
check('precessing to the catalogue epoch is a no-op',
  (() => { const p = precess(123.456, -45.678, 2451545.0);
    return Math.abs(p.raDeg - 123.456) < 1e-9 && Math.abs(p.decDeg + 45.678) < 1e-9; })());
{
  // Near the pole the approximate per-year formula fails; the rigorous one must
  // not. Polaris moves about 0.45 deg in declination over a century.
  const a = precess(37.9529, 89.2641, 2451545.0);
  const b = precess(37.9529, 89.2641, 2451545.0 + 36525);
  check('Polaris precesses without blowing up near the pole',
    Number.isFinite(b.raDeg) && Number.isFinite(b.decDeg) && b.decDeg > 89 && b.decDeg < 90,
    `dec ${a.decDeg.toFixed(4)} -> ${b.decDeg.toFixed(4)} over a century`);
}

console.log('\n=== Equatorial to horizontal (Meeus example 13.b) ===');
{
  /* Venus from Washington: apparent RA 23h09m16.641s, Dec -6d43'11.61",
   * observer lat +38d55'17", long 77d03'56" WEST. The apparent sidereal time at
   * Greenwich is the one from example 12.1b, 128.737232 deg -- the MEAN value
   * that example computes is 128.737873, and the 0.00064 deg between them is
   * the nutation in right ascension, which this module does not model and
   * which is forty times smaller than anything this page can show.
   *
   * Meeus reports azimuth 68.0337 measured FROM THE SOUTH, and altitude
   * 15.1249. */
  const ra = hms(23, 9, 16.641);
  const dec = dms(-6, 43, 11.61);
  const lst = 128.737232 - dms(77, 3, 56);
  const h = equatorialToHorizontal(ra, dec, lst, dms(38, 55, 17));
  near('  altitude', h.altDeg, 15.1249, 1e-3);
  // This module measures azimuth from NORTH through east, so Meeus + 180.
  nearAngle('  azimuth (north-based = Meeus + 180)', h.azDeg, 68.0337 + 180, 1e-3);
}
{
  // A star exactly on the meridian above the pole sits due south for a
  // northern observer when its declination is below their latitude.
  const h = equatorialToHorizontal(100, 10, 100, 45);
  nearAngle('a transiting star south of the zenith bears 180', h.azDeg, 180, 1e-9);
  near('  and its altitude is 90 - lat + dec', h.altDeg, 90 - 45 + 10, 1e-9);
}
{
  const h = equatorialToHorizontal(100, 80, 100, 45);
  nearAngle('a transiting star north of the zenith bears 0', h.azDeg, 0, 1e-9);
  near('  and its altitude is 90 + lat - dec', h.altDeg, 90 - 80 + 45, 1e-9);
}
{
  // The celestial pole sits at the observer's latitude, due north, always.
  for (const lat of [10, 35, 51.5, 70]) {
    const h = equatorialToHorizontal(0, 90, 123.456, lat);
    near(`pole altitude equals latitude at ${lat}`, h.altDeg, lat, 1e-9);
  }
}

console.log('\n=== Refraction (Meeus ch. 16) ===');
// Bennett's formula returns 34.48 arcmin on the true horizon. The often-quoted
// round figure is "about 34 arcmin"; both are inside the spread that real
// temperature and pressure produce, and the point for this page is that it is
// most of a degree and therefore cannot be left out.
near('on the true horizon, 34.48 arcmin', refractionDeg(0), 34.48 / 60, 1e-4);
check('which is inside the accepted 34-35 arcmin band',
  refractionDeg(0) * 60 > 34 && refractionDeg(0) * 60 < 35);
near('at 45 deg altitude, about 1 arcmin', refractionDeg(45), 1 / 60, 3e-3);
check('refraction falls as altitude rises',
  refractionDeg(0) > refractionDeg(10) && refractionDeg(10) > refractionDeg(45)
  && refractionDeg(45) > refractionDeg(80));
near('at the zenith it is essentially nothing', refractionDeg(90), 0, 1e-3);

console.log('\n=== The Sun (Meeus example 25.a) ===');
{
  // 1992 October 13 at 0h TD, JDE 2448908.5. Meeus: apparent RA 13h13m31.4s,
  // Dec -7d47'06". The low-accuracy series he gives is good to about 0.01 deg.
  const s = sunPosition(2448908.5);
  nearAngle('  right ascension', s.raDeg, hms(13, 13, 31.4), 0.01);
  near('  declination', s.decDeg, dms(-7, 47, 6), 0.01);
}
{
  /* The distance is checked against orbital geometry rather than a published
   * figure, because the only value to hand for it disagreed with the arithmetic
   * of the formula it was supposed to come from, and a test is worth nothing if
   * its expected value is the thing in doubt. Perihelion and aphelion are not
   * in doubt: 0.98329 au around January 3rd, 1.01671 au around July 4th. */
  let lo = Infinity, hi = -Infinity, loJd = 0, hiJd = 0;
  for (let d = 0; d < 366; d += 0.25) {
    const jd = julianDay(new Date(Date.UTC(2026, 0, 1))) + d;
    const r = sunPosition(jd).distanceAu;
    if (r < lo) { lo = r; loJd = jd; }
    if (r > hi) { hi = r; hiJd = jd; }
  }
  near('perihelion distance', lo, 0.98329, 2e-4, 'au');
  near('aphelion distance', hi, 1.01671, 2e-4, 'au');
  const day = jd => new Date((jd - 2440587.5) * 86400000).getUTCMonth() + 1;
  check('perihelion falls in January', day(loJd) === 1);
  check('aphelion falls in July', day(hiJd) === 7);
}
{
  // At the March equinox the Sun's apparent longitude passes 0 and its
  // declination passes zero going north. 2026-03-20 14:46 UTC.
  const s = sunPosition(julianDay(new Date(Date.UTC(2026, 2, 20, 14, 46, 0))));
  near('declination at the 2026 March equinox is ~0', s.decDeg, 0, 0.01);
}

console.log('\n=== The Moon (Meeus example 47.a) ===');
{
  // 1992 April 12 at 0h TD, JDE 2448724.5.
  // Meeus: lambda 133.162655, beta -3.229126, apparent RA 134.688470,
  // Dec 13.768368. The terms carried here claim about 0.02 deg.
  const m = moonPosition(2448724.5);
  nearAngle('  ecliptic longitude', m.eclipticLonDeg, 133.162655, 0.02);
  near('  ecliptic latitude', m.eclipticLatDeg, -3.229126, 0.02);
  nearAngle('  right ascension', m.raDeg, 134.688470, 0.03);
  near('  declination', m.decDeg, 13.768368, 0.02);
}
{
  // Illuminated fraction is a fraction, and a new Moon is dark.
  // 2026-01-18 19:52 UTC is a new Moon.
  const m = moonPosition(julianDay(new Date(Date.UTC(2026, 0, 18, 19, 52, 0))));
  check('new Moon is barely illuminated', m.illuminated < 0.01,
    `illuminated ${(m.illuminated * 100).toFixed(2)}%`);
  const full = moonPosition(julianDay(new Date(Date.UTC(2026, 0, 3, 10, 3, 0))));
  check('full Moon is nearly fully illuminated', full.illuminated > 0.99,
    `illuminated ${(full.illuminated * 100).toFixed(2)}%`);
}

console.log('\n=== Planets (JPL approximate elements) ===');
/* These elements are good to a few arcminutes, so the checks are the ones that
 * catch a WRONG planet rather than an imprecise one: the geometry each planet
 * is forbidden to violate. A sign error, a missing geocentric subtraction or a
 * botched Kepler solve breaks all of them; none of them would notice a
 * two-arcminute drift, and nothing here claims to. */
{
  const jd = julianDay(new Date(Date.UTC(2026, 5, 15, 0, 0, 0)));
  for (const name of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']) {
    const p = planetPosition(name, jd);
    check(`${name} returns a finite position`,
      p && Number.isFinite(p.raDeg) && Number.isFinite(p.decDeg)
      && p.raDeg >= 0 && p.raDeg < 360 && Math.abs(p.decDeg) <= 90,
      `ra ${p.raDeg.toFixed(2)} dec ${p.decDeg.toFixed(2)} at ${p.distanceAu.toFixed(3)} au`);
  }
  check('Earth is not a planet you can observe', planetPosition('Earth', jd) === null);
  check('an unknown name returns null', planetPosition('Vulcan', jd) === null);
}
{
  // Geocentric distance bounds are fixed by orbital geometry and are violated
  // instantly if the Earth's position is not subtracted.
  const bounds = { Mercury: [0.52, 1.5], Venus: [0.25, 1.75], Mars: [0.37, 2.7],
    Jupiter: [3.9, 6.5], Saturn: [7.9, 11.1] };
  let worst = '';
  let ok = true;
  for (const [name, [lo, hi]] of Object.entries(bounds)) {
    for (let d = 0; d < 4000; d += 7) {
      const p = planetPosition(name, 2451545.0 + d);
      if (p.distanceAu < lo || p.distanceAu > hi) { ok = false; worst = `${name} ${p.distanceAu.toFixed(3)} au`; }
    }
  }
  check('geocentric distances stay inside their orbital bounds over 11 years', ok, worst);
}
{
  // Mercury and Venus can never appear far from the Sun. This is the check that
  // an inner planet's geocentric direction is right, and it needs no ephemeris.
  let maxMercury = 0, maxVenus = 0;
  for (let d = 0; d < 4000; d += 3) {
    const jd = 2451545.0 + d;
    const sun = sunPosition(jd);
    for (const [name, keep] of [['Mercury', 0], ['Venus', 1]]) {
      const p = planetPosition(name, jd);
      // Angular separation on the sphere.
      const toRad = Math.PI / 180;
      const cosSep = Math.sin(p.decDeg * toRad) * Math.sin(sun.decDeg * toRad)
        + Math.cos(p.decDeg * toRad) * Math.cos(sun.decDeg * toRad)
        * Math.cos((p.raDeg - sun.raDeg) * toRad);
      const sep = Math.acos(Math.max(-1, Math.min(1, cosSep))) / toRad;
      if (keep) maxVenus = Math.max(maxVenus, sep); else maxMercury = Math.max(maxMercury, sep);
    }
  }
  check('Mercury never strays more than ~28 deg from the Sun',
    maxMercury > 17 && maxMercury < 29, `max elongation ${maxMercury.toFixed(2)} deg`);
  check('Venus never strays more than ~47 deg from the Sun',
    maxVenus > 44 && maxVenus < 48, `max elongation ${maxVenus.toFixed(2)} deg`);
}

console.log('\n=== The whole chain, and the sanity of it ===');
{
  // Greenwich, and a star at the pole: must sit due north at the latitude,
  // lifted a hair by refraction.
  const jd = julianDay(new Date(Date.UTC(2026, 8, 23, 22, 0, 0)));
  const a = apparentAltAz(precess(0, 90, jd).raDeg, precess(0, 90, jd).decDeg, jd, 51.4779, 0);
  check('refraction lifts, never lowers', a.altDeg >= a.trueAltDeg);
  const noRefract = apparentAltAz(0, 90, jd, 51.4779, 0, { refract: false });
  check('and can be switched off', Math.abs(noRefract.altDeg - noRefract.trueAltDeg) < 1e-12);
}
{
  // An hour of clock is fifteen degrees of sky. This is the single error most
  // likely to be mistaken for a bad azimuth datum, so it is pinned down.
  const base = new Date(Date.UTC(2026, 8, 23, 22, 0, 0));
  const later = new Date(base.getTime() + 3600 * 1000);
  const a = apparentAltAz(279.234, 38.784, julianDay(base), 42.3, -71.1);
  const b = apparentAltAz(279.234, 38.784, julianDay(later), 42.3, -71.1);
  const lstStep = wrap180(lstDeg(julianDay(later), -71.1) - lstDeg(julianDay(base), -71.1));
  near('one hour of clock is one sidereal hour of rotation', lstStep, 15.041, 1e-2);
  check('and the star actually moves', Math.abs(wrap180(a.azDeg - b.azDeg)) > 1);
}
{
  const t = twilight(julianDay(new Date(Date.UTC(2026, 5, 21, 12, 0, 0))), 42.3, -71.1);
  check('local noon in June in Massachusetts is daylight', t.label === 'daylight',
    `sun ${t.sunAltDeg.toFixed(1)} deg`);
  const n = twilight(julianDay(new Date(Date.UTC(2026, 11, 21, 5, 0, 0))), 42.3, -71.1);
  check('midnight in December is night', n.label === 'night', `sun ${n.sunAltDeg.toFixed(1)} deg`);
}
{
  check('wrap360 folds negatives', wrap360(-10) === 350 && wrap360(370) === 10);
  check('wrap180 folds the long way round', wrap180(350) === -10 && wrap180(-190) === 170);
}

console.log(failures ? `\n${failures} FAILED` : '\nall astro checks passed');
process.exitCode = failures ? 1 : 0;
