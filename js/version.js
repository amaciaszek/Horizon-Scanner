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
export const VERSION = '0.20.0';
export const BUILD_DATE = '2026-08-21';

/**
 * Columns that finish, a dot that lets go, and straight lines that stay straight.
 * Kept short deliberately: it is read on a phone, in daylight, by someone who
 * wants to know whether to trust what they are holding.
 */
export const RELEASE_NOTE =
  'The serpentine is enforced: the target holds a bearing until its column of heights is filled, and gives up rather than pinning when a column cannot be reached. Lens distortion is corrected, and the panorama can be looked around as a dome.';

/** One line for the header, the log and the archives. */
export function versionLabel() {
  return `v${VERSION} (${BUILD_DATE})`;
}
