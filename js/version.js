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
export const VERSION = '0.22.0';
export const BUILD_DATE = '2026-08-25';

/**
 * The dot travels instead of teleporting.
 * Kept short deliberately: it is read on a phone, in daylight, by someone who
 * wants to know whether to trust what they are holding.
 */
export const RELEASE_NOTE =
  'The dot led, but it lurched: it asked for the far end of each column, so from the top of the house it sent you straight to the horizon and back, eighteen times in one survey. It now asks for the nearest height still needed, in the direction you are already travelling, and it is speed limited so it always looks like it travelled there. Photographs taken while the camera is swinging are refused on both axes now, not just on turning, and the app no longer photographs the ground.';

/** One line for the header, the log and the archives. */
export function versionLabel() {
  return `v${VERSION} (${BUILD_DATE})`;
}
