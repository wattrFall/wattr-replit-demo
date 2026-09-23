import {
  SIM_DT_S,
  createSimState,
  readTelemetry,
  stepSim,
  type SimState,
} from "@/lib/sandbox/model";
import { SFO_01_LAYOUT } from "@/lib/facility/templates";
import { assertModelConfig } from "@/lib/cockpit/contracts";
import type { FacilityModelConfig } from "@/lib/cockpit/simulation";
import { placementRefusal } from "@/lib/sandbox/store";
import { hasHistoricalInitialInlets } from "./csv";
import type { SandboxItem, SimLayout } from "@/lib/sandbox/types";
import type {
  HistoricalDataset,
  HistoricalReplayResult,
  HistoricalScenario,
  ReplayInputRow,
  ReplayRawPoint,
  ReplayTimePoint,
} from "./types";

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const coolingKinds = new Set(["cdu", "crac"]);

export function modelLayout(config: FacilityModelConfig): SimLayout {
  assertModelConfig(config);
  const layout = config.layout ?? SFO_01_LAYOUT;
  return structuredClone({ items: layout.items.filter((item) => item.kind !== "sensor"), connections: layout.connections });
}

export function supportedReplayRackIds(config: FacilityModelConfig): string[] {
  return modelLayout(config).items.filter((item) => item.kind === "rack").map((item) => item.id);
}

function candidateLayout(config: FacilityModelConfig, scenario: HistoricalScenario): SimLayout {
  const layout = modelLayout(config);
  const rack = layout.items.find((item) => item.id === scenario.relocation.rackId && item.kind === "rack");
  if (!rack) throw new RangeError(`Rack ${scenario.relocation.rackId} is not part of the immutable historical model.`);
  if (!Number.isInteger(scenario.relocation.to.x) || !Number.isInteger(scenario.relocation.to.z)) {
    throw new RangeError("Rack relocation must target whole spatial grid coordinates.");
  }
  const occupied = layout.items.some((item) => item.id !== rack.id && item.cell.x === scenario.relocation.to.x && item.cell.z === scenario.relocation.to.z);
  if (occupied) throw new RangeError("Rack relocation target is occupied.");
  rack.cell = { ...scenario.relocation.to };
  return layout;
}

export function assertSupportedRelocation(config: FacilityModelConfig, rackId: string, to: { x: number; z: number }) {
  const baseline = modelLayout(config);
  const rack = baseline.items.find((item) => item.id === rackId && item.kind === "rack");
  if (!rack) throw new RangeError(`Rack ${rackId} is not a supported rack in this historical model.`);
  if (!Number.isInteger(to.x) || !Number.isInteger(to.z) || to.x < 0 || to.z < 0 || to.x > 63 || to.z > 63) {
    throw new RangeError("Rack relocation must be an in-site whole-grid position.");
  }
  if (rack.cell.x === to.x && rack.cell.z === to.z) throw new RangeError("Candidate relocation must differ from the immutable baseline position.");
  const facilityLayout = config.layout ?? SFO_01_LAYOUT;
  const refusal = placementRefusal(
    facilityLayout.items.filter((item) => item.id !== rackId),
    facilityLayout.zones,
    "rack",
    to,
  );
  if (refusal) throw new RangeError(`Unsupported rack relocation: ${refusal}`);
  const candidate = candidateLayout(config, {
    relocation: { rackId, to },
  } as HistoricalScenario);
  return candidate;
}

function layoutForInputs(layout: SimLayout, rows: ReplayInputRow[]): SimLayout {
  const byRack = new Map(rows.map((row) => [row.rackId, row]));
  const ambientC = rows.reduce((sum, row) => sum + row.ambientC, 0) / rows.length;
  const coolingSupplyC = rows.reduce((sum, row) => sum + row.coolingSupplyC, 0) / rows.length;
  const flows = rows.map((row) => row.coolingFlowPct).filter((value): value is number => value !== null);
  const coolingFlowPct = flows.length ? flows.reduce((sum, value) => sum + value, 0) / flows.length : null;
  return {
    connections: layout.connections,
    items: layout.items.map((item): SandboxItem => {
      if (item.kind === "rack") {
        const row = byRack.get(item.id);
        if (!row) throw new RangeError(`Historical input is missing rack ${item.id}.`);
        // Both values remain input evidence. rack_power_kw is the thermal load;
        // workload_kw is retained as the workload boundary condition, not invented.
        return { ...item, params: { ...item.params, itLoadKw: row.rackPowerKw, utilisationPct: 100 } };
      }
      if (item.kind === "chiller") return { ...item, params: { ...item.params, ambientC } };
      if (coolingKinds.has(item.kind)) {
        const key = item.kind === "cdu" ? "supplyWaterC" : "supplyAirC";
        const speedKey = item.kind === "cdu" ? "pumpSpeedPct" : "fanSpeedPct";
        return { ...item, params: { ...item.params, [key]: coolingSupplyC, ...(coolingFlowPct === null ? {} : { [speedKey]: coolingFlowPct }) } };
      }
      return item;
    }),
  };
}

/**
 * A deliberately bounded local spatial term, outside the core thermal kernel.
 * It represents relative rack crowding and distance from connected cooling only.
 * This is not CFD and is disclosed as an uncalibrated approximation.
 */
function spatialAdjustment(layout: SimLayout, state: SimState, target: SandboxItem): number {
  const racks = layout.items.filter((item) => item.kind === "rack");
  const cooling = layout.items.filter((item) => coolingKinds.has(item.kind));
  const crowding = racks.filter((rack) => rack.id !== target.id).reduce((sum, rack) => {
    const distance = Math.abs(rack.cell.x - target.cell.x) + Math.abs(rack.cell.z - target.cell.z);
    const load = rack.params.itLoadKw * (rack.params.utilisationPct / 100);
    return sum + Math.min(0.12, (load / 1_000) * 0.12 / Math.max(1, distance));
  }, 0);
  const nearestCooling = cooling.length
    ? Math.min(...cooling.map((unit) => Math.abs(unit.cell.x - target.cell.x) + Math.abs(unit.cell.z - target.cell.z)))
    : 12;
  const current = state.inletC[target.id] ?? 30;
  return Math.max(-0.6, Math.min(1.5, crowding + nearestCooling * 0.018 + (current - 30) * 0.01));
}

function summarizePoint(timestamp: number, layout: SimLayout, state: SimState): ReplayRawPoint {
  const telemetry = readTelemetry(state, layout, "baseline");
  const racks = layout.items.filter((item) => item.kind === "rack").map((rack) => {
    const spatialAdjustmentC = spatialAdjustment(layout, state, rack);
    return {
      rackId: rack.id,
      inletC: round((state.inletC[rack.id] ?? 30) + spatialAdjustmentC),
      limitC: rack.params.inletLimitC,
      spatialAdjustmentC: round(spatialAdjustmentC),
    };
  });
  const peakInletC = Math.max(...racks.map((rack) => rack.inletC), telemetry.maxInletC ?? 0);
  const meanInletC = racks.reduce((sum, rack) => sum + rack.inletC, 0) / Math.max(1, racks.length);
  const thermalHeadroomC = Math.min(...racks.map((rack) => rack.limitC - rack.inletC));
  const violations = racks.filter((rack) => rack.inletC >= rack.limitC).length;
  return { timestamp, peakInletC: round(peakInletC), meanInletC: round(meanInletC), thermalHeadroomC: round(thermalHeadroomC), hotspot: violations > 0, violations, racks };
}

function groupRows(rows: ReplayInputRow[], startAt: number, endAt: number) {
  const groups = new Map<number, ReplayInputRow[]>();
  for (const row of rows) {
    if (row.timestamp < startAt || row.timestamp > endAt) continue;
    const group = groups.get(row.timestamp) ?? [];
    group.push(row);
    groups.set(row.timestamp, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b);
}

function run(layout: SimLayout, groups: Array<[number, ReplayInputRow[]]>): ReplayRawPoint[] {
  const initialLayout = layoutForInputs(layout, groups[0][1]);
  let state = createSimState(initialLayout);
  // The sandbox kernel defaults to 30°C. A complete historical inlet state at
  // this branch's selected boundary replaces it; otherwise callers disclose
  // this documented synthetic initial condition in scenario/result metadata.
  const measuredInitial = groups[0][1].filter((row) => row.initialInletC !== null);
  if (measuredInitial.length === groups[0][1].length) {
    state = { inletC: Object.fromEntries(measuredInitial.map((row) => [row.rackId, row.initialInletC!])) };
  }
  // Each row is a left-hand boundary condition. Publish the explicit state at
  // the first timestamp, then publish every interval at its end timestamp.
  // Future rows are never used to describe past state.
  const output: ReplayRawPoint[] = [summarizePoint(groups[0][0], initialLayout, state)];
  for (let index = 0; index < groups.length - 1; index += 1) {
    const [timestamp, rows] = groups[index];
    const nextAt = groups[index + 1][0];
    const input = layoutForInputs(layout, rows);
    const seconds = Math.max(0, nextAt - timestamp);
    // The physics remains fixed at SIM_DT_S. We batch only an unchanged input interval.
    state = stepSim(state, input, "baseline", Math.round(seconds / SIM_DT_S));
    output.push(summarizePoint(nextAt, input, state));
  }
  return output;
}

function comparison(baseline: number, candidate: number) {
  return { baseline: round(baseline), candidate: round(candidate), difference: round(candidate - baseline) };
}

function metrics(points: ReplayRawPoint[]) {
  const intervals = points.slice(1).map((end, index) => ({
    start: points[index],
    end,
    duration: Math.max(0, end.timestamp - points[index].timestamp),
  }));
  const totalDuration = intervals.reduce((sum, interval) => sum + interval.duration, 0);
  return {
    peak: Math.max(...points.map((point) => point.peakInletC)),
    // Both real endpoint states contribute over every real timestamp interval.
    // A final boundary never receives invented duration.
    mean: intervals.reduce((sum, interval) => sum + ((interval.start.meanInletC + interval.end.meanInletC) / 2) * interval.duration, 0) / Math.max(1, totalDuration),
    headroom: Math.min(...points.map((point) => point.thermalHeadroomC)),
    hotspotDuration: intervals.reduce((sum, interval) => sum + (interval.end.hotspot ? interval.duration : 0), 0),
    violations: intervals.reduce((sum, interval) => sum + interval.end.violations, 0),
  };
}

export function runHistoricalReplay(scenario: HistoricalScenario, dataset: HistoricalDataset): HistoricalReplayResult {
  if (scenario.validationStatus !== "VALID" || !dataset.validation.valid) throw new RangeError("Historical replay is unavailable until all required inputs validate.");
  if (scenario.datasetId !== dataset.id || scenario.facilityId !== dataset.facilityId) throw new RangeError("Scenario and dataset must belong to the same facility.");
  const groups = groupRows(dataset.rows, scenario.periodStartAt, scenario.periodEndAt);
  if (groups.length < 2) throw new RangeError("The selected period needs at least two validated historical timestamps.");
  const baselineLayout = modelLayout(scenario.baselineModelConfig);
  const candidate = candidateLayout(scenario.baselineModelConfig, scenario);
  const baselineRawOutputs = run(baselineLayout, groups);
  const candidateRawOutputs = run(candidate, groups);
  const hasInitialInlets = hasHistoricalInitialInlets(dataset.rows, scenario.periodStartAt, supportedReplayRackIds(scenario.baselineModelConfig));
  const initialConditionDisclosure = hasInitialInlets
    ? "Complete historical initial_inlet_c values initialize both branches at the selected period boundary."
    : "No complete historical initial_inlet_c values exist at the selected boundary; both branches use the documented 30°C synthetic initial thermal state.";
  const base = metrics(baselineRawOutputs);
  const proposed = metrics(candidateRawOutputs);
  const toSeries = ({ racks, ...point }: ReplayRawPoint): ReplayTimePoint => point;
  return {
    scenarioId: scenario.id, simulated: true, source: dataset.source, sourceName: dataset.sourceName,
    period: { startAt: scenario.periodStartAt, endAt: scenario.periodEndAt },
    model: { versionId: scenario.historicalModelVersionId, config: structuredClone(scenario.baselineModelConfig) },
    inputFingerprint: dataset.checksum,
    assumptions: [...new Set([...scenario.assumptions, initialConditionDisclosure])],
    missingInputs: [...new Set([...scenario.missingInputs, ...(hasInitialInlets ? [] : ["initial_inlet_c"])])],
    validationStatus: scenario.validationStatus,
    method: "CONSTRAINED_SPATIAL_THERMAL_APPROXIMATION",
    limitation: "Simulated, uncalibrated reduced-order thermal approximation. Spatial effects are constrained local distance/crowding terms, not validated CFD or measured telemetry.",
    metrics: {
      thermalPeakC: comparison(base.peak, proposed.peak),
      meanInletC: comparison(base.mean, proposed.mean),
      thermalHeadroomC: comparison(base.headroom, proposed.headroom),
      hotspotDurationS: comparison(base.hotspotDuration, proposed.hotspotDuration),
      thermalLimitViolations: comparison(base.violations, proposed.violations),
    },
    unsupportedMetrics: ["Cooling, fan, and energy effects are unavailable: this replay does not calculate energy savings."],
    spatialLayouts: {
      relocatedRackId: scenario.relocation.rackId,
      baselineRacks: baselineLayout.items.filter((item) => item.kind === "rack").map((item) => ({ rackId: item.id, x: item.cell.x, z: item.cell.z })),
      candidateRacks: candidate.items.filter((item) => item.kind === "rack").map((item) => ({ rackId: item.id, x: item.cell.x, z: item.cell.z })),
    },
    baselineSeries: baselineRawOutputs.map(toSeries),
    candidateSeries: candidateRawOutputs.map(toSeries),
    baselineRawOutputs, candidateRawOutputs,
  };
}