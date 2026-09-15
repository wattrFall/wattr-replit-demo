/**
 * The simulation run.
 *
 * A run is a fixed number of steps of the model, executed for BOTH control
 * modes from the same starting state, so the two columns on the results screen
 * are genuinely comparable rather than two separate sessions remembered side by
 * side.
 *
 * Deterministic by construction: same layout in, same numbers out. Nothing here
 * reads wall-clock time or randomness.
 */
import {
  SIM_DT_S,
  createSimState,
  readTelemetry,
  resolvePlant,
  stepSim,
  type Telemetry,
} from "./model";
import type { ControlMode, SandboxLayout } from "./types";

/**
 * Steps per run, in the Python env's units. The env truncates an episode at
 * 200 steps, and matching that keeps the two comparable.
 */
export const RUN_STEPS = 200;

/** The integrator advances SIM_DT_S * 6 env-steps per slice; invert for slices. */
const SLICES_PER_ENV_STEP = 1 / (SIM_DT_S * 6);

/** How many env steps between recorded samples. */
const SAMPLE_EVERY = 10;

/**
 * Steps discarded before the statistics start.
 *
 * Every run begins with the hall at the env's initial 30 degC, which is above a
 * default rack's 27 degC limit, so both modes spend their opening steps cooling
 * down from an alarm state. Counting those steps punished whichever controller
 * descends more gently — Wattr, which runs leaner fans on purpose — and made it
 * look less safe than the baseline when at steady state it is not.
 *
 * Both modes discard the same window, so the comparison stays fair. The samples
 * still cover the whole run, so the warm-up is visible if it is ever charted.
 */
const WARMUP_STEPS = 60;

export interface RunSample {
  step: number;
  pue: number | null;
  maxInletC: number | null;
  totalPowerKw: number;
  racksAtRisk: number;
}

export interface RunSummary {
  mode: ControlMode;
  samples: RunSample[];
  /** Time-averaged over the run, not a final-frame snapshot. */
  meanPue: number | null;
  meanTotalPowerKw: number;
  meanCoolingPowerKw: number;
  itPowerKw: number;
  /** kWh over the run, treating one env step as one minute of plant time. */
  coolingEnergyKwh: number;
  peakInletC: number | null;
  meanInletC: number | null;
  /** Steps where at least one rack sat at or above its own limit. */
  stepsOverLimit: number;
  /** The worst simultaneous count of racks over limit. */
  worstRacksAtRisk: number;
  rackCount: number;
  finalChilledWaterC: number | null;
  meanFan: number | null;
}

export interface RunResult {
  steps: number;
  /** Opening steps excluded from the statistics; see WARMUP_STEPS. */
  warmupSteps: number;
  scoredSteps: number;
  baseline: RunSummary;
  wattr: RunSummary;
}

/** One env step is treated as a minute of plant time when integrating energy. */
const MINUTES_PER_STEP = 1;

function runOne(layout: SandboxLayout, mode: ControlMode): RunSummary {
  let state = createSimState(layout);
  const samples: RunSample[] = [];

  let pueSum = 0;
  let pueCount = 0;
  let powerSum = 0;
  let coolingSum = 0;
  let inletSum = 0;
  let inletCount = 0;
  let peak = -Infinity;
  let stepsOverLimit = 0;
  let worstRacksAtRisk = 0;
  let last: Telemetry | null = null;

  let scored = 0;

  for (let step = 1; step <= RUN_STEPS; step++) {
    state = stepSim(state, layout, mode, SLICES_PER_ENV_STEP);
    const t = readTelemetry(state, layout, mode);
    last = t;

    if (step > WARMUP_STEPS) {
      scored++;
      const cooling = t.fanPowerKw + t.chillerPowerKw;
      powerSum += t.totalPowerKw;
      coolingSum += cooling;
      if (t.pue !== null) {
        pueSum += t.pue;
        pueCount++;
      }
      if (t.maxInletC !== null) {
        peak = Math.max(peak, t.maxInletC);
      }
      if (t.meanInletC !== null) {
        inletSum += t.meanInletC;
        inletCount++;
      }
      if (t.racksAtRisk > 0) stepsOverLimit++;
      worstRacksAtRisk = Math.max(worstRacksAtRisk, t.racksAtRisk);
    }

    if (step % SAMPLE_EVERY === 0 || step === 1) {
      samples.push({
        step,
        pue: t.pue,
        maxInletC: t.maxInletC,
        totalPowerKw: t.totalPowerKw,
        racksAtRisk: t.racksAtRisk,
      });
    }
  }

  const plant = resolvePlant(layout, mode);

  return {
    mode,
    samples,
    meanPue: pueCount > 0 ? pueSum / pueCount : null,
    meanTotalPowerKw: scored > 0 ? powerSum / scored : 0,
    meanCoolingPowerKw: scored > 0 ? coolingSum / scored : 0,
    itPowerKw: last?.itPowerKw ?? 0,
    coolingEnergyKwh:
      scored > 0 ? (coolingSum / scored) * (scored * MINUTES_PER_STEP) / 60 : 0,
    peakInletC: Number.isFinite(peak) ? peak : null,
    meanInletC: inletCount > 0 ? inletSum / inletCount : null,
    stepsOverLimit,
    worstRacksAtRisk,
    rackCount: last?.rackCount ?? 0,
    finalChilledWaterC: plant.chilledWaterC,
    meanFan: plant.controls.length
      ? plant.controls.reduce((sum, c) => sum + c.fan, 0) / plant.controls.length
      : null,
  };
}

/** Run both control modes over the same layout and step count. */
export function runEpisode(layout: SandboxLayout): RunResult {
  return {
    steps: RUN_STEPS,
    warmupSteps: WARMUP_STEPS,
    scoredSteps: RUN_STEPS - WARMUP_STEPS,
    baseline: runOne(layout, "baseline"),
    wattr: runOne(layout, "wattr"),
  };
}
