import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { DEFAULT_FACILITY_MODEL } from "../src/lib/cockpit/simulation";
import { SFO_01_LAYOUT } from "../src/lib/facility/templates";
import { parseReplayCsv, syntheticReplayCsv } from "../src/lib/replay/csv";
import { assertSupportedRelocation, runHistoricalReplay, supportedReplayRackIds } from "../src/lib/replay/engine";
import type { HistoricalDataset, HistoricalScenario } from "../src/lib/replay/types";
import { recordReplayModelChange, registerReplayRoutes } from "../server/replay-routes";

const rackIds = supportedReplayRackIds(DEFAULT_FACILITY_MODEL);
const csv = syntheticReplayCsv(rackIds);
const parsed = parseReplayCsv(csv, rackIds);
assert(parsed.validation.valid, parsed.validation.errors.join("; "));
assert.equal(parsed.validation.inputStatus.workload, "PRESENT");
assert.equal(parsed.validation.inputStatus.rackPower, "PRESENT");
assert.equal(parsed.validation.inputStatus.environment, "PRESENT");
assert.equal(parsed.validation.inputStatus.cooling, "PRESENT");
assert.equal(parsed.validation.inputStatus.initialInlet, "MISSING");
assert.throws(
  () => parseReplayCsv("timestamp,rack_id,workload_kw,rack_power_kw,ambient_c\n1,rack-a01,1,1,20", rackIds),
  /cooling_supply_c/,
  "CSV with an unsupported cooling input must be rejected",
);
assert.throws(
  () => assertSupportedRelocation(DEFAULT_FACILITY_MODEL, "rack-a01", { x: 0, z: 0 }),
  /Unsupported rack relocation/,
  "candidate must land in an accepted, unoccupied facility location",
);
const dataset: HistoricalDataset = {
  id: "dataset-1", facilityId: "facility-1", source: "SYNTHETIC_DEMO", sourceName: "Synthetic replay demo dataset",
  checksum: "0".repeat(64), rows: parsed.rows, validation: parsed.validation,
  periodStartAt: parsed.validation.timestamps[0], periodEndAt: parsed.validation.timestamps.at(-1)!,
};
const scenario: HistoricalScenario = {
  id: "scenario-1", facilityId: "facility-1", datasetId: dataset.id, name: "Move A01",
  status: "SAVED_FOR_REVIEW", periodStartAt: dataset.periodStartAt, periodEndAt: dataset.periodEndAt,
  historicalModelVersionId: "model-1", baselineModelConfig: structuredClone(DEFAULT_FACILITY_MODEL),
  relocation: { rackId: "rack-a01", to: { x: 18, z: 13 } },
  assumptions: ["same input rows"], missingInputs: [], validationStatus: "VALID", source: "SYNTHETIC_DEMO",
};
const first = runHistoricalReplay(scenario, dataset);
const second = runHistoricalReplay(structuredClone(scenario), structuredClone(dataset));
assert.deepEqual(first, second, "replay must be deterministic for the same immutable model and input rows");
assert.equal(first.inputFingerprint, dataset.checksum);
assert.equal(first.baselineSeries.length, first.candidateSeries.length);
assert.notDeepEqual(first.baselineRawOutputs, first.candidateRawOutputs, "a supported relocation must affect constrained spatial output");
assert.equal(first.unsupportedMetrics.length, 1, "energy metrics must remain unavailable rather than invented");
assert(first.assumptions.some((item) => item.includes("30°C synthetic initial thermal state")), "default initial state must be disclosed");
assert(first.missingInputs.includes("initial_inlet_c"), "missing historical initial state must be reported");
assert.deepEqual(dataset.rows, parsed.rows, "running a candidate may not mutate baseline input rows");
assert.deepEqual(scenario.baselineModelConfig, DEFAULT_FACILITY_MODEL, "scenario must retain its immutable baseline configuration");

const csvWithInitialState = csv.split("\n").map((line, index) =>
  index === 0 ? `${line},initial_inlet_c` : `${line},25`,
).join("\n");
const alignedParsed = parseReplayCsv(csvWithInitialState, rackIds);
const alignedDataset: HistoricalDataset = {
  ...dataset, id: "dataset-aligned", checksum: "1".repeat(64), rows: alignedParsed.rows, validation: alignedParsed.validation,
  periodStartAt: alignedParsed.validation.timestamps[0], periodEndAt: alignedParsed.validation.timestamps.at(-1)!,
};
const alignedScenario: HistoricalScenario = { ...scenario, id: "scenario-aligned", datasetId: alignedDataset.id, periodStartAt: alignedDataset.periodStartAt, periodEndAt: alignedDataset.periodEndAt };
const aligned = runHistoricalReplay(alignedScenario, alignedDataset);
assert.deepEqual(aligned.baselineSeries.map((point) => point.timestamp), alignedParsed.validation.timestamps, "outputs must include initial state then each true interval end boundary");
for (const rack of aligned.baselineRawOutputs[0].racks) {
  assert.equal(rack.inletC - rack.spatialAdjustmentC, 25, "known historical initial inlet must be the first output state");
}
const changedFinalBoundary: HistoricalDataset = {
  ...alignedDataset,
  checksum: "2".repeat(64),
  rows: alignedDataset.rows.map((row) => row.timestamp === alignedDataset.periodEndAt ? { ...row, rackPowerKw: row.rackPowerKw + 900 } : row),
};
const withChangedFinalBoundary = runHistoricalReplay(alignedScenario, changedFinalBoundary);
assert.deepEqual(withChangedFinalBoundary.baselineRawOutputs, aligned.baselineRawOutputs, "a final boundary input must not be applied retroactively to the completed preceding interval");
assert.deepEqual(withChangedFinalBoundary.metrics, aligned.metrics, "duration metrics must use completed timestamp intervals only");

const previousConfig = { ...structuredClone(DEFAULT_FACILITY_MODEL), layout: structuredClone(SFO_01_LAYOUT) };
const nextConfig = structuredClone(previousConfig);
nextConfig.layout.items.find((item) => item.id === "rack-a01")!.cell = { x: 18, z: 13 };
const historyQueries: Array<{ sql: string; values: unknown[] }> = [];
await recordReplayModelChange({
  client: {
    query: async (sql: string, values: unknown[]) => {
      historyQueries.push({ sql, values });
      if (sql.startsWith("SELECT")) return { rows: [{ id: "old", config: previousConfig }, { id: "new", config: nextConfig }] };
      return { rows: [] };
    },
  } as any,
  facilityId: "facility-1", previousVersionId: "old", nextVersionId: "new", source: "MODEL_PUBLISH",
});
const assetInserts = historyQueries.filter((entry) => entry.sql.startsWith("INSERT"));
assert.equal(assetInserts.length, 1, "a single moved rack must produce its own immutable event");
assert.equal(assetInserts[0].values[2], "rack-a01", "history event must retain the canonical affected asset id");
assert.equal(assetInserts[0].values[6], "RACK_RELOCATED");

// Route authorization is tested against the injected access contract: no
// unauthorised request may reach a data query, even with a facility id supplied.
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as typeof req & { userId?: string }).userId = req.header("x-test-user-id") ?? undefined; next(); });
let queryReached = false;
registerReplayRoutes(app, {
  pool: {
    query: async () => { queryReached = true; return { rows: [] }; },
    connect: async () => { throw new Error("should not connect"); },
  } as any,
  requireFacilityAccess: async (userId, facilityId, response) => {
    if (userId !== "engineer-1" || facilityId !== "facility-1") {
      response.status(404).json({ error: "Facility unavailable" });
      return undefined;
    }
    return { organization_id: "org-1", role: "ENGINEER" };
  },
  publishedModel: async () => ({ model_version: "model-1", config: DEFAULT_FACILITY_MODEL }),
});
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/facilities/facility-2/history`, {
    headers: { "x-test-user-id": "engineer-1" },
  });
  assert.equal(response.status, 404, "cross-facility history read must be denied");
  assert.equal(queryReached, false, "denied request must not query replay history");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

console.log("Replay CSV validation, immutable baseline, deterministic spatial comparison, and route authorization tests passed.");