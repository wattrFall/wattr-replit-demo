import express, { type NextFunction, type Request, type Response } from "express";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import {
  COMMAND_ENVELOPE,
  MODEL_DOMAIN_MAX_C,
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  counterfactualCockpitSnapshot,
  replayCockpitSnapshot,
  snapshotForAudit,
  type AdvisoryParameters,
  type FacilityModelConfig,
} from "../src/lib/cockpit/simulation";
import { thermalGraph } from "../src/lib/cockpit/workspaces";
import {
  assertModelConfig,
  CONTRACT_VERSION,
  provenanceForRecord,
  syntheticProvenance,
} from "../src/lib/cockpit/contracts";
import {
  defaultLandingPath,
  ROLE_CAPABILITIES,
  ROLES,
  type Capability,
  type Role,
} from "../src/lib/security/rolePolicy";

const app = express();
const port = Number(process.env.PORT || 5000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DEMO_ORGANIZATION_ID = "wattr-demo";
const isDatabaseTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const isScenarioTimestamp = (value: unknown): value is number =>
  isDatabaseTimestamp(value) &&
  value >= SCENARIO_START_S &&
  value <= SCENARIO_START_S + SCENARIO_DURATION_S;

function replaySnapshot(simulatedAt: number, config?: FacilityModelConfig) {
  return replayCockpitSnapshot(simulatedAt, config);
}

type AdvisoryCommand = AdvisoryParameters & { assetId: "cdu-03" };
type SafetyCheckResult = {
  id: string;
  status: "PASS" | "WARNING" | "BLOCK";
  pass: boolean;
  detail: string;
  evidence: Record<string, unknown>;
};

function parseAdvisoryCommand(value: unknown): AdvisoryCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const command = value as Record<string, unknown>;
  if (
    command.assetId !== "cdu-03" ||
    typeof command.flowPercent !== "number" || !Number.isFinite(command.flowPercent) ||
    command.flowPercent < 0 || command.flowPercent > 100 ||
    !Number.isInteger(command.durationMinutes) ||
    Number(command.durationMinutes) < 1 || Number(command.durationMinutes) > 60
  ) return undefined;
  return {
    assetId: "cdu-03",
    flowPercent: command.flowPercent,
    durationMinutes: Number(command.durationMinutes),
  };
}

function advisoryCommandsEqual(left: unknown, right: AdvisoryCommand): boolean {
  const parsed = parseAdvisoryCommand(left);
  return Boolean(
    parsed &&
    parsed.assetId === right.assetId &&
    parsed.flowPercent === right.flowPercent &&
    parsed.durationMinutes === right.durationMinutes,
  );
}

function safetyChecksFor(snapshot: ReturnType<typeof counterfactualCockpitSnapshot>, command: AdvisoryCommand): SafetyCheckResult[] {
  const inEnvelope =
    command.flowPercent >= COMMAND_ENVELOPE.minFlowPercent &&
    command.flowPercent <= COMMAND_ENVELOPE.maxFlowPercent;
  const advisoryPeak = snapshot.forecast.advisoryPeakC;
  const threshold = snapshot.forecast.thresholdC;
  const headroomStatus = advisoryPeak < threshold
    ? "PASS"
    : advisoryPeak < threshold + 1
      ? "WARNING"
      : "BLOCK";
  const confidenceStatus = snapshot.forecast.baselinePeakC <= MODEL_DOMAIN_MAX_C - 0.5
    ? "PASS"
    : snapshot.forecast.baselinePeakC <= MODEL_DOMAIN_MAX_C
      ? "WARNING"
      : "BLOCK";
  return [
    {
      id: "COMMAND_ENVELOPE",
      status: inEnvelope ? "PASS" : "BLOCK",
      pass: inEnvelope,
      detail: `${command.flowPercent}% ${inEnvelope ? "is within" : "is outside"} the ${COMMAND_ENVELOPE.minFlowPercent}–${COMMAND_ENVELOPE.maxFlowPercent}% CDU-03 advisory envelope.`,
      evidence: { requestedFlowPercent: command.flowPercent, envelope: COMMAND_ENVELOPE },
    },
    {
      id: "COOLING_HEADROOM",
      status: headroomStatus,
      pass: headroomStatus !== "BLOCK",
      detail: `Counterfactual peak is ${advisoryPeak.toFixed(1)}°C against the ${threshold.toFixed(1)}°C limit.`,
      evidence: { advisoryPeakC: advisoryPeak, thresholdC: threshold },
    },
    {
      id: "MAINTENANCE_STATE",
      status: snapshot.plant.maintenanceLockout ? "BLOCK" : "PASS",
      pass: !snapshot.plant.maintenanceLockout,
      detail: snapshot.plant.maintenanceLockout ? "A maintenance lockout is active." : "No synthetic maintenance lockout is active.",
      evidence: { maintenanceLockout: snapshot.plant.maintenanceLockout },
    },
    {
      id: "MODEL_CONFIDENCE",
      status: confidenceStatus,
      pass: confidenceStatus !== "BLOCK",
      detail: `Baseline peak is ${snapshot.forecast.baselinePeakC.toFixed(1)}°C; the disclosed model domain ends at ${MODEL_DOMAIN_MAX_C.toFixed(1)}°C.`,
      evidence: {
        baselinePeakC: snapshot.forecast.baselinePeakC,
        domainMaximumC: MODEL_DOMAIN_MAX_C,
        horizonConfidence: snapshot.forecast.confidence,
      },
    },
  ];
}

function safetyOutcome(checks: SafetyCheckResult[]): "PASS" | "WARNING" | "BLOCK" {
  if (checks.some((check) => check.status === "BLOCK")) return "BLOCK";
  if (checks.some((check) => check.status === "WARNING")) return "WARNING";
  return "PASS";
}

async function publishedModel(facilityId: string, client: pg.Pool | pg.PoolClient = pool) {
  const result = await client.query(
    `SELECT f.model_version, mv.config
     FROM facilities f JOIN model_versions mv ON mv.id = f.model_version
     WHERE f.id = $1 AND mv.status = 'PUBLISHED'`,
    [facilityId],
  );
  return result.rows[0] as { model_version: string; config: FacilityModelConfig } | undefined;
}

async function facilityPermission(userId: string, facilityId: string, capability: Capability = "view", client: pg.Pool | pg.PoolClient = pool) {
  const result = await client.query(
    `SELECT p.can_view, p.can_operate, p.can_edit_model, f.organization_id, m.role, m.is_admin,
            (o.owner_user_id = m.user_id) AS is_owner
     FROM facility_permissions p
     JOIN facilities f ON f.id = p.facility_id
     JOIN memberships m ON m.organization_id = f.organization_id AND m.user_id = p.user_id
     JOIN organizations o ON o.id = f.organization_id
     WHERE p.user_id = $1 AND p.facility_id = $2 AND f.organization_id = $4
       AND (
         ($3 = 'view' AND p.can_view)
         OR ($3 = 'operate' AND p.can_operate AND m.role = 'OPERATOR')
         OR ($3 = 'engineer' AND p.can_view AND m.role = 'ENGINEER')
         OR ($3 = 'model' AND p.can_edit_model AND m.role = 'MODEL_ADMIN')
         OR ($3 = 'assistant' AND p.can_view AND m.role IN ('PORTFOLIO_MANAGER', 'OPERATOR', 'ENGINEER'))
       )`,
    [userId, facilityId, capability, DEMO_ORGANIZATION_ID],
  );
  const row = result.rows[0];
  return row && ROLE_CAPABILITIES[row.role as Role]?.[capability] ? row : undefined;
}

async function organizationMembership(userId: string, client: pg.Pool | pg.PoolClient = pool) {
  const result = await client.query(
    `SELECT m.user_id, m.organization_id, m.role, m.is_admin,
            (o.owner_user_id = m.user_id) AS is_owner
     FROM memberships m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 AND m.organization_id = $2`,
    [userId, DEMO_ORGANIZATION_ID],
  );
  return result.rows[0] as {
    user_id: string; organization_id: string; role: Role; is_admin: boolean; is_owner: boolean;
  } | undefined;
}

async function requireFacilityAccess(userId: string, facilityId: string, res: Response, capability: Capability = "view") {
  const permission = await facilityPermission(userId, facilityId, capability);
  // Do not distinguish an unknown facility from one outside the user's
  // organization or facility grant.
  if (!permission) {
    res.status(404).json({ error: "Facility unavailable" });
    return undefined;
  }
  return permission;
}

async function requireOrganizationAdmin(userId: string, res: Response) {
  const membership = await organizationMembership(userId);
  if (!membership || (!membership.is_admin && !membership.is_owner)) {
    res.status(403).json({ error: "Organization administration permission required" });
    return undefined;
  }
  return membership;
}

async function recordAdministrativeAudit(
  client: pg.Pool | pg.PoolClient,
  actorUserId: string,
  action: string,
  targetUserId: string | null,
  facilityId: string | null,
  payload: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO administrative_audit_records
       (id, organization_id, actor_user_id, target_user_id, facility_id, action, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [randomUUID(), DEMO_ORGANIZATION_ID, actorUserId, targetUserId, facilityId, action, JSON.stringify(payload)],
  );
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
  if (process.env.NODE_ENV === "test") {
    const testUserId = req.header("x-test-user-id");
    if (testUserId) {
      req.userId = testUserId;
      return next();
    }
  }
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
    // The one-time owner bootstrap establishes a durable owner. After that,
    // authenticated users never receive a role implicitly; an owner/admin must
    // provision them through the administration API.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('wattr-demo-owner'))");
    await client.query(
      "INSERT INTO users (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET updated_at = now()",
      [userId, "Wattr User"],
    );
    await client.query(
      "INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
    const organization = await client.query(
      "SELECT owner_user_id FROM organizations WHERE id = $1 FOR UPDATE",
      [DEMO_ORGANIZATION_ID],
    );
    if (!organization.rows[0]?.owner_user_id) {
      const legacyOwner = await client.query(
        `SELECT user_id FROM memberships
         WHERE organization_id = $1 AND role = 'MODEL_ADMIN'
         ORDER BY user_id LIMIT 1`,
        [DEMO_ORGANIZATION_ID],
      );
      // Legacy databases can safely promote their already-established model
      // administrator. New databases fail closed until the explicit
      // security:provision-owner command is run.
      const legacyOwnerId = legacyOwner.rows[0]?.user_id;
      if (legacyOwnerId) {
        await client.query(
          "UPDATE organizations SET owner_user_id = $1 WHERE id = $2",
          [legacyOwnerId, DEMO_ORGANIZATION_ID],
        );
        await client.query(
          `UPDATE memberships SET is_admin = true
           WHERE user_id = $1 AND organization_id = $2`,
          [legacyOwnerId, DEMO_ORGANIZATION_ID],
        );
      }
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

app.use("/api", requireAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    await ensureDemoAccess(req.userId!);
    if (!await organizationMembership(req.userId!)) {
      return res.status(403).json({ error: "Organization membership required" });
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/api/me", requireAuth, async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `SELECT u.id, u.display_name, m.organization_id, m.role, m.is_admin,
            (o.owner_user_id = m.user_id) AS is_owner,
            p.theme, p.tutorial_complete, p.tutorial_step
     FROM users u
     JOIN memberships m ON m.user_id = u.id AND m.organization_id = $2
     JOIN organizations o ON o.id = m.organization_id
     JOIN user_preferences p ON p.user_id = u.id
     WHERE u.id = $1`,
    [req.userId, DEMO_ORGANIZATION_ID],
  );
  const member = result.rows[0];
  if (!member) return res.status(403).json({ error: "Organization membership required" });
  res.json({
    ...member,
    is_admin: Boolean(member.is_admin || member.is_owner),
    capabilities: ROLE_CAPABILITIES[member.role as Role],
    default_path: defaultLandingPath(member.role as Role),
  });
});

app.get("/api/facilities", requireAuth, async (req: AuthedRequest, res) => {
  const result = await pool.query(
    `SELECT f.id, f.name, f.location, f.model_version, f.provenance, mv.config AS model_config,
            COALESCE((
              SELECT r.status FROM recommendations r
              WHERE r.facility_id = f.id
              ORDER BY r.created_at DESC LIMIT 1
            ), 'NONE') AS recommendation_status,
            p.can_view,
            (p.can_operate AND m.role = 'OPERATOR') AS can_operate,
            (p.can_edit_model AND m.role = 'MODEL_ADMIN') AS can_edit_model,
            (m.role = 'ENGINEER') AS can_engineer,
            (m.role IN ('PORTFOLIO_MANAGER', 'OPERATOR', 'ENGINEER')) AS can_assistant
     FROM facilities f
     JOIN model_versions mv ON mv.id = f.model_version
     JOIN facility_permissions p ON p.facility_id = f.id
     JOIN memberships m ON m.user_id = p.user_id AND m.organization_id = f.organization_id
     WHERE p.user_id = $1 AND f.organization_id = $2 AND p.can_view = true`,
    [req.userId, DEMO_ORGANIZATION_ID],
  );
  res.json(result.rows);
});

app.get("/api/admin/memberships", requireAuth, async (req: AuthedRequest, res) => {
  if (!await requireOrganizationAdmin(req.userId!, res)) return;
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, m.role, m.is_admin,
            (o.owner_user_id = u.id) AS is_owner,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'facility_id', f.id,
                  'facility_name', f.name,
                  'can_view', COALESCE(p.can_view, false),
                  'can_operate', COALESCE(p.can_operate, false),
                  'can_edit_model', COALESCE(p.can_edit_model, false)
                ) ORDER BY f.name
              ) FILTER (WHERE f.id IS NOT NULL),
              '[]'::jsonb
            ) AS facilities
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     JOIN organizations o ON o.id = m.organization_id
     LEFT JOIN facilities f ON f.organization_id = m.organization_id
     LEFT JOIN facility_permissions p ON p.user_id = m.user_id AND p.facility_id = f.id
     WHERE m.organization_id = $1
     GROUP BY u.id, u.email, u.display_name, m.role, m.is_admin, o.owner_user_id
     ORDER BY (o.owner_user_id = u.id) DESC, u.display_name, u.id`,
    [DEMO_ORGANIZATION_ID],
  );
  res.json({ items: result.rows });
});

app.post("/api/admin/memberships", requireAuth, async (req: AuthedRequest, res) => {
  const administrator = await requireOrganizationAdmin(req.userId!, res);
  if (!administrator) return;
  const { userId, email, displayName, role, isAdmin = false } = req.body ?? {};
  if (
    typeof userId !== "string" || userId.length < 2 || userId.length > 200 ||
    !ROLES.includes(role) ||
    typeof isAdmin !== "boolean" ||
    (email !== undefined && (typeof email !== "string" || email.length > 320)) ||
    (displayName !== undefined && (typeof displayName !== "string" || displayName.length > 120))
  ) {
    return res.status(400).json({ error: "Invalid membership" });
  }
  // Only the durable owner may grant organization-administrator authority.
  if (isAdmin && !administrator.is_owner) {
    return res.status(403).json({ error: "Only the organization owner can grant administrator access" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query(
      `SELECT role, is_admin FROM memberships
       WHERE user_id = $1 AND organization_id = $2 FOR UPDATE`,
      [userId, DEMO_ORGANIZATION_ID],
    );
    const owner = await client.query(
      "SELECT owner_user_id FROM organizations WHERE id = $1 FOR UPDATE",
      [DEMO_ORGANIZATION_ID],
    );
    if (owner.rows[0]?.owner_user_id === userId && !isAdmin) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "The organization owner must remain an administrator" });
    }
    await client.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         email = COALESCE(EXCLUDED.email, users.email),
         display_name = COALESCE(EXCLUDED.display_name, users.display_name),
         updated_at = now()`,
      [userId, email ?? null, displayName ?? null],
    );
    await client.query(
      "INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
    await client.query(
      `INSERT INTO memberships (user_id, organization_id, role, is_admin)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, organization_id) DO UPDATE
         SET role = EXCLUDED.role, is_admin = EXCLUDED.is_admin`,
      [userId, DEMO_ORGANIZATION_ID, role, isAdmin],
    );
    await recordAdministrativeAudit(client, req.userId!, previous.rowCount ? "MEMBERSHIP_UPDATED" : "MEMBERSHIP_CREATED", userId, null, {
      previous: previous.rows[0] ?? null,
      role,
      isAdmin,
    });
    await client.query("COMMIT");
    res.status(previous.rowCount ? 200 : 201).json({ user_id: userId, role, is_admin: isAdmin });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.patch("/api/admin/memberships/:userId/facilities/:facilityId", requireAuth, async (req: AuthedRequest, res) => {
  if (!await requireOrganizationAdmin(req.userId!, res)) return;
  const { canView, canOperate, canEditModel } = req.body ?? {};
  if ([canView, canOperate, canEditModel].some((value) => typeof value !== "boolean") ||
      ((!canView) && (canOperate || canEditModel))) {
    return res.status(400).json({ error: "Facility grants require boolean values and view access for elevated rights" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query(
      `SELECT m.role FROM memberships m
       JOIN facilities f ON f.organization_id = m.organization_id
       WHERE m.user_id = $1 AND m.organization_id = $2 AND f.id = $3`,
      [req.params.userId, DEMO_ORGANIZATION_ID, req.params.facilityId],
    );
    if (!target.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Membership or facility unavailable" });
    }
    const previous = await client.query(
      `SELECT can_view, can_operate, can_edit_model FROM facility_permissions
       WHERE user_id = $1 AND facility_id = $2 FOR UPDATE`,
      [req.params.userId, req.params.facilityId],
    );
    await client.query(
      `INSERT INTO facility_permissions
         (user_id, facility_id, can_view, can_operate, can_edit_model)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, facility_id) DO UPDATE SET
         can_view = EXCLUDED.can_view,
         can_operate = EXCLUDED.can_operate,
         can_edit_model = EXCLUDED.can_edit_model`,
      [req.params.userId, req.params.facilityId, canView, canOperate, canEditModel],
    );
    await recordAdministrativeAudit(client, req.userId!, "FACILITY_PERMISSION_CHANGED", String(req.params.userId), String(req.params.facilityId), {
      previous: previous.rows[0] ?? null,
      canView,
      canOperate,
      canEditModel,
    });
    await client.query("COMMIT");
    res.json({ facility_id: req.params.facilityId, can_view: canView, can_operate: canOperate, can_edit_model: canEditModel });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.delete("/api/admin/memberships/:userId", requireAuth, async (req: AuthedRequest, res) => {
  if (!await requireOrganizationAdmin(req.userId!, res)) return;
  if (req.params.userId === req.userId) {
    return res.status(409).json({ error: "Administrators cannot revoke their own membership" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      "SELECT owner_user_id FROM organizations WHERE id = $1 FOR UPDATE",
      [DEMO_ORGANIZATION_ID],
    );
    if (owner.rows[0]?.owner_user_id === req.params.userId) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "The organization owner cannot be revoked" });
    }
    const membership = await client.query(
      `DELETE FROM memberships
       WHERE user_id = $1 AND organization_id = $2
       RETURNING role, is_admin`,
      [req.params.userId, DEMO_ORGANIZATION_ID],
    );
    if (!membership.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Membership unavailable" });
    }
    await client.query(
      `DELETE FROM facility_permissions p USING facilities f
       WHERE p.facility_id = f.id AND p.user_id = $1 AND f.organization_id = $2`,
      [req.params.userId, DEMO_ORGANIZATION_ID],
    );
    await recordAdministrativeAudit(client, req.userId!, "MEMBERSHIP_REVOKED", String(req.params.userId), null, {
      previous: membership.rows[0],
    });
    await client.query("COMMIT");
    res.status(204).end();
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/api/admin/audit", requireAuth, async (req: AuthedRequest, res) => {
  if (!await requireOrganizationAdmin(req.userId!, res)) return;
  const result = await pool.query(
    `SELECT id, actor_user_id, target_user_id, facility_id, action, payload, created_at
     FROM administrative_audit_records
     WHERE organization_id = $1
     ORDER BY created_at DESC LIMIT 200`,
    [DEMO_ORGANIZATION_ID],
  );
  res.json({ items: result.rows });
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
                raw_signal_count, likely_cause, forecast_minutes, correlated_signals,
                thermal_path, deduplication_key, model_version_id,
                provenance, synthetic_status, quality, created_at
         FROM incidents WHERE facility_id = $1 ORDER BY created_at DESC`,
        [facilityId],
      ),
      pool.query(
        `SELECT r.id, r.scenario_id, r.incident_id, r.kind, r.status, r.title, r.rationale,
                r.command, r.version, r.explanation, r.evidence, r.confidence,
                r.limitations, r.simulated_at, r.model_version_id, r.provenance,
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
  const simulatedAt = scenario ? Number(scenario.simulated_start_at) : SCENARIO_START_S;
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
      snapshot: replaySnapshot(Number(row.simulated_at), row.model_config),
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
            r.version, r.explanation, r.evidence, r.confidence, r.limitations,
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
      snapshot: replaySnapshot(Number(row.simulated_at), row.model_config),
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
     FROM saved_views sv
     WHERE user_id = $1
       AND (
         facility_id IS NULL OR EXISTS (
           SELECT 1
           FROM facility_permissions fp
           JOIN facilities f ON f.id = fp.facility_id
           JOIN memberships m ON m.user_id = fp.user_id AND m.organization_id = f.organization_id
           WHERE fp.user_id = $1 AND fp.facility_id = sv.facility_id
             AND fp.can_view = true AND f.organization_id = $2
         )
       )
     ORDER BY updated_at DESC`,
    [req.userId, DEMO_ORGANIZATION_ID],
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows });
});

app.get("/api/tutorials", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const result = await pool.query(
    `SELECT t.id, t.role, t.version, t.steps, t.provenance, t.created_at
     FROM tutorials t
     JOIN memberships m ON m.role = t.role
     WHERE m.user_id = $1 AND m.organization_id = $2
     ORDER BY t.version DESC`,
    [req.userId, DEMO_ORGANIZATION_ID],
  );
  res.json({ contractVersion: CONTRACT_VERSION, items: result.rows });
});

app.get("/api/facilities/:facilityId/audit", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  if (!await requireFacilityAccess(req.userId!, String(req.params.facilityId), res)) return;
  const values: unknown[] = [req.userId, req.params.facilityId];
  const filters = ["p.user_id = $1", "p.can_view = true", "a.facility_id = $2"];
  const addFilter = (sql: string, value: unknown) => {
    values.push(value);
    filters.push(sql.replace("?", `$${values.length}`));
  };
  if (typeof req.query.action === "string" && req.query.action) addFilter("a.action = ?", req.query.action);
  if (typeof req.query.decision === "string" && req.query.decision) {
    addFilter("a.payload->'decision'->>'decision' = ?", req.query.decision);
  }
  if (typeof req.query.modelVersion === "string" && req.query.modelVersion) addFilter("a.model_version = ?", req.query.modelVersion);
  if (typeof req.query.search === "string" && req.query.search) {
    addFilter("(a.action ILIKE '%' || ? || '%' OR a.payload::text ILIKE '%' || ? || '%')", req.query.search);
    values.push(req.query.search);
    filters[filters.length - 1] = filters[filters.length - 1].replace(
      new RegExp(`\\$${values.length - 1}(?!\\d)`, "g"),
      `$${values.length - 1}`,
    ).replace("?", `$${values.length}`);
  }
  const result = await pool.query(
    `SELECT a.id, a.action, a.scenario_id, a.simulated_at, a.model_version, a.payload, a.created_at
     FROM audit_records a
     JOIN facility_permissions p ON p.facility_id = a.facility_id
      WHERE ${filters.join(" AND ")}
     ORDER BY a.created_at DESC LIMIT 100`,
    values,
  );
  res.json(result.rows);
});

app.get("/api/facilities/:facilityId/audit/:auditId", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  if (!await requireFacilityAccess(req.userId!, String(req.params.facilityId), res)) return;
  const result = await pool.query(
    `SELECT a.id, a.action, a.scenario_id, a.simulated_at, a.model_version, a.payload, a.created_at
     FROM audit_records a
     JOIN facility_permissions p ON p.facility_id = a.facility_id
     WHERE p.user_id = $1 AND p.can_view = true AND a.facility_id = $2 AND a.id = $3`,
    [req.userId, req.params.facilityId, req.params.auditId],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Audit record not found" });
  const record = result.rows[0];
  if (!record.payload?.snapshot) {
    return res.status(409).json({ error: "This legacy record does not contain an immutable reconstruction snapshot" });
  }
  res.json({
    record,
    snapshot: record.payload.snapshot,
    scenario: record.payload.scenario,
    model: record.payload.model,
    recommendation: record.payload.recommendation,
    safetyEvaluation: record.payload.safetyEvaluation,
    decision: record.payload.decision,
  });
});

app.get("/api/facilities/:facilityId/incidents", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  if (!await requireFacilityAccess(req.userId!, String(req.params.facilityId), res)) return;
  const result = await pool.query(
    `SELECT i.id, i.title, i.severity, i.status, i.simulated_at, i.affected_assets,
            i.raw_signal_count, i.likely_cause, i.forecast_minutes, i.correlated_signals,
            i.thermal_path, i.deduplication_key, i.model_version
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
  if (!await requireFacilityAccess(req.userId!, String(req.params.facilityId), res)) return;
  const result = await pool.query(
    `SELECT i.id, i.title, i.severity, i.status, i.simulated_at, i.affected_assets,
            i.raw_signal_count, i.likely_cause, i.forecast_minutes, i.correlated_signals,
            i.thermal_path, i.deduplication_key, i.model_version, i.model_config
     FROM incidents i
     JOIN facility_permissions p ON p.facility_id = i.facility_id
     WHERE p.user_id = $1 AND p.can_view = true AND i.facility_id = $2 AND i.id = $3`,
    [req.userId, req.params.facilityId, req.params.incidentId],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Incident not found" });
  res.json({ incident: result.rows[0], snapshot: replaySnapshot(Number(result.rows[0].simulated_at), result.rows[0].model_config) });
});

app.get("/api/facilities/:facilityId/topology", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const permission = await requireFacilityAccess(req.userId!, String(req.params.facilityId), res);
  if (!permission) return;
  if (!["OPERATOR", "ENGINEER"].includes(permission.role)) {
    return res.status(404).json({ error: "Facility workspace unavailable" });
  }
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
  if (!await requireFacilityAccess(req.userId!, String(req.params.facilityId), res, "model")) return;
  const result = await pool.query(
    `SELECT id, facility_id, status, config, published_at, created_by, created_at
     FROM model_versions WHERE facility_id = $1 ORDER BY created_at DESC`,
    [req.params.facilityId],
  );
  res.json(result.rows);
});

app.post("/api/facilities/:facilityId/model/versions", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  if (!await requireFacilityAccess(req.userId!, String(req.params.facilityId), res, "model")) return;
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
  return Boolean(await requireFacilityAccess(userId, facilityId, res, "model"));
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

app.post("/api/facilities/:facilityId/recommendations/:recommendationId/what-if", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  if (!await requireFacilityAccess(req.userId!, String(req.params.facilityId), res, "assistant")) return;
  const simulatedAt = req.body?.simulatedAt;
  const command = parseAdvisoryCommand(req.body?.command);
  if (!isScenarioTimestamp(simulatedAt) || !command) return res.status(400).json({ error: "Invalid counterfactual request" });
  if (command.flowPercent < COMMAND_ENVELOPE.minFlowPercent || command.flowPercent > COMMAND_ENVELOPE.maxFlowPercent) {
    return res.status(400).json({ error: "Alternative must remain inside the permitted advisory envelope" });
  }
  const recommendation = await pool.query(
    `SELECT r.id, r.version, r.command, r.model_version_id, mv.config AS model_config
     FROM recommendations r JOIN model_versions mv ON mv.id = r.model_version_id
     WHERE r.id = $1 AND r.facility_id = $2`,
    [req.params.recommendationId, req.params.facilityId],
  );
  if (!recommendation.rows[0]) return res.status(404).json({ error: "Recommendation not found" });
  const row = recommendation.rows[0];
  assertModelConfig(row.model_config);
  const recommendedCommand = parseAdvisoryCommand(row.command);
  if (!recommendedCommand) return res.status(409).json({ error: "Persisted recommendation command is invalid" });
  const inaction = replaySnapshot(simulatedAt, row.model_config);
  const recommended = counterfactualCockpitSnapshot(simulatedAt, recommendedCommand, row.model_config);
  const alternative = counterfactualCockpitSnapshot(simulatedAt, command, row.model_config);
  res.json({
    scenarioId: "gpu-training-ramp-v1",
    simulatedAt,
    modelVersionId: row.model_version_id,
    recommendationVersion: row.version,
    sharedInputs: {
      simulatedAt,
      initialState: snapshotForAudit(inaction),
      modelConfig: row.model_config,
      events: ["GPU Training Ramp", "Rack heat rise", "CDU-03 modeled response lag"],
    },
    options: [
      {
        id: "inaction",
        label: "Inaction",
        command: null,
        peakC: inaction.forecast.baselinePeakC,
        constraintMinutes: inaction.forecast.baselineConstraintMinutes,
        series: inaction.forecast.series.map((point) => ({ simulatedAt: point.simulatedAt, peakC: point.baselinePeakC })),
      },
      {
        id: "recommendation",
        label: "Wattr recommendation",
        command: recommendedCommand,
        peakC: recommended.forecast.advisoryPeakC,
        constraintMinutes: recommended.forecast.advisoryConstraintMinutes,
        series: recommended.forecast.series.map((point) => ({ simulatedAt: point.simulatedAt, peakC: point.counterfactualPeakC })),
      },
      {
        id: "alternative",
        label: "Permitted alternative",
        command,
        peakC: alternative.forecast.advisoryPeakC,
        constraintMinutes: alternative.forecast.advisoryConstraintMinutes,
        series: alternative.forecast.series.map((point) => ({ simulatedAt: point.simulatedAt, peakC: point.counterfactualPeakC })),
      },
    ],
    provenance: syntheticProvenance(undefined, row.model_version_id),
  });
});

app.post("/api/facilities/:facilityId/recommendations/:recommendationId/evaluate", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  if (!await requireFacilityAccess(req.userId!, String(req.params.facilityId), res, "assistant")) return;
  const simulatedAt = req.body?.simulatedAt;
  if (!isScenarioTimestamp(simulatedAt)) return res.status(400).json({ error: "Invalid simulation timestamp" });

  const recommendation = await pool.query(
    `SELECT r.id, r.version, r.command, r.model_version_id, mv.config AS model_config
     FROM recommendations r JOIN model_versions mv ON mv.id = r.model_version_id
     WHERE r.id = $1 AND r.facility_id = $2`,
    [req.params.recommendationId, req.params.facilityId],
  );
  if (!recommendation.rows[0]) return res.status(404).json({ error: "Recommendation not found" });
  const row = recommendation.rows[0];
  const command = parseAdvisoryCommand(req.body?.command ?? row.command);
  if (!command) return res.status(400).json({ error: "Invalid advisory command" });
  const model = await publishedModel(String(req.params.facilityId));
  if (!model || model.model_version !== row.model_version_id) {
    return res.status(409).json({ error: "Recommendation does not match the active facility model" });
  }
  const snapshot = counterfactualCockpitSnapshot(simulatedAt, command, model.config);
  const checks = safetyChecksFor(snapshot, command);
  const outcome = safetyOutcome(checks);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO safety_evaluations
      (id, user_id, facility_id, recommendation_id, simulated_at, outcome, checks,
       command, recommendation_version, snapshot, model_version, model_version_id,
       model_config, provenance, synthetic_status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb,
             $11, $11, $12::jsonb, 'SIMULATED', 'SYNTHETIC', now() + interval '10 minutes')`,
    [
      id,
      req.userId,
      req.params.facilityId,
      req.params.recommendationId,
      simulatedAt,
      outcome,
      JSON.stringify(checks),
      JSON.stringify(command),
      row.version,
      JSON.stringify(snapshotForAudit(snapshot)),
      model.model_version,
      JSON.stringify(model.config),
    ],
  );
  res.status(201).json({
    id,
    outcome,
    checks,
    command,
    simulatedAt,
    recommendationVersion: row.version,
    modelVersionId: model.model_version,
    expiresInSeconds: 600,
  });
});

app.post("/api/facilities/:facilityId/recommendations/:recommendationId/decisions", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const permission = await requireFacilityAccess(req.userId!, String(req.params.facilityId), res, "operate");
  if (!permission) return;
  const simulatedAt = req.body?.simulatedAt;
  const decision = req.body?.decision;
  const note = req.body?.note;
  if (
    !isScenarioTimestamp(simulatedAt) ||
    !["APPROVE", "REJECT", "DEFER", "REQUEST_ALTERNATIVE", "ACKNOWLEDGE"].includes(decision) ||
    (note !== undefined && (typeof note !== "string" || note.length > 500))
  ) return res.status(400).json({ error: "Invalid operator disposition" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recommendationResult = await client.query(
      `SELECT r.id, r.version, r.status, r.title, r.rationale, r.command, r.explanation,
              r.evidence, r.confidence, r.limitations, r.model_version_id,
              mv.config AS model_config
       FROM recommendations r JOIN model_versions mv ON mv.id = r.model_version_id
       WHERE r.id = $1 AND r.facility_id = $2 FOR UPDATE OF r`,
      [req.params.recommendationId, req.params.facilityId],
    );
    const recommendation = recommendationResult.rows[0];
    if (!recommendation) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Recommendation not found" });
    }
    const command = parseAdvisoryCommand(req.body?.command ?? recommendation.command);
    if (!command) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Invalid advisory command" });
    }
    const activeModel = await publishedModel(String(req.params.facilityId), client);
    if (!activeModel || activeModel.model_version !== recommendation.model_version_id) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Recommendation model is no longer active; request a new recommendation" });
    }
    assertModelConfig(recommendation.model_config);
    const snapshot = counterfactualCockpitSnapshot(simulatedAt, command, recommendation.model_config);

    let evaluation;
    const suppliedEvaluationId = req.body?.safetyEvaluationId;
    if (typeof suppliedEvaluationId === "string") {
      const evaluationResult = await client.query(
        `SELECT id, outcome, checks, command, recommendation_version, model_version_id,
                model_config, snapshot
         FROM safety_evaluations
         WHERE id = $1 AND user_id = $2 AND facility_id = $3 AND recommendation_id = $4
           AND simulated_at = $5 AND used_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [suppliedEvaluationId, req.userId, req.params.facilityId, req.params.recommendationId, simulatedAt],
      );
      evaluation = evaluationResult.rows[0];
      if (
        !evaluation ||
        evaluation.model_version_id !== recommendation.model_version_id ||
        evaluation.recommendation_version !== recommendation.version ||
        !advisoryCommandsEqual(evaluation.command, command)
      ) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Safety Shield result does not match this recommendation version, command, model, and replay instant" });
      }
    } else if (decision === "APPROVE") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "A current server-verified Safety Shield PASS is required" });
    } else {
      const checks = safetyChecksFor(snapshot, command);
      const id = randomUUID();
      const outcome = safetyOutcome(checks);
      const inserted = await client.query(
        `INSERT INTO safety_evaluations
          (id, user_id, facility_id, recommendation_id, simulated_at, outcome, checks,
           command, recommendation_version, snapshot, model_version, model_version_id,
           model_config, provenance, synthetic_status, expires_at, used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb,
                 $11, $11, $12::jsonb, 'SIMULATED', 'SYNTHETIC', now() + interval '10 minutes', now())
         RETURNING id, outcome, checks, command, recommendation_version, model_version_id,
                   model_config, snapshot`,
        [
          id, req.userId, req.params.facilityId, req.params.recommendationId,
          simulatedAt, outcome, JSON.stringify(checks), JSON.stringify(command),
          recommendation.version, JSON.stringify(snapshotForAudit(snapshot)),
          activeModel.model_version, JSON.stringify(activeModel.config),
        ],
      );
      evaluation = inserted.rows[0];
    }
    if (decision === "APPROVE" && evaluation.outcome !== "PASS") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Safety Shield ${evaluation.outcome} cannot be approved` });
    }

    const outcomes: Record<string, string> = {
      APPROVE: "ALLOWED_AS_ADVISORY",
      REJECT: "REJECTED",
      DEFER: "DEFERRED",
      REQUEST_ALTERNATIVE: "ALTERNATIVE_REQUESTED",
      ACKNOWLEDGE: "ACKNOWLEDGED",
    };
    const statuses: Record<string, string> = {
      APPROVE: "APPROVED",
      REJECT: "REJECTED",
      DEFER: "DEFERRED",
      REQUEST_ALTERNATIVE: "ALTERNATIVE_REQUESTED",
      ACKNOWLEDGE: recommendation.status,
    };
    const outcome = outcomes[decision];
    const decisionId = randomUUID();
    const decisionSnapshot = {
      recommendationId: recommendation.id,
      recommendationVersion: recommendation.version,
      decision,
      outcome,
      note: note ?? "",
      command,
    };
    await client.query(
      `INSERT INTO operator_decisions
        (id, facility_id, scenario_id, recommendation_id, safety_evaluation_id, user_id,
         decision, outcome, simulated_at, model_version_id, payload, provenance,
         synthetic_status, quality)
       VALUES ($1, $2, 'gpu-training-ramp-v1', $3, $4, $5, $6, $7, $8, $9,
               $10::jsonb, 'SIMULATED', 'SYNTHETIC', 'GOOD')`,
      [
        decisionId, req.params.facilityId, recommendation.id, evaluation.id,
        req.userId, decision, outcome, simulatedAt, activeModel.model_version,
        JSON.stringify(decisionSnapshot),
      ],
    );
    const auditPayload = {
      scenario: { id: "gpu-training-ramp-v1", simulatedAt },
      model: { version: activeModel.model_version, config: activeModel.config },
      recommendation: {
        id: recommendation.id,
        version: recommendation.version,
        title: recommendation.title,
        rationale: recommendation.rationale,
        explanation: recommendation.explanation,
        evidence: recommendation.evidence,
        confidence: Number(recommendation.confidence),
        limitations: recommendation.limitations,
      },
      safetyEvaluation: {
        id: evaluation.id,
        outcome: evaluation.outcome,
        checks: evaluation.checks,
        command: evaluation.command,
      },
      decision: { id: decisionId, ...decisionSnapshot },
      snapshot: snapshotForAudit(snapshot),
      provenance: "SIMULATED",
    };
    const auditResult = await client.query(
      `INSERT INTO audit_records
        (organization_id, facility_id, user_id, action, scenario_id, simulated_at,
         model_version, model_version_id, payload, provenance, synthetic_status, quality)
       VALUES ($1, $2, $3, $4, 'gpu-training-ramp-v1', $5, $6, $6, $7::jsonb,
               'SIMULATED', 'SYNTHETIC', 'GOOD')
       RETURNING id, action, scenario_id, simulated_at, model_version, payload, created_at`,
      [
        permission.organization_id, req.params.facilityId, req.userId,
        `DECISION_${decision}`, simulatedAt, activeModel.model_version,
        JSON.stringify(auditPayload),
      ],
    );
    await client.query("UPDATE recommendations SET status = $1 WHERE id = $2", [statuses[decision], recommendation.id]);
    if (typeof suppliedEvaluationId === "string") {
      await client.query("UPDATE safety_evaluations SET used_at = now() WHERE id = $1", [suppliedEvaluationId]);
    }
    await client.query("COMMIT");
    res.status(201).json(auditResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/api/facilities/:facilityId/audit", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  if (!await requireFacilityAccess(req.userId!, String(req.params.facilityId), res, "operate")) return;
  res.status(410).json({
    error: "Legacy approval endpoint retired; use the recommendation decision endpoint so Safety Shield evidence remains fully bound",
  });
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