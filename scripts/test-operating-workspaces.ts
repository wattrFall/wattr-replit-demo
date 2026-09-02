import assert from "node:assert/strict";
import {
  DEFAULT_FACILITY_MODEL,
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  replayCockpitSnapshot,
} from "../src/lib/cockpit/simulation";
import { compareControllers, graphSelection, thermalGraph } from "../src/lib/cockpit/workspaces";

const simulatedAt = SCENARIO_START_S + SCENARIO_DURATION_S;
const baseline = replayCockpitSnapshot(simulatedAt, DEFAULT_FACILITY_MODEL);
const alternate = replayCockpitSnapshot(simulatedAt, {
  ...DEFAULT_FACILITY_MODEL,
  thermalMass: 1.5,
  responseLag: 80,
});
assert.notEqual(
  alternate.forecast.baselinePeakC,
  baseline.forecast.baselinePeakC,
  "published model parameters must change replay output",
);

const graph = thermalGraph(baseline, "forecast");
const cdu = graphSelection(graph, "cdu-03");
assert(cdu.upstream.some((node) => node.id === "gpu-b"), "CDU traversal must reach the workload source");
assert(cdu.downstream.some((node) => node.id === "chiller-02"), "CDU traversal must reach heat rejection");

const comparison = compareControllers(baseline);
assert.equal(new Set(comparison.results.map((row) => row.id)).size, 3);
assert(comparison.results.every((row) => Number.isFinite(row.peakC)));
assert.equal(comparison.simulatedAt, baseline.simulatedAt);

console.log("Operating workspace model, traversal, and comparison tests passed.");