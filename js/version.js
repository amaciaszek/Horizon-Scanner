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
export const VERSION = '0.21.0';
export const BUILD_DATE = '2026-08-25';

/**
 * The dot leads again.
 * Kept short deliberately: it is read on a phone, in daylight, by someone who
 * wants to know whether to trust what they are holding.
 */
export const RELEASE_NOTE =
  'The guidance dot was a mirror of the phone, not an instruction: it sat on your own bearing at your own elevation and asked for nothing. It now names the exact band it wants filled and waits there while you go and get it. Columns no longer demand heights the app will never ask you to aim at. Frames are spent densely on unseen ground and sparsely on ground already done. And the survey says up front how long it will take, so you can stop the screen dimming first.';

/** One line for the header, the log and the archives. */
export function versionLabel() {
  return `v${VERSION} (${BUILD_DATE})`;
}
