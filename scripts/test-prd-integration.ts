import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import pg from "pg";
import { chromium } from "playwright";
import { availableTestPort } from "./test-port";
import {
  assertSupportedRelocation,
  supportedReplayRackIds,
} from "../src/lib/replay/engine";
import { syntheticReplayCsv } from "../src/lib/replay/csv";
import type { FacilityModelConfig } from "../src/lib/cockpit/simulation";

/**
 * Integration regression for the PRD intelligence and historical replay
 * surfaces. This intentionally uses only an isolated user and records created
 * by that user; the canonical SFO-01 model is read, never activated or
 * published.
 */

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const suffix = randomUUID().slice(0, 8);
const userId = `prd-integration-${suffix}`;
const facilityId = "sfo-01";
const port = await availableTestPort();
const baseUrl = `http://127.0.0.1:${port}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let server: ChildProcess | undefined;
let stderr = "";
let seedAttempted = false;
const datasetIds = new Set<string>();
const scenarioIds = new Set<string>();
const importFileIds = new Set<string>();
const importSessionIds = new Set<string>();
const draftModelIds = new Set<string>();

type ApiResponse<T> = { status: number; body: T | null; text: string };

async function api<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "x-test-user-id": userId,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw new Error(`Request failed for ${path}: ${String(error)}\n${stderr}`);
  }
  const text = await response.text();
  let body: T | null = null;
  try {
    body = text ? JSON.parse(text) as T : null;
  } catch {
    // HTML and malformed error payloads remain available in text for failure
    // diagnostics; callers assert the status before using body.
  }
  return { status: response.status, body, text };
}

async function seed() {
  seedAttempted = true;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO users (id, display_name) VALUES ($1, $2)",
      [userId, "PRD integration engineer"],
    );
    await client.query(
      `INSERT INTO memberships (user_id, organization_id, role, is_admin)
       VALUES ($1, 'wattr-demo', 'ENGINEER', false)`,
      [userId],
    );
    await client.query(
      `INSERT INTO facility_permissions
         (user_id, facility_id, can_view, can_operate, can_edit_model)
       VALUES ($1, $2, true, false, false)`,
      [userId, facilityId],
    );
    // Complete both tutorial stores so screenshots exercise the product pages,
    // not the onboarding overlay. This is isolated to the test identity.
    await client.query(
      `INSERT INTO user_preferences (user_id, theme, tutorial_complete, tutorial_step, tutorial_role)
       VALUES ($1, 'dark', true, 10, 'ENGINEER')`,
      [userId],
    );
    await client.query(
      `INSERT INTO user_tutorial_progress (user_id, role, tutorial_complete, tutorial_step)
       VALUES ($1, 'ENGINEER', true, 10)`,
      [userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function startServer() {
  server = spawn("node_modules/.bin/tsx", ["server/index.ts"], {
    env: { ...process.env, NODE_ENV: "test", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  server.stdout?.resume();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`PRD integration server exited with code ${server.exitCode}.\n${stderr}`);
    }
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // The listener may still be loading tsx and the application modules.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`PRD integration server did not start on ${port}.\n${stderr}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (server && server.exitCode === null) server.kill("SIGKILL");
      resolve();
    }, 5_000);
    server?.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

const replayImmutableTriggers = [
  ["replay_change_events", "replay_change_events_immutable"],
  ["replay_datasets", "replay_datasets_immutable"],
  ["replay_historical_scenarios", "replay_historical_scenarios_immutable"],
  ["replay_historical_results", "replay_historical_results_immutable"],
] as const;

async function enableReplayTriggers(client: pg.PoolClient) {
  for (const [table, trigger] of replayImmutableTriggers) {
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  }
}

async function assertReplayTriggersEnabled() {
  const result = await pool.query(
    `SELECT c.relname, t.tgname, t.tgenabled
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = ANY($1::text[])
       AND t.tgname = ANY($2::text[])`,
    [
      replayImmutableTriggers.map(([table]) => table),
      replayImmutableTriggers.map(([, trigger]) => trigger),
    ],
  );
  assert.equal(
    result.rows.filter((row) => row.tgenabled !== "O").length,
    0,
    "replay immutable triggers must never remain disabled",
  );
}

async function cleanup() {
  if (!seedAttempted) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Recover IDs if a response was lost after the server committed. The
    // predicates are restricted to this run's user, never to fixture rows.
    const ownedDatasets = await client.query(
      "SELECT id FROM replay_datasets WHERE uploaded_by = $1",
      [userId],
    );
    const ownedScenarios = await client.query(
      "SELECT id FROM replay_historical_scenarios WHERE created_by = $1",
      [userId],
    );
    const ownedImports = await client.query(
      "SELECT id, file_id FROM facility_import_sessions WHERE created_by = $1",
      [userId],
    );
    const ownedFiles = await client.query(
      "SELECT id FROM facility_import_files WHERE uploaded_by = $1",
      [userId],
    );
    const ownedDrafts = await client.query(
      "SELECT id FROM model_versions WHERE created_by = $1 AND id LIKE 'build-import-%'",
      [userId],
    );
    for (const row of ownedDatasets.rows) datasetIds.add(String(row.id));
    for (const row of ownedScenarios.rows) scenarioIds.add(String(row.id));
    for (const row of ownedImports.rows) {
      importSessionIds.add(String(row.id));
      importFileIds.add(String(row.file_id));
    }
    for (const row of ownedFiles.rows) importFileIds.add(String(row.id));
    for (const row of ownedDrafts.rows) draftModelIds.add(String(row.id));

    // Replay records are intentionally immutable. The row-level immutable
    // triggers are disabled only inside this transaction, then restored before
    // COMMIT; the no-truncate triggers remain enabled throughout.
    for (const [table, trigger] of replayImmutableTriggers) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    if (scenarioIds.size) {
      await client.query(
        "DELETE FROM replay_historical_results WHERE scenario_id = ANY($1::uuid[])",
        [[...scenarioIds]],
      );
      await client.query(
        "DELETE FROM replay_historical_scenarios WHERE id = ANY($1::uuid[])",
        [[...scenarioIds]],
      );
    }
    if (datasetIds.size) {
      await client.query(
        "DELETE FROM replay_datasets WHERE id = ANY($1::uuid[]) AND uploaded_by = $2",
        [[...datasetIds], userId],
      );
    }
    await enableReplayTriggers(client);

    // Import drafts and their retained source/session rows are mutable,
    // user-owned review artifacts. Remove the draft first, then the session
    // (whose file_id is RESTRICT), then the uploaded source bytes.
    if (draftModelIds.size) {
      await client.query(
        "DELETE FROM model_versions WHERE id = ANY($1::text[]) AND created_by = $2 AND id LIKE 'build-import-%'",
        [[...draftModelIds], userId],
      );
    }
    if (importSessionIds.size) {
      await client.query(
        "DELETE FROM facility_import_sessions WHERE id = ANY($1::uuid[]) AND created_by = $2",
        [[...importSessionIds], userId],
      );
    }
    if (importFileIds.size) {
      await client.query(
        "DELETE FROM facility_import_files WHERE id = ANY($1::uuid[]) AND uploaded_by = $2",
        [[...importFileIds], userId],
      );
    }

    // The user has no fixture ownership and all remaining rows are
    // user-scoped. Deleting it cascades preferences, grants, and learning
    // diagnostics while preserving canonical facility/model data.
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("COMMIT");
  } catch (error) {
    // Re-enable before rollback as well; rollback normally restores the DDL,
    // but this makes cleanup safe if a driver reports an error after ALTER.
    try { await enableReplayTriggers(client); } catch { /* rollback restores DDL */ }
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
    // This check also catches a failed cleanup path that was recovered by the
    // outer finally. It never leaves a disabled trigger behind.
    try {
      await assertReplayTriggersEnabled();
    } catch (error) {
      const repair = await pool.connect();
      try {
        await repair.query("BEGIN");
        await enableReplayTriggers(repair);
        await repair.query("COMMIT");
      } catch {
        try { await repair.query("ROLLBACK"); } catch { /* best effort */ }
      } finally {
        repair.release();
      }
      throw error;
    }
  }
}

function jsonBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}

function findRelocation(config: FacilityModelConfig, rackId: string) {
  for (let x = 0; x <= 63; x += 1) {
    for (let z = 0; z <= 63; z += 1) {
      try {
        assertSupportedRelocation(config, rackId, { x, z });
        return { x, z };
      } catch {
        // The engine helper is the authority for in-site and unoccupied cells.
      }
    }
  }
  throw new Error(`No supported relocation target found for ${rackId}`);
}

async function assertIntelligenceEndpoints(config: FacilityModelConfig, modelVersionId: string) {
  const hierarchy = await api<{
    modelVersionId: string;
    hierarchy: Array<{ id: string; kind: string; assetId?: string }>;
    provenance: { kind: string; source: string };
  }>(`/api/facilities/${facilityId}/intelligence/hierarchy`);
  assert.equal(hierarchy.status, 200, hierarchy.text);
  assert.equal(hierarchy.body?.modelVersionId, modelVersionId);
  assert.equal(hierarchy.body?.provenance.kind, "SIMULATED");
  assert.equal(hierarchy.body?.provenance.source, "Active published model layout");
  const hierarchyIds = new Set(hierarchy.body?.hierarchy.map((node) => node.assetId ?? node.id));
  for (const id of ["rack-a01", "rack-a02", "rack-b01", "rack-b02", "cdu-03", "chiller-01"]) {
    assert(hierarchyIds.has(id) || hierarchyIds.has(`asset:${id}`), `hierarchy omitted canonical asset ${id}`);
  }

  const assets = await api<{
    modelVersionId: string;
    assets: Array<{ id: string; twinSelectionId: string; kind: string; provenance: { kind: string; source: string } }>;
    count: number;
  }>(`/api/facilities/${facilityId}/intelligence/assets?at=1752676800`);
  assert.equal(assets.status, 200, assets.text);
  assert.equal(assets.body?.modelVersionId, modelVersionId);
  assert.equal(assets.body?.count, assets.body?.assets.length);
  const assetsById = new Map(assets.body?.assets.map((asset) => [asset.id, asset]));
  for (const id of ["rack-a01", "rack-a02", "rack-b01", "rack-b02", "cdu-03", "chiller-01", "sensor-01", "sensor-02"]) {
    assert(assetsById.has(id), `assets omitted canonical id ${id}`);
  }
  assert.equal(assetsById.get("rack-a01")?.twinSelectionId, "A01");
  assert.equal(assetsById.get("rack-a01")?.provenance.kind, "SIMULATED");

  const metrics = await api<{
    metric: string;
    label: string;
    aggregate: { unit: string; contributingAssetCount: number; value: number | null };
    contributions: Array<{ assetId: string; unit: string }>;
    source: string;
  }>(`/api/facilities/${facilityId}/intelligence/metrics?metric=rack_power_kw&at=1752676800`);
  assert.equal(metrics.status, 200, metrics.text);
  assert.equal(metrics.body?.metric, "rack_power_kw");
  assert.equal(metrics.body?.label, "Rack power");
  assert.equal(metrics.body?.aggregate.unit, "kW");
  assert(metrics.body?.aggregate.contributingAssetCount && metrics.body.aggregate.contributingAssetCount >= 4);
  assert(metrics.body?.contributions.some((item) => item.assetId === "rack-a01"));
  assert.match(metrics.body?.source ?? "", /Deterministic published-model replay; not measured telemetry/);

  const telemetry = await api<{
    assetId: string;
    metric: string;
    label: string;
    simulated: boolean;
    mode: string;
    source: string;
    points: Array<{ assetId: string; provenance: string; unit: string }>;
  }>(`/api/facilities/${facilityId}/intelligence/telemetry?assetId=rack-a01&metric=rack_inlet_temperature_c&at=1752676800`);
  assert.equal(telemetry.status, 200, telemetry.text);
  assert.equal(telemetry.body?.assetId, "rack-a01");
  assert.equal(telemetry.body?.metric, "rack_inlet_temperature_c");
  assert.equal(telemetry.body?.label, "Rack inlet temperature");
  assert.equal(telemetry.body?.simulated, true);
  assert.equal(telemetry.body?.mode, "asset_series");
  assert.match(telemetry.body?.source ?? "", /not measured telemetry/);
  assert(telemetry.body?.points.length && telemetry.body.points.every((point) =>
    point.assetId === "rack-a01" && point.provenance === "SIMULATED" && point.unit === "°C"));

  const unsupported = await api(`/api/facilities/${facilityId}/intelligence/telemetry?assetId=rack-a01&metric=energy_kwh`);
  assert.equal(unsupported.status, 422, unsupported.text);

  const unknownFacility = await api(`/api/facilities/not-a-real-facility/intelligence/hierarchy`);
  assert.equal(unknownFacility.status, 404, "unknown facilities must be forbidden without leaking model data");
}

async function assertReplayEndpoints(config: FacilityModelConfig, modelVersionId: string) {
  const invalidBefore = await api<{ items: Array<{ id: string }> }>(
    `/api/facilities/${facilityId}/replay/datasets`,
  );
  assert.equal(invalidBefore.status, 200, invalidBefore.text);
  const invalid = await api(
    `/api/facilities/${facilityId}/replay/datasets`,
    jsonBody({
      source: "UPLOADED_CSV",
      sourceName: `invalid-${suffix}.csv`,
      modelVersionId,
      csv: "timestamp,rack_id,workload_kw,rack_power_kw,ambient_c\n1752676800,rack-a01,1,1,20",
    }),
  );
  assert.equal(invalid.status, 400, "CSV missing required columns must be rejected");
  const invalidAfter = await api<{ items: Array<{ id: string }> }>(
    `/api/facilities/${facilityId}/replay/datasets`,
  );
  assert.equal(invalidAfter.status, 200, invalidAfter.text);
  assert.equal(invalidAfter.body?.items.length, invalidBefore.body?.items.length);

  const dataset = await api<{
    id: string;
    duplicate?: boolean;
    model_version_id: string;
    source: string;
    source_name: string;
    checksum: string;
    period_start_at: number | string;
    period_end_at: number | string;
    validation: { valid: boolean; inputStatus: Record<string, string> };
  }>(
    `/api/facilities/${facilityId}/replay/datasets`,
    jsonBody({ source: "SYNTHETIC_DEMO", modelVersionId }),
  );
  assert([200, 201].includes(dataset.status), dataset.text);
  assert(dataset.body?.id);
  // A previous interrupted run may have left the immutable synthetic checksum
  // behind. Never claim or delete that fixture; only this request's insert is
  // owned by the isolated user.
  if (dataset.status === 201 && !dataset.body?.duplicate) datasetIds.add(dataset.body!.id);
  assert.equal(dataset.body?.model_version_id, modelVersionId);
  assert.equal(dataset.body?.source, "SYNTHETIC_DEMO");
  assert.equal(dataset.body?.source_name, "Synthetic replay demo dataset");
  assert.equal(dataset.body?.validation.valid, true);
  assert.equal(dataset.body?.validation.inputStatus.workload, "PRESENT");
  assert.equal(dataset.body?.validation.inputStatus.rackPower, "PRESENT");
  assert.equal(dataset.body?.validation.inputStatus.environment, "PRESENT");
  assert.equal(dataset.body?.validation.inputStatus.cooling, "PRESENT");

  // Keep this assertion close to the route exercise: the worker's generated
  // fixture is still the same constrained, explicitly synthetic CSV contract.
  assert.match(
    syntheticReplayCsv(supportedReplayRackIds(config)),
    /timestamp,rack_id,workload_kw,rack_power_kw,ambient_c,cooling_supply_c,cooling_flow_pct/,
  );

  const startAt = Number(dataset.body!.period_start_at);
  const endAt = Number(dataset.body!.period_end_at);
  const rackId = supportedReplayRackIds(config)[0];
  assert(rackId, "published model has no supported replay rack");
  const target = findRelocation(config, rackId);

  const scenario = await api<{
    id: string;
    datasetId: string;
    status: string;
    validationStatus: string;
    relocation: { rackId: string; to: { x: number; z: number } };
  }>(
    `/api/facilities/${facilityId}/replay/scenarios`,
    jsonBody({
      datasetId: dataset.body!.id,
      name: `PRD integration relocation ${suffix}`,
      periodStartAt: startAt,
      periodEndAt: endAt,
      relocation: { rackId, to: target },
      saveForReview: true,
    }),
  );
  assert.equal(scenario.status, 201, scenario.text);
  assert(scenario.body?.id);
  scenarioIds.add(scenario.body!.id);
  assert.equal(scenario.body?.datasetId, dataset.body?.id);
  assert.equal(scenario.body?.status, "SAVED_FOR_REVIEW");
  assert.equal(scenario.body?.validationStatus, "VALID");
  assert.deepEqual(scenario.body?.relocation, { rackId, to: target });

  const detail = await api<{ scenario: { id: string; datasetId: string; source: string }; dataset: { id: string; source: string } }>(
    `/api/facilities/${facilityId}/replay/scenarios/${scenario.body!.id}`,
  );
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.body?.scenario.id, scenario.body?.id);
  assert.equal(detail.body?.scenario.datasetId, dataset.body?.id);
  assert.equal(detail.body?.scenario.source, "SYNTHETIC_DEMO");
  assert.equal(detail.body?.dataset.source, "SYNTHETIC_DEMO");

  const persistedBaseline = await pool.query(
    "SELECT baseline_model_config FROM replay_historical_scenarios WHERE id = $1",
    [scenario.body!.id],
  );
  assert.deepEqual(persistedBaseline.rows[0]?.baseline_model_config, config);

  const firstRun = await api<{
    scenarioId: string;
    simulated: boolean;
    source: string;
    sourceName: string;
    model: { versionId: string; config: FacilityModelConfig };
    unsupportedMetrics: string[];
    baselineRawOutputs: unknown[];
    candidateRawOutputs: unknown[];
    persisted: boolean;
  }>(
    `/api/facilities/${facilityId}/replay/scenarios/${scenario.body!.id}/run`,
    jsonBody({}),
  );
  assert.equal(firstRun.status, 201, firstRun.text);
  assert.equal(firstRun.body?.scenarioId, scenario.body?.id);
  assert.equal(firstRun.body?.simulated, true);
  assert.equal(firstRun.body?.source, "SYNTHETIC_DEMO");
  assert.equal(firstRun.body?.sourceName, "Synthetic replay demo dataset");
  assert.equal(firstRun.body?.model.versionId, modelVersionId);
  assert.deepEqual(firstRun.body?.model.config, config);
  assert.equal(firstRun.body?.persisted, true);
  assert(firstRun.body?.baselineRawOutputs.length && firstRun.body.candidateRawOutputs.length);
  assert.notDeepEqual(firstRun.body?.baselineRawOutputs, firstRun.body?.candidateRawOutputs);
  assert(firstRun.body?.unsupportedMetrics.some((item) => /energy/i.test(item)), "energy omission must be explicit");
  assert(!("energySavings" in (firstRun.body ?? {})), "replay must not invent an energy result");

  const baselineAfterRun = await pool.query(
    "SELECT baseline_model_config FROM replay_historical_scenarios WHERE id = $1",
    [scenario.body!.id],
  );
  assert.deepEqual(
    baselineAfterRun.rows[0]?.baseline_model_config,
    persistedBaseline.rows[0]?.baseline_model_config,
    "running a candidate must not mutate the immutable baseline model",
  );

  const secondRun = await api<{ persisted: boolean; inputFingerprint: string }>(
    `/api/facilities/${facilityId}/replay/scenarios/${scenario.body!.id}/run`,
    jsonBody({}),
  );
  assert.equal(secondRun.status, 200, secondRun.text);
  assert.equal(secondRun.body?.persisted, true);
  assert.equal(secondRun.body?.inputFingerprint, dataset.body?.checksum);

  const storedResult = await api<{ persisted: boolean; simulated: boolean; source: string; unsupportedMetrics: string[] }>(
    `/api/facilities/${facilityId}/replay/scenarios/${scenario.body!.id}/result`,
  );
  assert.equal(storedResult.status, 200, storedResult.text);
  assert.equal(storedResult.body?.persisted, true);
  assert.equal(storedResult.body?.simulated, true);
  assert.equal(storedResult.body?.source, "SYNTHETIC_DEMO");
  assert(storedResult.body?.unsupportedMetrics.some((item) => /energy/i.test(item)));
}

async function assertImportEndpoints() {
  const catalogue = await api<{ items: Array<{ id: string; category: string }> }>(
    `/api/facilities/${facilityId}/imports/catalogue`,
  );
  assert.equal(catalogue.status, 200, catalogue.text);
  assert(catalogue.body?.items.length, "curated import catalogue is empty");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="20" viewBox="0 0 32 20"><rect width="32" height="20" fill="#10212c"/><path d="M2 2h28v16H2z" fill="none" stroke="#72d5d0"/></svg>`;
  const upload = await api<{
    preview: { importId: string; fileId: string; kind: string; sourceName: string; objects: unknown[] };
    referenceLayer: { fileId: string; provenance: string; mimeType: string };
  }>(
    `/api/facilities/${facilityId}/imports/floorplans`,
    jsonBody({
      name: `prd-${suffix}.svg`,
      mimeType: "image/svg+xml",
      contentBase64: Buffer.from(svg, "utf8").toString("base64"),
    }),
  );
  assert.equal(upload.status, 201, upload.text);
  assert(upload.body?.preview.importId);
  assert(upload.body?.preview.fileId);
  importSessionIds.add(upload.body!.preview.importId);
  importFileIds.add(upload.body!.preview.fileId);
  assert.equal(upload.body?.preview.kind, "FLOORPLAN");
  assert.equal(upload.body?.preview.sourceName, `prd-${suffix}.svg`);
  assert.deepEqual(upload.body?.preview.objects, []);
  assert.equal(upload.body?.referenceLayer.fileId, upload.body?.preview.fileId);
  assert.equal(upload.body?.referenceLayer.provenance, "IMPORTED");
  assert.equal(upload.body?.referenceLayer.mimeType, "image/svg+xml");

  const review = await api<{
    preview: { importId: string; fileId: string };
    status: string;
    draftModelVersionId: string | null;
  }>(`/api/facilities/${facilityId}/imports/${upload.body!.preview.importId}`);
  assert.equal(review.status, 200, review.text);
  assert.equal(review.body?.status, "REVIEW");
  assert.equal(review.body?.draftModelVersionId, null);

  const file = await api<string>(
    `/api/facilities/${facilityId}/imports/files/${upload.body!.preview.fileId}`,
  );
  assert.equal(file.status, 200, "stored SVG reference could not be read");
  assert.match(file.text, /^<svg\b/);

  const draft = await api<{ id: string; status: string; importId: string; message: string }>(
    `/api/facilities/${facilityId}/imports/${upload.body!.preview.importId}/create-draft`,
    jsonBody({ mappings: [] }),
  );
  assert.equal(draft.status, 201, draft.text);
  assert(draft.body?.id);
  draftModelIds.add(draft.body!.id);
  assert.equal(draft.body?.status, "DRAFT");
  assert.equal(draft.body?.importId, upload.body?.preview.importId);
  assert.match(draft.body?.message ?? "", /validate and publish/i);
  const draftRow = await pool.query(
    "SELECT status, created_by FROM model_versions WHERE id = $1",
    [draft.body!.id],
  );
  assert.equal(draftRow.rows[0]?.status, "DRAFT");
  assert.equal(draftRow.rows[0]?.created_by, userId);
  const publishedRow = await pool.query(
    "SELECT id, status FROM model_versions WHERE id = (SELECT model_version FROM facilities WHERE id = $1)",
    [facilityId],
  );
  assert.equal(publishedRow.rows[0]?.id, "sfo-rom-1.0.0");
  assert.equal(publishedRow.rows[0]?.status, "PUBLISHED", "import draft must not activate a model");

  const reviewAfterDraft = await api<{ status: string; draftModelVersionId: string | null }>(
    `/api/facilities/${facilityId}/imports/${upload.body!.preview.importId}`,
  );
  assert.equal(reviewAfterDraft.status, 200, reviewAfterDraft.text);
  assert.equal(reviewAfterDraft.body?.status, "DRAFT_CREATED");
  assert.equal(reviewAfterDraft.body?.draftModelVersionId, draft.body?.id);

  const sessionsBeforeBadIfc = await pool.query(
    "SELECT count(*)::int AS count FROM facility_import_sessions WHERE created_by = $1",
    [userId],
  );
  const badIfc = await api(
    `/api/facilities/${facilityId}/imports/ifc`,
    jsonBody({
      name: `prd-invalid-${suffix}.ifc`,
      mimeType: "application/x-step",
      contentBase64: Buffer.from("this is not ISO-10303-21", "utf8").toString("base64"),
    }),
  );
  assert.equal(badIfc.status, 422, badIfc.text);
  const sessionsAfterBadIfc = await pool.query(
    "SELECT count(*)::int AS count FROM facility_import_sessions WHERE created_by = $1",
    [userId],
  );
  assert.equal(sessionsAfterBadIfc.rows[0]?.count, sessionsBeforeBadIfc.rows[0]?.count);
}

async function browserRegression() {
  await mkdir("screenshots", { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const paths = [
      ["/facilities/sfo-01/intelligence", "Facility intelligence", "explore"],
      ["/facilities/sfo-01/history", "Change history", "history"],
      ["/facilities/sfo-01/replay", "Scenario replay", "replay"],
      ["/facilities/sfo-01/import", "Import engineering data", "import"],
    ] as const;
    for (const [viewport, suffixName] of [
      [{ width: 1440, height: 900 }, "desktop"],
      [{ width: 390, height: 844 }, "mobile"],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        reducedMotion: "reduce",
        colorScheme: "dark",
      });
      const page = await context.newPage();
      await page.addInitScript((testUserId) => {
        (globalThis as typeof globalThis & { __WATTR_E2E_USER_ID__?: string }).__WATTR_E2E_USER_ID__ = testUserId;
        document.documentElement.dataset.theme = "dark";
      }, userId);
      for (const [path, expected, name] of paths) {
        await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
        await page.getByText(expected, { exact: false }).first().waitFor({ timeout: 15_000 });
        if (name === "explore") {
          // The scope KPI and asset projection are API-backed. Waiting for a
          // canonical contributor prevents a screenshot of the shell/loading
          // state and exercises the contributor-to-detail interaction.
          const kpi = page.locator("section").filter({ hasText: "SCOPE KPI / CONTRIBUTING DIMENSIONS" });
          await kpi.getByText("rack-a01", { exact: true }).first().waitFor({ timeout: 15_000 });
          if (suffixName === "desktop") {
            await kpi.getByText("rack-a01", { exact: true }).first().click();
            await page.getByRole("heading", { name: "Rack A01", exact: true }).waitFor({ timeout: 10_000 });
            const selectedAt = new URL(page.url()).searchParams.get("at");
            assert(selectedAt, "asset selection did not preserve a replay timestamp");

            await page.getByRole("button", { name: "Rack inlet temperature", exact: true }).click();
            await page.getByText("Selected asset time series", { exact: true }).waitFor({ timeout: 10_000 });
            await page.locator("section").filter({ hasText: "Selected asset time series" }).getByRole("heading", { name: "Rack inlet temperature", exact: true }).waitFor();
            assert(await page.locator("text=SIMULATED").count() > 0, "telemetry series is not labelled simulated");
            assert(await page.locator("tbody tr").count() > 0, "selected inlet history series is empty");

            await page.getByRole("button", { name: "Asset history", exact: true }).click();
            await page.waitForURL(/\/facilities\/sfo-01\/history\?/);
            const historyUrl = new URL(page.url());
            assert.equal(historyUrl.searchParams.get("assetId"), "rack-a01");
            assert.equal(historyUrl.searchParams.get("at"), selectedAt);

            await page.goto(`${baseUrl}/facilities/sfo-01/intelligence?view=telemetry&assetId=rack-a01&metric=rack_inlet_temperature_c&at=${encodeURIComponent(selectedAt)}`, { waitUntil: "domcontentloaded" });
            await page.getByText("Selected asset time series", { exact: true }).waitFor({ timeout: 10_000 });
            await page.getByRole("button", { name: /(?:Open|Show) in twin/ }).click();
            await page.waitForURL(/\/facilities\/sfo-01\/operations\?/);
            const twinUrl = new URL(page.url());
            assert.equal(twinUrl.searchParams.get("canonicalAssetId"), "rack-a01");
            assert.equal(twinUrl.searchParams.get("at"), selectedAt, "Show in twin changed the replay time");
            // Do not wait for WebGL/canvas: this regression covers the
            // navigation contract and replay timestamp, not renderer startup.
            await page.goto(`${baseUrl}/facilities/sfo-01/intelligence?view=telemetry&assetId=rack-a01&metric=rack_inlet_temperature_c&at=${encodeURIComponent(selectedAt)}`, { waitUntil: "domcontentloaded" });
            await page.getByText("Selected asset time series", { exact: true }).waitFor({ timeout: 10_000 });
          }
        } else if (name === "history") {
          await page.getByText("sfo-rom-1.0.0", { exact: true }).first().waitFor({ timeout: 15_000 });
        } else if (name === "replay") {
          // Wait for the saved scenario list, select this run's own scenario,
          // and drive the same run path an engineer uses in the browser.
          const saved = page.getByRole("button", { name: new RegExp(`PRD integration relocation ${suffix}`) });
          await saved.waitFor({ timeout: 15_000 });
          await saved.click();
          const runButton = page.getByRole("button", { name: "Run selected scenario", exact: true });
          await runButton.waitFor({ timeout: 10_000 });
          await runButton.click();
          await page.getByText("Baseline vs candidate thermal comparison", { exact: true }).waitFor({ timeout: 15_000 });
          const maps = page.getByRole("img", { name: /spatial thermal rack layout/i });
          await maps.first().waitFor({ timeout: 10_000 });
          assert.equal(await maps.count(), 2, "replay must render paired baseline and candidate spatial maps");
          assert(await page.getByText("SYNTHETIC DEMO", { exact: true }).count() > 0, "replay source label is missing");
          assert(await page.getByText(/energy savings/i).count() > 0, "replay energy omission is not disclosed");
        } else if (name === "import") {
          await page.getByText("Curated demo catalogue", { exact: true }).waitFor({ timeout: 15_000 });
        }
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          `${path} overflows at ${viewport.width}px`,
        );
        await page.screenshot({
          path: `screenshots/prd-${name}-${suffixName}.png`,
          fullPage: true,
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

try {
  await seed();
  await startServer();

  const facilities = await api<Array<{
    id: string;
    model_version: string;
    model_config: FacilityModelConfig;
    can_engineer: boolean;
  }>>("/api/facilities");
  assert.equal(facilities.status, 200, facilities.text);
  const facility = facilities.body?.find((item) => item.id === facilityId);
  assert(facility, "isolated engineer was not granted canonical SFO-01");
  assert.equal(facility.can_engineer, true, "replay writes require ENGINEER, not MODEL_ADMIN");
  assert(facility.model_config, "published model config is unavailable");

  await assertIntelligenceEndpoints(facility.model_config, facility.model_version);
  await assertReplayEndpoints(facility.model_config, facility.model_version);
  await assertImportEndpoints();
  await browserRegression();
} finally {
  await stopServer();
  try {
    await cleanup();
  } finally {
    await pool.end();
  }
}

console.log("PRD integration passed: intelligence APIs, isolated historical replay, immutable baseline, and responsive explorer/history/replay pages.");