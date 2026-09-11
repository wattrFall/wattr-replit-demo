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
  /**
   * How much heat the node holds: 0 is cool and 1 is at its limit or capacity;
   * above 1 is past it. Absent in the topology view, which shows structure only.
   */
  heat?: number;
  /** What the heat reading compares, such as "load against capacity". */
  heatBasis?: string;
  /** The readings shown when the node is expanded. */
  facts?: Array<{ label: string; value: string }>;
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

const kw = (value: number) => `${Math.round(value).toLocaleString()} kW`;

/**
 * How much heat each node holds in a view. A rack reads its inlet against its
 * limit, a cooling unit or chiller its load against its capacity, and the
 * workload its IT power against the facility's rated capacity. The forecast
 * view projects every rack by the forecast rise in the facility's peak inlet.
 */
function heatReadings(snapshot: CockpitSnapshot, view: GraphView): Map<string, Pick<ThermalGraphNode, "heat" | "heatBasis" | "facts">> {
  const readings = new Map<string, Pick<ThermalGraphNode, "heat" | "heatBasis" | "facts">>();
  if (view === "topology") return readings;
  const plant = facilityPlant(snapshot.modelConfig);
  const { workload } = facilityAssets(snapshot.modelConfig);
  const itemsById = new Map(plant.items.map((item) => [item.id, item]));
  const racks = new Map(snapshot.racks.map((rack) => [rack.id, rack]));
  const riseC = view === "forecast" ? Math.max(0, snapshot.forecast.baselinePeakC - snapshot.peakInletC) : 0;

  for (const rack of snapshot.racks) {
    const inletC = rack.inletC + riseC;
    readings.set(rack.id, {
      heat: (inletC - 20) / Math.max(1, rack.limitC - 20),
      heatBasis: view === "forecast" ? "projected inlet against limit" : "inlet against limit",
      facts: [
        { label: view === "forecast" ? "Projected inlet" : "Inlet", value: `${inletC.toFixed(1)}°C` },
        { label: "Limit", value: `${rack.limitC.toFixed(1)}°C` },
        { label: "Margin", value: `${(rack.limitC - inletC).toFixed(1)}°C` },
        { label: "IT heat", value: kw(rack.heatKw) },
      ],
    });
  }

  const unitLoadKw = new Map<string, number>();
  for (const unit of plant.items.filter((item) => item.kind === "cdu" || item.kind === "crac")) {
    const served = plant.connections
      .filter((link) => link.fromId === unit.id)
      .map((link) => itemsById.get(link.toId))
      .filter((item): item is SandboxItem => item?.kind === "rack");
    const loadKw = served.reduce((sum, item) => sum + (racks.get(twinAssetId(item))?.heatKw ?? 0), 0);
    const capacityKw = unit.params.capacityKw;
    unitLoadKw.set(unit.id, loadKw);
    readings.set(unit.id, {
      heat: loadKw / Math.max(1, capacityKw),
      heatBasis: "load against capacity",
      facts: [
        { label: "Load", value: kw(loadKw) },
        { label: "Capacity", value: kw(capacityKw) },
        { label: "Headroom", value: kw(capacityKw - loadKw) },
        { label: "Serves", value: `${served.length} ${served.length === 1 ? "rack" : "racks"}` },
      ],
    });
  }
  for (const chiller of plant.items.filter((item) => item.kind === "chiller")) {
    const loadKw = plant.connections
      .filter((link) => link.fromId === chiller.id)
      .reduce((sum, link) => sum + (unitLoadKw.get(link.toId) ?? 0), 0);
    const capacityKw = chiller.params.capacityKw;
    readings.set(chiller.id, {
      heat: loadKw / Math.max(1, capacityKw),
      heatBasis: "heat rejected against capacity",
      facts: [
        { label: "Rejecting", value: kw(loadKw) },
        { label: "Capacity", value: kw(capacityKw) },
        { label: "Headroom", value: kw(capacityKw - loadKw) },
        { label: "Chilled water", value: `${snapshot.chilledWaterC.toFixed(1)}°C` },
      ],
    });
  }
  readings.set(workload.id, {
    heat: snapshot.itPowerKw / Math.max(1, snapshot.plant.ratedCapacityKw),
    heatBasis: "IT power against rated capacity",
    facts: [
      { label: "IT power", value: kw(snapshot.itPowerKw) },
      { label: "Workload", value: `${snapshot.workloadPercent}%` },
      { label: "Rated capacity", value: kw(snapshot.plant.ratedCapacityKw) },
      { label: "Headroom", value: kw(snapshot.headroomKw) },
    ],
  });
  // The SFO-01 graph also shows the loops between its CDU and its chiller;
  // each carries the heat of the equipment it joins.
  if (!snapshot.modelConfig.layout) {
    const secondary = readings.get("cdu-03");
    const primary = readings.get("chiller-01");
    if (secondary) readings.set("loop-b", secondary);
    if (primary) readings.set("primary", primary);
  }
  return readings;
}

export function thermalGraph(snapshot: CockpitSnapshot, view: GraphView = "current"): {
  nodes: ThermalGraphNode[];
  edges: ThermalGraphEdge[];
} {
  // A published build gets a graph generated from its layout. Models saved
  // before the Builder keep the curated SFO-01 graph, whose ids match the
  // seeded topology, incident and assistant records.
  const graph = snapshot.modelConfig.layout ? buildThermalGraph(snapshot, view) : referenceThermalGraph(snapshot, view);
  const readings = heatReadings(snapshot, view);
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, ...readings.get(node.id) })) };
}

function referenceThermalGraph(snapshot: CockpitSnapshot, view: GraphView): {
  nodes: ThermalGraphNode[];
  edges: ThermalGraphEdge[];
} {
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