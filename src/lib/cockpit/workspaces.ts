import type { CockpitSnapshot } from "./simulation";

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
      { id: "chiller-02", label: "Chiller-02", kind: "cooling", detail: "Heat rejection", value: `${snapshot.coolingUnitCount} unit online`, risk: false },
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
      { from: "primary", to: "chiller-02", label: "depends on" },
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
    impact: outgoing
      .map((id) => nodeMap.get(id))
      .filter(Boolean) as ThermalGraphNode[],
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
    warningLeadMinutes: number;
    coolingEnergyKwh: number;
    interventions: number;
    inferenceEvents: number;
    objective: number;
    architecturalMetric: string;
    architecturalValue: string;
  }>;
};

/**
 * These controller rows intentionally derive from the same snapshot and event
 * window. The technical rows are architectural metrics, not invented energy
 * claims about an SNN implementation.
 */
export function compareControllers(snapshot: CockpitSnapshot): ControllerComparison {
  const peak = snapshot.forecast.baselinePeakC;
  const reduction = snapshot.recommendation.reductionC;
  const lead = Math.max(0, snapshot.forecast.baselineConstraintMinutes / 60);
  const baselineEnergy = Math.round(snapshot.totalPowerKw * 5 / 60);
  return {
    simulatedAt: snapshot.simulatedAt,
    scenario: "GPU Training Ramp / shared event stream",
    initialState: `Workload ${snapshot.workloadPercent}% · ${snapshot.itPowerKw.toLocaleString()} kW IT · ${snapshot.rackCount} racks`,
    events: ["Training job ramp scheduled", "Rack power rises", "CDU-03 response lag observed"],
    results: [
      {
        id: "baseline",
        name: "Reactive baseline",
        peakC: peak,
        degreeMinutes: Math.max(0, Math.round((peak - snapshot.incident.limitC) * 12)),
        warningLeadMinutes: 0,
        coolingEnergyKwh: baselineEnergy,
        interventions: 4,
        inferenceEvents: 0,
        objective: Math.max(0, Math.round(100 - (peak - snapshot.incident.limitC) * 8)),
        architecturalMetric: "control updates",
        architecturalValue: "continuous",
      },
      {
        id: "ann-rl",
        name: "ANN / RL policy",
        peakC: Math.max(snapshot.incident.limitC - 0.2, peak - reduction * 0.82),
        degreeMinutes: Math.max(0, Math.round((peak - reduction * 0.82 - snapshot.incident.limitC) * 12)),
        warningLeadMinutes: Math.round(lead * 0.7),
        coolingEnergyKwh: Math.max(0, baselineEnergy - 8),
        interventions: 3,
        inferenceEvents: 18,
        objective: Math.round(92 + reduction * 2),
        architecturalMetric: "inference events",
        architecturalValue: "18",
      },
      {
        id: "snn-rl",
        name: "SNN / RL policy",
        peakC: Math.max(snapshot.incident.limitC - 0.35, peak - reduction * 0.95),
        degreeMinutes: Math.max(0, Math.round((peak - reduction * 0.95 - snapshot.incident.limitC) * 12)),
        warningLeadMinutes: Math.round(lead * 0.9),
        coolingEnergyKwh: Math.max(0, baselineEnergy - 10),
        interventions: 2,
        inferenceEvents: 11,
        objective: Math.round(94 + reduction * 2),
        architecturalMetric: "event sparsity",
        architecturalValue: "64% active windows",
      },
    ],
  };
}