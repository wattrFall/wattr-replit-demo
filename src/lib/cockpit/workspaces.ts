import {
  COMMAND_ENVELOPE,
  DEFAULT_ADVISORY_PARAMETERS,
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

export function thermalGraph(snapshot: CockpitSnapshot, view: GraphView = "current"): {
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
    objective: number;
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
      warningLeadMinutes: controller.id === "baseline" ? 0 : null,
      coolingEnergyKwh: controller.id === "snn-rl" ? null : Math.round(run.coolingEnergyKwh * 10) / 10,
      interventions: controller.id === "baseline" ? 0 : 1,
      inferenceEvents: null,
      objective: Math.max(0, Math.round(100 - Math.max(0, run.peakC - snapshot.incident.limitC) * 10)),
      architecturalMetric: controller.id === "snn-rl" ? "SNN compute energy" : "control architecture",
      architecturalValue: controller.id === "snn-rl" ? "Unavailable — no measured implementation" : controller.id === "ann-rl" ? "Dense policy evaluation" : "Fixed reactive setpoint",
      inputFingerprint,
    })),
  };
}