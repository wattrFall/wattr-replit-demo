import express, { type NextFunction, type Request, type Response } from "express";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import {
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  replayCockpitSnapshot,
  snapshotForAudit,
  type FacilityModelConfig,
} from "../src/lib/cockpit/simulation";
import { thermalGraph } from "../src/lib/cockpit/workspaces";
import {
  assertModelConfig,
  CONTRACT_VERSION,
  provenanceForRecord,
  syntheticProvenance,
} from "../src/lib/cockpit/contracts";

const app = express();
const port = Number(process.env.PORT || 5000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const isDatabaseTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const isScenarioTimestamp = (value: unknown): value is number =>
  isDatabaseTimestamp(value) &&
  value >= SCENARIO_START_S &&
  value <= SCENARIO_START_S + SCENARIO_DURATION_S;

function replaySnapshot(simulatedAt: number, config?: FacilityModelConfig) {
  return replayCockpitSnapshot(simulatedAt, config);
}

async function publishedModel(facilityId: string, client: pg.Pool | pg.PoolClient = pool) {
  const result = await client.query(
    `SELECT f.model_version, mv.config
     FROM facilities f JOIN model_versions mv ON mv.id = f.model_version
     WHERE f.id = $1`,
    [facilityId],
  );
  return result.rows[0] as { model_version: string; config: FacilityModelConfig } | undefined;
}

async function facilityPermission(userId: string, facilityId: string, capability = "can_view") {
  const result = await pool.query(
    `SELECT p.can_view, p.can_operate, p.can_edit_model, f.organization_id
     FROM facility_permissions p
     JOIN facilities f ON f.id = p.facility_id
     WHERE p.user_id = $1 AND p.facility_id = $2`,
    [userId, facilityId],
  );
  const row = result.rows[0];
  return row && row[capability] ? row : undefined;
}

function canonicalProvenance(row: {
  provenance?: string;
  synthetic_status?: string;
  created_at?: string;
  generated_at?: string;
  model_version_id?: string;
}) {
  return provenanceForRecord(row);
}

function canonical(row: Record<string, any>, facilityId: string) {
  const serialized: Record<string, unknown> = {};
  const numericFields = new Set([
    "rated_capacity_kw", "simulated_start_at", "duration_s", "seed", "simulated_at",
    "horizon_s", "baseline_peak_c", "advisory_peak_c", "baseline_constraint_minutes",
    "advisory_constraint_minutes", "elapsed_s", "sample_period_s", "forecast_minutes",
    "raw_signal_count",
  ]);
  for (const [key, value] of Object.entries(row)) {
    if (["provenance", "synthetic_status", "quality", "model_version_id"].includes(key)) continue;
    const camelKey = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    serialized[camelKey] = numericFields.has(key) && value !== null ? Number(value) : value;
  }
  return {
    contractVersion: CONTRACT_VERSION,
    ...serialized,
    facilityId,
    modelVersionId: row.model_version_id ?? row.modelVersionId ?? "unknown",
    provenance: canonicalProvenance(row),
    quality: row.quality ?? "GOOD",
  };
}

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(clerkMiddleware((req) => ({
  publishableKey: publishableKeyFromHost(getClerkProxyHost(req) ?? "", process.env.CLERK_PUBLISHABLE_KEY),
})));

type AuthedRequest = Request & { userId?: string };

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const auth = getAuth(req);
  const userId = auth?.sessionClaims?.userId as string | undefined || auth?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
}

async function ensureDemoAccess(userId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize the first-member decision for this organization. The lock is
    // transaction-scoped, so concurrent endpoints and signups cannot both
    // observe an empty membership set and grant themselves administrator rights.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('wattr-demo-bootstrap'))");
    await client.query(
      "INSERT INTO users (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [userId, "Wattr Operator"],
    );
    await client.query(
      "INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
    const existing = await client.query(
      "SELECT role FROM memberships WHERE user_id = $1 AND organization_id = 'wattr-demo'",
      [userId],
    );
    if (!existing.rowCount) {
      const memberCount = await client.query(
        "SELECT count(*)::integer AS count FROM memberships WHERE organization_id = 'wattr-demo'",
      );
      const firstUser = memberCount.rows[0].count === 0;
      await client.query(
        `INSERT INTO memberships (user_id, organization_id, role)
         VALUES ($1, 'wattr-demo', $2)
         ON CONFLICT (user_id, organization_id) DO NOTHING`,
        [userId, firstUser ? "MODEL_ADMIN" : "VIEWER"],
      );
      await client.query(
        `INSERT INTO facility_permissions
          (user_id, facility_id, can_view, can_operate, can_edit_model)
         VALUES ($1, 'sfo-01', true, $2, $2)
         ON CONFLICT (user_id, facility_id) DO NOTHING`,
        [userId, firstUser],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "wattr-operator-cockpit" }));

app.get("/api/me", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const result = await pool.query(
    `SELECT u.id, u.display_name, m.role, p.theme, p.tutorial_complete, p.tutorial_step
     FROM users u
     JOIN memberships m ON m.user_id = u.id AND m.organization_id = 'wattr-demo'
     JOIN user_preferences p ON p.user_id = u.id
     WHERE u.id = $1`,
    [req.userId],
  );
  res.json(result.rows[0]);
});

app.get("/api/facilities", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const result = await pool.query(
    `SELECT f.id, f.name, f.location, f.model_version, f.provenance, mv.config AS model_config,
            p.can_operate, p.can_edit_model
     FROM facilities f
     JOIN model_versions mv ON mv.id = f.model_version
     JOIN facility_permissions p ON p.facility_id = f.id
     WHERE p.user_id = $1 AND p.can_view = true`,
    [req.userId],
  );
  res.json(result.rows);
});

/**
 * The context endpoint is the canonical read model. Each collection is
 * permission-filtered and references the same published model version; the
 * simulation snapshot is reconstructed on request rather than copied into
 * every high-frequency telemetry row.
 */
app.get("/api/facilities/:facilityId/context", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const facilityId = String(req.params.facilityId);
  if (!await facilityPermission(req.userId!, facilityId)) {
    return res.status(403).json({ error: "Facility permission required" });
  }
  const [facility, hierarchy, assets, sensors, topology, scenarios, forecasts, incidents, recommendations, decisions, checkpoints] =
    await Promise.all([
      pool.query(
        `SELECT f.id, f.organization_id, f.name, f.location, f.model_version AS model_version_id,
                f.provenance, f.synthetic_status, f.quality, f.created_at, mv.config AS model_config
         FROM facilities f JOIN model_versions mv ON mv.id = f.model_version WHERE f.id = $1`,
        [facilityId],
      ),
      pool.query(
        `SELECT id, parent_id, kind, name, path, model_version_id, provenance, synthetic_status,
                quality, metadata, created_at
         FROM facility_hierarchy WHERE facility_id = $1 ORDER BY path`,
        [facilityId],
      ),
      pool.query(
        `SELECT id, hierarchy_id, parent_asset_id, kind, name, status, rated_capacity_kw,
                unit_metadata, model_version_id, provenance, synthetic_status, quality, metadata, created_at
         FROM assets WHERE facility_id = $1 ORDER BY id`,
        [facilityId],
      ),
      pool.query(
        `SELECT id, asset_id, hierarchy_id, name, metric, unit, sample_period_s, quality,
                model_version_id, provenance, synthetic_status, metadata, created_at
         FROM sensors WHERE facility_id = $1 ORDER BY id`,
        [facilityId],
      ),
      pool.query(
        `SELECT id, from_asset_id, to_asset_id, relation, model_version_id, provenance,
                synthetic_status, quality, metadata, created_at
         FROM topology_edges WHERE facility_id = $1 ORDER BY id`,
        [facilityId],
      ),
      pool.query(
        `SELECT id, scenario_key, name, status, simulated_start_at, duration_s, seed,
                model_version_id, config, provenance, synthetic_status, quality, created_at
         FROM scenarios WHERE facility_id = $1 ORDER BY created_at DESC`,
        [facilityId],
      ),
      pool.query(
        `SELECT id, scenario_id, simulated_at, horizon_s, baseline_peak_c, advisory_peak_c,
                baseline_constraint_minutes, advisory_constraint_minutes, risk, model_version_id,
                provenance, synthetic_status, quality, generated_at
         FROM forecasts WHERE facility_id = $1 ORDER BY simulated_at`,
        [facilityId],
      ),
      pool.query(
        `SELECT id, scenario_id, title, severity, status, simulated_at, affected_assets,
                raw_signal_count, likely_cause, forecast_minutes, model_version_id,
                provenance, synthetic_status, quality, created_at
         FROM incidents WHERE facility_id = $1 ORDER BY created_at DESC`,
        [facilityId],
      ),
      pool.query(
        `SELECT r.id, r.scenario_id, r.incident_id, r.kind, r.status, r.title, r.rationale,
                r.command, r.simulated_at, r.model_version_id, r.provenance,
                r.synthetic_status, r.quality, r.created_at, mv.config AS model_config
         FROM recommendations r JOIN model_versions mv ON mv.id = r.model_version_id
         WHERE r.facility_id = $1 ORDER BY r.created_at DESC`,
        [facilityId],
      ),
      pool.query(
        `SELECT id, scenario_id, recommendation_id, safety_evaluation_id, user_id, decision,
                outcome, simulated_at, model_version_id, payload, provenance, synthetic_status,
                quality, created_at
         FROM operator_decisions WHERE facility_id = $1 ORDER BY created_at DESC`,
        [facilityId],
      ),
      pool.query(
        `SELECT id, scenario_id, simulated_at, elapsed_s, state, model_version_id,
                provenance, synthetic_status, quality, created_at
         FROM replay_checkpoints WHERE facility_id = $1 ORDER BY simulated_at`,
        [facilityId],
      ),
    ]);
  if (!facility.rows[0]) return res.status(404).json({ error: "Facility not found" });
  const mapRows = (rows: Record<string, any>[]) => rows.map((row) => canonical(row, facilityId));
  const facilityRow = facility.rows[0];
  const scenario = scenarios.rows[0];
  const simulatedAt = scenario?.simulated_start_at ?? SCENARIO_START_S;
  const modelConfig = facilityRow.model_config as FacilityModelConfig;
  assertModelConfig(modelConfig);
  return res.json({
    contractVersion: CONTRACT_VERSION,
    facility: canonical(facilityRow, facilityId),
    hierarchy: mapRows(hierarchy.rows),
    assets: mapRows(assets.rows),
    sensors: mapRows(sensors.rows),
    topology: mapRows(topology.rows),
    scenarios: mapRows(scenarios.rows),
    forecasts: mapRows(forecasts.rows),
    incidents: mapRows(incidents.rows),
    recommendations: recommendations.rows.map((row) => ({
      ...canonical(row, facilityId),
      command: row.command,
      snapshot: replaySnapshot(row.simulated_at, row.model_config),
    })),
    decisions: mapRows(decisions.rows),
    checkpoints: mapRows(checkpoints.rows),
    snapshot: {
      contractVersion: CONTRACT_VERSION,
      scenarioId: scenario?.id ?? "gpu-training-ramp-v1",
      simulatedAt,
      modelVersionId: facilityRow.model_version_id,
      provenance: canonicalProvenance({
        provenance: "SIMULATED",
        synthetic_status: "SYNTHETIC",
        created_at: facilityRow.created_at,
        model_version_id: facilityRow.model_version_id,
      }),
      quality: "GOOD",
      value: replaySnapshot(simulatedAt, modelConfig),
    },
  });
});

app.get("/api/facilities/:facilityId/hierarchy", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const facilityId = String(req.params.facilityId);
  if (!await facilityPermission(req.userId!, facilityId)) return res.status(403).json({ error: "Facility permission required" });
  const result = await pool.query(
    `SELECT id, parent_id, kind, name, path, model_version_id, provenance, synthetic_status,
            quality, metadata, created_at
     FROM facility_hierarchy WHERE facility_id = $1 ORDER BY path`,
    [facilityId],
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows.map((row) => canonical(row, facilityId)) });
});

app.get("/api/facilities/:facilityId/assets", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const facilityId = String(req.params.facilityId);
  if (!await facilityPermission(req.userId!, facilityId)) return res.status(403).json({ error: "Facility permission required" });
  const result = await pool.query(
    `SELECT id, hierarchy_id, parent_asset_id, kind, name, status, rated_capacity_kw,
            unit_metadata, model_version_id, provenance, synthetic_status, quality, metadata, created_at
     FROM assets WHERE facility_id = $1 ORDER BY id`,
    [facilityId],
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows.map((row) => canonical(row, facilityId)) });
});

app.get("/api/facilities/:facilityId/sensors", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const facilityId = String(req.params.facilityId);
  if (!await facilityPermission(req.userId!, facilityId)) return res.status(403).json({ error: "Facility permission required" });
  const result = await pool.query(
    `SELECT id, asset_id, hierarchy_id, name, metric, unit, sample_period_s, quality,
            model_version_id, provenance, synthetic_status, metadata, created_at
     FROM sensors WHERE facility_id = $1 ORDER BY id`,
    [facilityId],
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows.map((row) => canonical(row, facilityId)) });
});

app.get("/api/facilities/:facilityId/scenarios", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const facilityId = String(req.params.facilityId);
  if (!await facilityPermission(req.userId!, facilityId)) return res.status(403).json({ error: "Facility permission required" });
  const result = await pool.query(
    `SELECT id, scenario_key, name, status, simulated_start_at, duration_s, seed,
            model_version_id, config, provenance, synthetic_status, quality, created_at
     FROM scenarios WHERE facility_id = $1 ORDER BY created_at DESC`,
    [facilityId],
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows.map((row) => canonical(row, facilityId)) });
});

app.get("/api/facilities/:facilityId/scenarios/:scenarioId/snapshot", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const facilityId = String(req.params.facilityId);
  if (!await facilityPermission(req.userId!, facilityId)) return res.status(403).json({ error: "Facility permission required" });
  const scenarioResult = await pool.query(
    `SELECT s.id, s.simulated_start_at, s.duration_s, s.model_version_id,
            mv.config AS model_config
     FROM scenarios s JOIN model_versions mv ON mv.id = s.model_version_id
     WHERE s.facility_id = $1 AND s.id = $2`,
    [facilityId, req.params.scenarioId],
  );
  const scenario = scenarioResult.rows[0];
  if (!scenario) return res.status(404).json({ error: "Scenario not found" });
  const simulatedAt = req.query.simulatedAt === undefined
    ? Number(scenario.simulated_start_at)
    : Number(req.query.simulatedAt);
  if (!Number.isSafeInteger(simulatedAt) ||
      simulatedAt < Number(scenario.simulated_start_at) ||
      simulatedAt > Number(scenario.simulated_start_at) + scenario.duration_s) {
    return res.status(400).json({ error: "Invalid simulation timestamp" });
  }
  assertModelConfig(scenario.model_config);
  res.json({
    contractVersion: CONTRACT_VERSION,
    scenarioId: scenario.id,
    simulatedAt,
    modelVersionId: scenario.model_version_id,
    provenance: syntheticProvenance(undefined, scenario.model_version_id),
    quality: "GOOD",
    snapshot: replaySnapshot(simulatedAt, scenario.model_config),
  });
});

app.get("/api/facilities/:facilityId/forecasts", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const facilityId = String(req.params.facilityId);
  if (!await facilityPermission(req.userId!, facilityId)) return res.status(403).json({ error: "Facility permission required" });
  const result = await pool.query(
    `SELECT id, scenario_id, simulated_at, horizon_s, baseline_peak_c, advisory_peak_c,
            baseline_constraint_minutes, advisory_constraint_minutes, risk, model_version_id,
            provenance, synthetic_status, quality, generated_at
     FROM forecasts WHERE facility_id = $1 ORDER BY simulated_at`,
    [facilityId],
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows.map((row) => canonical(row, facilityId)) });
});

app.get("/api/facilities/:facilityId/recommendations", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const facilityId = String(req.params.facilityId);
  if (!await facilityPermission(req.userId!, facilityId)) return res.status(403).json({ error: "Facility permission required" });
  const model = await publishedModel(facilityId);
  if (!model) return res.status(409).json({ error: "Published facility model is unavailable" });
  const result = await pool.query(
    `SELECT r.id, r.scenario_id, r.incident_id, r.kind, r.status, r.title, r.rationale, r.command,
            simulated_at, r.model_version_id, r.provenance, r.synthetic_status, r.quality,
            r.created_at, mv.config AS model_config
     FROM recommendations r JOIN model_versions mv ON mv.id = r.model_version_id
     WHERE r.facility_id = $1 ORDER BY r.created_at DESC`,
    [facilityId],
  );
  res.json({
    contractVersion: CONTRACT_VERSION,
    items: result.rows.map((row) => ({
      ...canonical(row, facilityId),
      snapshot: replaySnapshot(row.simulated_at, row.model_config),
    })),
  });
});

app.get("/api/facilities/:facilityId/decisions", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const facilityId = String(req.params.facilityId);
  if (!await facilityPermission(req.userId!, facilityId)) return res.status(403).json({ error: "Facility permission required" });
  const result = await pool.query(
    `SELECT id, scenario_id, recommendation_id, safety_evaluation_id, user_id, decision,
            outcome, simulated_at, model_version_id, payload, provenance, synthetic_status,
            quality, created_at
     FROM operator_decisions WHERE facility_id = $1 ORDER BY created_at DESC`,
    [facilityId],
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows.map((row) => canonical(row, facilityId)) });
});

app.get("/api/facilities/:facilityId/replay/checkpoints", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const facilityId = String(req.params.facilityId);
  if (!await facilityPermission(req.userId!, facilityId)) return res.status(403).json({ error: "Facility permission required" });
  const result = await pool.query(
    `SELECT id, scenario_id, simulated_at, elapsed_s, state, model_version_id,
            provenance, synthetic_status, quality, created_at
     FROM replay_checkpoints WHERE facility_id = $1 ORDER BY simulated_at`,
    [facilityId],
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows.map((row) => canonical(row, facilityId)) });
});

app.get("/api/me/saved-views", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const result = await pool.query(
    `SELECT id, facility_id, name, view_type, state, created_at, updated_at
     FROM saved_views WHERE user_id = $1 ORDER BY updated_at DESC`,
    [req.userId],
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows });
});

app.get("/api/tutorials", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const result = await pool.query(
    `SELECT id, role, version, steps, provenance, created_at FROM tutorials ORDER BY role, version DESC`,
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows });
});

app.get("/api/facilities/:facilityId/audit", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const result = await pool.query(
    `SELECT a.id, a.action, a.scenario_id, a.simulated_at, a.model_version, a.payload, a.created_at
     FROM audit_records a
     JOIN facility_permissions p ON p.facility_id = a.facility_id
     WHERE p.user_id = $1 AND p.can_view = true AND a.facility_id = $2
     ORDER BY a.created_at DESC LIMIT 100`,
    [req.userId, req.params.facilityId],
  );
  res.json(result.rows);
});

app.get("/api/facilities/:facilityId/audit/:auditId", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const result = await pool.query(
    `SELECT a.id, a.action, a.scenario_id, a.simulated_at, a.model_version, a.payload, a.created_at
     FROM audit_records a
     JOIN facility_permissions p ON p.facility_id = a.facility_id
     WHERE p.user_id = $1 AND p.can_view = true AND a.facility_id = $2 AND a.id = $3`,
    [req.userId, req.params.facilityId, req.params.auditId],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Audit record not found" });
  const record = result.rows[0];
  res.json({ record, snapshot: record.payload?.snapshot ?? replaySnapshot(record.simulated_at, record.payload?.modelConfig) });
});

app.get("/api/facilities/:facilityId/incidents", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const result = await pool.query(
    `SELECT i.id, i.title, i.severity, i.status, i.simulated_at, i.affected_assets,
            i.raw_signal_count, i.likely_cause, i.forecast_minutes, i.model_version
     FROM incidents i
     JOIN facility_permissions p ON p.facility_id = i.facility_id
     WHERE p.user_id = $1 AND p.can_view = true AND i.facility_id = $2
     ORDER BY i.created_at DESC`,
    [req.userId, req.params.facilityId],
  );
  res.json(result.rows);
});

app.get("/api/facilities/:facilityId/incidents/:incidentId", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const result = await pool.query(
    `SELECT i.id, i.title, i.severity, i.status, i.simulated_at, i.affected_assets,
            i.raw_signal_count, i.likely_cause, i.forecast_minutes, i.model_version, i.model_config
     FROM incidents i
     JOIN facility_permissions p ON p.facility_id = i.facility_id
     WHERE p.user_id = $1 AND p.can_view = true AND i.facility_id = $2 AND i.id = $3`,
    [req.userId, req.params.facilityId, req.params.incidentId],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Incident not found" });
  res.json({ incident: result.rows[0], snapshot: replaySnapshot(result.rows[0].simulated_at, result.rows[0].model_config) });
});

app.get("/api/facilities/:facilityId/topology", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const permission = await pool.query(
    "SELECT can_view FROM facility_permissions WHERE user_id = $1 AND facility_id = $2",
    [req.userId, req.params.facilityId],
  );
  if (!permission.rows[0]?.can_view) return res.status(403).json({ error: "Facility permission required" });
  const [model, persisted] = await Promise.all([
    publishedModel(String(req.params.facilityId)),
    pool.query(
      `SELECT id, from_asset_id, to_asset_id, relation, model_version_id,
              provenance, synthetic_status, quality, metadata, created_at
       FROM topology_edges WHERE facility_id = $1 ORDER BY id`,
      [req.params.facilityId],
    ),
  ]);
  if (!model) return res.status(409).json({ error: "Published facility model is unavailable" });
  res.json({
    contractVersion: CONTRACT_VERSION,
    modelVersionId: model.model_version,
    provenance: syntheticProvenance(undefined, model.model_version),
    ...thermalGraph(replaySnapshot(SCENARIO_START_S, model.config)),
    persistedEdges: persisted.rows.map((row) => canonical(row, String(req.params.facilityId))),
  });
});

app.patch("/api/me/tutorial", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const step = req.body?.step;
  const complete = req.body?.complete;
  if (!Number.isInteger(step) || step < 0 || step > 20 || typeof complete !== "boolean") {
    return res.status(400).json({ error: "Invalid tutorial progress" });
  }
  const result = await pool.query(
    `UPDATE user_preferences
     SET tutorial_step = $2, tutorial_complete = $3, updated_at = now()
     WHERE user_id = $1
     RETURNING tutorial_step, tutorial_complete`,
    [req.userId, step, complete],
  );
  res.json(result.rows[0]);
});

app.get("/api/facilities/:facilityId/model/versions", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const permission = await pool.query(
    "SELECT can_view FROM facility_permissions WHERE user_id = $1 AND facility_id = $2",
    [req.userId, req.params.facilityId],
  );
  if (!permission.rows[0]?.can_view) return res.status(403).json({ error: "Facility permission required" });
  const result = await pool.query(
    `SELECT id, facility_id, status, config, published_at, created_by, created_at
     FROM model_versions WHERE facility_id = $1 ORDER BY created_at DESC`,
    [req.params.facilityId],
  );
  res.json(result.rows);
});

app.post("/api/facilities/:facilityId/model/versions", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const permission = await pool.query(
    "SELECT can_edit_model FROM facility_permissions WHERE user_id = $1 AND facility_id = $2",
    [req.userId, req.params.facilityId],
  );
  if (!permission.rows[0]?.can_edit_model) return res.status(403).json({ error: "Model editing permission required" });
  const config = req.body?.config;
  if (
    !config || typeof config !== "object" || Array.isArray(config) ||
    config.scenario !== "gpu-training-ramp-v1" ||
    !Number.isInteger(config.seed) ||
    !Number.isFinite(config.thermalMass) || config.thermalMass < 0.2 || config.thermalMass > 2 ||
    !Number.isFinite(config.responseLag) || config.responseLag < 1 || config.responseLag > 120
  ) {
    return res.status(400).json({ error: "A DEMO MODEL requires the approved scenario, integer seed, thermalMass 0.2–2.0, and responseLag 1–120s" });
  }
  const id = `sfo-rom-${randomUUID().slice(0, 8)}`;
  const result = await pool.query(
    `INSERT INTO model_versions (id, facility_id, status, config, created_by)
     VALUES ($1, $2, 'DRAFT', $3::jsonb, $4)
     RETURNING id, facility_id, status, config, published_at, created_by, created_at`,
    [id, req.params.facilityId, JSON.stringify(config), req.userId],
  );
  res.status(201).json(result.rows[0]);
});

async function requireModelEdit(userId: string, facilityId: string, res: Response) {
  const permission = await pool.query(
    "SELECT can_edit_model FROM facility_permissions WHERE user_id = $1 AND facility_id = $2",
    [userId, facilityId],
  );
  if (!permission.rows[0]?.can_edit_model) {
    res.status(403).json({ error: "Model editing permission required" });
    return false;
  }
  return true;
}

app.post("/api/facilities/:facilityId/model/versions/:versionId/validate", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  if (!await requireModelEdit(req.userId!, String(req.params.facilityId), res)) return;
  const result = await pool.query(
    `UPDATE model_versions
     SET status = 'VALIDATED'
     WHERE id = $1 AND facility_id = $2 AND status = 'DRAFT'
       AND config->>'scenario' = 'gpu-training-ramp-v1'
       AND (config->>'seed')::integer IS NOT NULL
       AND (config->>'thermalMass')::numeric BETWEEN 0.2 AND 2.0
       AND (config->>'responseLag')::numeric BETWEEN 1 AND 120
     RETURNING id, status`,
    [req.params.versionId, req.params.facilityId],
  );
  if (!result.rows[0]) return res.status(409).json({ error: "Only valid draft models can be validated" });
  res.json(result.rows[0]);
});

app.post("/api/facilities/:facilityId/model/versions/:versionId/publish", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  if (!await requireModelEdit(req.userId!, String(req.params.facilityId), res)) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const version = await client.query(
      `SELECT id FROM model_versions
       WHERE id = $1 AND facility_id = $2 AND status = 'VALIDATED' FOR UPDATE`,
      [req.params.versionId, req.params.facilityId],
    );
    if (!version.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Validate this model before publishing" });
    }
    await client.query("UPDATE model_versions SET status = 'ARCHIVED' WHERE facility_id = $1 AND status = 'PUBLISHED'", [req.params.facilityId]);
    await client.query("UPDATE model_versions SET status = 'PUBLISHED', published_at = now() WHERE id = $1", [req.params.versionId]);
    await client.query("UPDATE facilities SET model_version = $1 WHERE id = $2", [req.params.versionId, req.params.facilityId]);
    await client.query("COMMIT");
    res.json({ id: req.params.versionId, status: "PUBLISHED" });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/api/facilities/:facilityId/model/rollback", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  if (!await requireModelEdit(req.userId!, String(req.params.facilityId), res)) return;
  const versionId = req.body?.versionId ?? req.params.versionId;
  if (typeof versionId !== "string") return res.status(400).json({ error: "A model version is required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const version = await client.query(
      `SELECT id FROM model_versions
       WHERE id = $1 AND facility_id = $2 AND status IN ('ARCHIVED','VALIDATED','PUBLISHED') FOR UPDATE`,
      [versionId, req.params.facilityId],
    );
    if (!version.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Rollback target not found" });
    }
    await client.query("UPDATE model_versions SET status = 'ARCHIVED' WHERE facility_id = $1 AND status = 'PUBLISHED'", [req.params.facilityId]);
    await client.query("UPDATE model_versions SET status = 'PUBLISHED', published_at = now() WHERE id = $1", [versionId]);
    await client.query("UPDATE facilities SET model_version = $1 WHERE id = $2", [versionId, req.params.facilityId]);
    await client.query("COMMIT");
    res.json({ id: versionId, status: "PUBLISHED" });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/api/facilities/:facilityId/recommendations/rec-17/evaluate", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const permission = await pool.query(
    "SELECT can_view FROM facility_permissions WHERE user_id = $1 AND facility_id = $2",
    [req.userId, req.params.facilityId],
  );
  if (!permission.rows[0]?.can_view) return res.status(403).json({ error: "Facility permission required" });
  const simulatedAt = req.body?.simulatedAt;
  if (!isScenarioTimestamp(simulatedAt)) return res.status(400).json({ error: "Invalid simulation timestamp" });

  const model = await publishedModel(String(req.params.facilityId));
  if (!model) return res.status(409).json({ error: "Published facility model is unavailable" });
  const snapshot = replaySnapshot(simulatedAt, model.config);
  const safety = snapshot.safety.checks;
  const checks = [
    { id: "COMMAND_ENVELOPE", pass: safety.commandEnvelope, detail: `${snapshot.recommendation.flowPercent}% is within the CDU-03 advisory envelope.` },
    { id: "HEADROOM", pass: safety.coolingHeadroom, detail: `Advisory forecast peak is ${snapshot.forecast.advisoryPeakC.toFixed(1)}°C.` },
    { id: "MAINTENANCE", pass: safety.maintenanceState, detail: "No synthetic maintenance lockout is active." },
    { id: "MODEL_CONFIDENCE", pass: safety.modelConfidence, detail: `Baseline forecast peak is ${snapshot.forecast.baselinePeakC.toFixed(1)}°C.` },
  ];
  const outcome = checks.every((check) => check.pass) ? "PASS" : "BLOCK";
  const id = randomUUID();
  await pool.query(
    `INSERT INTO safety_evaluations
      (id, user_id, facility_id, recommendation_id, simulated_at, outcome, checks,
       model_version, model_version_id, model_config, provenance, synthetic_status, expires_at)
     VALUES ($1, $2, $3, 'rec-17', $4, $5, $6::jsonb, $7, $7, $8::jsonb,
             'SIMULATED', 'SYNTHETIC', now() + interval '10 minutes')`,
    [id, req.userId, req.params.facilityId, simulatedAt, outcome, JSON.stringify(checks), model.model_version, JSON.stringify(model.config)],
  );
  res.status(201).json({ id, outcome, checks, simulatedAt });
});

app.post("/api/facilities/:facilityId/audit", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const permission = await pool.query(
    `SELECT p.can_operate, f.organization_id
     FROM facility_permissions p JOIN facilities f ON f.id = p.facility_id
     WHERE p.user_id = $1 AND p.facility_id = $2`,
    [req.userId, req.params.facilityId],
  );
  if (!permission.rows[0]?.can_operate) return res.status(403).json({ error: "Facility operation permission required" });
  const { action, simulatedAt, payload, safetyEvaluationId } = req.body ?? {};
  const validPayload =
    payload &&
    payload.recommendationId === "rec-17" &&
    payload.outcome === "ALLOWED_AS_ADVISORY" &&
    payload.provenance === "SIMULATED" &&
    payload.command?.assetId === "cdu-03" &&
    payload.command?.flowPercent === 78 &&
    payload.command?.durationMinutes === 20;
  if (action !== "APPROVE_ADVISORY" || !isScenarioTimestamp(simulatedAt) || !validPayload || typeof safetyEvaluationId !== "string") {
    return res.status(400).json({ error: "Invalid audit record" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const evaluation = await client.query(
      `SELECT id, model_version, model_version_id, model_config FROM safety_evaluations
       WHERE id = $1 AND user_id = $2 AND facility_id = $3
         AND recommendation_id = 'rec-17' AND simulated_at = $4
         AND outcome = 'PASS' AND used_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [safetyEvaluationId, req.userId, req.params.facilityId, simulatedAt],
    );
    if (!evaluation.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "A current server-verified Safety Shield PASS is required" });
    }
    const facilityModel = await publishedModel(String(req.params.facilityId), client);
    if (!facilityModel) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Published facility model is unavailable" });
    }
    if (facilityModel.model_version !== evaluation.rows[0].model_version) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "The facility model changed after Safety Shield evaluation; run it again" });
    }
    const evaluatedConfig = evaluation.rows[0].model_config as FacilityModelConfig;
    const snapshot = replaySnapshot(simulatedAt, evaluatedConfig);
    const decisionId = randomUUID();
    await client.query(
      `INSERT INTO operator_decisions
        (id, facility_id, scenario_id, recommendation_id, safety_evaluation_id, user_id,
         decision, outcome, simulated_at, model_version_id, payload, provenance,
         synthetic_status, quality)
       VALUES ($1, $2, 'gpu-training-ramp-v1', 'rec-17', $3, $4, 'APPROVE',
               'ALLOWED_AS_ADVISORY', $5, $6, $7::jsonb, 'SIMULATED', 'SYNTHETIC', 'GOOD')`,
      [
        decisionId,
        req.params.facilityId,
        safetyEvaluationId,
        req.userId,
        simulatedAt,
        facilityModel.model_version,
        JSON.stringify(payload),
      ],
    );
    const result = await client.query(
      `INSERT INTO audit_records
        (organization_id, facility_id, user_id, action, scenario_id, simulated_at,
         model_version, model_version_id, payload, provenance, synthetic_status)
       VALUES ($1, $2, $3, $4, 'gpu-training-ramp-v1', $5, $6, $6, $7::jsonb,
               'SIMULATED', 'SYNTHETIC')
       RETURNING id, action, created_at`,
      [permission.rows[0].organization_id, req.params.facilityId, req.userId, action, simulatedAt, facilityModel.model_version, JSON.stringify({
        ...payload,
        operatorDecisionId: decisionId,
        safetyEvaluationId,
        modelConfig: evaluatedConfig,
        snapshot: snapshotForAudit(snapshot),
      })],
    );
    await client.query("UPDATE safety_evaluations SET used_at = now() WHERE id = $1", [safetyEvaluationId]);
    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist"), { immutable: true, maxAge: "1y", index: false }));
  app.use((_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Wattr Operator Cockpit listening on ${port}`);
});