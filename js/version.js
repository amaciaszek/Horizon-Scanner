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
export const VERSION = '0.23.0';
export const BUILD_DATE = '2026-08-25';

/**
 * The lens was a guess, and the guess ruined a survey.
 * Kept short deliberately: it is read on a phone, in daylight, by someone who
 * wants to know whether to trust what they are holding.
 */
export const RELEASE_NOTE =
  'A self-calibrated focal length was adopted after twelve samples and then never revised, so one early bad guess was locked in for the whole survey. On 2026-08-25 that guess was 66 degrees against a real 42, which spaced the photographs too far apart and made the stitcher search for features in the wrong place: 13 of 88 frames placed, a mostly black panorama. The lens is now only adopted once the estimate has converged, a better one may replace it mid-survey, and if the survey starts on a guess it says so before you walk. The serpentine step follows the lens too, so a narrow phone steps less far than a wide tablet.';

/** One line for the header, the log and the archives. */
export function versionLabel() {
  return `v${VERSION} (${BUILD_DATE})`;
}
