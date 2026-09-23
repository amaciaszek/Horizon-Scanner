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
export const VERSION = '0.29.0';
export const BUILD_DATE = '2026-09-23';

/**
 * The stitcher stops doing work it throws away.
 * Kept short deliberately: it is read on a phone, in daylight, by someone who
 * wants to know whether to trust what they are holding.
 */
export const RELEASE_NOTE =
  'The seam finder was told every photograph covered the whole sky, so it compared all 57,000 possible pairs instead of the 5,000 that really overlap, on tiles that were mostly black padding. And every frame enlarged its seam mask to the full panorama before keeping a fortieth of it. Both are fixed: a 340-photograph build that had not finished its seam stage in twenty-two minutes now completes end to end in thirteen. The progress bar is rebuilt on measured stage weights, reports to three decimals so it visibly ticks, and carries a live estimate for the step and for the whole build.';

/** One line for the header, the log and the archives. */
export function versionLabel() {
  return `v${VERSION} (${BUILD_DATE})`;
}
