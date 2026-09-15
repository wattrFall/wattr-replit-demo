/**
 * When acting on the advisory pays off.
 *
 * The constraint minutes an advisory avoids depend on when it is taken: early
 * in the ramp nothing is near its limit yet, and late in the ramp the limit has
 * already been reached. This replays the scenario at regular instants and
 * reports what acting at each one would avoid, so the decision page can show
 * the benefit over time rather than only at the current replay instant.
 */
import {
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  replayCockpitSnapshot,
  type FacilityModelConfig,
} from "./simulation";

export interface AdvisoryTimingPoint {
  /** Seconds into the scenario at which the advisory is taken. */
  elapsedS: number;
  /** Modeled constraint minutes the advisory avoids when taken then. */
  minutesAvoided: number;
  /** Modeled reduction of the forecast peak, °C. */
  reductionC: number;
}

export interface AdvisoryTiming {
  points: AdvisoryTimingPoint[];
  /** The instant where acting avoids the most; the earliest if several tie. */
  best: AdvisoryTimingPoint;
  /** The last instant at which acting still avoids anything, or null if none does. */
  lastUsefulS: number | null;
}

/** Five-minute steps: seven replays, fast enough to compute when the page opens. */
export const ADVISORY_TIMING_STEP_S = 300;

const cache = new WeakMap<FacilityModelConfig, Map<number, AdvisoryTiming>>();

export function advisoryTiming(config: FacilityModelConfig, stepS = ADVISORY_TIMING_STEP_S): AdvisoryTiming {
  const byStep = cache.get(config) ?? new Map<number, AdvisoryTiming>();
  cache.set(config, byStep);
  const cached = byStep.get(stepS);
  if (cached) return cached;

  const points: AdvisoryTimingPoint[] = [];
  for (let elapsedS = 0; elapsedS <= SCENARIO_DURATION_S; elapsedS += stepS) {
    const { recommendation } = replayCockpitSnapshot(SCENARIO_START_S + elapsedS, config);
    points.push({ elapsedS, minutesAvoided: recommendation.constraintMinutesAvoided, reductionC: recommendation.reductionC });
  }
  const best = points.reduce((leader, point) => point.minutesAvoided > leader.minutesAvoided ? point : leader);
  const useful = points.filter((point) => point.minutesAvoided > 0);
  const timing = { points, best, lastUsefulS: useful.length ? useful[useful.length - 1].elapsedS : null };
  byStep.set(stepS, timing);
  return timing;
}
