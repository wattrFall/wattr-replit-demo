/**
 * Facility-scoped change history and historical scenario replay routes.
 * Register after the application's authentication middleware and before its API
 * catch-all. Dependencies are injected so this module cannot bypass the
 * existing role, organization, or facility-grant policy.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type pg from "pg";
import type { Capability } from "../src/lib/security/rolePolicy";
import type { FacilityModelConfig } from "../src/lib/cockpit/simulation";
import { assertModelConfig } from "../src/lib/cockpit/contracts";
import { hasHistoricalInitialInlets, parseReplayCsv, syntheticReplayCsv, validateReplayRows } from "../src/lib/replay/csv";
import { assertSupportedRelocation, runHistoricalReplay, supportedReplayRackIds } from "../src/lib/replay/engine";
import type { HistoricalDataset, HistoricalScenario, RackRelocation, ReplayValidation } from "../src/lib/replay/types";

type AuthedRequest = Request & { userId?: string };
type PoolClient = pg.PoolClient;

export type FacilityPermission = {
  organization_id: string;
  role: string;
  is_owner?: boolean;
};

export type ReplayRouteDependencies = {
  pool: pg.Pool;
  requireFacilityAccess: (
    userId: string,
    facilityId: string,
    response: Response,
    capability?: Capability,
  ) => Promise<FacilityPermission | undefined>;
  publishedModel: (
    facilityId: string,
    client?: pg.Pool | PoolClient,
  ) => Promise<{ model_version: string; config: FacilityModelConfig } | undefined>;
};

type ModelRow = { id: string; config: FacilityModelConfig; status: string; created_at: string; published_at: string | null };
type DatasetRow = {
  id: string; facility_id: string; model_version_id: string; source: HistoricalDataset["source"];
  source_name: string; checksum: string; input_rows: unknown; validation: unknown;
  period_start_at: string | number; period_end_at: string | number; created_at: string;
};
type ScenarioRow = {
  id: string; facility_id: string; dataset_id: string; name: string; status: HistoricalScenario["status"];
  period_start_at: string | number; period_end_at: string | number; historical_model_version_id: string;
  baseline_model_config: FacilityModelConfig; relocation: RackRelocation; assumptions: string[];
  missing_inputs: string[]; validation_status: HistoricalScenario["validationStatus"];
  created_by: string; created_at: string;
};

const asString = (value: unknown, maximum = 160) =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum ? value.trim() : undefined;
const json = (value: unknown) => JSON.stringify(value);
const checksum = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const asEpoch = (value: string | number) => Number(value);

function modelDataset(row: DatasetRow): HistoricalDataset {
  return {
    id: row.id, facilityId: row.facility_id, source: row.source, sourceName: row.source_name,
    checksum: row.checksum, rows: row.input_rows as HistoricalDataset["rows"],
    validation: row.validation as ReplayValidation, periodStartAt: asEpoch(row.period_start_at),
    periodEndAt: asEpoch(row.period_end_at), createdAt: row.created_at,
  };
}

function modelScenario(row: ScenarioRow, dataset: HistoricalDataset): HistoricalScenario {
  return {
    id: row.id, facilityId: row.facility_id, datasetId: row.dataset_id, name: row.name, status: row.status,
    periodStartAt: asEpoch(row.period_start_at), periodEndAt: asEpoch(row.period_end_at),
    historicalModelVersionId: row.historical_model_version_id, baselineModelConfig: row.baseline_model_config,
    relocation: row.relocation, assumptions: row.assumptions, missingInputs: row.missing_inputs,
    validationStatus: row.validation_status, source: dataset.source, createdAt: row.created_at, createdBy: row.created_by,
  };
}

function safeScenarioSummary(row: ScenarioRow, source: HistoricalDataset["source"]) {
  return {
    id: row.id, facilityId: row.facility_id, datasetId: row.dataset_id, name: row.name, status: row.status,
    periodStartAt: asEpoch(row.period_start_at), periodEndAt: asEpoch(row.period_end_at),
    historicalModelVersionId: row.historical_model_version_id, relocation: row.relocation,
    assumptions: row.assumptions, missingInputs: row.missing_inputs, validationStatus: row.validation_status,
    source, createdAt: row.created_at, createdBy: row.created_by,
  };
}

function relocation(value: unknown): RackRelocation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.rackId !== "string" || !item.to || typeof item.to !== "object" || Array.isArray(item.to)) return undefined;
  const to = item.to as Record<string, unknown>;
  if (!Number.isInteger(to.x) || !Number.isInteger(to.z)) return undefined;
  return { rackId: item.rackId, to: { x: Number(to.x), z: Number(to.z) } };
}

async function historicalModel(pool: pg.Pool, facilityId: string, versionId: string): Promise<ModelRow | undefined> {
  const result = await pool.query(
    `SELECT id, config, status, created_at, published_at
     FROM model_versions WHERE id = $1 AND facility_id = $2`,
    [versionId, facilityId],
  );
  return result.rows[0] as ModelRow | undefined;
}

/**
 * Publication hook for the host's transaction. It reads both immutable version
 * snapshots and only appends an event when their supported configuration differs.
 */
export async function recordReplayModelChange(input: {
  client: PoolClient;
  facilityId: string;
  previousVersionId: string;
  nextVersionId: string;
  actorUserId?: string | null;
  source: "MODEL_PUBLISH" | "MODEL_ROLLBACK" | "MODEL_CONFIGURATION";
  metadata?: Record<string, unknown>;
}): Promise<string | undefined> {
  const models = await input.client.query(
    `SELECT id, config FROM model_versions
     WHERE facility_id = $1 AND id = ANY($2::text[])`,
    [input.facilityId, [input.previousVersionId, input.nextVersionId]],
  );
  const before = models.rows.find((row) => row.id === input.previousVersionId)?.config;
  const after = models.rows.find((row) => row.id === input.nextVersionId)?.config;
  if (!before || !after) throw new RangeError("Cannot record history for an unavailable facility model version.");
  assertModelConfig(before);
  assertModelConfig(after);
  const changes = changedHistoricalAssets(before, after);
  if (!changes.length) return undefined;
  let firstId: string | undefined;
  for (const change of changes) {
    const id = randomUUID();
    firstId ??= id;
    await input.client.query(
      `INSERT INTO replay_change_events
         (id, facility_id, asset_id, model_version_id, actor_user_id, source, change_type, before_config, after_config, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [id, input.facilityId, change.assetId, input.nextVersionId, input.actorUserId ?? null, input.source, change.changeType,
        json(change.before), json(change.after), json({ ...input.metadata, affectedAssets: [change.assetId] })],
    );
  }
  return firstId;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type HistoricalAssetChange = {
  assetId: string;
  changeType: "MODEL_CONFIGURATION_CHANGED" | "RACK_RELOCATED" | "SUPPORTED_CONFIGURATION_CHANGED";
  before: unknown;
  after: unknown;
};

function changedHistoricalAssets(before: FacilityModelConfig, after: FacilityModelConfig): HistoricalAssetChange[] {
  const changes: HistoricalAssetChange[] = [];
  const beforeLayout = before.layout;
  const afterLayout = after.layout;
  if (beforeLayout || afterLayout) {
    const oldItems = new Map((beforeLayout?.items ?? []).map((item) => [item.id, item]));
    const newItems = new Map((afterLayout?.items ?? []).map((item) => [item.id, item]));
    for (const assetId of new Set([...oldItems.keys(), ...newItems.keys()])) {
      const oldItem = oldItems.get(assetId) ?? null;
      const newItem = newItems.get(assetId) ?? null;
      if (stableJson(oldItem) === stableJson(newItem)) continue;
      const movedRack = oldItem?.kind === "rack" && newItem?.kind === "rack" &&
        stableJson(oldItem.cell) !== stableJson(newItem.cell);
      changes.push({ assetId, changeType: movedRack ? "RACK_RELOCATED" : "SUPPORTED_CONFIGURATION_CHANGED", before: oldItem, after: newItem });
    }
    const addLayoutChanges = (kind: "zones" | "connections", prefix: string) => {
      const oldEntities = new Map((beforeLayout?.[kind] ?? []).map((entity) => [entity.id, entity]));
      const newEntities = new Map((afterLayout?.[kind] ?? []).map((entity) => [entity.id, entity]));
      for (const id of new Set([...oldEntities.keys(), ...newEntities.keys()])) {
        const oldEntity = oldEntities.get(id) ?? null;
        const newEntity = newEntities.get(id) ?? null;
        if (stableJson(oldEntity) !== stableJson(newEntity)) {
          changes.push({ assetId: `${prefix}:${id}`, changeType: "SUPPORTED_CONFIGURATION_CHANGED", before: oldEntity, after: newEntity });
        }
      }
    };
    addLayoutChanges("zones", "zone");
    addLayoutChanges("connections", "connection");
  }
  const withoutLayout = (config: FacilityModelConfig) => {
    const { layout: _layout, ...remainder } = config;
    return remainder;
  };
  if (stableJson(withoutLayout(before)) !== stableJson(withoutLayout(after))) {
    changes.push({ assetId: "facility-model", changeType: "MODEL_CONFIGURATION_CHANGED", before: withoutLayout(before), after: withoutLayout(after) });
  }
  return changes;
}

export function registerReplayRoutes(app: Express, dependencies: ReplayRouteDependencies): void {
  const { pool, requireFacilityAccess, publishedModel } = dependencies;
  const canRead = async (req: AuthedRequest, res: Response) =>
    requireFacilityAccess(req.userId!, String(req.params.facilityId), res, "view");
  const canEngineer = async (req: AuthedRequest, res: Response) =>
    requireFacilityAccess(req.userId!, String(req.params.facilityId), res, "engineer");

  app.get("/api/facilities/:facilityId/history", async (req: AuthedRequest, res) => {
    if (!await canRead(req, res)) return;
    const facilityId = String(req.params.facilityId);
    const assetId = asString(req.query.assetId, 128) ?? null;
    const [events, versions] = await Promise.all([
      pool.query(
        `SELECT id, asset_id, model_version_id, occurred_at, actor_user_id, source, change_type, before_config, after_config, metadata
         FROM replay_change_events
         WHERE facility_id = $1 AND ($2::text IS NULL OR asset_id = $2 OR (metadata->'affectedAssets') ? $2)
         ORDER BY occurred_at DESC, id DESC LIMIT 200`, [facilityId, assetId],
      ),
      pool.query(
        `SELECT id, status, config, created_at, published_at
         FROM model_versions WHERE facility_id = $1 ORDER BY created_at DESC LIMIT 100`, [facilityId],
      ),
    ]);
    res.json({ events: events.rows, modelVersions: versions.rows });
  });

  app.get("/api/facilities/:facilityId/replay/datasets", async (req: AuthedRequest, res) => {
    if (!await canRead(req, res)) return;
    const result = await pool.query(
      `SELECT id, model_version_id, source, source_name, checksum, validation, period_start_at, period_end_at, created_at
       FROM replay_datasets WHERE facility_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.params.facilityId],
    );
    res.json({ items: result.rows.map((row) => ({ ...row, period_start_at: Number(row.period_start_at), period_end_at: Number(row.period_end_at) })) });
  });

  app.post("/api/facilities/:facilityId/replay/datasets", async (req: AuthedRequest, res) => {
    if (!await canEngineer(req, res)) return;
    const facilityId = String(req.params.facilityId);
    const requestedVersion = asString(req.body?.modelVersionId, 128);
    const active = requestedVersion ? undefined : await publishedModel(facilityId);
    const model = requestedVersion
      ? await historicalModel(pool, facilityId, requestedVersion)
      : active ? { id: active.model_version, config: active.config } : undefined;
    if (!model) return res.status(409).json({ error: "The selected historical facility model is unavailable." });
    try {
      assertModelConfig(model.config);
      const source = req.body?.source === "SYNTHETIC_DEMO" ? "SYNTHETIC_DEMO" : "UPLOADED_CSV";
      const sourceName = source === "SYNTHETIC_DEMO"
        ? "Synthetic replay demo dataset"
        : asString(req.body?.sourceName, 160);
      if (!sourceName) return res.status(400).json({ error: "A source filename is required for uploaded historical CSV data." });
      const csv = source === "SYNTHETIC_DEMO"
        ? syntheticReplayCsv(supportedReplayRackIds(model.config))
        : req.body?.csv;
      const parsed = parseReplayCsv(csv, supportedReplayRackIds(model.config));
      if (!parsed.validation.valid) return res.status(422).json({ error: "Historical CSV validation failed.", validation: parsed.validation });
      const id = randomUUID();
      const fingerprint = checksum(csv);
      const inserted = await pool.query(
        `INSERT INTO replay_datasets
          (id, facility_id, model_version_id, uploaded_by, source, source_name, checksum, input_rows, validation, period_start_at, period_end_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
         ON CONFLICT (facility_id, model_version_id, checksum) DO NOTHING
         RETURNING id, model_version_id, source, source_name, checksum, validation, period_start_at, period_end_at, created_at`,
        [id, facilityId, model.id, req.userId, source, sourceName, fingerprint, json(parsed.rows), json(parsed.validation),
          parsed.validation.timestamps[0], parsed.validation.timestamps.at(-1)],
      );
      if (!inserted.rows[0]) {
        const existing = await pool.query(
          `SELECT id, model_version_id, source, source_name, checksum, validation, period_start_at, period_end_at, created_at
           FROM replay_datasets WHERE facility_id = $1 AND model_version_id = $2 AND checksum = $3`, [facilityId, model.id, fingerprint],
        );
        return res.status(200).json({ ...existing.rows[0], duplicate: true });
      }
      res.status(201).json(inserted.rows[0]);
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      throw error;
    }
  });

  app.get("/api/facilities/:facilityId/replay/scenarios", async (req: AuthedRequest, res) => {
    if (!await canRead(req, res)) return;
    const result = await pool.query(
      `SELECT s.*, d.source
       FROM replay_historical_scenarios s JOIN replay_datasets d ON d.id = s.dataset_id
       WHERE s.facility_id = $1 AND d.facility_id = s.facility_id ORDER BY s.created_at DESC LIMIT 100`, [req.params.facilityId],
    );
    res.json({ items: result.rows.map((row) => safeScenarioSummary(row as ScenarioRow, row.source)) });
  });

  app.post("/api/facilities/:facilityId/replay/scenarios", async (req: AuthedRequest, res) => {
    if (!await canEngineer(req, res)) return;
    const facilityId = String(req.params.facilityId);
    const datasetId = asString(req.body?.datasetId, 80);
    const name = asString(req.body?.name, 120);
    const move = relocation(req.body?.relocation);
    const startAt = req.body?.periodStartAt;
    const endAt = req.body?.periodEndAt;
    if (!datasetId || !name || !move || !Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || endAt < startAt) {
      return res.status(400).json({ error: "Scenario needs a name, facility dataset, valid period, and one rack relocation." });
    }
    const datasetResult = await pool.query(
      `SELECT * FROM replay_datasets WHERE id = $1 AND facility_id = $2`, [datasetId, facilityId],
    );
    const datasetRow = datasetResult.rows[0] as DatasetRow | undefined;
    if (!datasetRow) return res.status(404).json({ error: "Historical dataset unavailable." });
    const dataset = modelDataset(datasetRow);
    if (startAt < dataset.periodStartAt || endAt > dataset.periodEndAt) {
      return res.status(400).json({ error: "Selected period must remain within the uploaded historical dataset." });
    }
    const model = await historicalModel(pool, facilityId, datasetRow.model_version_id);
    if (!model) return res.status(409).json({ error: "The model associated with this historical dataset is unavailable." });
    try {
      assertModelConfig(model.config);
      const validation = validateReplayRows(dataset.rows, supportedReplayRackIds(model.config));
      assertSupportedRelocation(model.config, move.rackId, move.to);
      const includedTimes = validation.timestamps.filter((time) => time >= startAt && time <= endAt);
      if (!validation.valid || includedTimes.length < 2) {
        return res.status(422).json({ error: "Selected dataset or period has unsupported/missing inputs.", validation });
      }
      const hasInitialInlets = hasHistoricalInitialInlets(dataset.rows, startAt, supportedReplayRackIds(model.config));
      const missingInputs = Object.entries(validation.inputStatus).filter(([, value]) => value === "MISSING").map(([key]) => key)
        .filter((key) => key !== "initialInlet");
      if (!hasInitialInlets) missingInputs.push("initial_inlet_c");
      const assumptions = [
        "Baseline and candidate use identical uploaded rows and timestamps.",
        "rack_power_kw is applied as the rack thermal load; workload_kw remains recorded input evidence.",
        "Cooling boundaries apply to supported CRAC/CDU supply and flow settings.",
        "Spatial effects are constrained local distance/crowding terms and are not validated CFD.",
        hasInitialInlets
          ? "Complete historical initial_inlet_c values initialize both branches at the selected period boundary."
          : "No complete historical initial_inlet_c values exist at the selected boundary; both branches use the documented 30°C synthetic initial thermal state.",
      ];
      const id = randomUUID();
      const status: HistoricalScenario["status"] = req.body?.saveForReview === true ? "SAVED_FOR_REVIEW" : "DRAFT";
      const inserted = await pool.query(
        `INSERT INTO replay_historical_scenarios
          (id, facility_id, dataset_id, name, status, period_start_at, period_end_at, historical_model_version_id,
           baseline_model_config, relocation, assumptions, missing_inputs, validation_status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, 'VALID', $13)
         RETURNING *`,
        [id, facilityId, dataset.id, name, status, startAt, endAt, model.id, json(model.config), json(move),
          json(assumptions), json(missingInputs), req.userId],
      );
      res.status(201).json(safeScenarioSummary(inserted.rows[0] as ScenarioRow, dataset.source));
    } catch (error) {
      if (error instanceof RangeError) return res.status(400).json({ error: error.message });
      throw error;
    }
  });

  app.get("/api/facilities/:facilityId/replay/scenarios/:scenarioId", async (req: AuthedRequest, res) => {
    if (!await canRead(req, res)) return;
    const result = await pool.query(
      `SELECT s.*, d.source, d.source_name, d.checksum, d.input_rows, d.validation, d.period_start_at AS dataset_start_at, d.period_end_at AS dataset_end_at
       FROM replay_historical_scenarios s JOIN replay_datasets d ON d.id = s.dataset_id
       WHERE s.id = $1 AND s.facility_id = $2 AND d.facility_id = s.facility_id`,
      [req.params.scenarioId, req.params.facilityId],
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "Historical scenario unavailable." });
    const dataset = modelDataset({ ...row, id: row.dataset_id, period_start_at: row.dataset_start_at, period_end_at: row.dataset_end_at } as DatasetRow);
    res.json({ scenario: safeScenarioSummary(row as ScenarioRow, dataset.source), dataset: {
      id: dataset.id, source: dataset.source, sourceName: dataset.sourceName, checksum: dataset.checksum,
      periodStartAt: dataset.periodStartAt, periodEndAt: dataset.periodEndAt, validation: dataset.validation,
    } });
  });

  app.post("/api/facilities/:facilityId/replay/scenarios/:scenarioId/run", async (req: AuthedRequest, res) => {
    if (!await canEngineer(req, res)) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const loaded = await client.query(
        `SELECT s.*, d.source, d.source_name, d.checksum, d.input_rows, d.validation,
                d.period_start_at AS dataset_start_at, d.period_end_at AS dataset_end_at
         FROM replay_historical_scenarios s JOIN replay_datasets d ON d.id = s.dataset_id
         WHERE s.id = $1 AND s.facility_id = $2 AND d.facility_id = s.facility_id FOR UPDATE OF s`,
        [req.params.scenarioId, req.params.facilityId],
      );
      const row = loaded.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Historical scenario unavailable." });
      }
      const existing = await client.query(
        "SELECT result FROM replay_historical_results WHERE scenario_id = $1 AND facility_id = $2",
        [row.id, req.params.facilityId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return res.json({ ...existing.rows[0].result, persisted: true });
      }
      const dataset = modelDataset({ ...row, id: row.dataset_id, period_start_at: row.dataset_start_at, period_end_at: row.dataset_end_at } as DatasetRow);
      const scenario = modelScenario(row as ScenarioRow, dataset);
      const result = runHistoricalReplay(scenario, dataset);
      await client.query(
        `INSERT INTO replay_historical_results (scenario_id, facility_id, result, input_checksum, model_version_id)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [scenario.id, scenario.facilityId, json(result), dataset.checksum, scenario.historicalModelVersionId],
      );
      await client.query("COMMIT");
      res.status(201).json({ ...result, persisted: true });
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof RangeError) return res.status(422).json({ error: error.message });
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/api/facilities/:facilityId/replay/scenarios/:scenarioId/result", async (req: AuthedRequest, res) => {
    if (!await canRead(req, res)) return;
    const result = await pool.query(
      `SELECT r.result, r.generated_at FROM replay_historical_results r
       JOIN replay_historical_scenarios s ON s.id = r.scenario_id
       WHERE r.scenario_id = $1 AND r.facility_id = $2 AND s.facility_id = r.facility_id`,
      [req.params.scenarioId, req.params.facilityId],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Historical replay has not been run." });
    res.json({ ...result.rows[0].result, generatedAt: result.rows[0].generated_at, persisted: true });
  });
}