import type { SandboxItem } from "@/lib/sandbox/types";
import { facilityAssets, twinAssetId } from "./facilityAssets";
import {
  COMMAND_ENVELOPE,
  DEFAULT_ADVISORY_PARAMETERS,
  facilityPlant,
  simulateVariant,
  type CockpitSnapshot,
} from "./simulation";

export type GraphView = "topology" | "current" | "forecast";

export type ThermalGraphNode = {
  id: string;
  label: string;
  kind: string;
  detail: string;
  value: string;
  risk?: boolean;
};

export type ThermalGraphEdge = {
  from: string;
  to: string;
  label: string;
};

/**
 * The heat-flow graph of a published build, generated from its layout: the
 * workload heats every rack, each rack is cooled by the units wired to it, and
 * those units return heat to the chillers feeding them.
 */
function buildThermalGraph(snapshot: CockpitSnapshot, view: GraphView): {
  nodes: ThermalGraphNode[];
  edges: ThermalGraphEdge[];
} {
  const plant = facilityPlant(snapshot.modelConfig);
  const { workload, byId } = facilityAssets(snapshot.modelConfig);
  const risk = snapshot.incident.open;
  const itemsById = new Map(plant.items.map((item) => [item.id, item]));
  const rackValue = (inletC: number) => view === "topology" ? "Thermal asset" : view === "forecast" ? `${snapshot.forecast.baselinePeakC.toFixed(1)}°C forecast` : `${inletC.toFixed(1)}°C current`;
  const coolingValue = (unit: SandboxItem) => {
    const advised = unit.id === plant.advisedUnit.id;
    if (view === "topology") return unit.kind === "cdu" ? "Racks → coolant loop" : "Racks → cooling air";
    if (view === "forecast") return advised ? `${snapshot.recommendation.flowPercent}% advisory` : "Baseline command";
    return `${snapshot.fanPercent}% mean fan`;
  };
  const labelOf = (item: SandboxItem) => byId.get(twinAssetId(item))?.label ?? item.id;

  const nodes: ThermalGraphNode[] = [
    { id: workload.id, label: workload.label, kind: "workload", detail: "GPU Training Ramp", value: `${snapshot.workloadPercent}% load`, risk },
    ...snapshot.racks.map((rack) => ({
      id: rack.id,
      label: `Rack ${rack.id}`,
      kind: "rack",
      detail: rack.atRisk ? "Forecast constraint" : "Within margin",
      value: rackValue(rack.inletC),
      risk: rack.atRisk,
    })),
    ...plant.items
      .filter((item) => item.kind === "cdu" || item.kind === "crac")
      .map((unit) => ({
        id: unit.id,
        label: labelOf(unit),
        kind: "cooling",
        detail: unit.kind === "cdu" ? "Cooling distribution unit" : "Computer room air conditioner",
        value: coolingValue(unit),
        risk: risk && unit.id === plant.advisedUnit.id,
      })),
    ...plant.items
      .filter((item) => item.kind === "chiller")
      .map((chiller) => ({
        id: chiller.id,
        label: labelOf(chiller),
        kind: "cooling",
        detail: "Heat rejection",
        value: `${snapshot.chilledWaterC.toFixed(1)}°C water`,
        risk: false,
      })),
  ];
  const edges: ThermalGraphEdge[] = [
    ...snapshot.racks.map((rack) => ({ from: workload.id, to: rack.id, label: "generates heat" })),
    ...plant.connections.flatMap((link) => {
      const from = itemsById.get(link.fromId);
      const to = itemsById.get(link.toId);
      if (!from || !to) return [];
      if (to.kind === "rack") return [{ from: twinAssetId(to), to: from.id, label: "is cooled by" }];
      if (from.kind === "chiller") return [{ from: to.id, to: from.id, label: "returns heat to" }];
      return [];
    }),
  ];
  return { nodes, edges };
}

export function thermalGraph(snapshot: CockpitSnapshot, view: GraphView = "current"): {
  nodes: ThermalGraphNode[];
  edges: ThermalGraphEdge[];
} {
  // A published build gets a graph generated from its layout. Models saved
  // before the Builder keep the curated SFO-01 graph below, whose ids match
  // the seeded topology, incident and assistant records.
  if (snapshot.modelConfig.layout) return buildThermalGraph(snapshot, view);
  const risk = snapshot.incident.open;
  const rackValue = (inletC: number) => view === "topology" ? "Thermal asset" : view === "forecast" ? `${snapshot.forecast.baselinePeakC.toFixed(1)}°C forecast` : `${inletC.toFixed(1)}°C current`;
  return {
    nodes: [
      { id: "gpu-b", label: "GPU Cluster B", kind: "workload", detail: "GPU Training Ramp", value: `${snapshot.workloadPercent}% load`, risk },
      ...snapshot.racks.map((rack) => ({
        id: rack.id,
        label: `Rack ${rack.id}`,
        kind: "rack",
        detail: rack.atRisk ? "Forecast constraint" : "Within margin",
        value: rackValue(rack.inletC),
        risk: rack.atRisk,
      })),
      { id: "loop-b", label: "Liquid Loop B", kind: "loop", detail: "Secondary cooling loop", value: "Active", risk },
      { id: "cdu-03", label: "CDU-03", kind: "cooling", detail: "Cooling distribution unit", value: view === "topology" ? "Rack → primary loop" : view === "forecast" ? `${snapshot.recommendation.flowPercent}% advisory` : `${snapshot.fanPercent}% fan`, risk },
      { id: "primary", label: "Primary Cooling Loop", kind: "loop", detail: "Facility water circuit", value: `${snapshot.chilledWaterC.toFixed(1)}°C`, risk: false },
      { id: "chiller-01", label: "Chiller-01", kind: "cooling", detail: "Heat rejection", value: `${snapshot.coolingUnitCount} unit online`, risk: false },
    ],
    edges: [
      { from: "gpu-b", to: "A01", label: "generates heat" },
      { from: "gpu-b", to: "A02", label: "generates heat" },
      { from: "gpu-b", to: "B01", label: "generates heat" },
      { from: "gpu-b", to: "B02", label: "generates heat" },
      { from: "A01", to: "loop-b", label: "thermally influences" },
      { from: "A02", to: "loop-b", label: "thermally influences" },
      { from: "B01", to: "loop-b", label: "thermally influences" },
      { from: "B02", to: "loop-b", label: "thermally influences" },
      { from: "loop-b", to: "cdu-03", label: "receives coolant from" },
      { from: "cdu-03", to: "primary", label: "returns heat to" },
      { from: "primary", to: "chiller-01", label: "depends on" },
    ],
  };
}

export function graphSelection(
  graph: ReturnType<typeof thermalGraph>,
  selectedId: string,
): { upstream: ThermalGraphNode[]; downstream: ThermalGraphNode[]; impact: ThermalGraphNode[] } {
  const walk = (start: string, direction: "up" | "down") => {
    const visited = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      const next = graph.edges
        .filter((edge) => direction === "up" ? edge.to === current : edge.from === current)
        .map((edge) => direction === "up" ? edge.from : edge.to);
      for (const id of next) {
        if (id === start || visited.has(id)) continue;
        visited.add(id);
        queue.push(id);
      }
    }
    return [...visited];
  };
  const incoming = walk(selectedId, "up");
  const outgoing = walk(selectedId, "down");
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  return {
    upstream: incoming.map((id) => nodeMap.get(id)).filter(Boolean) as ThermalGraphNode[],
    downstream: outgoing.map((id) => nodeMap.get(id)).filter(Boolean) as ThermalGraphNode[],
    impact: [...new Set([...incoming, ...outgoing])]
      .map((id) => nodeMap.get(id))
      .filter((node): node is ThermalGraphNode => Boolean(node) && node?.kind === "rack"),
  };
}

export type ControllerComparison = {
  simulatedAt: number;
  scenario: string;
  initialState: string;
  events: string[];
  results: Array<{
    id: "baseline" | "ann-rl" | "snn-rl";
    name: string;
    peakC: number;
    degreeMinutes: number;
    warningLeadMinutes: number | null;
    coolingEnergyKwh: number | null;
    interventions: number;
    inferenceEvents: number | null;
    /** °C between the run's peak and the rack inlet limit; negative above the limit. */
    peakMarginC: number;
    architecturalMetric: string;
    architecturalValue: string;
    inputFingerprint: string;
  }>;
};

/**
 * These controller rows intentionally derive from the same snapshot and event
 * window. The technical rows are architectural metrics, not invented energy
 * claims about an SNN implementation.
 */
export function compareControllers(snapshot: CockpitSnapshot): ControllerComparison {
  const initialState = snapshot.baselineTelemetry;
  const thermal = snapshot.thermalState;
  const shared = [
    { id: "baseline" as const, name: "Reactive baseline", variant: "baseline" as const, flowPercent: 70, durationMinutes: 0 },
    { id: "ann-rl" as const, name: "ANN / RL policy", variant: "advisory" as const, ...DEFAULT_ADVISORY_PARAMETERS },
    { id: "snn-rl" as const, name: "SNN / RL policy", variant: "alternative" as const, flowPercent: COMMAND_ENVELOPE.maxFlowPercent, durationMinutes: 10 },
  ];
  const inputFingerprint = [
    snapshot.simulatedAt,
    snapshot.modelConfig.seed,
    snapshot.modelConfig.thermalMass,
    snapshot.modelConfig.responseLag,
    snapshot.racks.map((rack) => `${rack.id}:${rack.inletC}`).join(","),
    snapshot.checkpoints.map((event) => `${event.id}:${event.elapsedS}`).join(","),
  ].join("|");
  const runs = shared.map((controller) => ({
    controller,
    run: simulateVariant(
      thermal,
      snapshot.simulatedAt - snapshot.elapsedS,
      snapshot.simulatedAt,
      controller.variant,
      snapshot.modelConfig,
      { flowPercent: controller.flowPercent, durationMinutes: controller.durationMinutes },
    ),
  }));
  const limitC = snapshot.incident.limitC;
  // Minutes until the uncontrolled trajectory first reaches the limit, if it
  // does within the horizon. A predictive policy can warn that far ahead; a
  // reactive controller only warns once the limit is reached.
  const uncontrolled = runs.find(({ controller }) => controller.variant === "baseline")?.run;
  const crossing = uncontrolled?.points.find((point) => point.baselinePeakC >= limitC);
  const crossingMinutes = crossing ? Math.round((crossing.offsetS / 60) * 10) / 10 : null;
  return {
    simulatedAt: snapshot.simulatedAt,
    scenario: "GPU Training Ramp / shared event stream",
    initialState: `Workload ${snapshot.workloadPercent}% · ${initialState.itPowerKw.toLocaleString()} kW IT · ${snapshot.rackCount} racks`,
    events: snapshot.checkpoints.map((event) => `${event.elapsedS}s ${event.label}`),
    results: runs.map(({ controller, run }) => ({
      id: controller.id,
      name: controller.name,
      peakC: run.peakC,
      degreeMinutes: run.degreeMinutes,
      warningLeadMinutes: crossingMinutes === null ? null : controller.variant === "baseline" ? 0 : crossingMinutes,
      coolingEnergyKwh: controller.id === "snn-rl" ? null : Math.round(run.coolingEnergyKwh * 10) / 10,
      interventions: controller.durationMinutes > 0 ? 1 : 0,
      inferenceEvents: null,
      peakMarginC: Math.round((limitC - run.peakC) * 10) / 10,
      architecturalMetric: controller.id === "snn-rl" ? "SNN compute energy" : "control architecture",
      architecturalValue: controller.id === "snn-rl" ? "Unavailable — no measured implementation" : controller.id === "ann-rl" ? "Dense policy evaluation" : "Fixed reactive setpoint",
      inputFingerprint,
    })),
  };
}