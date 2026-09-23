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
import { tutorialPageLabel, tutorialRouteFor } from "../src/lib/cockpit/tutorial";

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

// Tutorial steps name the page they live on instead of redirecting to it.
assert.equal(tutorialRouteFor("/operations", "sfo-01"), "/facilities/sfo-01/operations");
assert.equal(tutorialRouteFor("/portfolio", "sfo-01"), "/portfolio");
assert.equal(tutorialPageLabel("/model-lab"), "Model Lab");
assert.equal(tutorialPageLabel("/model"), "Model Studio");
assert.equal(tutorialPageLabel("/incidents/inc-204"), "Incidents");

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

// A published build gets names, a graph and scenario records from its layout.
const { FACILITY_TEMPLATES } = await import("../src/lib/facility/templates");
const { facilityAssets, itemLabel } = await import("../src/lib/cockpit/facilityAssets");
const { facilityPlant } = await import("../src/lib/cockpit/simulation");
const { REFERENCE_SCENARIO_RECORDS, SCENARIO_INCIDENT_AT, scenarioRecords } = await import("../src/lib/cockpit/scenarioRecords");

const referenceAssets = facilityAssets(DEFAULT_FACILITY_MODEL);
assert.deepEqual(
  referenceAssets.assets.map((asset) => asset.id),
  ["A01", "A02", "B01", "B02", "cdu-03", "chiller-01", "sensor-01", "sensor-02"],
  "the reference twin lists the SFO-01 equipment under the ids its snapshot and graph use",
);
assert.equal(referenceAssets.workload.id, "gpu-b");
assert.equal(referenceAssets.hallLabel, "GPU Hall B");
assert.equal(itemLabel({ id: "chiller-01", kind: "chiller" }), "Chiller-01");
assert.equal(itemLabel({ id: "crac-02", kind: "crac" }), "CRAC-02");
assert.equal(itemLabel({ id: "rack-a01", kind: "rack" }), "Rack A01");

const airModel = { ...DEFAULT_FACILITY_MODEL, layout: FACILITY_TEMPLATES.find((template) => template.id === "air-cooled-rows")!.layout };
const airAssets = facilityAssets(airModel);
assert.equal(airAssets.workload.label, "Data hall workload");
assert.equal(airAssets.byId.get("crac-01")?.label, "CRAC-01");
const airGraph = thermalGraph(replayCockpitSnapshot(simulatedAt, airModel), "forecast");
assert.equal(new Set(airGraph.nodes.map((node) => node.id)).size, airGraph.nodes.length, "graph node ids must be unique");
const nodeIds = new Set(airGraph.nodes.map((node) => node.id));
assert(airGraph.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)), "every graph edge must join two nodes");
const crac = graphSelection(airGraph, "crac-01");
assert.deepEqual(crac.impact.map((node) => node.id).sort(), ["A01", "A02", "A03", "A04", "A05", "A06"], "a CRAC unit's impact is the row it serves");
assert(crac.upstream.some((node) => node.id === airAssets.workload.id), "CRAC traversal must reach the workload source");
assert(crac.downstream.some((node) => node.id === "chiller-01"), "CRAC traversal must reach heat rejection");

assert.equal(SCENARIO_INCIDENT_AT, 1_752_677_460, "scenario records are raised when the seeded incident is");
assert.equal(scenarioRecords(DEFAULT_FACILITY_MODEL), REFERENCE_SCENARIO_RECORDS, "models without a build keep the seeded records");
const airRecords = scenarioRecords(airModel);
assert.equal(airRecords.recommendation.command.assetId, facilityPlant(airModel).advisedUnit.id, "the recommendation commands the advised unit");
assert.match(airRecords.incident.title, /^CRAC-0[12] thermal response degradation$/);
assert.match(airRecords.recommendation.explanation.what, /^Increase CRAC-0[12] flow to 78% for 20 minutes\.$/);
assert(
  airRecords.incident.thermalPath.every((id) => id === airAssets.workload.id || airModel.layout.items.some((item) => item.id === id)),
  "the thermal path names only the build's own equipment",
);

// The session follows a newly published build to a unit that exists in it.
useScenarioSession.getState().reset();
useScenarioSession.getState().selectAsset("cdu-03");
useScenarioSession.getState().setModelConfig(airModel);
assert.equal(useScenarioSession.getState().selectedAssetId, facilityPlant(airModel).advisedUnit.id, "a build without the selected asset selects its advised unit");
assert.equal(useScenarioSession.getState().simulation.snapshot.rackCount, 12, "the session replays the published build");
useScenarioSession.getState().selectAsset("A03");
useScenarioSession.getState().setModelConfig(DEFAULT_FACILITY_MODEL);
assert.equal(useScenarioSession.getState().selectedAssetId, "cdu-03", "returning to the reference selects CDU-03 when the selection is gone");
useScenarioSession.getState().reset();

// The thermal graph shows where the heat is: every asset carries a heat reading.
const { LINEAGE_METRICS, heatTone, lineageEdgePath, lineageLayout } = await import("../src/lib/cockpit/graphLayout");
const snapshot900 = replayCockpitSnapshot(SCENARIO_START_S + 900);
const heatGraph = thermalGraph(snapshot900, "current");
assert(heatGraph.nodes.every((node) => typeof node.heat === "number" && Number.isFinite(node.heat)), "every node has a heat reading in the current view");
assert(thermalGraph(snapshot900, "topology").nodes.every((node) => node.heat === undefined), "the topology view shows structure only");
assert.equal(
  heatGraph.nodes.find((node) => node.id === "cdu-03")?.heat,
  snapshot900.racks.reduce((sum, rack) => sum + rack.heatKw, 0) / 1_800,
  "a CDU reads its served load against its capacity",
);
const hottestRack = snapshot900.racks.reduce((hot, rack) => rack.inletC > hot.inletC ? rack : hot);
const rackNodes = heatGraph.nodes.filter((node) => node.kind === "rack");
assert.equal(rackNodes.reduce((hot, node) => (node.heat ?? 0) > (hot.heat ?? 0) ? node : hot).id, hottestRack.id, "the hottest rack reads hottest");
assert(
  (thermalGraph(snapshot900, "forecast").nodes.find((node) => node.id === hottestRack.id)?.heat ?? 0) >=
    (rackNodes.find((node) => node.id === hottestRack.id)?.heat ?? 0),
  "during the ramp the forecast view never reads cooler than now",
);
assert(airGraph.nodes.every((node) => typeof node.heat === "number"), "a build's graph carries heat readings too");
assert.equal(heatTone(0), "#3b82f6", "cool nodes are blue");
assert.equal(heatTone(1), "#ef4444", "nodes at their limit are red");
assert.equal(heatTone(2.5), "#ef4444", "nodes past their limit stay red");

// The lineage layout reads left to right along the heat flow.
for (const [name, graphUnderTest] of [["reference", heatGraph], ["air-cooled build", airGraph]] as const) {
  const placed = lineageLayout(graphUnderTest.nodes, graphUnderTest.edges);
  assert(graphUnderTest.edges.every((edge) => placed.nodes.get(edge.from)!.layer < placed.nodes.get(edge.to)!.layer), `${name}: every edge runs left to right`);
  const boxes = [...placed.nodes.values()];
  assert.equal(boxes.length, graphUnderTest.nodes.length, `${name}: every node is placed`);
  assert(
    boxes.every((a) => boxes.every((b) => a === b || a.layer !== b.layer || Math.abs(a.y - b.y) >= LINEAGE_METRICS.nodeHeight)),
    `${name}: nodes in a column never overlap`,
  );
  assert(
    boxes.every((box) => box.x + LINEAGE_METRICS.nodeWidth <= placed.width && box.y + LINEAGE_METRICS.nodeHeight <= placed.height),
    `${name}: nodes fit inside the canvas`,
  );
  const first = graphUnderTest.edges[0];
  assert.match(lineageEdgePath(placed.nodes.get(first.from)!, placed.nodes.get(first.to)!), /^M [\d.]+ [\d.]+ C /);
}
assert.deepEqual(lineageLayout(heatGraph.nodes, heatGraph.edges).layers[0], ["gpu-b"], "heat flow starts at the workload");

// A failed request reads as a sentence a person can act on, never a raw status line.
const { ApiError, describeError } = await import("../src/components/cockpit/api");
assert.equal(describeError(new ApiError("Request failed (401)", 401, {})), "Your session has ended. Sign in again to continue.");
assert.match(describeError(new ApiError("Organization membership required", 403, {})), /does not have access/);
assert.match(describeError(new ApiError("Request failed (503)", 503, {})), /problem on the server/);
assert.equal(describeError(new ApiError("Recommendation not found", 404, {})), "Recommendation not found", "a specific server message is kept");
assert.equal(describeError(new ApiError("Invalid advisory command", 400, {})), "Invalid advisory command");
assert.match(describeError(new TypeError("Failed to fetch")), /could not reach the server/);
assert.equal(describeError(new TypeError("Cannot read properties of undefined")), "Cannot read properties of undefined", "a code error is not reported as a network error");
assert(!/^Error:/.test(describeError(new Error("Model not published"))), "messages never start with a raw error prefix");

// The twin's labels never cover one another; rack IDs win, nearer labels win, and a moved label keeps a leader.
const { layoutLabels } = await import("../src/lib/twin/labelLayout");
const stage = { width: 800, height: 480, inset: { top: 6, right: 6, bottom: 48, left: 6 } };
const label = (id: string, x: number, y: number, extra: Partial<Parameters<typeof layoutLabels>[0][number]> = {}) => ({
  id, anchorX: x, anchorY: y, targetX: x, targetY: y + 20, width: 40, height: 18, priority: 0, distance: 10, inFront: true, leader: true, ...extra,
});
const clear = (placements: ReturnType<typeof layoutLabels>, sizes: Map<string, [number, number]>) => {
  const boxes = placements.filter((place) => place.visible).map((place) => {
    const [w, h] = sizes.get(place.id)!;
    return { id: place.id, x: place.x, y: place.y, w: w * place.scale, h: h * place.scale };
  });
  for (const a of boxes) for (const b of boxes) {
    if (a === b) continue;
    const overlapping = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    assert(!overlapping, `${a.id} and ${b.id} must not overlap`);
    assert(a.x >= stage.inset.left && a.y >= stage.inset.top && a.x + a.w <= stage.width - stage.inset.right && a.y + a.h <= stage.height - stage.inset.bottom, `${a.id} stays inside the stage`);
  }
};
{
  const stacked = layoutLabels([label("A01", 300, 200), label("A02", 300, 200, { distance: 12 })], stage);
  const [a01, a02] = stacked;
  assert(a01.visible && a02.visible, "two labels on one spot both show");
  assert.equal(a01.leader, null, "the nearer label keeps its spot");
  assert(a02.leader, "the label that moved keeps a leader line to its equipment");
  clear(stacked, new Map([["A01", [40, 18]], ["A02", [40, 18]]]));
}
{
  const [rack, callout] = layoutLabels([label("A01", 300, 200, { distance: 14 }), label("path", 300, 200, { priority: 2, distance: 5, leader: false, width: 120 })], stage);
  assert.equal(rack.leader, null, "a rack ID keeps its spot over a nearer callout");
  assert(Math.abs(rack.x + 20 * rack.scale - 300) < 1 && Math.abs(rack.y + 9 * rack.scale - 200) < 1, "a rack ID sits centred on its anchor");
  assert(callout.visible && callout.leader === null, "a callout moves aside without a leader");
}
{
  const [behind, offscreen] = layoutLabels([label("A01", 300, 200, { inFront: false }), label("A02", 900, 200)], stage);
  assert(!behind.visible && !offscreen.visible, "labels behind the camera or off the stage are hidden");
}
{
  const cluster = Array.from({ length: 12 }, (_, i) => label(`R${i}`, 380 + (i % 4) * 6, 220 + Math.floor(i / 4) * 5, { distance: 10 + i }));
  const placements = layoutLabels(cluster, stage);
  assert(placements.every((place) => place.visible), "every rack ID in a tight cluster shows");
  clear(placements, new Map(cluster.map((item) => [item.id, [40, 18] as [number, number]])));
  assert.equal(placements[0].scale, 1, "the nearest label is full size");
  assert(placements[11].scale < 1 && placements[11].opacity < 1, "the furthest label shrinks and fades a little");
}
{
  const [edge] = layoutLabels([label("A01", 10, 470)], stage);
  assert(edge.visible && edge.x >= stage.inset.left && edge.y + 18 <= stage.height - stage.inset.bottom, "a label near the edge moves inside the stage");
}

console.log("Operating workspace model, traversal, and comparison tests passed.");
