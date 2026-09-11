import assert from "node:assert/strict";
import {
  DEFAULT_FACILITY_MODEL,
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  replayCockpitSnapshot,
} from "../src/lib/cockpit/simulation";
import { compareControllers, graphSelection, thermalGraph } from "../src/lib/cockpit/workspaces";
import { useScenarioSession } from "../src/lib/cockpit/session";
import { incidentStateAt, selectIncident } from "../src/lib/cockpit/incidents";

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

// Model Lab values come from each run rather than fixed placeholders.
const opening = compareControllers(replayCockpitSnapshot(SCENARIO_START_S));
assert(opening.results.every((row) => row.warningLeadMinutes === null), "no warning lead without a limit crossing in the horizon");
assert(new Set(opening.results.map((row) => row.peakMarginC)).size > 1, "controllers below the limit must still be distinguishable");
for (const row of [...opening.results, ...comparison.results]) {
  assert.equal(row.peakMarginC, Math.round((baseline.incident.limitC - row.peakC) * 10) / 10, "peak margin must derive from the run's peak");
}
const ramping = compareControllers(replayCockpitSnapshot(SCENARIO_START_S + 300));
const leads = new Map(ramping.results.map((row) => [row.id, row.warningLeadMinutes]));
assert.equal(leads.get("baseline"), 0, "a reactive controller warns only at the limit");
assert((leads.get("ann-rl") ?? 0) > 0, "a predictive policy must warn before the limit crossing");
assert.equal(leads.get("ann-rl"), leads.get("snn-rl"), "policies share one uncontrolled trajectory");
assert.deepEqual(ramping.results.map((row) => row.interventions), [0, 1, 1], "interventions must follow each controller's commands");

// An unknown incident id is reported, never replaced by another incident.
const incidentRecords = [
  { id: "inc-204", status: "OPEN", severity: "HIGH", simulated_at: String(SCENARIO_START_S + 660) },
  { id: "inc-100", status: "RESOLVED", severity: "WATCH", simulated_at: String(SCENARIO_START_S) },
];
assert.deepEqual(selectIncident(incidentRecords, "inc-999"), { incident: undefined, notFound: true });
assert.equal(selectIncident(incidentRecords, "inc-100").incident?.id, "inc-100");
assert.equal(selectIncident(incidentRecords).incident?.id, "inc-204");
assert.equal(selectIncident([], "inc-204").notFound, true);

// Incident status follows the replay instant, as Portfolio's open-incident count does.
for (const elapsedS of [0, 300, 660, 900, SCENARIO_DURATION_S]) {
  const snapshot = replayCockpitSnapshot(SCENARIO_START_S + elapsedS);
  const state = incidentStateAt(incidentRecords[0], snapshot);
  assert.equal(state.status === "OPEN", snapshot.incident.open, `incident page and portfolio disagree at ${elapsedS}s`);
  assert.equal(state.severity, snapshot.incident.open ? snapshot.incident.severity : null);
}
assert.equal(
  incidentStateAt(incidentRecords[0], replayCockpitSnapshot(SCENARIO_START_S)).status,
  "CLEAR",
  "the scenario incident must not read OPEN before the forecast reaches the limit",
);
assert.equal(incidentStateAt(incidentRecords[1], replayCockpitSnapshot(SCENARIO_START_S + 900)).status, "CLEAR", "other records keep their stored status");

const session = useScenarioSession.getState();
session.reset();
session.selectAsset("A02");
session.jump(900);
const sharedAt = useScenarioSession.getState().simulatedAt;
assert.equal(useScenarioSession.getState().selectedAssetId, "A02", "twin and HUD must share selection");
assert.equal(
  thermalGraph(useScenarioSession.getState().simulation.snapshot, "current").nodes.find((node) => node.id === "A02")?.value,
  `${useScenarioSession.getState().simulation.snapshot.racks.find((rack) => rack.id === "A02")?.inletC.toFixed(1)}°C current`,
  "graph must derive from the twin and HUD scenario instant",
);
assert.equal(useScenarioSession.getState().simulation.snapshot.simulatedAt, sharedAt, "timeline must share scenario time");
useScenarioSession.getState().focusTwin({
  assetId: "cdu-03",
  floor: 1,
  path: ["gpu-b", "cdu-03", "chiller-01"],
  incidentId: "inc-204",
  simulatedAt: SCENARIO_START_S + 600,
});
const focused = useScenarioSession.getState();
assert.equal(focused.simulatedAt, SCENARIO_START_S + 600, "assistant focus must restore cited scenario time");
assert.equal(focused.selectedAssetId, "cdu-03", "assistant focus must restore cited asset");
assert.deepEqual(focused.highlightedPath, ["gpu-b", "cdu-03", "chiller-01"]);
assert.equal(focused.focusedIncidentId, "inc-204");
assert.equal(focused.playing, false, "focus and audit reconstruction must pause replay");

console.log("Operating workspace model, traversal, and comparison tests passed.");