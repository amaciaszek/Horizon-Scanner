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
export const VERSION = '0.25.0';
export const BUILD_DATE = '2026-09-02';

/**
 * The vertical half of the lens has to earn its place.
 * Kept short deliberately: it is read on a phone, in daylight, by someone who
 * wants to know whether to trust what they are holding.
 */
export const RELEASE_NOTE =
  'The lens is measured twice, sideways against the gyroscope and up-and-down against gravity, and on a square-pixel sensor the two must agree. When they did not the app said so in the log and then used the disagreeing vertical anyway: on the phone that recorded a vertical field 16 percent too tall, which scales every altitude, the column heights and the stitcher geometry with it. A contradicted vertical is now discarded and derived from the sideways measurement instead. Builds also report where their time went, by stage.';

/** One line for the header, the log and the archives. */
export function versionLabel() {
  return `v${VERSION} (${BUILD_DATE})`;
}
