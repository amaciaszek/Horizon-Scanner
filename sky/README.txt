sky/ — Skyline Align, and the Planetarium
=========================================

TWO PAGES, IN ORDER. Align first, then observe.

  skyline-align.html  measures the two offsets that put the survey's bearings
                      on the real sky.
  planetarium.html    uses them: your measured horizon, the real sky behind it,
                      a search box and a scrub bar through the night.

They share one renderer (skyview.js), one skyline detector (panorama-sky.js)
and one saved alignment, so the horizon drawn on the second page is the horizon
as corrected on the first. Two copies of any of that would be two answers.

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


DO THE ALIGNMENT ONCE: THE SILHOUETTE PANEL
-------------------------------------------
Posing a panorama against the stars is a job for a clear night and a steady
hand, and it is not a job to repeat every time you want to know when something
clears the roof. Once the sliders are right, the "Silhouette" panel turns that
work into something permanent.

  Send this horizon      Bakes the two offsets into the 720 bins and keeps the
  to the Planetarium     result where sky/planetarium.html looks on startup.
                         No file, no re-posing, and it stays until replaced.
                         The offsets go to zero afterwards BECAUSE they are now
                         in the numbers -- the panorama will look turned, and
                         that is the alignment and not a mistake.

  .horizon-profile       The same 720 bins as a small JSON file, for keeping,
                         for the planetarium on another device, and for
                         whatever reads a horizon next.

  SVG                    The outline, as vector. One point per bin, 0.1 degrees
                         of azimuth per unit, 0 at due north.

  PNG alpha mask         3600 x 900, one pixel per tenth of a degree, opaque
                         terrain and transparent sky, ready to lay over an
                         equirectangular render.

ALL FOUR ARE THE TRACED SKYLINE AND NOT THE PICTURE'S CUT EDGE, and that is the
whole point of generating them from the numbers. The cut edge is the skyline
PLUS the `skyMarginDeg` band of real sky deliberately kept above it, minus
whatever the stitcher never painted, at the texture's resolution. Over a
treeline, where the traced row jumps tens of pixels between neighbouring
columns, that reads as a comb of bright streaks standing in the sky -- which
looks like the cut having torn pieces out of the terrain and is nothing of the
kind. The exports have no margin, no fade, no holes and no resampling.

Everything written out is in TRUE bearings, north through east, with
`azimuthOffsetDeg: 0` stated in the file. A profile that is only correct when
accompanied by two numbers in a different document is a profile that will
eventually be used without them.


THE PLANETARIUM
---------------
Open sky/planetarium.html after you have an alignment.

WHY IT EXISTS. Every planetarium on earth will tell you M33 rises at 19:40.
None of them know about the barn. The question an owner of a fixed telescope
actually has is "when does M33 clear MY roofline, and how long do I get", and
answering it needs a measured horizon -- which is what this whole project
produces. Rise and set here are computed against the survey's 720-bin profile,
never against a flat horizon nobody has.

WHAT YOU FEED IT. Usually nothing: press "Send this horizon to the Planetarium"
on the align page and this one opens on it. Otherwise a `.horizon-project` or a
`.horizon-profile` (small, carries the measured profile outright) or the
panorama PNG (bigger, gives you the picture too, and the skyline is re-detected
from it with the same worker).
Both at once is best, and that they draw the same edge is a free check that
they agree. The profile is remembered between visits; the panorama is not,
because a multi-megabyte image in localStorage is a page that fails to open.

WHAT IT ANSWERS, for whatever you select:

    now      az  71.0 deg   alt  26.1 deg
    skyline  59.8 deg here  ->  -33.7 deg
    highest  01:16 at 78.4 deg (az 180 deg)
    clears   23:17
    7.0 hours above your skyline

The track is drawn across the sky with an hour tick on it, solid where the
object is in the clear and dotted where the skyline is in the way. The bar
under the sky spans civil dusk to civil dawn rather than midnight to midnight,
because every pixel of it should be a minute someone could observe in; a
24-hour bar spends over half its length in daylight.

THE DEEP-SKY CATALOGUE. sky/dso-catalog.json, 687 objects, built by
tools/build-dso-catalog.py from OpenNGC -- see below. All 110 Messier whatever
their magnitude; everything else to magnitude 10; everything with a name; and
anything 10 arcminutes or wider that nobody has measured.

That last rule is there because of a miss reported from the field: NGC 281,
the Pacman, is 35 arcminutes across and a standard beginner target, and the
first build did not have it. OpenNGC tabulates no magnitude at all for most
large emission nebulae, so a magnitude cut throws away exactly the objects that
are easiest to find. An object with no tabulated magnitude is not a faint
object, it is an unmeasured one.

M102 has never been settled and OpenNGC does not carry it; it is aliased here
to NGC 5866 and labelled as disputed rather than quietly merged.

FINDING THINGS BY THE NAME YOU KNOW. Also reported from the field: "Shedar"
found nothing, because the label is "Schedar", and "Pacman" found nothing
because OpenNGC does not carry nicknames. Three things answer that now, and
none of them is picking a better single spelling, because there isn't one.

  alternate spellings  Every name Stellarium lists for a star, not only the
                       first. HIP 3179 answers to Schedar, Shedar and Shedir.
  Bayer designations   1,517 of them, so "alpha Cas", "alp cas" and the Greek
                       letter pasted off a chart all work.
  nicknames            A short hand-kept table in tools/build-dso-catalog.py
                       for the popular names OpenNGC lacks -- Pacman, Heart,
                       Soul, Wizard, Seagull and the rest.

A query that still matches nothing falls back to an edit distance of two, so a
near miss finds the thing anyway. Only a miss falls back: a query that matched
something exactly is never reordered by guesses.

NOT A POINTING MODEL. Rise and set are good to well under a minute given the
profile, and the profile is good to whatever the survey measured. The planets
are good to a few arcminutes and no better. Do not drive a mount from this.


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

  Deep sky OpenNGC
           https://github.com/mattiaverga/OpenNGC
           database_files/NGC.csv and database_files/addendum.csv
           CC BY-SA 4.0
           687 objects. Positions J2000.0, magnitudes V where OpenNGC has
           one and estimated from B - 0.4 where it does not, which the
           catalogue marks so the page can say so. A handful of popular
           nicknames OpenNGC does not carry are added by the builder and
           are listed there.

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

And for the deep-sky catalogue:

    curl -L -o NGC.csv       https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv
    curl -L -o addendum.csv       https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/addendum.csv
    python tools/build-dso-catalog.py NGC.csv addendum.csv

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
- Skyline Align does not draw deep-sky objects; the planetarium does. Nothing
  naked-eye is missing from either except the Milky Way and the Magellanic
  Clouds.
- A bin the survey never reached is a HOLE in the planetarium's silhouette and
  reads as "not surveyed at this bearing" rather than as a rise time. A missing
  bin drawn as flat ground would promise open sky where there may be a wall,
  and buildHzn2 writes 255 for the same reason.
