import {
  SIM_DT_S,
  createSimState,
  readTelemetry,
  stepSim,
  type SimState,
  type Telemetry,
} from "@/lib/sandbox/model";
import type { SandboxItem, SandboxLayout } from "@/lib/sandbox/types";

export { SIM_DT_S };
export const SCENARIO_START_S = 1_752_676_800;
export const SCENARIO_DURATION_S = 1_800;
export const FORECAST_HORIZON_S = 300;
export const SCENARIO_RATED_CAPACITY_KW = 2_160;
export const COMMAND_ENVELOPE = { minFlowPercent: 60, maxFlowPercent: 85 } as const;
export const RECOMMENDATION_FLOW_PERCENT = 78;
export const RECOMMENDATION_DURATION_MINUTES = 20;
export const MODEL_DOMAIN_MAX_C = 35;
const RACK_IDS = ["A01", "A02", "B01", "B02"] as const;
const BASE_RACK_LOAD_KW = 500;
const BASE_UTILISATION_PCT = 82;
const RAMP_INCREASE = 0.25;
const RACK_LIMIT_C = 32;
const MAINTENANCE_LOCKOUT = false;

export type SimulationVariant = "baseline" | "advisory";
export type AdvisoryParameters = {
  flowPercent: number;
  durationMinutes: number;
};
export const DEFAULT_ADVISORY_PARAMETERS: AdvisoryParameters = {
  flowPercent: RECOMMENDATION_FLOW_PERCENT,
  durationMinutes: RECOMMENDATION_DURATION_MINUTES,
};
export type FacilityModelConfig = {
  scenario: "gpu-training-ramp-v1";
  seed: number;
  thermalMass: number;
  responseLag: number;
};
export const DEFAULT_FACILITY_MODEL: FacilityModelConfig = {
  scenario: "gpu-training-ramp-v1",
  seed: 4103,
  thermalMass: 0.82,
  responseLag: 12,
};

export interface CockpitRackSnapshot {
  id: string;
  inletC: number;
  limitC: number;
  heatKw: number;
  atRisk: boolean;
}

export interface ForecastSnapshot {
  horizonS: number;
  baselinePeakC: number;
  advisoryPeakC: number;
  baselineConstraintMinutes: number;
  advisoryConstraintMinutes: number;
  risk: "clear" | "watch" | "critical";
  thresholdC: number;
  confidence: number;
  series: ForecastSeriesPoint[];
}

export interface ForecastSeriesPoint {
  simulatedAt: number;
  offsetS: number;
  actualPeakC: number | null;
  baselinePeakC: number;
  counterfactualPeakC: number;
  thresholdC: number;
  confidence: number;
}

export interface RecommendationSnapshot {
  id: "rec-17";
  flowPercent: number;
  durationMinutes: number;
  baselinePeakC: number;
  advisoryPeakC: number;
  reductionC: number;
  constraintMinutesAvoided: number;
  what: string;
  why: string;
  where: string;
  expectedEffect: string;
  confidence: number;
  provenance: "SIMULATED";
  limitations: string[];
  command: AdvisoryParameters & { assetId: "cdu-03" };
}

export interface SafetySnapshot {
  outcome: "PASS" | "WARNING" | "BLOCK";
  checks: {
    commandEnvelope: boolean;
    coolingHeadroom: boolean;
    maintenanceState: boolean;
    modelConfidence: boolean;
  };
}

export interface CockpitSnapshot {
  simulatedAt: number;
  elapsedS: number;
  workloadPercent: number;
  itPowerKw: number;
  totalPowerKw: number;
  peakInletC: number;
  meanInletC: number;
  pue: number;
  headroomKw: number;
  racksAtRisk: number;
  rackCount: number;
  fanPercent: number;
  chilledWaterC: number;
  coolingUnitCount: number;
  plant: {
    ratedCapacityKw: number;
    maintenanceLockout: boolean;
    commandEnvelope: typeof COMMAND_ENVELOPE;
    modelDomainMaxC: number;
  };
  racks: CockpitRackSnapshot[];
  forecast: ForecastSnapshot;
  incident: {
    id: "inc-204";
    open: boolean;
    rackId: string;
    peakC: number;
    limitC: number;
    severity: "WATCH" | "HIGH";
  };
  recommendation: RecommendationSnapshot;
  safety: SafetySnapshot;
  baselineTelemetry: Telemetry;
  advisoryTelemetry: Telemetry;
  modelConfig: FacilityModelConfig;
  series: {
    actual: ForecastSeriesPoint[];
    forecast: ForecastSeriesPoint[];
    counterfactual: ForecastSeriesPoint[];
  };
}

export interface CockpitSimulationState {
  elapsedSlices: number;
  simulatedAt: number;
  thermal: SimState;
  snapshot: CockpitSnapshot;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function scenarioElapsed(simulatedAt: number, startAt: number): number {
  return Math.max(0, simulatedAt - startAt);
}

function rampAt(simulatedAt: number, startAt: number): number {
  return clamp01(scenarioElapsed(simulatedAt, startAt) / SCENARIO_DURATION_S);
}

function seededLoadScale(seed: number): number {
  const canonicalBucket = DEFAULT_FACILITY_MODEL.seed % 97;
  return 1 + ((seed % 97) - canonicalBucket) / 10_000;
}

function rack(id: string, loadMultiplier: number): SandboxItem {
  return {
    id: `rack-${id.toLowerCase()}`,
    kind: "rack",
    cell: { x: 0, z: 0 },
    params: {
      itLoadKw: BASE_RACK_LOAD_KW,
      utilisationPct: BASE_UTILISATION_PCT * loadMultiplier,
      inletLimitC: RACK_LIMIT_C,
      rackUnits: 42,
    },
  };
}

/**
 * The cockpit and the public sandbox use the same physical kernel. This is
 * the fixed, versioned facility topology used by the GPU Training Ramp.
 */
export function scenarioLayout(
  simulatedAt: number,
  startAt: number,
  variant: SimulationVariant,
  config: FacilityModelConfig = DEFAULT_FACILITY_MODEL,
  advisory: AdvisoryParameters = DEFAULT_ADVISORY_PARAMETERS,
): SandboxLayout {
  const ramp = rampAt(simulatedAt, startAt);
  const loadMultiplier =
    1 + RAMP_INCREASE * ramp *
    (DEFAULT_FACILITY_MODEL.thermalMass / config.thermalMass) *
    seededLoadScale(config.seed);
  const lagAdjustment = (DEFAULT_FACILITY_MODEL.responseLag - config.responseLag) / 120;
  const cduPumpPercent = variant === "advisory" ? advisory.flowPercent : 70 + 6 * lagAdjustment * ramp;

  const racks = RACK_IDS.map((id) => rack(id, loadMultiplier));
  const cdu: SandboxItem = {
    id: "cdu-03",
    kind: "cdu",
    cell: { x: 4, z: 0 },
    params: {
      pumpSpeedPct: cduPumpPercent,
      supplyWaterC: 21,
      capacityKw: 1_800,
      approachK: 5,
      loopDeltaK: 9,
    },
  };
  const chiller: SandboxItem = {
    id: "chiller-01",
    kind: "chiller",
    cell: { x: 6, z: 0 },
    params: {
      chilledWaterC: 12,
      ambientC: 28,
      capacityKw: 2_160,
    },
  };

  return {
    items: [chiller, cdu, ...racks],
    connections: [
      { id: "link-chiller-cdu", fromId: chiller.id, toId: cdu.id },
      ...racks.map((item) => ({
        id: `link-cdu-${item.id}`,
        fromId: cdu.id,
        toId: item.id,
      })),
    ],
  };
}

function fixedSliceCount(seconds: number): number {
  return Math.max(0, Math.round(seconds / SIM_DT_S));
}

function constraintMinutes(
  thermal: SimState,
  startAt: number,
  fromAt: number,
  variant: SimulationVariant,
  config: FacilityModelConfig,
  advisory: AdvisoryParameters = DEFAULT_ADVISORY_PARAMETERS,
): { peakC: number; minutes: number; points: ForecastSeriesPoint[] } {
  let state = thermal;
  let peakC = -Infinity;
  let constrainedSlices = 0;
  const points: ForecastSeriesPoint[] = [];
  const seconds = Math.round(FORECAST_HORIZON_S);

  for (let i = 0; i < seconds; i += 1) {
    const simulatedAt = fromAt + i + 1;
    const advisoryActive = variant === "advisory" && i < advisory.durationMinutes * 60;
    const layout = scenarioLayout(
      simulatedAt,
      startAt,
      advisoryActive ? "advisory" : "baseline",
      config,
      advisory,
    );
    state = stepSim(state, layout, "baseline", fixedSliceCount(1));
    const telemetry = readTelemetry(state, layout, "baseline");
    peakC = Math.max(peakC, telemetry.maxInletC ?? RACK_LIMIT_C);
    if (telemetry.racksAtRisk > 0) constrainedSlices += fixedSliceCount(1);
    points.push({
      simulatedAt,
      offsetS: i + 1,
      actualPeakC: null,
      baselinePeakC: rounded(telemetry.maxInletC ?? RACK_LIMIT_C),
      counterfactualPeakC: rounded(telemetry.maxInletC ?? RACK_LIMIT_C),
      thresholdC: RACK_LIMIT_C,
      confidence: rounded(Math.max(0.55, 0.98 - ((i + 1) / seconds) * 0.18), 3),
    });
  }

  return {
    peakC: Number.isFinite(peakC) ? peakC : RACK_LIMIT_C,
    minutes: constrainedSlices * SIM_DT_S / 60,
    points,
  };
}

function rounded(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function deriveSnapshot(
  thermal: SimState,
  simulatedAt: number,
  startAt: number,
  config: FacilityModelConfig,
  advisory: AdvisoryParameters = DEFAULT_ADVISORY_PARAMETERS,
): CockpitSnapshot {
  const baselineLayout = scenarioLayout(simulatedAt, startAt, "baseline", config);
  const advisoryLayout = scenarioLayout(simulatedAt, startAt, "advisory", config, advisory);
  const baselineTelemetry = readTelemetry(thermal, baselineLayout, "baseline");
  const advisoryTelemetry = readTelemetry(thermal, advisoryLayout, "baseline");
  const baselineForecast = constraintMinutes(thermal, startAt, simulatedAt, "baseline", config);
  const advisoryForecast = constraintMinutes(thermal, startAt, simulatedAt, "advisory", config, advisory);
  const currentRacks = baselineLayout.items
    .filter((item) => item.kind === "rack")
    .map((item) => {
      const inletC = thermal.inletC[item.id] ?? RACK_LIMIT_C;
      const heatKw = item.params.itLoadKw * (item.params.utilisationPct / 100);
      return {
        id: item.id.replace("rack-", "").toUpperCase(),
        inletC: rounded(inletC),
        limitC: item.params.inletLimitC,
        heatKw: rounded(heatKw),
        atRisk: inletC >= item.params.inletLimitC,
      };
    });
  const currentPeak = baselineTelemetry.maxInletC ?? RACK_LIMIT_C;
  const forecastRisk =
    baselineForecast.peakC >= RACK_LIMIT_C + 1
      ? "critical"
      : baselineForecast.peakC >= RACK_LIMIT_C
        ? "watch"
        : "clear";
  const reductionC = Math.max(0, baselineForecast.peakC - advisoryForecast.peakC);
  const constraintMinutesAvoided = Math.max(0, baselineForecast.minutes - advisoryForecast.minutes);
  const headroomKw = Math.max(0, SCENARIO_RATED_CAPACITY_KW - baselineTelemetry.itPowerKw);
  const safetyChecks = {
    commandEnvelope:
      advisory.flowPercent >= COMMAND_ENVELOPE.minFlowPercent &&
      advisory.flowPercent <= COMMAND_ENVELOPE.maxFlowPercent,
    coolingHeadroom: advisoryTelemetry.maxInletC === null || advisoryTelemetry.maxInletC < RACK_LIMIT_C + 1,
    maintenanceState: !MAINTENANCE_LOCKOUT,
    modelConfidence: baselineForecast.peakC <= MODEL_DOMAIN_MAX_C,
  };
  const safetyWarning =
    safetyChecks.coolingHeadroom &&
    advisoryForecast.peakC >= RACK_LIMIT_C &&
    advisoryForecast.peakC < RACK_LIMIT_C + 1;
  const safetyPass = Object.values(safetyChecks).every(Boolean);
  const forecastSeries = baselineForecast.points.map((point, index) => ({
    ...point,
    counterfactualPeakC: advisoryForecast.points[index]?.baselinePeakC ?? point.counterfactualPeakC,
    actualPeakC: index === 0 ? rounded(currentPeak) : null,
  }));
  const actualPoint = {
    simulatedAt,
    offsetS: 0,
    actualPeakC: rounded(currentPeak),
    baselinePeakC: rounded(currentPeak),
    counterfactualPeakC: rounded(currentPeak),
    thresholdC: RACK_LIMIT_C,
    confidence: 1,
  };
  const safetyOutcome = !safetyPass ? "BLOCK" : safetyWarning ? "WARNING" : "PASS";

  return {
    simulatedAt,
    elapsedS: scenarioElapsed(simulatedAt, startAt),
    workloadPercent: rounded((1 + RAMP_INCREASE * rampAt(simulatedAt, startAt)) * 100),
    itPowerKw: rounded(baselineTelemetry.itPowerKw),
    totalPowerKw: rounded(baselineTelemetry.totalPowerKw),
    peakInletC: rounded(currentPeak),
    meanInletC: rounded(baselineTelemetry.meanInletC ?? RACK_LIMIT_C),
    pue: rounded(baselineTelemetry.pue ?? 0, 3),
    headroomKw: rounded(headroomKw),
    racksAtRisk: baselineTelemetry.racksAtRisk,
    rackCount: baselineTelemetry.rackCount,
    fanPercent: rounded((baselineTelemetry.meanFan ?? 0) * 100),
    chilledWaterC: rounded(baselineTelemetry.chilledWaterC ?? 0),
    coolingUnitCount: baselineTelemetry.coolingUnitCount,
    plant: {
      ratedCapacityKw: SCENARIO_RATED_CAPACITY_KW,
      maintenanceLockout: MAINTENANCE_LOCKOUT,
      commandEnvelope: COMMAND_ENVELOPE,
      modelDomainMaxC: MODEL_DOMAIN_MAX_C,
    },
    racks: currentRacks,
    forecast: {
      horizonS: FORECAST_HORIZON_S,
      baselinePeakC: rounded(baselineForecast.peakC),
      advisoryPeakC: rounded(advisoryForecast.peakC),
      baselineConstraintMinutes: rounded(baselineForecast.minutes, 1),
      advisoryConstraintMinutes: rounded(advisoryForecast.minutes, 1),
      risk: forecastRisk,
      thresholdC: RACK_LIMIT_C,
      confidence: forecastSeries[forecastSeries.length - 1]?.confidence ?? 0.55,
      series: forecastSeries,
    },
    incident: {
      id: "inc-204",
      open: forecastRisk !== "clear" || baselineTelemetry.racksAtRisk > 0,
      rackId: currentRacks.reduce((hot, item) => item.inletC > hot.inletC ? item : hot, currentRacks[0]).id,
      peakC: rounded(baselineForecast.peakC),
      limitC: RACK_LIMIT_C,
      severity: forecastRisk === "critical" ? "HIGH" : "WATCH",
    },
    recommendation: {
      id: "rec-17",
      flowPercent: advisory.flowPercent,
      durationMinutes: advisory.durationMinutes,
      baselinePeakC: rounded(baselineForecast.peakC),
      advisoryPeakC: rounded(advisoryForecast.peakC),
      reductionC: rounded(reductionC),
      constraintMinutesAvoided: rounded(constraintMinutesAvoided, 1),
      what: `Increase CDU-03 flow to ${advisory.flowPercent}% for ${advisory.durationMinutes} minutes.`,
      why: "Pre-empt the modeled CDU-03 response lag before the workload ramp reaches the thermal constraint.",
      where: "GPU Hall B · GPU Training Zone · CDU-03 serving racks A01–B02.",
      expectedEffect: `${rounded(reductionC)}°C lower forecast peak and ${rounded(constraintMinutesAvoided, 1)} minutes less modeled constraint exposure.`,
      confidence: forecastSeries[forecastSeries.length - 1]?.confidence ?? 0.55,
      provenance: "SIMULATED",
      limitations: [
        "Synthetic reduced-order model; values are not measured telemetry.",
        "Advisory is bounded to the CDU-03 command envelope and does not send an OT command.",
        `Confidence is disclosed only within the ≤${MODEL_DOMAIN_MAX_C}°C model domain.`,
      ],
      command: { assetId: "cdu-03", flowPercent: advisory.flowPercent, durationMinutes: advisory.durationMinutes },
    },
    safety: {
      outcome: safetyOutcome,
      checks: safetyChecks,
    },
    baselineTelemetry,
    advisoryTelemetry,
    modelConfig: config,
    series: {
      actual: [actualPoint],
      forecast: forecastSeries,
      counterfactual: forecastSeries,
    },
  };
}

export function createCockpitSimulation(startAt: number, config: FacilityModelConfig = DEFAULT_FACILITY_MODEL): CockpitSimulationState {
  const layout = scenarioLayout(startAt, startAt, "baseline", config);
  const thermal = createSimState(layout);
  return {
    elapsedSlices: 0,
    simulatedAt: startAt,
    thermal,
    snapshot: deriveSnapshot(thermal, startAt, startAt, config),
  };
}

/**
 * Advance only in whole physical slices. A 60x replay is still the same 30Hz
 * integration repeated 1,800 times per wall-clock second, rather than a larger
 * timestep with different physics.
 */
export function advanceCockpitSimulation(
  simulation: CockpitSimulationState,
  seconds: number,
  startAt: number,
  config: FacilityModelConfig = DEFAULT_FACILITY_MODEL,
): CockpitSimulationState {
  const maximumSlices = fixedSliceCount(SCENARIO_DURATION_S);
  const slices = Math.min(
    fixedSliceCount(seconds),
    Math.max(0, maximumSlices - simulation.elapsedSlices),
  );
  const elapsedSlices = simulation.elapsedSlices + slices;
  let thermal = simulation.thermal;
  let cursor = simulation.elapsedSlices;
  let remaining = slices;
  const slicesPerSecond = fixedSliceCount(1);
  while (remaining > 0) {
    const toNextSecond = slicesPerSecond - (cursor % slicesPerSecond);
    const batch = Math.min(remaining, toNextSecond);
    const sampledAt = startAt + (cursor + batch) * SIM_DT_S;
    thermal = stepSim(
      thermal,
      scenarioLayout(sampledAt, startAt, "baseline", config),
      "baseline",
      batch,
    );
    cursor += batch;
    remaining -= batch;
  }
  const rawSimulatedAt = startAt + elapsedSlices * SIM_DT_S;
  const simulatedAt = Math.abs(rawSimulatedAt - Math.round(rawSimulatedAt)) < 1e-6
    ? Math.round(rawSimulatedAt)
    : rawSimulatedAt;

  return {
    elapsedSlices,
    simulatedAt,
    thermal,
    snapshot: deriveSnapshot(thermal, simulatedAt, startAt, config),
  };
}

export function replayCockpitSnapshot(simulatedAt: number, config: FacilityModelConfig = DEFAULT_FACILITY_MODEL): CockpitSnapshot {
  if (!Number.isInteger(simulatedAt) || simulatedAt < SCENARIO_START_S || simulatedAt > SCENARIO_START_S + SCENARIO_DURATION_S) {
    throw new RangeError("Simulation timestamp is outside the GPU Training Ramp");
  }
  return advanceCockpitSimulation(
    createCockpitSimulation(SCENARIO_START_S, config),
    simulatedAt - SCENARIO_START_S,
    SCENARIO_START_S,
    config,
  ).snapshot;
}

export function counterfactualCockpitSnapshot(
  simulatedAt: number,
  advisory: AdvisoryParameters,
  config: FacilityModelConfig = DEFAULT_FACILITY_MODEL,
): CockpitSnapshot {
  if (!Number.isInteger(simulatedAt) || simulatedAt < SCENARIO_START_S || simulatedAt > SCENARIO_START_S + SCENARIO_DURATION_S) {
    throw new RangeError("Simulation timestamp is outside the GPU Training Ramp");
  }
  const simulation = advanceCockpitSimulation(
    createCockpitSimulation(SCENARIO_START_S, config),
    simulatedAt - SCENARIO_START_S,
    SCENARIO_START_S,
    config,
  );
  return deriveSnapshot(simulation.thermal, simulatedAt, SCENARIO_START_S, config, advisory);
}

export function snapshotForAudit(snapshot: CockpitSnapshot) {
  return {
    scenarioId: "gpu-training-ramp-v1",
    simulatedAt: snapshot.simulatedAt,
    elapsedS: snapshot.elapsedS,
    workloadPercent: snapshot.workloadPercent,
    itPowerKw: snapshot.itPowerKw,
    totalPowerKw: snapshot.totalPowerKw,
    peakInletC: snapshot.peakInletC,
    pue: snapshot.pue,
    modelConfig: snapshot.modelConfig,
    plant: snapshot.plant,
    racks: snapshot.racks,
    forecast: snapshot.forecast,
    recommendation: snapshot.recommendation,
    safety: snapshot.safety,
    baselineTelemetry: snapshot.baselineTelemetry,
    advisoryTelemetry: snapshot.advisoryTelemetry,
    series: snapshot.series,
    incident: snapshot.incident,
  };
}