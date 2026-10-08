"""
Vendor the deep-sky objects a telescope at this site would actually be aimed at.

WHY A SECOND CATALOGUE AND NOT MORE ROWS IN THE STAR ONE. `sky/star-catalog.json`
stops at magnitude 6.5 because it exists to be compared against what an eye
sees. `sky/planetarium.html` answers a different question -- "does M33 clear my
roofline tonight, and when" -- and the targets for that are not naked-eye
objects at all. Mixing them would force one magnitude limit to serve two jobs
it cannot serve at once.

SOURCE. OpenNGC, mattiaverga/OpenNGC, database_files/NGC.csv plus
database_files/addendum.csv. CC BY-SA 4.0, same licence as the star data.
Re-run with the two source files in the working directory:

    curl -L -o NGC.csv https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv
    curl -L -o addendum.csv https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/addendum.csv
    python tools/build-dso-catalog.py NGC.csv addendum.csv

WHAT IS KEPT, and why that line and not another:

  every Messier object        109 of them. M102 is not in OpenNGC because it
                              has never been settled what Messier saw; it is
                              aliased to NGC 5866 below, which is the usual
                              identification, and labelled so the page does not
                              pretend the question is closed.
  everything to magnitude 10  A 10-inch instrument under suburban sky is the
                              use case this site is being surveyed for, and 10
                              is about where that stops being fun.
  everything with a name      A named object is one people ask for by name.
  anything big and unmeasured OpenNGC tabulates no magnitude at all for most
                              large emission nebulae, so a magnitude cut throws
                              away exactly the objects that are easiest to
                              find. MEASURED, from the field: NGC 281, the
                              Pacman -- 35 arcminutes across, a standard
                              beginner target -- was missing from the first
                              build for precisely this reason. An object with
                              no tabulated magnitude is not a faint object, it
                              is an unmeasured one, so anything 10 arcminutes
                              or wider is kept regardless.

  The whole file is about 100 kB, so the limits are set by what is worth
  listing and not by download size.

Types that are not objects -- OpenNGC's Dup (a duplicate entry), NonEx (does
not exist), and the plain-star entries -- are dropped. A search result that
turns out to be a catalogue bookkeeping row is worse than no result. A Messier
number overrides that: M24 is catalogued as a star association and M40 as a
double star, and a list that answers "M39" but shrugs at "M40" is broken as
far as anyone using it is concerned.

Magnitudes are V where OpenNGC has one. Where it only has B, V is estimated as
B - 0.4, which is roughly right for a galaxy and wrong by a couple of tenths
for anything blue; the field marks these so the page can say "approx" rather
than quoting a number it did not measure.
"""
import csv
import json
import sys
from pathlib import Path

MAG_LIMIT = 10.0
BIG_ARCMIN = 10.0
OUT = Path('sky/dso-catalog.json')

# NAMES EVERYBODY USES THAT OPENNGC DOES NOT CARRY.
#
# OpenNGC's `Common names` column is good and incomplete, and what it is
# missing is mostly the popular nicknames of large nebulae -- the ones an
# observer types, because nobody says "NGC 281". Reported from the field:
# searching "Pacman" found nothing. These are added to whatever OpenNGC
# already has rather than replacing it, and an object named here is kept
# whatever its magnitude, because being worth a nickname is the evidence that
# somebody wants to find it.
NICKNAMES = {
    'NGC0281': ['Pacman Nebula'],
    'IC1805': ['Heart Nebula'],
    'IC1848': ['Soul Nebula'],
    'IC1396': ["Elephant's Trunk Nebula"],
    'NGC7380': ['Wizard Nebula'],
    'IC0410': ['Tadpoles Nebula'],
    'IC2177': ['Seagull Nebula'],
    'NGC2359': ["Thor's Helmet"],
    # OpenNGC hangs "Flame Nebula" on IC 434, which is the HII region the
    # Horsehead is silhouetted against. Both names are in common use for both
    # objects; carrying each on each is the only way a search answers either.
    'NGC2024': ['Flame Nebula'],
    'IC0434': ['Horsehead Nebula'],
    'IC0443': ['Jellyfish Nebula'],
    'NGC2237': ['Rosette Nebula'],
    'NGC0869': ['Double Cluster', 'h Persei'],
    'NGC0884': ['Double Cluster', 'chi Persei'],
    'NGC3628': ['Hamburger Galaxy', 'Leo Triplet'],
    'NGC5907': ['Splinter Galaxy'],
    'NGC0253': ['Sculptor Galaxy', 'Silver Coin Galaxy'],
    'NGC2264': ['Cone Nebula'],
    'NGC1333': ['Embryo Nebula'],
}

# Catalogues worth answering to, and no more. OpenNGC's Identifiers column
# also carries 2MASX, PGC, SDSS and a dozen survey designations that nobody
# types at an eyepiece, and carrying them all would double the file.
ALT_PREFIXES = ('Sh2-', 'LBN', 'LDN', 'Barnard', 'Cr ', 'Mel ', 'Tr ',
                'Stock ', 'King ', 'vdB', 'Ced', 'Abell', 'Hickson', 'Arp')


def alt_identifiers(text):
    out = []
    for raw in (text or '').split(','):
        name = raw.strip()
        if name and name.startswith(ALT_PREFIXES):
            out.append(name)
    return out[:4] or None

# OpenNGC type codes, spelled out. The page shows these to a person standing
# outside, so they are words rather than the two-letter codes.
TYPE_NAMES = {
    'G': 'galaxy', 'GPair': 'galaxy pair', 'GTrpl': 'galaxy triplet',
    'GGroup': 'galaxy group', 'GCl': 'globular cluster', 'OCl': 'open cluster',
    'Cl+N': 'cluster with nebulosity', 'PN': 'planetary nebula',
    'Neb': 'nebula', 'EmN': 'emission nebula', 'RfN': 'reflection nebula',
    'HII': 'HII region', 'SNR': 'supernova remnant', 'DrkN': 'dark nebula',
    'Nova': 'nova', 'Other': 'object',
    # Only reachable via the Messier override above.
    '*Ass': 'star cloud', '**': 'double star'
}
SKIP_TYPES = {'Dup', 'NonEx', '*', '**', '*Ass', 'Nova'}


def sexagesimal_to_deg(text, is_ra):
    """OpenNGC writes RA as hh:mm:ss.s and Dec as +dd:mm:ss.s."""
    if not text:
        return None
    sign = -1.0 if text.strip().startswith('-') else 1.0
    parts = text.strip().lstrip('+-').split(':')
    if len(parts) != 3:
        return None
    value = float(parts[0]) + float(parts[1]) / 60 + float(parts[2]) / 3600
    return sign * value * (15.0 if is_ra else 1.0)


def magnitude(row):
    """(value, exact) -- see the note in the module docstring about B - 0.4."""
    try:
        return float(row['V-Mag']), True
    except (TypeError, ValueError):
        pass
    try:
        return float(row['B-Mag']) - 0.4, False
    except (TypeError, ValueError):
        return None, False


def main(paths):
    rows = []
    for p in paths:
        with open(p, newline='', encoding='utf-8') as fh:
            rows += list(csv.DictReader(fh, delimiter=';'))

    objects = []
    for r in rows:
        kind = r['Type']
        messier = int(r['M']) if r['M'] else None
        if kind in SKIP_TYPES and messier is None:
            continue
        if kind in ('Dup', 'NonEx'):
            continue
        mag, exact = magnitude(r)
        try:
            size = float(r['MajAx'])
        except (TypeError, ValueError):
            size = None
        extra = NICKNAMES.get(r['Name'].strip(), [])
        common = [n.strip() for n in (r['Common names'] or '').split(',') if n.strip()]
        # A Messier object is kept whatever its catalogue magnitude says --
        # M24 and M45 have no tabulated V at all, and they are the two most
        # obvious things in a summer and a winter sky respectively. So is
        # anything named, and anything large that nobody has measured; see the
        # module docstring for why the magnitude cut on its own was wrong.
        if not (messier is not None
                or common or extra
                or (mag is not None and mag <= MAG_LIMIT)
                or (mag is None and size is not None and size >= BIG_ARCMIN)):
            continue
        ra = sexagesimal_to_deg(r['RA'], True)
        dec = sexagesimal_to_deg(r['Dec'], False)
        if ra is None or dec is None:
            continue
        objects.append({
            'id': r['Name'].strip(),
            'm': messier,
            'ra': round(ra, 4),
            'dec': round(dec, 4),
            'mag': None if mag is None else round(mag, 2),
            'magApprox': (mag is not None and not exact) or None,
            'type': TYPE_NAMES.get(kind, kind),
            'size': None if size is None else round(size, 1),
            'const': r['Const'].strip() or None,
            'names': common + [n for n in extra if n not in common],
            # A few of the other catalogues an observer might have the object
            # written down in. Sharpless numbers in particular are how large
            # nebulae are labelled on most charts.
            'alt': alt_identifiers(r['Identifiers'])
        })

    # M102: see the docstring. Tagged rather than silently merged.
    for o in objects:
        if o['id'] == 'NGC5866':
            o['m'] = 102
            o['names'] = o['names'] + ['Messier 102 (disputed)']

    objects.sort(key=lambda o: (o['m'] is None, o['m'] or 0, o['id']))
    OUT.write_text(json.dumps({
        'source': {
            'objects': 'OpenNGC (mattiaverga/OpenNGC), NGC.csv + addendum.csv',
            'note': 'CC BY-SA 4.0. See sky/README.txt. Rebuild with tools/build-dso-catalog.py.'
        },
        'epoch': 'J2000.0',
        'magLimit': MAG_LIMIT,
        'objects': objects
    }, separators=(',', ':')), encoding='utf-8')
    messier = sum(1 for o in objects if o['m'])
    print(f'{len(objects)} objects, {messier} of them Messier -> {OUT} '
          f'({OUT.stat().st_size / 1024:.0f} kB)')


if __name__ == '__main__':
    main(sys.argv[1:] or ['NGC.csv', 'addendum.csv'])
