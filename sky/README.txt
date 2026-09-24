sky/ — Skyline Align
====================

Open sky/skyline-align.html. Load a panorama, set your position, and turn the
two offset sliders until the stars sit where the real ones are. The azimuth
offset you end up with IS your survey's bearing error.

WHY IT EXISTS
-------------
The survey measures the SHAPE of a horizon very well and its BEARING only as
well as a phone magnetometer allows, which is not very. On the 2026-09-23
back-yard capture the app logged this itself:

    Yaw datum locked at 329.2 deg from 80 compass samples, spread 34.0 deg.
    The magnetometer disagreed with itself by 34 deg, so every bearing in this
    survey could be out by roughly +/-17 deg. The horizon SHAPE is unaffected.
    Fix the bearings afterwards with the landmark tool.

This is that fix, using the sky instead of landmarks. A star's bearing is
calculable to a thousandth of a degree from a date and a position, so the sky
is a better reference than any map, and it is available from the same spot the
telescope will stand on.

Elevation gets the same treatment. The second slider exists because a panorama's
altitude band is only as good as the accelerometer's idea of level, and lining
a known star's altitude up against a roofline settles it.


WHAT IT DOES, IN ORDER
----------------------
1. Detects the skyline in the loaded panorama and makes everything above it
   transparent, so real stars show through where sky used to be.
2. Wraps the result onto the inside of a sphere, which is what the panorama is
   a map of.
3. Places the stars, the constellation figures, the Sun, the Moon and the five
   naked-eye planets for your latitude, longitude and the moment shown.
4. Gives you the two offset sliders, in degrees.

The skyline detector is workers/segment.worker.js — the SAME one the capture
app runs on every frame. That is deliberate: a second detector would give a
second answer, and the point of this page is to show the app's own answer next
to the real sky. Two things are done to a panorama that a camera frame does not
need, and both are explained in the code: the image is fed to the detector with
its ends wrapped onto each other, because a panorama's left and right edges are
the same bearing; and unpainted black panel is filled with sky colour first,
because black is neither blue nor smooth and the detector would otherwise trace
the top of the black instead of the roofline.


UPDATE CADENCE
--------------
Every two minutes by default. The sky turns one degree every four minutes, so
anything faster is work for nothing, and on a phone held outside in the cold it
is battery for nothing. "Only when I ask" is there for when you want the picture
to hold still while you argue with a slider.


ACCURACY, STATED PLAINLY
------------------------
sky/astro.js carries the details and tests/astro.test.mjs checks every routine
against published worked examples from Meeus, Astronomical Algorithms (2nd ed.).
Measured against those examples:

    precession              1e-7 deg   (example 21.b)
    equatorial->horizontal  1.4e-4 deg (example 13.b)
    sidereal time           9e-8 deg   (examples 12.1a, 12.1b)
    the Sun                 1e-4 deg   (example 25.a)
    the Moon                5e-3 deg   (example 47.a)
    planets                 a few arcminutes, and no better

Not modelled, with what each costs: nutation (0.005 deg), aberration
(0.006 deg), proper motion (under 0.07 deg for any naked-eye star since J2000),
and the difference between UTC and Terrestrial Time (0.0002 deg of rotation).
All are far below what a skyline can be read to by eye.

Atmospheric refraction IS modelled and matters more than any of them: it lifts
an object on the true horizon by 0.57 degrees, which is more than a Moon's
width, and it is exactly where a horizon alignment lives. There is a switch for
it, which should stay on unless you are checking geometry rather than sky.

This is not an ephemeris and must not be used to point a telescope.


DATA, AND ITS LICENCES
----------------------
Both datasets are third-party and both are CC BY-SA 4.0. They are vendored into
sky/star-catalog.json rather than fetched, because this page gets used standing
in a field and a page that downloads its catalogue on open is a page that does
not open where it is needed. It works in aeroplane mode.

  Stars    HYG Database v4.0
           https://github.com/astronexus/HYG-Database
           hyg/CURRENT/hygdata_v40.csv.gz
           CC BY-SA 4.0
           8,969 stars to magnitude 6.5, plus 49 fainter ones that a
           constellation figure needs. Positions J2000.0.

  Figures  Stellarium, skycultures/modern/index.json
           https://github.com/Stellarium/stellarium
           Text and data CC BY-SA 4.0
           88 IAU constellations, 74 named asterisms, 573 proper names.

Rebuild after updating either source:

    curl -L -o hygdata_v40.csv.gz \
      https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v40.csv.gz
    curl -L -o index.json \
      https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern/index.json
    python tools/build-star-catalog.py hygdata_v40.csv.gz index.json

The builder resolves every figure vertex to a catalogue index at build time, so
the page never looks a HIP number up at runtime. Vertices it cannot resolve —
Stellarium hangs a few asterism lines off deep-sky objects and off Gaia source
IDs — break the polyline there rather than bridging across, because bridging
would draw a segment nobody put in the figure.


THE SKY CUT ERRS ON THE SIDE OF KEEPING THINGS
----------------------------------------------
The detector is tuned for 384x288 camera frames and on a panorama it traces
LOW, clipping rooflines and treetops. The first version cut on the traced line
and the verdict from the field was that it removed so much the skyline itself
was damaged -- which is the wrong way round, because that edge is the thing the
page exists to align.

The cut is therefore made a few degrees ABOVE the trace ("Keep this much sky",
6 degrees by default) and fades in across the band rather than ending on a hard
line, since a crisp horizontal edge in open sky reads as a real object. The
cost is the stars inside that band; turn it down if you need them.

Not all the black is the cut. A stitched panorama is full of holes -- 13.6% of
the 2026-09-23 render is unpainted, and 6.4% of the rows below the top of the
painted content are gaps INSIDE the terrain where the solver dropped a frame.
Rendered transparent they look exactly like an over-aggressive cut. "Mark
unpainted panel" paints them instead, so the two can be told apart at a glance.


KNOWN LIMITS
------------
- The altitude span is guessed from the image's aspect ratio. That is exact for
  anything this app rendered, because its renderer uses square degrees, and it
  is a guess for a panorama from anywhere else. The slider is there for that.
- The detector assumes sky is above ground everywhere. A panorama containing a
  tall thin object against a bright overcast can lose it.
- Deep-sky objects are not drawn. Nothing naked-eye is missing except the
  Milky Way, M31 and the Magellanic Clouds.
