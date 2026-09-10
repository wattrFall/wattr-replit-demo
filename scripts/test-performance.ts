import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  advanceCockpitSimulation,
  createCockpitSimulation,
} from "../src/lib/cockpit/simulation";
import { thermalGraph } from "../src/lib/cockpit/workspaces";

function replayAtSpeed(speed: 1 | 5 | 10 | 30 | 60) {
  let state = createCockpitSimulation(SCENARIO_START_S);
  for (let elapsed = 0; elapsed < SCENARIO_DURATION_S; elapsed += speed) {
    state = advanceCockpitSimulation(state, speed, SCENARIO_START_S);
  }
  return state;
}

const timings: Record<number, number> = {};
let reference: ReturnType<typeof replayAtSpeed> | undefined;
for (const speed of [1, 5, 10, 30, 60] as const) {
  const start = performance.now();
  const state = replayAtSpeed(speed);
  timings[speed] = performance.now() - start;
  assert.equal(state.snapshot.elapsedS, SCENARIO_DURATION_S);
  if (!reference) reference = state;
  else assert.deepEqual(state.snapshot, reference.snapshot, `${speed}x replay drifted`);
}

assert(timings[60] < 15_000, `60x replay exceeded 15s budget (${timings[60].toFixed(0)}ms)`);
assert(timings[60] <= timings[1] * 1.2, "60x replay should not do more work than 1x replay");

const fanoutStart = performance.now();
for (let index = 0; index < 120; index += 1) {
  const snapshot = replayAtSpeed(60).snapshot;
  const graph = thermalGraph(snapshot, index % 2 ? "forecast" : "current");
  assert.equal(graph.nodes.length, 9);
  assert.equal(graph.edges.length, 11);
}
const fanoutMs = performance.now() - fanoutStart;
assert(fanoutMs < 30_000, `graph update fan-out exceeded 30s budget (${fanoutMs.toFixed(0)}ms)`);

const heapBefore = process.memoryUsage().heapUsed;
for (let index = 0; index < 12; index += 1) replayAtSpeed(60);
const heapAfter = process.memoryUsage().heapUsed;
const heapGrowth = heapAfter - heapBefore;
assert(heapGrowth < 128 * 1024 * 1024, `replay memory grew by ${(heapGrowth / 1024 / 1024).toFixed(1)}MiB`);

const assetsDir = new URL("../dist/assets/", import.meta.url);
const assets = await readdir(assetsDir);
const jsAssets = await Promise.all(assets.filter((name) => name.endsWith(".js")).map(async (name) => ({
  name,
  bytes: (await stat(new URL(name, assetsDir))).size,
  source: await readFile(new URL(name, assetsDir), "utf8"),
})));
const twinChunks = jsAssets.filter((asset) => /^(FacilityTwinCanvas|SandboxCanvas|OrbitControls)-/.test(asset.name));
assert(twinChunks.length > 0, "lazy-loaded twin/WebGL bundle was not emitted");
const twinBundleBytes = twinChunks.reduce((sum, asset) => sum + asset.bytes, 0);
assert(twinBundleBytes < 2_500_000, `lazy twin bundle exceeded 2.5MB (${(twinBundleBytes / 1024 / 1024).toFixed(2)}MiB)`);
const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
for (const chunk of twinChunks) {
  assert(!html.includes(chunk.name), `twin chunk ${chunk.name} is eagerly loaded by the app shell`);
}

console.log(
  `Performance gates passed: ${Object.entries(timings).map(([speed, ms]) => `${speed}x=${ms.toFixed(0)}ms`).join(", ")}; graph fan-out=${fanoutMs.toFixed(0)}ms; heap growth=${(heapGrowth / 1024 / 1024).toFixed(1)}MiB; lazy twin bundle=${(twinBundleBytes / 1024 / 1024).toFixed(2)}MiB.`,
);