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
export const VERSION = '0.26.0';
export const BUILD_DATE = '2026-09-03';

/**
 * The dot waits for looks, not for glimpses.
 * Kept short deliberately: it is read on a phone, in daylight, by someone who
 * wants to know whether to trust what they are holding.
 */
export const RELEASE_NOTE =
  'A wide photograph credited every bearing it could see, and the count of independent looks was ticked by the very edge of the picture as hard as by the middle. So columns finished without anyone pointing at them: on the last capture, 83 of 180 were marked complete with zero photographs aimed at them, and the dot moved on regardless. A look now has to land near the middle of the frame to count. And at the end of a lap, when a few stragglers are left scattered round the ring, the dot turns round for the nearest one instead of walking most of a circle to reach the next in sweep order.';

/** One line for the header, the log and the archives. */
export function versionLabel() {
  return `v${VERSION} (${BUILD_DATE})`;
}
