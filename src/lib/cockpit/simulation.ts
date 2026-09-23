import {
  SIM_DT_S,
  createSimState,
  readTelemetry,
  stepSim,
  type SimState,
  type Telemetry,
} from "@/lib/sandbox/model";
import type { SandboxItem, SimLayout } from "@/lib/sandbox/types";
import type { FacilityLayout } from "@/lib/facility/layout";
import { SFO_01_LAYOUT } from "@/lib/facility/templates";
import { zoneAt } from "@/lib/sandbox/geometry";

export { SIM_DT_S };
export const SCENARIO_START_S = 1_752_676_800;
export const SCENARIO_DURATION_S = 1_800;
export const FORECAST_HORIZON_S = 300;
export const SCENARIO_RATED_CAPACITY_KW = 2_160;
export const COMMAND_ENVELOPE = { minFlowPercent: 60, maxFlowPercent: 85 } as const;
export const RECOMMENDATION_FLOW_PERCENT = 78;
export const RECOMMENDATION_DURATION_MINUTES = 20;
export const MODEL_DOMAIN_MAX_C = 35;
const RAMP_INCREASE = 0.25;
/** The SFO-01 reference rack inlet limit, used only when a layout has no racks. */
const RACK_LIMIT_C = 32;
const MAINTENANCE_LOCKOUT = false;
/** A forecast peak within this many °C below the rack inlet limit reads as WATCH. */
export const RISK_APPROACH_BAND_C = 1;

/** Forecast risk: WATCH while approaching the limit, CRITICAL from 1 °C above it. */
export function forecastRiskFor(peakC: number, limitC: number = RACK_LIMIT_C): ForecastSnapshot["risk"] {
  if (peakC >= limitC + 1) return "critical";
  if (peakC >= limitC - RISK_APPROACH_BAND_C) return "watch";
  return "clear";
}

export type SimulationVariant = "baseline" | "advisory" | "alternative";
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
  /**
   * The published facility build. Absent on models saved before the Builder,
   * which run on the SFO-01 reference layout.
   */
  layout?: FacilityLayout;
  /** Provenance for a verified import-backed Builder draft. */
  importMetadata?: { source: string; importId: string; kind: "FLOORPLAN" | "IFC"; provenance: "IMPORTED" };
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

export type ScenarioCheckpoint = {
  id: "workload-rise" | "cooling-lag" | "forecast-risk" | "incident" | "recommendation" | "decision";
  elapsedS: number;
  label: string;
};

export const SCENARIO_CHECKPOINTS: readonly ScenarioCheckpoint[] = [
  { id: "workload-rise", elapsedS: 120, label: "Training workload begins rising" },
  { id: "cooling-lag", elapsedS: 240, label: "CDU response lag becomes visible" },
  { id: "forecast-risk", elapsedS: 300, label: "Forecast crosses the thermal limit" },
  { id: "incident", elapsedS: 540, label: "Thermal incident forms" },
  { id: "recommendation", elapsedS: 600, label: "Cooling recommendation becomes available" },
  { id: "decision", elapsedS: 900, label: "Operator decision boundary" },
] as const;

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
  /** The advisory commands the cooling unit serving the most IT load in the published layout. */
  command: AdvisoryParameters & { assetId: string };
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
  thermalState: SimState;
  modelConfig: FacilityModelConfig;
  checkpoints: Array<ScenarioCheckpoint & { reached: boolean }>;
  series: {
    actual: ForecastSeriesPoint[];
    forecast: ForecastSeriesPoint[];
    counterfactual: ForecastSeriesPoint[];
    alternative: ForecastSeriesPoint[];
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

/** What Operations simulates for a facility model, derived once per layout. */
export interface FacilityPlant {
  /** Racks, cooling units and chillers in layout order. Sensors carry no physics. */
  items: SandboxItem[];
  connections: SimLayout["connections"];
  /** The cooling unit an advisory commands: the one serving the most IT load. */
  advisedUnit: SandboxItem;
  /** The advised unit as operators name it, such as CDU-03. */
  advisedLabel: string;
  /** The zone the advised unit stands in. */
  advisedZone: string;
  /** The racks the advised unit serves, as displayed. */
  advisedRacks: string[];
  /** Rated heat rejection: the chillers' combined capacity. */
  ratedCapacityKw: number;
  /** The strictest rack inlet limit, which forecasts and incidents are measured against. */
  limitC: number;
}

const plants = new WeakMap<FacilityLayout, FacilityPlant>();

/** Racks are shown by the part of their id after "rack-": rack-a01 is A01. */
export const rackLabel = (id: string) => id.replace("rack-", "").toUpperCase();

/**
 * The plant a facility model runs: its published build, or the SFO-01
 * reference layout for models saved before the Builder.
 */
export function facilityPlant(config: FacilityModelConfig = DEFAULT_FACILITY_MODEL): FacilityPlant {
  const layout = config.layout ?? SFO_01_LAYOUT;
  const cached = plants.get(layout);
  if (cached) return cached;

  const items = layout.items.filter((item) => item.kind !== "sensor");
  const ids = new Set(items.map((item) => item.id));
  const connections = layout.connections.filter((c) => ids.has(c.fromId) && ids.has(c.toId));
  const racks = items.filter((item) => item.kind === "rack");
  const served = (unit: SandboxItem) =>
    connections
      .filter((c) => c.fromId === unit.id)
      .map((c) => racks.find((rack) => rack.id === c.toId))
      .filter((rack): rack is SandboxItem => rack !== undefined);
  const load = (unit: SandboxItem) =>
    served(unit).reduce((sum, rack) => sum + (rack.params.itLoadKw * rack.params.utilisationPct) / 100, 0);
  const advisedUnit = items
    .filter((item) => item.kind === "cdu" || item.kind === "crac")
    .reduce<SandboxItem | undefined>((best, unit) => (!best || load(unit) > load(best) ? unit : best), undefined);
  if (!advisedUnit) {
    throw new RangeError("Invalid facility model configuration: the layout has no cooling unit to advise");
  }
  const chillers = items.filter((item) => item.kind === "chiller");

  const plant: FacilityPlant = {
    items,
    connections,
    advisedUnit,
    advisedLabel: advisedUnit.id.toUpperCase(),
    advisedZone: zoneAt(layout.zones, advisedUnit.cell)?.name ?? "Facility",
    advisedRacks: served(advisedUnit).map((rack) => rackLabel(rack.id)),
    ratedCapacityKw: chillers.length
      ? chillers.reduce((sum, chiller) => sum + chiller.params.capacityKw, 0)
      : SCENARIO_RATED_CAPACITY_KW,
    limitC: racks.length ? Math.min(...racks.map((rack) => rack.params.inletLimitC)) : RACK_LIMIT_C,
  };
  plants.set(layout, plant);
  return plant;
}

/**
 * The layout the kernel steps at one instant of the GPU Training Ramp.
 *
 * The published build supplies the equipment and wiring. The scenario ramps
 * every rack's utilisation, applies the configured response lag to every
 * cooling unit, and applies any advisory command to the advised unit. With the
 * SFO-01 reference layout this reproduces the replay model exactly.
 */
export function scenarioLayout(
  simulatedAt: number,
  startAt: number,
  variant: SimulationVariant,
  config: FacilityModelConfig = DEFAULT_FACILITY_MODEL,
  advisory: AdvisoryParameters = DEFAULT_ADVISORY_PARAMETERS,
  commandStartedAt: number = startAt,
): SimLayout {
  const plant = facilityPlant(config);
  const ramp = rampAt(simulatedAt, startAt);
  const loadMultiplier =
    1 + RAMP_INCREASE * ramp *
    (DEFAULT_FACILITY_MODEL.thermalMass / config.thermalMass) *
    seededLoadScale(config.seed);
  const lagAdjustment = (DEFAULT_FACILITY_MODEL.responseLag - config.responseLag) / 120;
  const lagS = Math.max(0, config.responseLag);
  const commandElapsed = Math.max(0, simulatedAt - commandStartedAt);
  const commandBlend = variant === "baseline" ? 1 : clamp01(commandElapsed / Math.max(1, lagS));

  const items = plant.items.map((item): SandboxItem => {
    if (item.kind === "rack") {
      return { ...item, params: { ...item.params, utilisationPct: item.params.utilisationPct * loadMultiplier } };
    }
    if (item.kind !== "cdu" && item.kind !== "crac") return item;
    const speedKey = item.kind === "cdu" ? "pumpSpeedPct" : "fanSpeedPct";
    const base = item.params[speedKey];
    const commandedFlow = variant === "baseline" || item.id !== plant.advisedUnit.id
      ? base
      : variant === "advisory"
        ? advisory.flowPercent
        : Math.max(COMMAND_ENVELOPE.minFlowPercent, advisory.flowPercent);
    return {
      ...item,
      params: { ...item.params, [speedKey]: base + (commandedFlow - base) * commandBlend + 6 * lagAdjustment * ramp },
    };
  });

  return { items, connections: plant.connections };
}

function fixedSliceCount(seconds: number): number {
  return Math.max(0, Math.round(seconds / SIM_DT_S));
}

export function simulateVariant(
  thermal: SimState,
  startAt: number,
  fromAt: number,
  variant: SimulationVariant,
  config: FacilityModelConfig,
  advisory: AdvisoryParameters = DEFAULT_ADVISORY_PARAMETERS,
): { peakC: number; minutes: number; degreeMinutes: number; points: ForecastSeriesPoint[]; finalState: SimState; coolingEnergyKwh: number } {
  let state = thermal;
  let peakC = -Infinity;
  let constrainedSlices = 0;
  const points: ForecastSeriesPoint[] = [];
  let coolingEnergyKwh = 0;
  let degreeMinutes = 0;
  const seconds = Math.round(FORECAST_HORIZON_S);
  const { limitC } = facilityPlant(config);

  for (let i = 0; i < seconds; i += 1) {
    const simulatedAt = fromAt + i + 1;
    const advisoryActive = variant !== "baseline" && i < advisory.durationMinutes * 60;
    const layout = scenarioLayout(
      simulatedAt,
      startAt,
      advisoryActive ? "advisory" : "baseline",
      config,
      advisory,
      fromAt,
    );
    state = stepSim(state, layout, "baseline", fixedSliceCount(1));
    const telemetry = readTelemetry(state, layout, "baseline");
    coolingEnergyKwh += Math.max(0, telemetry.totalPowerKw - telemetry.itPowerKw) / 3_600;
    peakC = Math.max(peakC, telemetry.maxInletC ?? limitC);
    degreeMinutes += Math.max(0, (telemetry.maxInletC ?? limitC) - limitC) / 60;
    if (telemetry.racksAtRisk > 0) constrainedSlices += fixedSliceCount(1);
    points.push({
      simulatedAt,
      offsetS: i + 1,
      actualPeakC: null,
      baselinePeakC: rounded(telemetry.maxInletC ?? limitC),
      counterfactualPeakC: rounded(telemetry.maxInletC ?? limitC),
      thresholdC: limitC,
      confidence: rounded(Math.max(0.55, 0.98 - ((i + 1) / seconds) * 0.18), 3),
    });
  }

  return {
    peakC: Number.isFinite(peakC) ? peakC : limitC,
    minutes: constrainedSlices * SIM_DT_S / 60,
    degreeMinutes,
    points,
    finalState: state,
    coolingEnergyKwh,
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
  const plant = facilityPlant(config);
  const { limitC } = plant;
  const baselineLayout = scenarioLayout(simulatedAt, startAt, "baseline", config);
  const advisoryLayout = scenarioLayout(simulatedAt, startAt, "advisory", config, advisory);
  const baselineTelemetry = readTelemetry(thermal, baselineLayout, "baseline");
  const advisoryTelemetry = readTelemetry(thermal, advisoryLayout, "baseline");
  const baselineForecast = simulateVariant(thermal, startAt, simulatedAt, "baseline", config);
  const advisoryForecast = simulateVariant(thermal, startAt, simulatedAt, "advisory", config, advisory);
  const alternativeForecast = simulateVariant(thermal, startAt, simulatedAt, "alternative", config, {
    flowPercent: COMMAND_ENVELOPE.maxFlowPercent,
    durationMinutes: Math.max(1, advisory.durationMinutes / 2),
  });
  const currentRacks = baselineLayout.items
    .filter((item) => item.kind === "rack")
    .map((item) => {
      const inletC = thermal.inletC[item.id] ?? limitC;
      const heatKw = item.params.itLoadKw * (item.params.utilisationPct / 100);
      return {
        id: rackLabel(item.id),
        inletC: rounded(inletC),
        limitC: item.params.inletLimitC,
        heatKw: rounded(heatKw),
        atRisk: inletC >= item.params.inletLimitC,
      };
    });
  const currentPeak = baselineTelemetry.maxInletC ?? limitC;
  const forecastRisk = forecastRiskFor(baselineForecast.peakC, limitC);
  const reductionC = Math.max(0, baselineForecast.peakC - advisoryForecast.peakC);
  const constraintMinutesAvoided = Math.max(0, baselineForecast.minutes - advisoryForecast.minutes);
  const headroomKw = Math.max(0, plant.ratedCapacityKw - baselineTelemetry.itPowerKw);
  const safetyChecks = {
    commandEnvelope:
      advisory.flowPercent >= COMMAND_ENVELOPE.minFlowPercent &&
      advisory.flowPercent <= COMMAND_ENVELOPE.maxFlowPercent,
    coolingHeadroom: advisoryTelemetry.maxInletC === null || advisoryTelemetry.maxInletC < limitC + 1,
    maintenanceState: !MAINTENANCE_LOCKOUT,
    modelConfidence: baselineForecast.peakC <= MODEL_DOMAIN_MAX_C,
  };
  const safetyWarning =
    safetyChecks.coolingHeadroom &&
    advisoryForecast.peakC >= limitC &&
    advisoryForecast.peakC < limitC + 1;
  const safetyPass = Object.values(safetyChecks).every(Boolean);
  const forecastSeries = baselineForecast.points.map((point, index) => ({
    ...point,
    counterfactualPeakC: advisoryForecast.points[index]?.baselinePeakC ?? point.counterfactualPeakC,
    actualPeakC: index === 0 ? rounded(currentPeak) : null,
  }));
  const alternativeSeries = baselineForecast.points.map((point, index) => ({
    ...point,
    counterfactualPeakC: alternativeForecast.points[index]?.baselinePeakC ?? point.baselinePeakC,
  }));
  const actualPoint = {
    simulatedAt,
    offsetS: 0,
    actualPeakC: rounded(currentPeak),
    baselinePeakC: rounded(currentPeak),
    counterfactualPeakC: rounded(currentPeak),
    thresholdC: limitC,
    confidence: 1,
  };
  const safetyOutcome = !safetyPass ? "BLOCK" : safetyWarning ? "WARNING" : "PASS";
  const unit = plant.advisedLabel;
  const servedRacks = plant.advisedRacks.length > 1
    ? `${plant.advisedRacks[0]}–${plant.advisedRacks[plant.advisedRacks.length - 1]}`
    : plant.advisedRacks[0] ?? "none";

  return {
    simulatedAt,
    elapsedS: scenarioElapsed(simulatedAt, startAt),
    workloadPercent: rounded((1 + RAMP_INCREASE * rampAt(simulatedAt, startAt)) * 100),
    itPowerKw: rounded(baselineTelemetry.itPowerKw),
    totalPowerKw: rounded(baselineTelemetry.totalPowerKw),
    peakInletC: rounded(currentPeak),
    meanInletC: rounded(baselineTelemetry.meanInletC ?? limitC),
    pue: rounded(baselineTelemetry.pue ?? 0, 3),
    headroomKw: rounded(headroomKw),
    racksAtRisk: baselineTelemetry.racksAtRisk,
    rackCount: baselineTelemetry.rackCount,
    fanPercent: rounded((baselineTelemetry.meanFan ?? 0) * 100),
    chilledWaterC: rounded(baselineTelemetry.chilledWaterC ?? 0),
    coolingUnitCount: baselineTelemetry.coolingUnitCount,
    plant: {
      ratedCapacityKw: plant.ratedCapacityKw,
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
      thresholdC: limitC,
      confidence: forecastSeries[forecastSeries.length - 1]?.confidence ?? 0.55,
      series: forecastSeries,
    },
    incident: {
      id: "inc-204",
      // Approaching the limit is a WATCH forecast, not an incident.
      open: baselineForecast.peakC >= limitC || baselineTelemetry.racksAtRisk > 0,
      rackId: currentRacks.reduce((hot, item) => item.inletC > hot.inletC ? item : hot, currentRacks[0]).id,
      peakC: rounded(baselineForecast.peakC),
      limitC,
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
      what: `Increase ${unit} flow to ${advisory.flowPercent}% for ${advisory.durationMinutes} minutes.`,
      why: `Pre-empt the modeled ${unit} response lag before the workload ramp reaches the thermal constraint.`,
      where: `${plant.advisedZone} · GPU Training Zone · ${unit} serving racks ${servedRacks}.`,
      expectedEffect: `${rounded(reductionC)}°C lower forecast peak and ${rounded(constraintMinutesAvoided, 1)} minutes less modeled constraint exposure.`,
      confidence: forecastSeries[forecastSeries.length - 1]?.confidence ?? 0.55,
      provenance: "SIMULATED",
      limitations: [
        "Synthetic reduced-order model; values are not measured telemetry.",
        `Advisory is bounded to the ${unit} command envelope and does not send an OT command.`,
        `Confidence is disclosed only within the ≤${MODEL_DOMAIN_MAX_C}°C model domain.`,
      ],
      command: { assetId: plant.advisedUnit.id, flowPercent: advisory.flowPercent, durationMinutes: advisory.durationMinutes },
    },
    safety: {
      outcome: safetyOutcome,
      checks: safetyChecks,
    },
    baselineTelemetry,
    advisoryTelemetry,
    thermalState: thermal,
    modelConfig: config,
    checkpoints: SCENARIO_CHECKPOINTS.map((checkpoint) => ({
      ...checkpoint,
      reached: scenarioElapsed(simulatedAt, startAt) >= checkpoint.elapsedS,
    })),
    series: {
      actual: [actualPoint],
      forecast: forecastSeries,
      counterfactual: advisoryForecast.points,
      alternative: alternativeSeries,
    },
  };
}

/**
 * A stable key for a layout object, so cached snapshots of different builds
 * never collide. Models without a layout all run the reference layout.
 */
const layoutKeys = new WeakMap<FacilityLayout, number>();
let nextLayoutKey = 0;
function layoutKey(layout: FacilityLayout | undefined): string {
  if (!layout) return "reference";
  let key = layoutKeys.get(layout);
  if (key === undefined) {
    key = ++nextLayoutKey;
    layoutKeys.set(layout, key);
  }
  return `layout-${key}`;
}

const snapshotCache = new Map<string, CockpitSnapshot>();

function cachedSnapshot(
  thermal: SimState,
  simulatedAt: number,
  startAt: number,
  config: FacilityModelConfig,
): CockpitSnapshot {
  const key = `${startAt}:${simulatedAt}:${config.scenario}:${config.seed}:${config.thermalMass}:${config.responseLag}:${layoutKey(config.layout)}`;
  const cached = snapshotCache.get(key);
  if (cached) return cached;
  const snapshot = deriveSnapshot(thermal, simulatedAt, startAt, config);
  snapshotCache.set(key, snapshot);
  if (snapshotCache.size > 256) snapshotCache.delete(snapshotCache.keys().next().value!);
  return snapshot;
}

export function createCockpitSimulation(startAt: number, config: FacilityModelConfig = DEFAULT_FACILITY_MODEL): CockpitSimulationState {
  const layout = scenarioLayout(startAt, startAt, "baseline", config);
  const thermal = createSimState(layout);
  return {
    elapsedSlices: 0,
    simulatedAt: startAt,
    thermal,
    snapshot: cachedSnapshot(thermal, startAt, startAt, config),
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
    snapshot: cachedSnapshot(thermal, simulatedAt, startAt, config),
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
    thermalState: snapshot.thermalState,
    series: snapshot.series,
    incident: snapshot.incident,
  };
}