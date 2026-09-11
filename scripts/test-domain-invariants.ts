import assert from "node:assert/strict";
import {
  DEFAULT_FACILITY_MODEL,
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  advanceCockpitSimulation,
  counterfactualCockpitSnapshot,
  createCockpitSimulation,
  replayCockpitSnapshot,
  scenarioLayout,
} from "../src/lib/cockpit/simulation";
import { compareControllers, graphSelection, thermalGraph } from "../src/lib/cockpit/workspaces";
import {
  createSimState,
  readTelemetry,
  resolvePlant,
  stepSim,
} from "../src/lib/sandbox/model";
import type { SimLayout } from "../src/lib/sandbox/types";
import { useScenarioSession } from "../src/lib/cockpit/session";

const assertFinite = (value: unknown, path = "value"): void => {
  if (typeof value === "number") assert(Number.isFinite(value), `${path} must be finite`);
  else if (Array.isArray(value)) value.forEach((item, index) => assertFinite(item, `${path}[${index}]`));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) assertFinite(child, `${path}.${key}`);
  }
};

const layout = scenarioLayout(SCENARIO_START_S, SCENARIO_START_S, "baseline");
assert.equal(layout.items.filter((item) => item.kind === "rack").length, 4);
assert.equal(layout.items.filter((item) => item.kind === "cdu").length, 1);
assert.equal(layout.items.filter((item) => item.kind === "chiller").length, 1);
assert.equal(layout.connections.length, 5);
assert.deepEqual(
  layout.connections.map((connection) => [connection.fromId, connection.toId]),
  [
    ["chiller-01", "cdu-03"],
    ["cdu-03", "rack-a01"],
    ["cdu-03", "rack-a02"],
    ["cdu-03", "rack-b01"],
    ["cdu-03", "rack-b02"],
  ],
);

const checkpoints = [0, 1, 30, 300, 900, SCENARIO_DURATION_S];
let previousPower = 0;
let previousTemperature = 0;
for (const elapsedS of checkpoints) {
  const simulation = advanceCockpitSimulation(
    createCockpitSimulation(SCENARIO_START_S),
    elapsedS,
    SCENARIO_START_S,
  );
  const { snapshot } = simulation;
  assertFinite(snapshot, `snapshot at ${elapsedS}s`);
  assert.equal(snapshot.elapsedS, elapsedS);
  assert.equal(snapshot.rackCount, 4);
  assert(snapshot.itPowerKw >= previousPower, "workload ramp must not reduce IT power");
  assert(snapshot.peakInletC >= previousTemperature, "workload ramp must not reduce peak inlet temperature");
  assert(snapshot.racks.every((rack) => rack.inletC >= 20 && rack.inletC <= 50), "rack temperature escaped model bounds");
  assert(snapshot.forecast.series.length === snapshot.forecast.horizonS, "forecast horizon and series diverged");
  assert(snapshot.forecast.baselinePeakC >= snapshot.peakInletC, "forecast must not understate current peak");
  previousPower = snapshot.itPowerKw;
  previousTemperature = snapshot.peakInletC;
}

const baseline = replayCockpitSnapshot(SCENARIO_START_S + 900);
const advisory = counterfactualCockpitSnapshot(
  SCENARIO_START_S + 900,
  { flowPercent: 78, durationMinutes: 20 },
);
assert(advisory.recommendation.advisoryPeakC <= baseline.forecast.baselinePeakC);
assert(advisory.recommendation.command.flowPercent === 78);
assert(advisory.recommendation.command.durationMinutes === 20);
const comparison = compareControllers(baseline);
assert.deepEqual(comparison.results.map((result) => result.id), ["baseline", "ann-rl", "snn-rl"]);
assert(comparison.results[2].peakMarginC >= comparison.results[1].peakMarginC);

const unservedLayout: SimLayout = {
  items: layout.items,
  connections: layout.connections.filter(
    (connection) => !connection.toId.startsWith("rack-"),
  ),
};
const unservedState = stepSim(
  createSimState(unservedLayout),
  unservedLayout,
  "baseline",
  30 * 60,
);
const unservedTelemetry = readTelemetry(unservedState, unservedLayout, "baseline");
assert.equal(unservedTelemetry.unservedRacks, 4);
assert(unservedTelemetry.maxInletC !== null && unservedTelemetry.maxInletC > 30);

const coolingLagLayout = scenarioLayout(SCENARIO_START_S + 900, SCENARIO_START_S, "baseline", {
  ...DEFAULT_FACILITY_MODEL,
  responseLag: 60,
});
const normalPlant = resolvePlant(
  scenarioLayout(SCENARIO_START_S + 900, SCENARIO_START_S, "baseline"),
  "baseline",
);
const laggedPlant = resolvePlant(coolingLagLayout, "baseline");
assert.notDeepEqual(laggedPlant.controls, normalPlant.controls, "response lag must affect plant controls");
const noLoadLayout: SimLayout = {
  ...layout,
  items: layout.items.map((item) =>
    item.kind === "rack"
      ? { ...item, params: { ...item.params, utilisationPct: 0 } }
      : item,
  ),
};
const noLoadState = stepSim(createSimState(noLoadLayout), noLoadLayout, "baseline", 30 * 10);
assert(
  Object.values(noLoadState.inletC).every((temperature) => temperature < 30),
  "zero workload must cool from the initial temperature",
);

assert.throws(
  () => replayCockpitSnapshot(SCENARIO_START_S - 1),
  /outside the GPU Training Ramp/,
);
assert.throws(
  () => replayCockpitSnapshot(SCENARIO_START_S + SCENARIO_DURATION_S + 1),
  /outside the GPU Training Ramp/,
);
const session = useScenarioSession.getState();
session.reset();
session.jump(900);
assert.equal(useScenarioSession.getState().simulation.snapshot.elapsedS, 900);
session.reset();
assert.equal(useScenarioSession.getState().simulation.snapshot.elapsedS, 0);

const graph = thermalGraph(baseline, "current");
assert.equal(graph.nodes.length, 9);
assert.equal(graph.edges.length, 11);
const selection = graphSelection(graph, "cdu-03");
assert(selection.upstream.some((node) => node.id === "B02"));
assert(selection.downstream.some((node) => node.id === "chiller-01"));
assert.deepEqual(selection.impact.map((node) => node.id).sort(), ["A01", "A02", "B01", "B02"]);

console.log("Domain invariants, topology, bounds, lag, offline equipment, reset, comparison, and graph checks passed.");