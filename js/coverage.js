'use strict';

import { wrap360, angDiff, clamp } from './math3d.js';

/**
 * What the camera has actually looked at, and how well.
 *
 * This is the physical truth layer of coverage-guided scanning, and it is
 * deliberately ignorant of the user interface. It answers one question — has
 * the region around this bearing received enough usable observation? — and
 * `js/guidance.js` turns that answer into somewhere to point. Keeping the two
 * apart means the scoring below can be retuned, or replaced outright, without
 * touching how the target behaves on screen.
 *
 * WHY THIS IS NOT THE SURVEY'S 720 BINS. `Survey` already keeps a bin per half
 * degree, but those record the measured skyline ALTITUDE and its agreement
 * across passes, they are filled only from accepted keyframes about nine
 * degrees apart, and a bin is only touched when a keyframe was admitted. That
 * is the right model for the product and the wrong one for guidance: what the
 * operator needs to be told is where the camera has dwelt with good data, which
 * includes every processed frame at roughly 10 Hz and must account for the
 * frames that were REFUSED. A sector the segmenter rejected forty times running
 * has plenty of survey observations of nothing, and zero coverage.
 *
 * THE SCORE IS A CONFIDENCE, NOT A COUNTER. Each observation moves a bin a
 * fraction of the way from where it is to fully covered:
 *
 *     score += (1 - score) * gain
 *
 * so repeated good looks raise confidence with diminishing returns, the value
 * can never exceed one, and a bin that is already solid is not made "more
 * solid" by staring at it. A poor observation contributes a small gain or none
 * at all; nothing ever REMOVES coverage. That last point is a deliberate
 * product decision rather than a modelling convenience — the operator will
 * wobble, reverse, overshoot and revisit, and a scanner that took coverage away
 * for it would be unusable.
 */

/**
 * Every knob, in one place, so the feel can be tuned without reading the code.
 * Angles in degrees, times in seconds unless a name says otherwise.
 */
export const COVERAGE_TUNING = {
  /** Angular resolution of the coverage map. 360 must divide by this. */
  binSizeDeg: 2,

  /** Confidence at which a bin counts as covered.
   *
   *  Raised from 0.75. The 2026-08-18 capture finished with a mean score of
   *  0.938 and a weakest bin of 0.783 — everything technically over the line,
   *  and yet the far side of the roof was never visited. A bar that the whole
   *  ring clears while obvious work remains is set too low. This survey is data
   *  constrained: extra frames cost seconds, missing ones cost a return trip. */
  coverageThreshold: 0.88,
  /** Independent observations a bin needs regardless of how good they were.
   *  Stops one lucky frame from declaring a sector done, and raised for the same
   *  reason as the threshold — more looks per bearing is the cheap direction to
   *  be wrong in. */
  minObservations: 8,

  /** How fast confidence accumulates, per second of ideal-quality viewing at
   *  the centre of frame. 2.0 puts a bin near 0.9 after about 1.5 s. */
  gainPerSecond: 2.0,
  /** Longest gap between frames that may be credited as continuous viewing.
   *  Without this, a stall in the pipeline would deposit a huge lump of
   *  confidence for a moment nobody was actually looking. */
  maxFrameGapSec: 0.25,

  /** Fraction of the horizontal field of view that earns credit. The outer
   *  edges are where lens distortion is worst and where the skyline is least
   *  reliably traced, so they are not treated as "looked at". */
  usableFovFraction: 0.8,
  /** Credit at the edge of the usable field, relative to the centre. */
  edgeWeight: 0.35,

  /* ---- quality ramps. Each is 1.0 across the whole normal operating range
     and falls off only when something is genuinely wrong, so that ordinary
     scanning is never quietly penalised. ---- */

  /** Turn rate that still earns full credit, and the rate at which an
   *  observation is worth nothing. */
  comfortableRateDegPerSec: 25,
  maxRateDegPerSec: 70,

  /** Elevation the camera may sit at before coverage stops counting. The
   *  survey is of the horizon; a frame pointed at the zenith has not observed
   *  the skyline whatever else it did. */
  comfortableElevationDeg: 25,
  maxElevationDeg: 55,

  /** Roll is carried through the projection and is not an error, but a heavily
   *  rolled frame samples a different band of sky and traces a worse skyline. */
  comfortableRollDeg: 12,
  maxRollDeg: 40,

  /** Change in turn rate between frames, as a proxy for erratic motion. */
  comfortableJerkDegPerSec2: 60,
  maxJerkDegPerSec2: 260,

  /** Orientation-stream scatter, in degrees. */
  comfortableJitterDeg: 0.6,
  maxJitterDeg: 2.5,

  /** Mean segmentation confidence along the traced skyline. Below the floor the
   *  boundary is not trustworthy enough to call the sector observed. */
  minSkylineConfidence: 0.30,
  goodSkylineConfidence: 0.55,

  /**
   * Frame-to-frame registration quality, where the pipeline reports it.
   *
   * RECALIBRATED 2026-08-20 AGAINST WHAT THE SENSOR ACTUALLY REPORTS.
   *
   * These were 0.20 and 0.45, which assumed a well-registered frame scores
   * around 0.45. It does not. `visualQuality` comes out of the NCC tracker as
   * `((peak - 0.45) / 0.5) * clamp(sharpness * 12, 0.25, 1)`, and on the things
   * this app photographs — foliage, clapboard, shingles, fence palings — the
   * second-best correlation peak is nearly as good as the best, so the
   * sharpness term holds even a perfectly tracked frame down near 0.25.
   *
   * Measured over 142 keyframes from two real captures (2026-08-19 and
   * 2026-08-20), the distribution is: p05 0.111, p10 0.151, median 0.247,
   * p90 0.530. Against the old ramp the MEDIAN frame earned 0.19 of its
   * possible credit and one frame in five earned exactly nothing.
   *
   * The consequence was total. Coverage is a product of seven ramps, so a
   * median factor of 0.19 multiplied through everything: the 2026-08-20 capture
   * ran for 224 seconds, held every other ramp at 1.0, and finished with a mean
   * bin score of 0.005 and ZERO of its 180 bins covered. The guidance dot had
   * nothing to advance on, which is exactly the "dot lagged and would not move
   * when I was on it" the operator reported. The map was blind, not slow.
   *
   * 0.08 and 0.28 put the median frame at 0.84 and zero only the worst 4%. The
   * discrimination that matters is kept: the frames over the nearby house and
   * umbrella score 0.036 and 0.043 and still earn nothing, which is correct,
   * because near-field parallax is precisely what the tracker is failing on
   * there. This ramp's job is to reject tracking failures, not to grade good
   * frames against each other.
   */
  minVisualQuality: 0.08,
  goodVisualQuality: 0.28,

  /** Blown-highlight fraction. Panning into a low sun collapses the exposure
   *  and the traced skyline with it. */
  maxGlareFraction: 0.04,

  /**
   * Fraction of the circle allowed to remain uncovered at completion.
   *
   * Zero. Every bin must be covered before the map calls itself complete.
   *
   * It was 0.015 — about five degrees, two bins — and on the 2026-08-18 capture
   * that was enough to end the survey with the far side and the centre of the
   * roof never visited, and several trees never returned to. Worse, a "complete"
   * map makes `ScanGuidance` drop its bearing, so the dot vanished while the
   * director still had cleanup targets: the tolerance did not just permit gaps,
   * it withdrew the one thing that would have closed them.
   *
   * Zero is safe here only because the operator is never trapped by it. The
   * primary button is enabled on travel alone past 300 degrees, so the lap can
   * always be closed by hand; this figure now decides when the app STOPS ASKING,
   * and the answer to that is: not until it has everything.
   */
  completionTolerance: 0,

  /* ---- elevation ---------------------------------------------------------
   * A sector is not surveyed just because the camera looked at its horizon. If
   * the obstruction runs off the top of the frame, the thing being measured —
   * how high it stands — is precisely what was not seen. The 2026-08-17 capture
   * refused 84 frames for exactly that and the guidance never once asked the
   * operator to tilt up, which is why the finished panorama has a hole above
   * the house.
   */

  /** Fraction of skyline columns running off the top edge before the sector is
   *  treated as needing a higher look. Deliberately far below the 0.22 that
   *  makes the whole frame unusable: a sector can be credited as covered while
   *  a tenth of the obstruction is still above the frame, and that tenth is the
   *  part the survey exists to measure. */
  clippedFractionForLift: 0.02,

  /** How much of the frame width has to have found a skyline before its highest
   *  point is trusted as the top of the obstruction. A handful of columns can
   *  catch a branch against the sky and say nothing about the roof behind it. */
  minMeasuredFractionForTop: 0.15,

  /** Where in the frame the top of an obstruction should sit once found, as a
   *  fraction of the vertical field below the top edge. Asking for it dead
   *  centre would throw the horizon out of the bottom of the picture. */
  liftHeadroomFraction: 0.35,

  /**
   * The highest tilt this will ever ask for.
   *
   * Was 32, for a reason that turned out to be a different bug. The 21:00
   * capture on 2026-08-17 was driven to 61.6 degrees and its solve FAILED its
   * sanity gate — 1.57 degrees of tilt correction against a 1.0 limit — so the
   * panorama fell back to raw sensor poses. The ceiling was dropped to 32 to
   * stop that happening again.
   *
   * But the gate was the fault, not the tilt. It tested the MAXIMUM tilt
   * correction over every frame, so a handful of weakly-constrained frames —
   * typically the last few of a lap, where a frame has fewest neighbours —
   * discarded the corrections of all the others. It now clamps those frames
   * individually and judges the solution on its median, so a steep capture is
   * no longer rejected wholesale. See `js/panorama-optimize.js`.
   *
   * With that repaired the ceiling can go back up. 60 is deliberately
   * aggressive — it is above the 2026-08-17 runaway's own peak — and it is
   * chosen because a tall near roof simply cannot be topped from close range at
   * anything less. It still sits below the 65-degree point where visual yaw is
   * abandoned, the 70-degree warning, and the 78-degree hard reject, which mark
   * where azimuth and roll genuinely stop being separable near the zenith.
   * Those three limits are real and are not being touched.
   *
   * What makes 60 safe now is not optimism about the solver, it is that the
   * descent is guided (see `restElevationAt`). The old failure was not the
   * height itself; it was arriving at height and being left there.
   */
  maxRequestedElevationDeg: 60
};

/** Frame states that mean the camera did not usefully observe anything. */
const DISQUALIFYING_FRAME_STATUS = new Set([
  'tooHigh', 'parallax', 'trackingLost', 'tooDark', 'noSky', 'allSky', 'clippedTop'
]);

/**
 * A falling ramp: 1 at or below `good`, 0 at or above `bad`, smooth between.
 * Smoothstep rather than linear so quality does not visibly step as the
 * operator drifts across a threshold.
 */
function fallingRamp(value, good, bad) {
  if (!Number.isFinite(value)) return 1;          // unmeasured is not evidence of harm
  const v = Math.abs(value);
  if (v <= good) return 1;
  if (v >= bad) return 0;
  const t = (v - good) / (bad - good);
  return 1 - t * t * (3 - 2 * t);
}

/** A rising ramp: 0 at or below `bad`, 1 at or above `good`. */
function risingRamp(value, bad, good) {
  if (!Number.isFinite(value)) return 1;
  if (value <= bad) return 0;
  if (value >= good) return 1;
  const t = (value - bad) / (good - bad);
  return t * t * (3 - 2 * t);
}

export class CoverageMap {
  constructor(tuning = {}) {
    this.tuning = { ...COVERAGE_TUNING, ...tuning };
    this.binCount = Math.max(8, Math.round(360 / this.tuning.binSizeDeg));
    this.binSizeDeg = 360 / this.binCount;
    this.reset();
  }

  /**
   * Clear the map for a new lap.
   *
   * `keepWorld` preserves everything that describes the SCENE rather than the
   * lap: how tall the obstruction at each bearing is, how high the camera must
   * be raised to frame it, and whether that has been achieved. Those are facts
   * about a house and some trees; they do not stop being true because a second
   * lap has begun.
   *
   * They used to be wiped. `finishPass1` called a bare reset(), so pass 2 began
   * knowing nothing about height, could not ask for any lift, and the roof was
   * simply never revisited — on the 2026-08-18 20:06 capture the exported map
   * shows binsNeedingLift 0 and highestRequestedElevationDeg 0 for a lap taken
   * in front of a house whose measured skyline reaches 67 degrees. That is the
   * regression behind "before we did the two-pass thing we got the roof every
   * time".
   *
   * Coverage confidence is NOT preserved, and should not be: verification is
   * the whole point of a second lap, and a bin that carried its pass-1 score
   * into pass 2 would be counted as verified without a second look.
   */
  reset({ keepWorld = false } = {}) {
    const world = keepWorld && this.obstructionTop ? {
      obstructionTop: this.obstructionTop.slice(),
      measuredTop: this.measuredTop.slice(),
      topSeen: this.topSeen.slice(),
      requiredElevation: this.requiredElevation.slice(),
      satisfiedElevation: this.satisfiedElevation.slice(),
      beyondTilt: this.beyondTilt.slice()
    } : null;
    this.score = new Float32Array(this.binCount);
    this.observations = new Uint16Array(this.binCount);
    // Every bin the camera has pointed at, whether or not the frame was worth
    // anything. Kept apart from `observations`, which counts only frames that
    // earned credit, because guidance needs to tell "swept past and got
    // nothing" apart from "not reached yet" and those are different facts.
    this.visits = new Uint16Array(this.binCount);
    this.bestQuality = new Float32Array(this.binCount);
    /* How high the camera must look here to see the top of what stands here,
     * and the highest unclipped look actually achieved. When the second falls
     * short of the first, the sector has a top nobody has measured. */
    this.requiredElevation = new Float32Array(this.binCount);
    this.satisfiedElevation = new Float32Array(this.binCount);
    this.satisfiedElevation.fill(-Infinity);
    /** The top of the obstruction as actually TRACED, where a frame has managed
     *  to contain it. Unlike `obstructionTop` this is a measurement, not a
     *  bound, and it is what the lift request is computed from. */
    this.measuredTop = new Float32Array(this.binCount);
    /**
     * Has the top here been CAPTURED — seen with clear space beneath the frame's
     * top edge, not merely glimpsed at the boundary?
     *
     * This is a flag and not an elevation on purpose. The previous attempt
     * compared `satisfiedElevation` (an obstruction-top elevation, once it was
     * measured properly) against `requiredElevation` (a CAMERA-pointing
     * elevation), which are different quantities in the same units. The top is
     * always higher than the aim that frames it, so the test passed everywhere
     * and `needsLift` was false on all 180 bins of both 2026-08-19 captures
     * despite tops reaching 73 and 79 degrees. Framing is a yes-or-no fact;
     * store it as one.
     */
    this.topSeen = new Uint8Array(this.binCount);
    /** Lower bound on how high the obstruction here actually reaches, from the
     *  top edge of any frame it overflowed. A fact about the world, so it only
     *  ever refines upward and never follows the camera. */
    this.obstructionTop = new Float32Array(this.binCount);
    /** Taller than tilting can reach. Recorded, not repaired. */
    this.beyondTilt = new Uint8Array(this.binCount);
    this.lastYawRate = null;
    this.lastObservedAt = null;
    this.totalObservations = 0;
    this.rejectedObservations = 0;
    /* Bumped every time a bin crosses into "covered". Guidance uses it as the
     * single permission to re-pick its target: if no ground became covered,
     * nothing about the map changed that could justify moving the dot, however
     * far the phone turned. This is the mechanism that makes "the dot advances
     * because the horizon got covered" true rather than merely intended. */
    this.generation = 0;

    // Put the scene back, if the caller is starting a lap rather than a survey.
    if (world) {
      this.obstructionTop.set(world.obstructionTop);
      this.measuredTop.set(world.measuredTop);
      this.topSeen.set(world.topSeen);
      this.requiredElevation.set(world.requiredElevation);
      this.satisfiedElevation.set(world.satisfiedElevation);
      this.beyondTilt.set(world.beyondTilt);
    }
  }

  /**
   * Knock the confidence out of specific bearings, keeping the rest.
   *
   * The alternative — and what used to happen at the end of a lap — is to wipe
   * the whole map so the next pass "earns its own" coverage. That is the right
   * instinct for VERIFICATION and the wrong mechanism for GUIDANCE, and the two
   * were sharing one array.
   *
   * Measured on the 2026-08-21 capture: pass 1 finished at 3m43s having covered
   * the ring, the map was wiped, and the operator then worked for another six
   * minutes against a guidance dot that believed nothing had ever been
   * surveyed. The exported map shows 24 observations total, all of them in a
   * 34-degree arc around where they happened to be standing when they gave up.
   * The operator's report — "the dot got very stuck, and I had to cover places
   * it wasn't telling me to" — is exactly what a blank map feels like.
   *
   * Verification lives in the survey's own 720 bins and always did. This map
   * exists to tell someone where to point, so it keeps what it knows and forgets
   * only the sectors that actually need re-walking.
   */
  demote(bearings = [], { to = 0.0 } = {}) {
    let touched = 0;
    for (const entry of bearings) {
      const from = Number(entry?.fromDeg ?? entry);
      const width = Number(entry?.widthDeg ?? this.binSizeDeg);
      if (!Number.isFinite(from)) continue;
      const steps = Math.max(1, Math.ceil(width / this.binSizeDeg));
      for (let k = 0; k < steps; k++) {
        const index = this.indexOf(from + k * this.binSizeDeg);
        if (this.score[index] > to) {
          this.score[index] = to;
          this.observations[index] = 0;
          touched++;
        }
      }
    }
    if (touched) this.generation++;
    return touched;
  }

  /** Bin index containing a bearing. */
  indexOf(headingDeg) {
    return Math.floor(wrap360(headingDeg) / this.binSizeDeg) % this.binCount;
  }

  /** Centre bearing of a bin. */
  bearingOf(index) {
    return wrap360((index + 0.5) * this.binSizeDeg);
  }

  /**
   * How good was this instant, as a single 0..1 number?
   *
   * Split into hard gates and soft ramps on purpose. The gates are conditions
   * under which the frame did not observe the horizon at all — there is no
   * partial credit for a photograph of the inside of a pocket. The ramps are
   * conditions that degrade an observation that did happen, and they multiply,
   * so several mediocre factors compound the way they do in reality. Every ramp
   * sits at exactly 1.0 through the normal operating range, which is what stops
   * the product of eight of them from quietly punishing a good scan.
   */
  observationQuality(sample) {
    const t = this.tuning;
    if (sample.trackingLost) return 0;
    if (sample.frameStatus && DISQUALIFYING_FRAME_STATUS.has(sample.frameStatus)) return 0;
    if (Number.isFinite(sample.skylineConfidence)
      && sample.skylineConfidence < t.minSkylineConfidence) return 0;
    if (Number.isFinite(sample.glareFraction)
      && sample.glareFraction > t.maxGlareFraction) return 0;

    // Erratic motion, measured as change in turn rate since the last frame.
    let jerk = null;
    if (Number.isFinite(sample.yawRateDegPerSec) && Number.isFinite(this.lastYawRate)
      && Number.isFinite(sample.dtSec) && sample.dtSec > 1e-3) {
      jerk = Math.abs(sample.yawRateDegPerSec - this.lastYawRate) / sample.dtSec;
    }

    /*
     * Elevation is judged against what THIS BEARING needs, not against zero.
     *
     * The ramp exists because a frame pointed at the sky has not observed a
     * skyline. But once the map has asked the operator to raise the camera for
     * a tall sector, the raised frame is precisely the observation that was
     * wanted — and scoring it against a flat horizon meant the two mechanisms
     * fought. On 2026-08-17 that fight was unwinnable: the dot demanded more
     * tilt, the tilt drove quality toward zero, the sector never filled, and so
     * the dot demanded more tilt. Half that session was spent above 32 degrees
     * earning frame qualities of 0.03.
     */
    const wanted = Number.isFinite(sample.requiredElevationDeg) ? sample.requiredElevationDeg : 0;
    const elevationError = Number.isFinite(sample.elevationDeg)
      ? sample.elevationDeg - wanted : null;

    const factors = [
      fallingRamp(sample.yawRateDegPerSec, t.comfortableRateDegPerSec, t.maxRateDegPerSec),
      fallingRamp(elevationError, t.comfortableElevationDeg, t.maxElevationDeg),
      fallingRamp(sample.rollDeg, t.comfortableRollDeg, t.maxRollDeg),
      fallingRamp(jerk, t.comfortableJerkDegPerSec2, t.maxJerkDegPerSec2),
      fallingRamp(sample.jitterDeg, t.comfortableJitterDeg, t.maxJitterDeg),
      risingRamp(sample.skylineConfidence, t.minSkylineConfidence, t.goodSkylineConfidence),
      risingRamp(sample.visualQuality, t.minVisualQuality, t.goodVisualQuality)
    ];
    let quality = 1;
    for (const f of factors) quality *= f;
    return clamp(quality, 0, 1);
  }

  /**
   * Credit one processed frame to every bin it could see.
   *
   * Crediting only the bin under the optical axis would be wrong twice over: it
   * would under-report a sweep (a 45-degree field genuinely observes 45 degrees
   * of horizon at once) and it would make coverage depend on frame rate rather
   * than on where the camera pointed. Credit is therefore spread across the
   * usable field with a raised-cosine falloff, so the centre — where the lens
   * is best behaved and the skyline best traced — is worth roughly three times
   * the edge.
   *
   * Returns what it did, which is what the capture audit and the guidance layer
   * want to know.
   */
  observe(sample = {}) {
    const t = this.tuning;
    const heading = Number(sample.headingDeg);
    if (!Number.isFinite(heading)) return { credited: false, reason: 'no-heading', quality: 0 };
    const elevationDeg = Number(sample.elevationDeg);
    const vfovDeg = Number(sample.vfovDeg);
    const clippedFraction = Number(sample.clippedFraction) || 0;

    const dtSec = Number.isFinite(sample.dtSec)
      ? clamp(sample.dtSec, 0, t.maxFrameGapSec)
      : t.maxFrameGapSec * 0.5;

    // What this bearing has already been shown to need, so the quality ramp can
    // judge the frame against the right target rather than against the horizon.
    const requiredElevationDeg = this.requiredElevation[this.indexOf(heading)];
    const quality = this.observationQuality({ ...sample, dtSec, requiredElevationDeg });
    if (Number.isFinite(sample.yawRateDegPerSec)) this.lastYawRate = sample.yawRateDegPerSec;

    const hfov = Number.isFinite(sample.hfovDeg) && sample.hfovDeg > 1 ? sample.hfovDeg : 45;
    const halfSpan = hfov * t.usableFovFraction / 2;
    const first = Math.floor((heading - halfSpan) / this.binSizeDeg);
    const last = Math.ceil((heading + halfSpan) / this.binSizeDeg);

    let touched = 0;
    for (let raw = first; raw <= last; raw++) {
      const centre = (raw + 0.5) * this.binSizeDeg;
      const offset = Math.abs(angDiff(centre, heading));
      if (offset > halfSpan) continue;
      const index = ((raw % this.binCount) + this.binCount) % this.binCount;

      // The camera pointed here. Recorded even for a worthless frame, because
      // "swept through and got nothing" is precisely the state the guidance dot
      // has to recognise in order to wait for the operator.
      if (this.visits[index] < 65535) this.visits[index]++;

      /*
       * Elevation bookkeeping, done for EVERY frame including the rejected
       * ones. A frame refused for clipping is the single most informative
       * frame about this sector: it is the app saying "there is more above
       * here than I can see". Skipping it because its quality was zero is how
       * the information got thrown away.
       */
      if (Number.isFinite(elevationDeg) && Number.isFinite(vfovDeg) && vfovDeg > 1) {
        /*
         * A DIRECT measurement of the obstruction's top, when the frame has one.
         *
         * This is the stronger of the two pieces of evidence available and it
         * used to be discarded. A clipped frame yields only a bound — "the top
         * is somewhere above this edge" — which is why `obstructionTop` sits a
         * median 9.3 degrees below the truth on real captures. A frame that
         * traced the top yields the answer outright.
         *
         * Recording it matters most for the thing it replaces. Satisfaction was
         * `satisfiedElevation = elevationDeg`: point the camera high enough and
         * the sector is marked done, whether or not the roofline was in the
         * picture. Aiming OVER a roof into clear sky satisfied it fastest of
         * all, because nothing clipped. Now a sector is satisfied only when the
         * top has been seen with room to spare beneath the frame's top edge.
         */
        const measured = Number(sample.skylineTopDeg);
        const measuredFraction = Number(sample.skylineMeasuredFraction) || 0;
        const frameTop = elevationDeg + vfovDeg / 2;
        if (Number.isFinite(measured) && measuredFraction >= t.minMeasuredFractionForTop
            && clippedFraction <= t.clippedFractionForLift) {
          if (measured > this.measuredTop[index]) this.measuredTop[index] = measured;
          // Framed with headroom, so a top sitting on the very edge does not
          // count. This is the test the old code should have been making.
          const headroom = vfovDeg * t.liftHeadroomFraction;
          if (measured <= frameTop - headroom * 0.5 && quality > 0) {
            this.topSeen[index] = 1;
            // Kept as the camera elevation that achieved it, which is what the
            // archive wants to show and what a later lap can aim to repeat.
            if (elevationDeg > this.satisfiedElevation[index]) {
              this.satisfiedElevation[index] = elevationDeg;
            }
          }
        }

        if (clippedFraction > t.clippedFractionForLift) {
          /*
           * Anchor the requirement to the SCENE, never to the camera.
           *
           * The first version of this asked for `elevation + vfov * 0.4`, which
           * is defined relative to where the camera happens to be — so obeying
           * it moved the reference, and the next clipped frame asked for more
           * again. It ratcheted the operator to 61.6 degrees on 2026-08-17 and
           * wrecked the panorama on the way.
           *
           * What a clipped frame actually tells you is a fact about the world:
           * the skyline here rises above this frame's top edge. That bound is a
           * property of the obstruction, it only ever gets refined upward, and
           * the tilt needed to see it follows from it rather than from the
           * operator's current pose.
           */
          const topEdge = elevationDeg + vfovDeg / 2;
          if (topEdge > this.obstructionTop[index]) this.obstructionTop[index] = topEdge;
          // Prefer the measured top where one exists; fall back to the bound.
          const best = Math.max(this.obstructionTop[index], this.measuredTop[index]);
          const wanted = best - vfovDeg * t.liftHeadroomFraction;
          this.requiredElevation[index] = Math.min(t.maxRequestedElevationDeg, Math.max(0, wanted));
          if (wanted > t.maxRequestedElevationDeg) this.beyondTilt[index] = 1;
        }
      }

      if (quality <= 0) continue;

      // Raised cosine from 1 at the axis to `edgeWeight` at the usable edge.
      const u = offset / halfSpan;
      const weight = t.edgeWeight + (1 - t.edgeWeight) * (0.5 * (1 + Math.cos(Math.PI * u)));
      const gain = quality * weight * dtSec * t.gainPerSecond;
      const wasCovered = this.isCovered(index);
      // Asymptotic approach: repeated good looks help, with diminishing returns,
      // and the score cannot run past 1.
      this.score[index] += (1 - this.score[index]) * clamp(gain, 0, 1);
      if (this.observations[index] < 65535) this.observations[index]++;
      if (!wasCovered && this.isCovered(index)) this.generation++;
      if (quality * weight > this.bestQuality[index]) this.bestQuality[index] = quality * weight;
      touched++;
    }

    if (quality <= 0) {
      this.rejectedObservations++;
      return { credited: false, reason: 'quality-zero', quality: 0 };
    }
    this.totalObservations++;
    this.lastObservedAt = sample.atMs ?? null;
    return { credited: touched > 0, quality, bins: touched, dtSec };
  }

  /** Confidence 0..1 for a bin index. */
  scoreOf(index) {
    return this.score[((index % this.binCount) + this.binCount) % this.binCount];
  }

  /** Confidence 0..1 at a bearing. */
  scoreAt(headingDeg) {
    return this.score[this.indexOf(headingDeg)];
  }

  /**
   * Is this bin done? Both tests matter: the score says the looking was good,
   * the observation count says there was enough of it. A single very good frame
   * can drive the score high, and one frame is not a scan.
   */
  isCovered(index) {
    const i = ((index % this.binCount) + this.binCount) % this.binCount;
    return this.score[i] >= this.tuning.coverageThreshold
      && this.observations[i] >= this.tuning.minObservations;
  }

  coveredAt(headingDeg) {
    return this.isCovered(this.indexOf(headingDeg));
  }

  /**
   * How high the camera should look here, or 0 where the horizon is enough.
   * This is what the guidance dot rides on vertically.
   */
  requiredElevationAt(headingDeg) {
    return this.requiredElevation[this.indexOf(headingDeg)];
  }

  /**
   * The elevation the camera should be HOLDING over this sector — the height at
   * which its skyline is actually framed.
   *
   * The dot needs this to bring the operator back down. Coming off a tall roof
   * at 60 degrees and turning into open garden, every frame is sky, nothing
   * earns coverage credit, and without a target to descend to the dot simply
   * rides along at 60 waiting for a sector that can never fill. Guiding the way
   * up and not the way down is what made the operator feel stuck at the edge of
   * the house.
   *
   * Where something stands, that is the lift this sector needed. Where nothing
   * does, it is the horizon.
   */
  restElevationAt(headingDeg) {
    return Math.max(0, this.requiredElevation[this.indexOf(headingDeg)] || 0);
  }

  /**
   * Has anything been seen standing above this sector that nobody has measured
   * the top of?
   *
   * A sector can be fully "covered" in the horizontal sense and still fail
   * this: the camera looked, the skyline was traced, and the top of the
   * obstruction was above the frame the whole time. That is the state that put
   * a black hole above the house in the 2026-08-17 panorama.
   */
  needsLift(index) {
    const i = ((index % this.binCount) + this.binCount) % this.binCount;
    // Past the tilt ceiling there is nothing more to ask of a turning camera,
    // so the sector stops blocking completion rather than holding the operator
    // hostage to an errand that cannot be run. It is recorded, not repaired:
    // `beyondTilt` is reported so the summary can say this sector's obstruction
    // was never fully seen.
    if (this.beyondTilt[i]) return false;
    const required = this.requiredElevation[i];
    if (!(required > 0)) return false;
    // One question: has the top been framed with room beneath the edge? Not
    // "was the camera once pointed high enough", which is what this used to ask
    // and which empty sky answered.
    return !this.topSeen[i];
  }

  /** Too tall to bring into frame by tilting, even at the 50-degree ceiling.
   *  Reported so the summary can say so rather than the guidance repeating an
   *  instruction the operator cannot carry out. */
  beyondTiltAt(headingDeg) {
    return this.beyondTilt[this.indexOf(headingDeg)] === 1;
  }

  needsLiftAt(headingDeg) {
    return this.needsLift(this.indexOf(headingDeg));
  }

  /** Covered horizontally AND nothing left unmeasured above it. */
  isComplete(index) {
    return this.isCovered(index) && !this.needsLift(index);
  }

  completeAt(headingDeg) {
    return this.isComplete(this.indexOf(headingDeg));
  }

  /**
   * Has the camera ever looked here at all, however badly?
   *
   * The distinction between "visited but not covered" and "never visited"
   * matters to guidance and nowhere else. Ground the operator swept through
   * without capturing anything usable is ground to send them back over; ground
   * they have simply not reached yet is not. Without this the dot would open
   * every scan by pointing backwards, because at the start nothing is covered
   * and everything therefore looks like it was missed.
   */
  visited(index) {
    return this.visits[((index % this.binCount) + this.binCount) % this.binCount] > 0;
  }

  visitedAt(headingDeg) {
    return this.visited(this.indexOf(headingDeg));
  }

  /** Overall state of the scan. */
  completeness() {
    let covered = 0, sum = 0, weakest = 0, weakestIndex = 0;
    let lifts = 0, highestRequest = 0;
    let lowest = Infinity;
    for (let i = 0; i < this.binCount; i++) {
      // Reported over every bin, not only outstanding ones. Gating it on
      // needsLift made the archive say "highest requested elevation 0" for a
      // capture that had asked for 55.7 degrees and got it, which reads as the
      // feature never having run.
      if (this.requiredElevation[i] > highestRequest) highestRequest = this.requiredElevation[i];
      if (this.needsLift(i)) lifts++;
      if (this.isComplete(i)) covered++;
      sum += this.score[i];
      if (this.score[i] < lowest) { lowest = this.score[i]; weakestIndex = i; }
    }
    weakest = Number.isFinite(lowest) ? lowest : 0;
    const fraction = covered / this.binCount;
    return {
      binCount: this.binCount,
      coveredBins: covered,
      /* Sectors whose horizon is covered but whose top is still above every
       * frame taken there. Reported separately because the operator's remedy is
       * different: tilt up, do not turn. */
      binsNeedingLift: lifts,
      highestRequestedElevationDeg: Number(highestRequest.toFixed(1)),
      fraction,
      meanScore: sum / this.binCount,
      weakestScore: weakest,
      weakestBearingDeg: this.bearingOf(weakestIndex),
      // A tiny sliver missed at a seam should not hold a survey hostage.
      complete: (1 - fraction) <= this.tuning.completionTolerance,
      remainingDeg: (this.binCount - covered) * this.binSizeDeg
    };
  }

  /**
   * Contiguous runs of not-yet-covered bins, largest first. Used by the
   * guidance layer to choose somewhere to send the operator, and by the report
   * to say what is left.
   */
  gaps() {
    // Find a covered bin to start from, so a run that straddles north is walked
    // as one piece rather than clipped into two at the array boundary.
    let anchor = -1;
    for (let i = 0; i < this.binCount; i++) {
      if (this.isCovered(i)) { anchor = i; break; }
    }
    if (anchor < 0) {
      // Nothing covered at all: the gap is the whole circle.
      return [this._run(0, this.binCount)];
    }
    const runs = [];
    let start = -1;
    for (let k = 1; k <= this.binCount; k++) {
      const i = (anchor + k) % this.binCount;
      const covered = this.isCovered(i);
      if (!covered && start < 0) start = anchor + k;
      else if (covered && start >= 0) { runs.push(this._run(start, anchor + k)); start = -1; }
    }
    if (start >= 0) runs.push(this._run(start, anchor + this.binCount + 1));
    runs.sort((a, b) => b.widthDeg - a.widthDeg);
    return runs;
  }

  _run(startIndex, endIndex) {
    const widthBins = Math.min(this.binCount, endIndex - startIndex);
    const fromDeg = wrap360(startIndex * this.binSizeDeg);
    let worst = 1, worstIndex = startIndex;
    for (let i = startIndex; i < startIndex + widthBins; i++) {
      const s = this.scoreOf(i);
      if (s < worst) { worst = s; worstIndex = i; }
    }
    return {
      fromDeg,
      toDeg: wrap360(fromDeg + widthBins * this.binSizeDeg),
      widthDeg: widthBins * this.binSizeDeg,
      centreDeg: wrap360(fromDeg + widthBins * this.binSizeDeg / 2),
      weakestBearingDeg: this.bearingOf(worstIndex),
      weakestScore: worst
    };
  }

  /** Compact record for the debug archive and the acceptance report. */
  snapshot() {
    const summary = this.completeness();
    return {
      binSizeDeg: this.binSizeDeg,
      binCount: this.binCount,
      coverageThreshold: this.tuning.coverageThreshold,
      minObservations: this.tuning.minObservations,
      completionTolerance: this.tuning.completionTolerance,
      totalObservations: this.totalObservations,
      rejectedObservations: this.rejectedObservations,
      ...summary,
      gaps: this.gaps().slice(0, 12),
      score: Array.from(this.score, v => Number(v.toFixed(4))),
      observations: Array.from(this.observations),
      visits: Array.from(this.visits),

      /*
       * The elevation model, per bin, exported because it cannot be
       * reconstructed from anything else in the archive.
       *
       * The traced boundaries let an offline tool recover what the skyline
       * ACTUALLY was at every bearing. What they cannot show is what the app
       * BELIEVED at the time — which bins it thought still had an unmeasured
       * top, how high it asked the operator to tilt, and where it decided it was
       * satisfied. Diagnosing "the dot stopped climbing before the roof was
       * centred" needs the belief and the truth side by side; without these four
       * arrays only the truth is recoverable and the reasoning is invisible.
       */
      obstructionTop: Array.from(this.obstructionTop, v => Number(v.toFixed(2))),
      measuredTop: Array.from(this.measuredTop, v => Number(v.toFixed(2))),
      topSeen: Array.from(this.topSeen),
      requiredElevation: Array.from(this.requiredElevation, v => Number(v.toFixed(2))),
      satisfiedElevation: Array.from(this.satisfiedElevation, v => Number(v.toFixed(2))),
      beyondTilt: Array.from(this.beyondTilt),
      needsLift: Array.from({ length: this.binCount }, (_, i) => (this.needsLift(i) ? 1 : 0)),
      elevationTuning: {
        clippedFractionForLift: this.tuning.clippedFractionForLift,
        liftHeadroomFraction: this.tuning.liftHeadroomFraction,
        maxRequestedElevationDeg: this.tuning.maxRequestedElevationDeg
      }
    };
  }
}
