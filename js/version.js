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
export const VERSION = '0.24.0';
export const BUILD_DATE = '2026-08-25';

/**
 * Every device learns its own lens.
 * Kept short deliberately: it is read on a phone, in daylight, by someone who
 * wants to know whether to trust what they are holding.
 */
export const RELEASE_NOTE =
  'One hand-written table entry was the whole difference between a perfect 198-photograph panorama on the iPad and a black screen on the phone: the iPad was in the table, the phone was not, so the phone ran on a 66 degree fallback against a real 42. The app now remembers the lens each device actually has, learned from the bundle adjustment over an entire survey, so one good run makes a device correct for good. The phone is in the table as well, and the fallback for an unknown device is 45 rather than 66.';

/** One line for the header, the log and the archives. */
export function versionLabel() {
  return `v${VERSION} (${BUILD_DATE})`;
}
