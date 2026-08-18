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
export const VERSION = '0.15.0';
export const BUILD_DATE = '2026-08-18';

/**
 * Coverage-guided scanning, and the field failure that shaped this release.
 * Kept short deliberately: it is read on a phone, in daylight, by someone who
 * wants to know whether to trust what they are holding.
 */
export const RELEASE_NOTE =
  'The skyline top is now MEASURED, not assumed from where you pointed, and '
  + 'what the first lap learned about height survives into the second. Pointing '
  + 'over a roof no longer counts as having seen it.';

/** One line for the header, the log and the archives. */
export function versionLabel() {
  return `v${VERSION} (${BUILD_DATE})`;
}
