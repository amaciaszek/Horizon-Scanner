"""
Vendor a naked-eye star catalogue and the constellation stick figures.

WHY THIS IS A BUILD STEP AND NOT A FETCH. `sky/skyline-align.html` is used
standing in a field at night, on a phone, quite possibly with no signal. A page
that downloads its star catalogue when it opens is a page that does not open
where it is needed. The catalogue is small enough to ship, so it ships.

WHAT COMES FROM WHERE, so the next person does not have to guess:

  stars   HYG Database v4.0, astronexus/HYG-Database, hyg/CURRENT/hygdata_v40
          Positions are J2000.0. Magnitudes are visual.
  figures Stellarium skycultures/modern/index.json -- the IAU 88 constellation
          lines, plus the named asterisms (Summer Triangle, the Plough, and so
          on) that are the things a person actually recognises overhead.

Both are third-party data under their own licences; see sky/README.txt. Re-run
with the two source files in the working directory:

    python tools/build-star-catalog.py hygdata_v40.csv.gz index.json

MAGNITUDE LIMIT. 6.5 is the naked-eye limit under a properly dark sky. A star
too faint to see is not useless here -- it is worse than useless, because this
page exists to let someone match what is in front of their eyes against what
the computer thinks is there, and a screen full of stars they cannot see makes
that harder, not easier. The page can dim them; the catalogue stops here.

PROPER MOTION IS DELIBERATELY NOT CARRIED. Over the twenty-six years from
J2000 the fastest naked-eye star moves about four arcminutes, and the median
moves under one. Precession is a different matter entirely -- roughly a third
of a degree of it by 2026, which is visible against a skyline -- and the page
applies that at runtime.
"""
import csv
import gzip
import io
import json
import math
import sys
from pathlib import Path

MAG_LIMIT = 6.5
OUT = Path('sky/star-catalog.json')


def load_hyg(path):
    """Every star to the magnitude limit, keyed by HIP where it has one."""
    opener = gzip.open if str(path).endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8', errors='replace') as fh:
        rows = list(csv.DictReader(fh))
    stars, by_hip = [], {}
    for r in rows:
        # id 0 is the Sun, which the catalogue carries and the sky does not
        # need from it: the page computes the Sun's place from the date.
        if r['id'] == '0':
            continue
        try:
            mag = float(r['mag'])
            ra_h = float(r['ra'])
            dec = float(r['dec'])
        except (TypeError, ValueError):
            continue
        hip = r['hip'].strip()
        if mag > MAG_LIMIT and not hip:
            continue
        try:
            ci = float(r['ci'])
        except (TypeError, ValueError):
            ci = 0.0
        stars.append({
            'ra': ra_h * 15.0,                 # hours in the file, degrees here
            'dec': dec,
            'mag': mag,
            'ci': ci,
            'hip': int(hip) if hip else None,
            'proper': (r['proper'] or '').strip(),
            'bayer': (r['bayer'] or '').strip(),
            'con': (r['con'] or '').strip(),
        })
    for s in stars:
        if s['hip'] is not None:
            by_hip[s['hip']] = s
    return stars, by_hip


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    hyg_path, index_path = Path(sys.argv[1]), Path(sys.argv[2])
    all_stars, by_hip = load_hyg(hyg_path)
    sky = json.loads(index_path.read_text(encoding='utf-8'))

    # A figure's line is useless if one of its stars is missing, and some of the
    # stick figures reach below the naked-eye limit. Those stars are kept
    # whatever their magnitude -- a broken constellation is worse than a faint
    # one -- and everything else is cut at the limit.
    needed = set()

    def as_hip(point):
        """A figure vertex, or None where it is not a star at all.

        Stellarium's asterisms also hang lines off deep-sky objects -- the
        Pleiades anchors one, and a vertex there reads `DSO:IC2602`. This
        catalogue is stars, so those vertices are not resolvable and the
        polyline has to be broken around them rather than closed across them.
        """
        try:
            return int(point)
        except (TypeError, ValueError):
            return None

    def collect(groups):
        for g in groups:
            for line in g.get('lines', ()):
                for point in line:
                    hip = as_hip(point)
                    if hip is not None:
                        needed.add(hip)

    collect(sky.get('constellations', ()))
    collect([a for a in sky.get('asterisms', ()) if not a.get('is_ray_helper')])

    kept = [s for s in all_stars
            if s['mag'] <= MAG_LIMIT or (s['hip'] is not None and s['hip'] in needed)]
    # Brightest first. The renderer draws in order and stops when it hits the
    # magnitude the user asked for, so sorting here is what makes that a slice
    # rather than a filter.
    kept.sort(key=lambda s: s['mag'])
    index_of = {s['hip']: i for i, s in enumerate(kept) if s['hip'] is not None}

    missing = sorted(h for h in needed if h not in index_of)
    if missing:
        print(f'  warning: {len(missing)} figure star(s) absent from HYG: '
              f'{missing[:10]}{" ..." if len(missing) > 10 else ""}')

    def figures(groups, named_only):
        out = []
        for g in groups:
            if g.get('is_ray_helper'):
                continue
            common = g.get('common_name') or {}
            name = common.get('english') or common.get('native') or ''
            if named_only and not name:
                continue
            lines = []
            for line in g.get('lines', ()):
                # Break, do not bridge. A vertex this catalogue cannot resolve
                # ends the run; joining its neighbours would draw a segment
                # nobody put in the figure.
                run = []
                for point in line:
                    hip = as_hip(point)
                    i = index_of.get(hip) if hip is not None else None
                    if i is None:
                        if len(run) >= 2:
                            lines.append(run)
                        run = []
                    else:
                        run.append(i)
                if len(run) >= 2:
                    lines.append(run)
            if not lines:
                continue
            entry = {'name': name, 'lines': lines}
            native = common.get('native')
            if native and native != name:
                entry['native'] = native
            abbr = g.get('id', '').split()[-1] if g.get('id') else ''
            if abbr:
                entry['abbr'] = abbr
            out.append(entry)
        return out

    # Proper names, preferring the HYG name and falling back to Stellarium's,
    # which knows a good many more of them.
    names = {}
    for i, s in enumerate(kept):
        if s['proper']:
            names[str(i)] = s['proper']
    for key, entries in (sky.get('common_names') or {}).items():
        if not key.startswith('HIP '):
            continue
        try:
            hip = int(key[4:])
        except ValueError:
            continue
        i = index_of.get(hip)
        if i is None or str(i) in names or not entries:
            continue
        first = entries[0]
        label = first.get('english') or first.get('native')
        if label:
            names[str(i)] = label

    catalogue = {
        'source': {
            'stars': 'HYG Database v4.0 (astronexus/HYG-Database, hyg/CURRENT/hygdata_v40)',
            'figures': 'Stellarium skycultures/modern (index.json)',
            'note': 'See sky/README.txt for licences. Rebuild with tools/build-star-catalog.py.',
        },
        'epoch': 'J2000.0',
        'magLimit': MAG_LIMIT,
        # Parallel arrays, not an array of objects: 9000 objects with four keys
        # each is most of a megabyte of repeated key names.
        'ra': [round(s['ra'], 4) for s in kept],
        'dec': [round(s['dec'], 4) for s in kept],
        'mag': [round(s['mag'], 2) for s in kept],
        'ci': [round(s['ci'], 2) for s in kept],
        'names': names,
        'constellations': figures(sky.get('constellations', ()), named_only=False),
        'asterisms': figures(sky.get('asterisms', ()), named_only=True),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(catalogue, separators=(',', ':')), encoding='utf-8')
    faint = sum(1 for s in kept if s['mag'] > MAG_LIMIT)
    print(f'wrote {OUT}  {OUT.stat().st_size / 1024:.0f} KB')
    print(f'  {len(kept)} stars to magnitude {MAG_LIMIT}'
          f'{f" (+{faint} fainter, kept because a figure needs them)" if faint else ""}')
    print(f'  {len(catalogue["constellations"])} constellations, '
          f'{len(catalogue["asterisms"])} named asterisms, {len(names)} proper names')
    print(f'  brightest {catalogue["mag"][0]}, faintest {catalogue["mag"][-1]}')


if __name__ == '__main__':
    main()
