'use strict';

/**
 * Which build is on the glass.
 *
 * Exists because of 2026-08-17: a field session failed completely, and the
 * first question — was the iPad even running the new code? — could not be
 * answered from anything on the screen or in the exported log. Confirming the
 * device has the build you think it has should take a glance, not a deduction.
 *
 * BUMP `VERSION` WITH ANY CHANGE THAT GOES TO A DEVICE. It is stamped into the
 * header, the debug snapshot, the field log at startup and every exported
 * archive, so a capture can always be tied back to the code that produced it.
 * `BUILD_DATE` is the date of that change, not of the deployment.
 */
export const VERSION = '0.30.0';
export const BUILD_DATE = '2026-09-23';

/**
 * The stitcher stops doing work it throws away.
 * Kept short deliberately: it is read on a phone, in daylight, by someone who
 * wants to know whether to trust what they are holding.
 */
export const RELEASE_NOTE =
  'Four measured fixes. Hamming distance is now one matrix multiply instead of a lookup table, '
  + 'bit-identical and roughly twice as fast end to end on the reference capture. The quality presets '
  + 'named feature counts the runtime silently capped at 1500, so all three expensive ones were the '
  + 'same detector; they now say what they do. The lens the app proves during the walk finally reaches '
  + 'the stitcher, which had been matching a 47-degree lens as if it were 38 and returning a broken '
  + 'graph. And the height each bearing was scanned to came from a running maximum that overshot the '
  + "app's own skyline at all 180 bearings by a median of 37 degrees, putting 155 of 180 columns on a "
  + 'full six-band stack; a new high must now be seen twice. A band of open sky is added above the '
  + 'skyline, because the top frame of a column was being dropped from the panorama five times as '
  + 'often as a low one, and bearings whose measurements disagree now earn extra looks instead of a '
  + 'step sideways. '
  + 'And a new page: Skyline Align, linked from the Export card. Load a panorama and it '
  + 'cuts the sky out, wraps the rest onto a dome and draws the real stars, Sun, Moon and '
  + 'planets over it for your position and the moment. Two sliders turn the picture until '
  + 'it matches the sky; the azimuth offset you land on is the survey bearing error the '
  + 'magnetometer could not give you.';

/** One line for the header, the log and the archives. */
export function versionLabel() {
  return `v${VERSION} (${BUILD_DATE})`;
}
