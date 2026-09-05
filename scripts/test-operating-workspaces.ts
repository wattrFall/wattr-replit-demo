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
assert(cdu.downstream.some((node) => node.id === "chiller-01"), "CDU traversal must reach heat rejection");
assert(cdu.impact.some((node) => node.id === "A01"), "CDU impact must include served racks");
assert.deepEqual(cdu.impact.map((node) => node.id).sort(), ["A01", "A02", "B01", "B02"], "CDU impact must contain exactly the served racks");

const comparison = compareControllers(baseline);
assert.equal(new Set(comparison.results.map((row) => row.id)).size, 3);
assert(comparison.results.every((row) => Number.isFinite(row.peakC)));
assert.equal(comparison.simulatedAt, baseline.simulatedAt);
assert.equal(comparison.results.find((row) => row.id === "snn-rl")?.coolingEnergyKwh, null);
assert.match(comparison.results.find((row) => row.id === "snn-rl")?.architecturalValue ?? "", /Unavailable/);
assert(new Set(comparison.events).size === baseline.checkpoints.length, "controllers must receive one identical event stream");
assert.equal(new Set(comparison.results.map((row) => row.inputFingerprint)).size, 1, "all controllers must receive identical inputs");
assert.equal(
  Math.round((comparison.results.find((row) => row.id === "baseline")?.peakC ?? 0) * 10) / 10,
  baseline.forecast.baselinePeakC,
  "Model Lab baseline must start from the snapshot's exact thermal state",
);
assert(
  comparison.results.every((row) => row.degreeMinutes <= Math.max(0, row.peakC - baseline.incident.limitC) * 5),
  "degree-minutes must integrate the trajectory rather than multiply peak by duration",
);

console.log("Operating workspace model, traversal, and comparison tests passed.");