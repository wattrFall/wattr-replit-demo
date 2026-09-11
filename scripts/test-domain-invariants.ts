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

// Zones: placement follows each zone's kind, and zone edits refuse rather than
// overlap another zone or strand equipment.
const { canPlaceAt, placementRefusal, useSandboxStore } = await import("../src/lib/sandbox/store");
const { PRESETS } = await import("../src/lib/sandbox/presets");
const { validateLayout } = await import("../src/lib/sandbox/validate");
const { SITE, zoneOfFootprint, zoneRect, zonesOverlap } = await import("../src/lib/sandbox/geometry");

for (const preset of PRESETS) {
  const result = validateLayout(preset.layout);
  assert(result.ok, `${preset.name} must pass design checks: ${result.errors.map((finding) => finding.message).join("; ")}`);
  for (const item of preset.layout.items) {
    assert(zoneOfFootprint(preset.layout.zones, item.kind, item.cell), `${preset.name}: ${item.id} must sit inside a zone`);
  }
}

const sandbox = () => useSandboxStore.getState();
sandbox().loadLayout(PRESETS[0].layout, PRESETS[0].id);
const [hall, plant] = sandbox().zones;
const firstRack = sandbox().items.find((item) => item.kind === "rack")!;
const firstChiller = sandbox().items.find((item) => item.kind === "chiller")!;
const openHallTile = { x: hall.x, z: hall.z };
const openPlantTile = { x: plant.x, z: plant.z + plant.d - 1 };

assert.equal(canPlaceAt(sandbox().items, sandbox().zones, "rack", openHallTile), true, "a rack fits an open compute hall tile");
assert.equal(canPlaceAt(sandbox().items, sandbox().zones, "crac", openHallTile), true, "a CRAC unit fits a compute hall");
assert.match(placementRefusal(sandbox().items, sandbox().zones, "rack", openPlantTile) ?? "", /compute hall, not a plant area/);
assert.match(placementRefusal(sandbox().items, sandbox().zones, "chiller", openHallTile) ?? "", /plant area, not a compute hall/);
assert.match(placementRefusal(sandbox().items, sandbox().zones, "rack", { x: 0, z: 0 }) ?? "", /inside a zone/);
assert.match(placementRefusal(sandbox().items, sandbox().zones, "rack", firstRack.cell) ?? "", /already occupied/);
assert.match(
  placementRefusal(sandbox().items, sandbox().zones, "chiller", { x: plant.x + plant.w - 1, z: plant.z + plant.d - 1 }) ?? "",
  /hang off/,
  "a two-tile chiller at a plant area's edge must be refused",
);

sandbox().updateZone(hall.id, { z: hall.z - 2 });
assert.equal(sandbox().zones[0].z, hall.z - 2, "a zone moves");
assert.equal(sandbox().items.find((item) => item.id === firstRack.id)?.cell.z, firstRack.cell.z - 2, "equipment moves with its zone");
assert.deepEqual(sandbox().items.find((item) => item.id === firstChiller.id)?.cell, firstChiller.cell, "other zones' equipment stays put");

sandbox().updateZone(plant.id, { x: hall.x + 1 });
assert.match(sandbox().notice ?? "", /cannot overlap/);
assert.equal(sandbox().zones[1].x, plant.x, "an overlapping move is refused");

sandbox().updateZone(hall.id, { w: 3 });
assert.match(sandbox().notice ?? "", /Cannot resize Raised floor: .*GPU rack/);
assert.equal(sandbox().zones[0].w, hall.w, "a resize that strands equipment is refused");

sandbox().updateZone(hall.id, { kind: "plant" });
assert.match(sandbox().notice ?? "", /Cannot make Raised floor a plant area/);
assert.equal(sandbox().zones[0].kind, "compute", "a retype that strands equipment is refused");

sandbox().removeZone(plant.id);
assert.match(sandbox().notice ?? "", /Plant yard still holds 1 Chiller/);
assert.equal(sandbox().zones.length, 2, "a zone holding equipment is not deleted");

sandbox().addZone("cooling");
const added = sandbox().zones[2];
assert.equal(added.kind, "cooling");
assert.equal(sandbox().selectedZoneId, added.id, "a new zone is selected for editing");
assert(added.x >= 0 && added.z >= 0 && added.x + added.w <= SITE.w && added.z + added.d <= SITE.d, "a new zone fits the site");
assert(sandbox().zones.slice(0, 2).every((zone) => !zonesOverlap(zoneRect(zone), zoneRect(added))), "a new zone overlaps nothing");
sandbox().removeZone(added.id);
assert.equal(sandbox().zones.length, 2, "an empty zone can be deleted");

const idsBefore = new Set([...sandbox().items, ...sandbox().connections, ...sandbox().zones].map((entity) => entity.id));
sandbox().place("sensor", { x: hall.x, z: hall.z - 2 });
const placedSensor = sandbox().items[sandbox().items.length - 1];
assert.equal(placedSensor.kind, "sensor", "a sensor can be placed in a moved hall");
assert(!idsBefore.has(placedSensor.id), "new ids never collide with a loaded layout's ids");
sandbox().reset();

// Connections: each link carries a medium, lands on ports that take only so
// many, can have either end moved, and is drawn as straight runs from port to
// port rather than floating arcs.
const { MANIFOLD_FAN_OUT, checkConnection, checkRewire } = await import("../src/lib/sandbox/connections");
const { linkMedium, linkPaths, portPosition } = await import("../src/lib/sandbox/routing");
type Check = ReturnType<typeof checkConnection>;
const refusal = (check: Check) => (check.ok ? "" : check.reason);

assert.equal(linkMedium("chiller", "cdu"), "chilled-water");
assert.equal(linkMedium("chiller", "crac"), "chilled-water");
assert.equal(linkMedium("cdu", "rack"), "coolant");
assert.equal(linkMedium("crac", "rack"), "air");
assert.equal(linkMedium("sensor", "rack"), "signal");

const liquid = PRESETS.find((preset) => preset.id === "liquid-gpu")!.layout;
const cdus = liquid.items.filter((item) => item.kind === "cdu");
const liquidRacks = liquid.items.filter((item) => item.kind === "rack");
const liquidChiller = liquid.items.find((item) => item.kind === "chiller")!;
const feedsRack = (fromId: string, toId: string) =>
  liquid.connections.some((connection) => connection.fromId === fromId && connection.toId === toId);
const rackOnFirstCdu = liquidRacks.find((rack) => feedsRack(cdus[0].id, rack.id))!;
const rackOnSecondCdu = liquidRacks.find((rack) => feedsRack(cdus[1].id, rack.id))!;

assert.match(
  refusal(checkConnection(liquid.items, liquid.connections, cdus[1].id, rackOnFirstCdu.id)),
  /one coolant supply/,
  "a rack's liquid inlet takes coolant from one CDU",
);

const headerItems = [
  { id: "cdu-h", kind: "cdu" as const, cell: { x: 0, z: 0 }, params: {} },
  ...Array.from({ length: MANIFOLD_FAN_OUT + 1 }, (_, i) => ({
    id: `rack-h${i}`,
    kind: "rack" as const,
    cell: { x: i + 1, z: 0 },
    params: {},
  })),
];
const headerBranches = Array.from({ length: MANIFOLD_FAN_OUT }, (_, i) => ({
  id: `link-h${i}`,
  fromId: "cdu-h",
  toId: `rack-h${i}`,
}));
assert.match(
  refusal(checkConnection(headerItems, headerBranches, "cdu-h", `rack-h${MANIFOLD_FAN_OUT}`)),
  new RegExp(`at most ${MANIFOLD_FAN_OUT} branches`),
  "a supply header is limited to its fan-out",
);

const firstSupply = liquid.connections.find(
  (connection) => connection.fromId === cdus[0].id && connection.toId === rackOnFirstCdu.id,
)!;
assert.equal(
  checkRewire(liquid.items, liquid.connections, firstSupply.id, "from", cdus[1].id).ok,
  true,
  "a rack's one coolant supply can move to another CDU",
);
assert.match(
  refusal(checkRewire(liquid.items, liquid.connections, firstSupply.id, "to", rackOnSecondCdu.id)),
  /one coolant supply/,
  "a supply cannot be moved onto a rack that already has one",
);
assert.equal(
  checkRewire(liquid.items, liquid.connections, firstSupply.id, "to", liquidChiller.id).ok,
  false,
  "rewiring still follows the pairing rules",
);
assert.match(
  refusal(checkRewire(liquid.items, liquid.connections, firstSupply.id, "to", rackOnFirstCdu.id)),
  /already runs there/,
);

sandbox().loadLayout(liquid, "liquid-gpu");
sandbox().beginRewire(firstSupply.id, "from");
assert.equal(sandbox().mode.type, "rewiring");
sandbox().rewire(liquidChiller.id);
assert.match(sandbox().notice ?? "", /chiller/i, "an illegal rewire is refused with a reason");
assert.equal(sandbox().mode.type, "rewiring", "a refused rewire stays armed");
sandbox().rewire(cdus[1].id);
assert.equal(
  sandbox().connections.find((connection) => connection.id === firstSupply.id)?.fromId,
  cdus[1].id,
  "rewiring moves one end of a connection",
);
assert.equal(sandbox().mode.type, "idle");
assert.equal(sandbox().selectedConnectionId, firstSupply.id, "the rewired connection stays selected");
sandbox().disconnect(firstSupply.id);
assert.equal(sandbox().selectedConnectionId, null, "disconnecting clears the connection selection");
assert(!sandbox().connections.some((connection) => connection.id === firstSupply.id));
sandbox().reset();

for (const preset of PRESETS) {
  const { items, connections } = preset.layout;
  for (const connection of connections) {
    const from = items.find((item) => item.id === connection.fromId)!;
    const to = items.find((item) => item.id === connection.toId)!;
    const paths = linkPaths(connection, items);
    assert(paths.length > 0, `${preset.name}: ${connection.id} must be drawn`);
    for (const path of paths) {
      for (let i = 1; i < path.points.length; i++) {
        const moved = [0, 1, 2].filter((axis) => Math.abs(path.points[i][axis] - path.points[i - 1][axis]) > 1e-9);
        assert.equal(moved.length, 1, `${preset.name}: ${connection.id} ${path.role} segment ${i} must run along one axis`);
      }
    }
    const medium = linkMedium(from.kind, to.kind);
    if (medium === "coolant" || medium === "chilled-water") {
      const [supply, back] = paths;
      assert.deepEqual(supply.points[0], portPosition(from, "b"), `${connection.id}: supply leaves the source outlet`);
      assert.deepEqual(supply.points[supply.points.length - 1], portPosition(to, "a"), `${connection.id}: supply lands on the target inlet`);
      assert.deepEqual(back.points[0], portPosition(to, "b"), `${connection.id}: return leaves the target outlet`);
      assert.deepEqual(back.points[back.points.length - 1], portPosition(from, "a"), `${connection.id}: return lands on the source inlet`);
    }
  }
}

console.log("Domain invariants, topology, bounds, lag, offline equipment, reset, comparison, graph, zone, and connection checks passed.");