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
import {
  ASSISTANT_TOOLS,
  type AssistantAction,
  type AssistantCitation,
  type AssistantResponse,
  type AssistantTool,
} from "../src/lib/cockpit/assistant";

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
    await recordLearningError({
      userId,
      category: "PERMISSION_FAILURE",
      code: `FACILITY_${capability.toUpperCase()}_REQUIRED`,
    });
    res.status(404).json({ error: "Facility unavailable" });
    return undefined;
  }
  return permission;
}

async function requireOrganizationAdmin(userId: string, res: Response) {
  const membership = await organizationMembership(userId);
  if (!membership || (!membership.is_admin && !membership.is_owner)) {
    await recordLearningError({ userId, category: "PERMISSION_FAILURE", code: "ORGANIZATION_ADMIN_REQUIRED" });
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

const LEARNING_EVENT_NAMES = new Set([
  "TUTORIAL_STEP_COMPLETED", "TUTORIAL_COMPLETED", "FACILITY_DRILLDOWN",
  "INCIDENT_REVIEWED", "RECOMMENDATION_INSPECTED", "WHAT_IF_USED",
  "SAFETY_RESULT", "DECISION_RECORDED", "ASSISTANT_USED",
  "AUDIT_RECONSTRUCTED", "ENGINEERING_TOOL_USED", "SCENARIO_COMPLETED",
]);
const CLIENT_LEARNING_EVENT_NAMES = new Set([
  "FACILITY_DRILLDOWN", "RECOMMENDATION_INSPECTED", "ENGINEERING_TOOL_USED",
]);
const LEARNING_ERROR_CATEGORIES = new Set([
  "APPLICATION_FAULT", "SIMULATION_INVARIANT_FAILURE",
  "PERMISSION_FAILURE", "EXTERNAL_SERVICE_UNAVAILABLE",
]);
const LEARNING_SURFACES = new Set([
  "PORTFOLIO","TUTORIAL","OPERATIONS","FORECAST","RECOMMENDATIONS",
  "ASK_WATTR","ENGINEERING","MODEL_STUDIO","MODEL_LAB","AUDIT","LEARNING","ADMIN",
]);
function canonicalLearningRoute(surface: unknown, facilityId?: string | null) {
  if (typeof surface !== "string" || !LEARNING_SURFACES.has(surface)) return undefined;
  if (["PORTFOLIO","TUTORIAL","LEARNING","ADMIN"].includes(surface)) {
    return `/${surface.toLowerCase().replace("_", "-")}`;
  }
  if (!facilityId) return undefined;
  const segment: Record<string, string> = {
    OPERATIONS: "operations", FORECAST: "forecast", RECOMMENDATIONS: "recommendations",
    ASK_WATTR: "ask-wattr", ENGINEERING: "engineering", MODEL_STUDIO: "model-studio",
    MODEL_LAB: "model-lab", AUDIT: "audit",
  };
  return `/facilities/${facilityId}/${segment[surface]}`;
}
function sanitizeServerLearningRoute(route: string, facilityId?: string | null) {
  if (route.startsWith("/tutorial")) return "/tutorial";
  if (route.startsWith("/portfolio")) return "/portfolio";
  if (route.startsWith("/learning")) return "/learning";
  if (route.startsWith("/admin")) return "/admin";
  const surface = [
    ["operations", "OPERATIONS"], ["forecast", "FORECAST"], ["recommendations", "RECOMMENDATIONS"],
    ["ask-wattr", "ASK_WATTR"], ["engineering", "ENGINEERING"], ["model-studio", "MODEL_STUDIO"],
    ["model-lab", "MODEL_LAB"], ["audit", "AUDIT"],
  ].find(([segment]) => route.includes(`/${segment}`))?.[1];
  return surface ? canonicalLearningRoute(surface, facilityId) ?? "/" : "/";
}
function safeLearningProperties(eventName: string, value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const properties = value as Record<string, unknown>;
  const keys = Object.keys(properties).sort();
  const exactKeys = (...expected: string[]) =>
    keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
  if (eventName === "TUTORIAL_STEP_COMPLETED" || eventName === "TUTORIAL_COMPLETED") {
    return exactKeys("step", "complete") &&
      Number.isInteger(properties.step) && Number(properties.step) >= 0 && Number(properties.step) <= 20 &&
      typeof properties.complete === "boolean"
      ? { step: Number(properties.step), complete: properties.complete } : undefined;
  }
  if (eventName === "FACILITY_DRILLDOWN") return exactKeys() ? {} : undefined;
  if (eventName === "INCIDENT_REVIEWED") {
    return exactKeys("incidentId") && typeof properties.incidentId === "string" && /^inc-[a-zA-Z0-9-]{1,40}$/.test(properties.incidentId)
      ? { incidentId: properties.incidentId } : undefined;
  }
  if (eventName === "RECOMMENDATION_INSPECTED" || eventName === "WHAT_IF_USED") {
    return exactKeys("recommendationId") && typeof properties.recommendationId === "string" && /^rec-[a-zA-Z0-9-]{1,40}$/.test(properties.recommendationId)
      ? { recommendationId: properties.recommendationId } : undefined;
  }
  if (eventName === "SAFETY_RESULT") {
    return exactKeys("recommendationId", "outcome") &&
      typeof properties.recommendationId === "string" && /^rec-[a-zA-Z0-9-]{1,40}$/.test(properties.recommendationId) &&
      ["PASS", "WARNING", "BLOCK"].includes(String(properties.outcome))
      ? { recommendationId: properties.recommendationId, outcome: String(properties.outcome) } : undefined;
  }
  if (eventName === "DECISION_RECORDED") {
    return exactKeys("recommendationId", "decision", "outcome") &&
      typeof properties.recommendationId === "string" && /^rec-[a-zA-Z0-9-]{1,40}$/.test(properties.recommendationId) &&
      ["APPROVE","REJECT","DEFER","REQUEST_ALTERNATIVE","ACKNOWLEDGE"].includes(String(properties.decision)) &&
      ["ALLOWED_AS_ADVISORY","REJECTED","DEFERRED","ALTERNATIVE_REQUESTED","ACKNOWLEDGED"].includes(String(properties.outcome))
      ? { recommendationId: properties.recommendationId, decision: String(properties.decision), outcome: String(properties.outcome) } : undefined;
  }
  if (eventName === "ASSISTANT_USED") {
    return exactKeys("tool", "topic") &&
      (ASSISTANT_TOOLS as readonly string[]).includes(String(properties.tool)) &&
      properties.topic === properties.tool
      ? { tool: String(properties.tool), topic: String(properties.topic) } : undefined;
  }
  if (eventName === "AUDIT_RECONSTRUCTED") {
    return exactKeys("auditId") && typeof properties.auditId === "string" && /^[0-9]{1,20}$/.test(properties.auditId)
      ? { auditId: properties.auditId } : undefined;
  }
  if (eventName === "ENGINEERING_TOOL_USED") return exactKeys() ? {} : undefined;
  if (eventName === "SCENARIO_COMPLETED") {
    return exactKeys("scenarioCompleted") && properties.scenarioCompleted === true
      ? { scenarioCompleted: true } : undefined;
  }
  return undefined;
}

async function recordLearningError(input: {
  userId?: string | null;
  facilityId?: string | null;
  category: string;
  code: string;
  route?: string | null;
}) {
  if (!LEARNING_ERROR_CATEGORIES.has(input.category) || !/^[A-Z0-9_:-]{1,120}$/.test(input.code)) return;
  try {
    await pool.query(
      `INSERT INTO product_learning_errors
        (id, organization_id, user_id, facility_id, category, code, route)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(), DEMO_ORGANIZATION_ID, input.userId ?? null, input.facilityId ?? null,
        input.category, input.code,
        typeof input.route === "string" ? sanitizeServerLearningRoute(input.route, input.facilityId) : null,
      ],
    );
  } catch {
    // Learning collection must never change the product request outcome.
  }
}

async function recordLearningEvent(input: {
  organizationId: string;
  userId: string;
  facilityId?: string | null;
  scenarioId?: string | null;
  eventName: string;
  route: string;
  role: Role;
  modelVersionId?: string | null;
  simulatedAt?: number | null;
  dedupeKey: string;
  properties?: Record<string, string | number | boolean | null>;
  client?: pg.Pool | pg.PoolClient;
}) {
  const properties = safeLearningProperties(input.eventName, input.properties);
  if (!LEARNING_EVENT_NAMES.has(input.eventName) || !properties) return;
  const client = input.client ?? pool;
  try {
    await client.query(
      `INSERT INTO product_learning_events
        (id, organization_id, user_id, facility_id, scenario_id, event_name, route,
         role, model_version_id, simulated_at, session_id, dedupe_key, properties)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'server', $11, $12::jsonb)
       ON CONFLICT (organization_id, user_id, event_name, dedupe_key) DO NOTHING`,
      [
        randomUUID(), input.organizationId, input.userId, input.facilityId ?? null,
        input.scenarioId ?? null, input.eventName,
        sanitizeServerLearningRoute(input.route, input.facilityId), input.role,
        input.modelVersionId ?? null, input.simulatedAt ?? null, input.dedupeKey,
        JSON.stringify(properties),
      ],
    );
  } catch {
    // Product learning is best-effort and must never alter the user workflow.
  }
}

let lastLearningPurgeAt = 0;
async function purgeExpiredLearningRecords() {
  const now = Date.now();
  if (now - lastLearningPurgeAt < 60_000) return;
  lastLearningPurgeAt = now;
  await Promise.all([
    pool.query("DELETE FROM product_learning_events WHERE expires_at <= now()"),
    pool.query("DELETE FROM operator_test_sessions WHERE expires_at <= now()"),
    pool.query("DELETE FROM product_feedback WHERE expires_at <= now()"),
    pool.query("DELETE FROM product_learning_errors WHERE expires_at <= now()"),
  ]);
}

async function learningFacilityContext(userId: string, facilityId: string) {
  const permission = await facilityPermission(userId, facilityId, "view");
  if (!permission) return undefined;
  const model = await publishedModel(facilityId);
  const scenario = await pool.query(
    "SELECT id, simulated_start_at FROM scenarios WHERE facility_id = $1 AND status = 'PUBLISHED' ORDER BY created_at DESC LIMIT 1",
    [facilityId],
  );
  return {
    organizationId: permission.organization_id,
    role: permission.role as Role,
    modelVersionId: model?.model_version ?? null,
    scenarioId: scenario.rows[0]?.id ?? null,
  };
}

async function requireLearningViewer(userId: string, res: Response) {
  const membership = await organizationMembership(userId);
  if (!membership || (!membership.is_admin && !membership.is_owner && membership.role !== "PORTFOLIO_MANAGER")) {
    await recordLearningError({ userId, category: "PERMISSION_FAILURE", code: "LEARNING_SUMMARY_FORBIDDEN" });
    res.status(403).json({ error: "Learning summary permission required" });
    return undefined;
  }
  return membership;
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
            (m.role IN ('PORTFOLIO_MANAGER', 'OPERATOR', 'ENGINEER', 'MODEL_ADMIN')) AS can_assistant
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

app.post("/api/learning/events", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  await purgeExpiredLearningRecords();
  const { eventName, facilityId, simulatedAt, sessionId } = req.body ?? {};
  const suppliedKeys = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? Object.keys(req.body).sort()
    : [];
  const expectedKeys = simulatedAt === undefined
    ? ["eventName", "facilityId", "sessionId"]
    : ["eventName", "facilityId", "sessionId", "simulatedAt"];
  const exactBody = suppliedKeys.length === expectedKeys.length &&
    suppliedKeys.every((key, index) => key === [...expectedKeys].sort()[index]);
  if (
    !exactBody ||
    typeof eventName !== "string" || !CLIENT_LEARNING_EVENT_NAMES.has(eventName) ||
    typeof sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId) ||
    (simulatedAt !== undefined && !isScenarioTimestamp(simulatedAt)) ||
    typeof facilityId !== "string" || facilityId.length > 120
  ) {
    return res.status(400).json({ error: "Invalid learning event" });
  }
  const membership = await organizationMembership(req.userId!);
  if (!membership) return res.status(403).json({ error: "Organization membership required" });
  const context = await learningFacilityContext(req.userId!, facilityId);
  if (!context) {
    await recordLearningError({
      userId: req.userId!, category: "PERMISSION_FAILURE",
      code: "LEARNING_EVENT_FACILITY_FORBIDDEN",
    });
    return res.status(404).json({ error: "Facility unavailable" });
  }
  const inserted = await pool.query(
    `INSERT INTO product_learning_events
      (id, organization_id, user_id, facility_id, scenario_id, event_name, route,
       role, model_version_id, simulated_at, session_id, dedupe_key, properties)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     ON CONFLICT (organization_id, user_id, event_name, dedupe_key) DO NOTHING
     RETURNING id`,
    [
      randomUUID(), membership.organization_id, req.userId!, facilityId,
      context.scenarioId, eventName,
      eventName === "FACILITY_DRILLDOWN"
        ? "/portfolio"
        : eventName === "RECOMMENDATION_INSPECTED"
          ? `/facilities/${facilityId}/recommendations`
          : `/facilities/${facilityId}/engineering`,
      context.role, context.modelVersionId, simulatedAt ?? null, sessionId,
      `${sessionId}:${eventName}:${facilityId}`,
      JSON.stringify({}),
    ],
  );
  res.status(inserted.rowCount ? 201 : 202).json({
    accepted: true,
    deduplicated: !inserted.rowCount,
    id: inserted.rows[0]?.id ?? null,
  });
});

app.post("/api/learning/errors", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  await purgeExpiredLearningRecords();
  const { category, code, surface, facilityId } = req.body ?? {};
  const suppliedKeys = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? Object.keys(req.body) : [];
  const route = canonicalLearningRoute(surface, facilityId);
  const permittedClientError =
    category === "APPLICATION_FAULT" && /^HTTP_5[0-9]{2}$/.test(code) ||
    category === "EXTERNAL_SERVICE_UNAVAILABLE" && /^HTTP_(502|503|504)$/.test(code);
  if (
    suppliedKeys.some((key) => !["category","code","surface","facilityId"].includes(key)) ||
    typeof category !== "string" || !LEARNING_ERROR_CATEGORIES.has(category) ||
    typeof code !== "string" || !permittedClientError ||
    !route ||
    (facilityId !== undefined && (typeof facilityId !== "string" || facilityId.length > 120))
  ) return res.status(400).json({ error: "Invalid learning error" });
  let scopedFacilityId: string | null = null;
  if (facilityId && await learningFacilityContext(req.userId!, facilityId)) scopedFacilityId = facilityId;
  await recordLearningError({
    userId: req.userId!, facilityId: scopedFacilityId, category, code, route,
  });
  res.status(202).json({ accepted: true });
});

app.post("/api/learning/operator-sessions", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  await purgeExpiredLearningRecords();
  const { facilityId } = req.body ?? {};
  const suppliedKeys = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? Object.keys(req.body) : [];
  if (
    typeof facilityId !== "string" || facilityId.length > 120 ||
    suppliedKeys.length !== 1 || suppliedKeys[0] !== "facilityId"
  ) return res.status(400).json({ error: "Invalid operator test session" });
  const context = await learningFacilityContext(req.userId!, facilityId);
  if (!context) return res.status(404).json({ error: "Facility unavailable" });
  if (context.role !== "OPERATOR") {
    await recordLearningError({ userId: req.userId!, category: "PERMISSION_FAILURE", code: "OPERATOR_TEST_ROLE_REQUIRED" });
    return res.status(403).json({ error: "Operator role required for an operator test session" });
  }
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO operator_test_sessions
      (id, organization_id, user_id, facility_id, scenario_id, model_version_id, role, status, last_route)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'IN_PROGRESS', $8)
     RETURNING id, facility_id, scenario_id, model_version_id, status, started_at`,
    [
      id, context.organizationId, req.userId!, facilityId, context.scenarioId,
      context.modelVersionId, context.role, canonicalLearningRoute("OPERATIONS", facilityId),
    ],
  );
  res.status(201).json(result.rows[0]);
});

app.patch("/api/learning/operator-sessions/:sessionId", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  await purgeExpiredLearningRecords();
  const { status, scenarioCompleted, timeToUnderstandingS, errorCount, abandonmentCode, qualitativeFeedbackCode, surface } = req.body ?? {};
  const suppliedKeys = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? Object.keys(req.body) : [];
  if (
    suppliedKeys.some((key) => !["status","scenarioCompleted","timeToUnderstandingS","errorCount","abandonmentCode","qualitativeFeedbackCode","surface"].includes(key)) ||
    (status !== undefined && !["IN_PROGRESS", "COMPLETED", "ABANDONED"].includes(status)) ||
    (scenarioCompleted !== undefined && typeof scenarioCompleted !== "boolean") ||
    (timeToUnderstandingS !== undefined && (!Number.isInteger(timeToUnderstandingS) || timeToUnderstandingS < 0)) ||
    (errorCount !== undefined && (!Number.isInteger(errorCount) || errorCount < 0)) ||
    (abandonmentCode !== undefined && !["NAVIGATION_FRICTION","UNCLEAR_FORECAST","UNCLEAR_RECOMMENDATION","PERMISSION_BLOCK","TECHNICAL_ERROR","MODERATOR_ENDED","OTHER"].includes(abandonmentCode)) ||
    (qualitativeFeedbackCode !== undefined && !["CLEAR","PARTLY_CLEAR","UNCLEAR","TOO_SLOW","MISSING_CONTEXT","OTHER"].includes(qualitativeFeedbackCode)) ||
    (surface !== undefined && !LEARNING_SURFACES.has(surface))
  ) return res.status(400).json({ error: "Invalid operator test outcome" });
  const existing = await pool.query(
    `SELECT facility_id FROM operator_test_sessions
     WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
    [req.params.sessionId, DEMO_ORGANIZATION_ID, req.userId!],
  );
  if (!existing.rows[0]) return res.status(404).json({ error: "Operator test session unavailable" });
  const result = await pool.query(
    `UPDATE operator_test_sessions
     SET status = COALESCE($3, status),
         scenario_completed = COALESCE($4, scenario_completed),
         time_to_understanding_s = COALESCE($5, time_to_understanding_s),
         error_count = COALESCE($6, error_count),
         abandonment_code = COALESCE($7, abandonment_code),
         qualitative_feedback_code = COALESCE($8, qualitative_feedback_code),
         last_route = COALESCE($9, last_route),
         completed_at = CASE WHEN COALESCE($3, status) IN ('COMPLETED', 'ABANDONED')
           THEN COALESCE(completed_at, now()) ELSE completed_at END
     WHERE id = $1 AND organization_id = $2 AND user_id = $10
     RETURNING id, status, scenario_completed, time_to_understanding_s, error_count,
               abandonment_code, qualitative_feedback_code, last_route, started_at, completed_at`,
    [
      req.params.sessionId, DEMO_ORGANIZATION_ID, status ?? null, scenarioCompleted ?? null,
      timeToUnderstandingS ?? null, errorCount ?? null, abandonmentCode ?? null,
      qualitativeFeedbackCode ?? null,
      surface === undefined ? null : canonicalLearningRoute(surface, existing.rows[0].facility_id),
      req.userId!,
    ],
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Operator test session unavailable" });
  const session = result.rows[0];
  if (session.status === "COMPLETED" && session.scenario_completed) {
    const context = await pool.query(
      `SELECT s.organization_id, s.facility_id, s.scenario_id, s.model_version_id, s.role
       FROM operator_test_sessions s WHERE s.id = $1`,
      [req.params.sessionId],
    );
    if (context.rows[0]) {
      await recordLearningEvent({
        organizationId: context.rows[0].organization_id,
        userId: req.userId!,
        facilityId: context.rows[0].facility_id,
        scenarioId: context.rows[0].scenario_id,
        eventName: "SCENARIO_COMPLETED",
        route: session.last_route ?? "/",
        role: context.rows[0].role,
        modelVersionId: context.rows[0].model_version_id,
        dedupeKey: `scenario-completed-${req.params.sessionId}`,
        properties: { scenarioCompleted: true },
      });
    }
  }
  res.json(session);
});

app.post("/api/learning/feedback", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  await purgeExpiredLearningRecords();
  const { facilityId, surface, sentiment, feedbackCode } = req.body ?? {};
  const suppliedKeys = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? Object.keys(req.body) : [];
  const route = canonicalLearningRoute(surface, facilityId);
  if (
    suppliedKeys.some((key) => !["facilityId","surface","sentiment","feedbackCode"].includes(key)) ||
    (facilityId !== undefined && (typeof facilityId !== "string" || facilityId.length > 120)) ||
    !route ||
    !["POSITIVE", "NEUTRAL", "NEGATIVE"].includes(sentiment) ||
    !["HELPFUL","UNCLEAR","MISSING_CONTEXT","TOO_SLOW","UNEXPECTED_RESULT","OTHER"].includes(feedbackCode)
  ) return res.status(400).json({ error: "Invalid contextual feedback" });
  let context: Awaited<ReturnType<typeof learningFacilityContext>> | undefined;
  if (facilityId) {
    context = await learningFacilityContext(req.userId!, facilityId);
    if (!context) return res.status(404).json({ error: "Facility unavailable" });
  }
  const result = await pool.query(
    `INSERT INTO product_feedback
      (id, organization_id, user_id, facility_id, scenario_id, model_version_id,
       route, role, sentiment, feedback_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, created_at`,
    [
      randomUUID(), DEMO_ORGANIZATION_ID, req.userId!, facilityId ?? null,
      context?.scenarioId ?? null, context?.modelVersionId ?? null, route,
      context?.role ?? (await organizationMembership(req.userId!))!.role, sentiment, feedbackCode,
    ],
  );
  res.status(201).json({ accepted: true, id: result.rows[0].id, created_at: result.rows[0].created_at });
});

app.get("/api/learning/outcomes", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  await purgeExpiredLearningRecords();
  const viewer = await requireLearningViewer(req.userId!, res);
  if (!viewer) return;
  const facilityId = typeof req.query.facilityId === "string" ? req.query.facilityId : undefined;
  if (facilityId && !await facilityPermission(req.userId!, facilityId, "view")) {
    await recordLearningError({ userId: req.userId!, facilityId, category: "PERMISSION_FAILURE", code: "LEARNING_OUTCOME_FACILITY_FORBIDDEN" });
    return res.status(404).json({ error: "Facility unavailable" });
  }
  const unrestricted = viewer.is_admin || viewer.is_owner;
  const grants = unrestricted ? [] : (await pool.query(
    `SELECT p.facility_id FROM facility_permissions p
     JOIN facilities f ON f.id = p.facility_id
     WHERE p.user_id = $1 AND p.can_view = true AND f.organization_id = $2`,
    [req.userId!, DEMO_ORGANIZATION_ID],
  )).rows.map((row) => row.facility_id as string);
  const params: unknown[] = facilityId
    ? [DEMO_ORGANIZATION_ID, facilityId]
    : unrestricted
      ? [DEMO_ORGANIZATION_ID]
      : [DEMO_ORGANIZATION_ID, grants];
  const scope = facilityId
    ? " AND facility_id = $2"
    : unrestricted
      ? ""
      : " AND facility_id = ANY($2::text[])";
  const facilityScope = facilityId
    ? " AND facility_id = $2"
    : unrestricted
      ? ""
      : " AND facility_id = ANY($2::text[])";
  const [events, sessions, safety, decisions, feedback, errors, topics] = await Promise.all([
    pool.query(`SELECT event_name, count(*)::int AS count, count(DISTINCT user_id)::int AS users
                FROM product_learning_events WHERE organization_id = $1 AND expires_at > now()${scope}
                GROUP BY event_name ORDER BY event_name`, params),
    pool.query(`SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
                       count(*) FILTER (WHERE status = 'ABANDONED')::int AS abandoned,
                       round(avg(time_to_understanding_s) FILTER (WHERE time_to_understanding_s IS NOT NULL))::int AS avg_time_to_understanding_s,
                       round(avg(error_count))::int AS avg_error_count
                FROM operator_test_sessions WHERE organization_id = $1 AND expires_at > now()${scope}`, params),
    pool.query(`SELECT outcome, count(*)::int AS count FROM safety_evaluations
                WHERE facility_id IN (SELECT id FROM facilities WHERE organization_id = $1)${facilityScope}
                GROUP BY outcome ORDER BY outcome`, params),
    pool.query(`SELECT outcome, count(*)::int AS count FROM operator_decisions
                WHERE facility_id IN (SELECT id FROM facilities WHERE organization_id = $1)${facilityScope}
                GROUP BY outcome ORDER BY outcome`, params),
    pool.query(`SELECT count(*)::int AS count,
                       count(*) FILTER (WHERE sentiment = 'POSITIVE')::int AS positive,
                       count(*) FILTER (WHERE sentiment = 'NEUTRAL')::int AS neutral,
                       count(*) FILTER (WHERE sentiment = 'NEGATIVE')::int AS negative
                FROM product_feedback WHERE organization_id = $1 AND expires_at > now()${scope}`, params),
    pool.query(`SELECT category, count(*)::int AS count FROM product_learning_errors
                WHERE organization_id = $1 AND expires_at > now()${scope} GROUP BY category ORDER BY category`, params),
    pool.query(`SELECT COALESCE(properties->>'topic', properties->>'tool', 'unknown') AS topic,
                       count(*)::int AS count
                FROM product_learning_events
                WHERE organization_id = $1 AND expires_at > now() AND event_name = 'ASSISTANT_USED'${scope}
                GROUP BY topic ORDER BY count DESC, topic`, params),
  ]);
  res.json({
    scope: facilityId ?? "organization",
    retention: { eventsAndFeedbackDays: 180, errorsDays: 90 },
    journeyEvents: events.rows,
    operatorSessions: sessions.rows[0],
    safetyOutcomes: safety.rows,
    decisionOutcomes: decisions.rows,
    feedback: feedback.rows[0],
    errors: errors.rows,
    commonAssistantTopics: topics.rows,
  });
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

type AssistantFacility = {
  id: string;
  name: string;
  location: string;
  model_version_id: string;
  provenance: string;
  synthetic_status: string;
  quality: "GOOD" | "DEGRADED" | "UNKNOWN";
  created_at: string;
  model_config: FacilityModelConfig;
  scenario_id: string;
  scenario_key: string;
  scenario_name: string;
  simulated_start_at: number;
  duration_s: number;
};

type AssistantContext = {
  facilityId: string;
  facilityName: string;
  scenarioId: string;
  simulatedAt: number;
  modelVersionId: string;
  provenance: ReturnType<typeof canonicalProvenance>;
  quality: "GOOD" | "DEGRADED" | "UNKNOWN";
};

function assistantRefusal(role: Role, reason: string, interpretedAs = "refusal"): AssistantResponse {
  return {
    contractVersion: CONTRACT_VERSION,
    answer: `I can’t answer that from your authorized Wattr data. ${reason}`,
    role,
    tool: "refusal",
    interpretedAs,
    context: {
      facilityId: null,
      scenarioId: null,
      simulatedAt: null,
      modelVersionId: null,
      provenance: null,
      quality: "UNKNOWN",
    },
    confidence: null,
    limitations: [reason],
    citations: [],
    actions: [],
  };
}

async function assistantFacilities(userId: string): Promise<AssistantFacility[]> {
  const result = await pool.query(
    `SELECT f.id, f.name, f.location, f.model_version AS model_version_id,
            f.provenance, f.synthetic_status, f.quality, f.created_at,
            mv.config AS model_config,
            s.id AS scenario_id, s.scenario_key, s.name AS scenario_name,
            s.simulated_start_at, s.duration_s
     FROM facilities f
     JOIN facility_permissions p ON p.facility_id = f.id AND p.user_id = $1 AND p.can_view = true
     JOIN memberships m ON m.user_id = p.user_id AND m.organization_id = f.organization_id
     JOIN model_versions mv ON mv.id = f.model_version AND mv.status = 'PUBLISHED'
     JOIN scenarios s ON s.facility_id = f.id AND s.model_version_id = mv.id AND s.status = 'PUBLISHED'
     WHERE f.organization_id = $2
     ORDER BY f.name, f.id`,
    [userId, DEMO_ORGANIZATION_ID],
  );
  return result.rows.map((row) => {
    assertModelConfig(row.model_config);
    return {
      ...row,
      simulated_start_at: Number(row.simulated_start_at),
      duration_s: Number(row.duration_s),
      model_config: row.model_config,
    };
  }) as AssistantFacility[];
}

async function assistantFacility(userId: string, facilityId: string): Promise<AssistantFacility | undefined> {
  const facilities = await assistantFacilities(userId);
  return facilities.find((facility) => facility.id === facilityId);
}

function assistantContext(facility: AssistantFacility, simulatedAt: number): AssistantContext {
  return {
    facilityId: facility.id,
    facilityName: facility.name,
    scenarioId: facility.scenario_id,
    simulatedAt,
    modelVersionId: facility.model_version_id,
    provenance: canonicalProvenance({
      provenance: facility.provenance,
      synthetic_status: facility.synthetic_status,
      created_at: facility.created_at,
      model_version_id: facility.model_version_id,
    }),
    quality: facility.quality,
  };
}

function assistantCitation(
  context: AssistantContext,
  id: string,
  label: string,
  kind: string,
  evidence: Record<string, unknown>,
  simulatedAt = context.simulatedAt,
): AssistantCitation {
  return {
    id,
    label,
    kind,
    facilityId: context.facilityId,
    scenarioId: context.scenarioId,
    simulatedAt,
    modelVersionId: context.modelVersionId,
    provenance: context.provenance,
    quality: context.quality,
    evidence,
  };
}

function assistantRecordCitation(
  context: AssistantContext,
  row: {
    scenario_id?: string;
    simulated_at?: number | string;
    model_version_id?: string;
    provenance?: string;
    synthetic_status?: string;
    quality?: "GOOD" | "DEGRADED" | "UNKNOWN";
    created_at?: string;
    generated_at?: string;
  },
  id: string,
  label: string,
  kind: string,
  evidence: Record<string, unknown>,
): AssistantCitation {
  return {
    ...assistantCitation(
      context,
      id,
      label,
      kind,
      evidence,
      row.simulated_at === undefined ? context.simulatedAt : Number(row.simulated_at),
    ),
    scenarioId: row.scenario_id ?? context.scenarioId,
    modelVersionId: row.model_version_id ?? context.modelVersionId,
    provenance: canonicalProvenance(row),
    quality: row.quality ?? context.quality,
  };
}

function assistantAction(id: string, label: string, path: string, capability: AssistantAction["capability"]): AssistantAction {
  return { id, label, kind: "NAVIGATE", path, capability };
}

function assistantActions(
  facility: AssistantFacility,
  tool: AssistantTool,
  role: Role,
  records: { incidentId?: string } = {},
): AssistantAction[] {
  const actions: AssistantAction[] = [
    assistantAction("open-operations", "Open operations", `/facilities/${facility.id}/operations`, "view"),
  ];
  if (tool === "incident_context" && records.incidentId) {
    actions.push(assistantAction(`open-incident:${records.incidentId}`, "Open incident", `/facilities/${facility.id}/incidents/${records.incidentId}`, "view"));
  }
  if (tool === "model_state" && role === "MODEL_ADMIN") {
    actions.push(assistantAction("open-model-studio", "Open Model Studio", `/facilities/${facility.id}/model`, "model"));
  }
  return actions;
}

function assistantToolAllowed(role: Role, tool: AssistantTool): boolean {
  if (tool === "portfolio_overview") return role === "PORTFOLIO_MANAGER";
  if (tool === "model_state") return role === "MODEL_ADMIN";
  return ROLE_CAPABILITIES[role]?.assistant === true;
}

function inferAssistantTool(question: string, hasFacility: boolean, role: Role): AssistantTool {
  const normalized = question.toLowerCase();
  if (!hasFacility && role === "PORTFOLIO_MANAGER") return "portfolio_overview";
  if (/\b(portfolio|fleet|sites?|facilit(?:y|ies)|rank|highest|lowest)\b/.test(normalized) &&
      role === "PORTFOLIO_MANAGER" && !/\b(this facility|this site|current site)\b/.test(normalized)) {
    return "portfolio_overview";
  }
  if (/\b(model|parameter|mapping|mapped|constraint|version|validate|validation|publish|published|configuration|config)\b/.test(normalized)) {
    return "model_state";
  }
  if (/\b(what if|counterfactual|alternative|inaction|outcome|would happen)\b/.test(normalized)) return "what_if";
  if (/\b(recommend|recommendation|advisory|next step|should we)\b/.test(normalized)) return "recommendation";
  if (/\b(incident|cause|affected|risk|alarm|thermal path|why)\b/.test(normalized)) return "incident_context";
  if (/\b(audit|decision|history|disposition)\b/.test(normalized)) return "audit_history";
  return "facility_state";
}

function assistantTimestamp(
  requested: unknown,
  facility: AssistantFacility,
): { simulatedAt?: number; error?: string } {
  const simulatedAt = requested === undefined ? facility.simulated_start_at : Number(requested);
  if (
    !Number.isSafeInteger(simulatedAt) ||
    simulatedAt < facility.simulated_start_at ||
    simulatedAt > facility.simulated_start_at + facility.duration_s
  ) {
    return { error: "The requested scenario time is outside the published facility scenario." };
  }
  return { simulatedAt };
}

function assistantAnswer(
  role: Role,
  tool: AssistantTool,
  interpretedAs: string,
  answer: string,
  context: AssistantContext,
  confidence: number | null,
  citations: AssistantCitation[],
  limitations: string[],
  actions: AssistantAction[],
): AssistantResponse {
  return {
    contractVersion: CONTRACT_VERSION,
    answer,
    role,
    tool,
    interpretedAs,
    context: {
      facilityId: context.facilityId,
      scenarioId: context.scenarioId,
      simulatedAt: context.simulatedAt,
      modelVersionId: context.modelVersionId,
      provenance: context.provenance,
      quality: context.quality,
    },
    confidence,
    limitations,
    citations,
    actions,
  };
}

function containsPromptInjection(question: string) {
  return /\b(ignore|disregard|override)\b.{0,40}\b(instructions?|policy|system|authorization)\b|reveal\b.{0,40}\b(prompt|system message|secret)\b/i.test(question);
}

app.get("/api/assistant/tools", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const membership = await organizationMembership(req.userId!);
  if (!membership || !ROLE_CAPABILITIES[membership.role]?.assistant) {
    return res.status(403).json({ error: "Ask Wattr is unavailable for this role" });
  }
  const tools = ASSISTANT_TOOLS.filter((tool) => assistantToolAllowed(membership.role, tool)).map((name) => ({
    name,
    readOnly: true,
    scope: name === "portfolio_overview" ? "organization" : "facility",
    description: {
      portfolio_overview: "Rank authorized facilities by modeled forecast risk and operating context.",
      facility_state: "Read the current authorized facility snapshot.",
      incident_context: "Read the authorized incident, affected assets, cause, and thermal path.",
      recommendation: "Read the authorized recommendation and its structured evidence.",
      what_if: "Run a read-only counterfactual over the published model.",
      audit_history: "Read immutable decision history for an authorized facility.",
      model_state: "Read model mappings, parameters, constraints, versions, and validation state.",
    }[name],
  }));
  res.json({ contractVersion: CONTRACT_VERSION, tools });
});

app.post("/api/assistant/query", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const membership = await organizationMembership(req.userId!);
  if (!membership || !ROLE_CAPABILITIES[membership.role]?.assistant) {
    return res.status(403).json(assistantRefusal(membership?.role ?? "VIEWER", "Ask Wattr requires an authorized assistant role."));
  }
  const question = req.body?.question;
  if (typeof question !== "string" || question.trim().length < 2 || question.length > 2000) {
    return res.status(400).json({ error: "Ask Wattr questions must be between 2 and 2,000 characters" });
  }
  const requestedTool = req.body?.tool;
  const validRequestedTool = typeof requestedTool === "string" &&
    (ASSISTANT_TOOLS as readonly string[]).includes(requestedTool)
    ? requestedTool as AssistantTool
    : undefined;
  if (requestedTool !== undefined && !validRequestedTool) {
    return res.status(400).json({ error: "Unknown Ask Wattr tool" });
  }
  const facilities = await assistantFacilities(req.userId!);
  const requestedFacilityId = req.body?.facilityId;
  if (requestedFacilityId !== undefined && (typeof requestedFacilityId !== "string" || requestedFacilityId.length > 128)) {
    return res.status(400).json({ error: "Invalid facility scope" });
  }
  const hasFacility = typeof requestedFacilityId === "string";
  const tool = validRequestedTool ?? inferAssistantTool(question, hasFacility, membership.role);
  const injectionLimitation = containsPromptInjection(question)
    ? "Instructions embedded in the question cannot change authorization, tool selection, or the canonical data boundary."
    : undefined;
  if (!assistantToolAllowed(membership.role, tool)) {
    const refusal = assistantRefusal(membership.role, `${tool} is not available for your role.`);
    if (injectionLimitation) refusal.limitations.push(injectionLimitation);
    return res.status(403).json(refusal);
  }
  if (tool === "portfolio_overview") {
    if (!facilities.length) {
      return res.json(assistantRefusal(membership.role, "No authorized facilities with a published scenario are available."));
    }
    const requestedAt = req.body?.simulatedAt;
    const invalidFacility = facilities.find((facility) => assistantTimestamp(requestedAt, facility).error);
    if (invalidFacility) {
      return res.status(400).json(assistantRefusal(
        membership.role,
        `The requested scenario time is unavailable for ${invalidFacility.name}; no alternate time was substituted.`,
        "portfolio facility ranking",
      ));
    }
    const rows = facilities.map((facility) => {
      const timestamp = assistantTimestamp(requestedAt, facility);
      const simulatedAt = timestamp.simulatedAt!;
      const snapshot = replaySnapshot(simulatedAt, facility.model_config);
      return { facility, simulatedAt, snapshot };
    }).sort((left, right) => {
      const risk = (value: string) => value === "critical" ? 3 : value === "watch" ? 2 : 1;
      return risk(right.snapshot.forecast.risk) - risk(left.snapshot.forecast.risk) ||
        right.snapshot.forecast.baselinePeakC - left.snapshot.forecast.baselinePeakC;
    });
    const citations = rows.map(({ facility, simulatedAt, snapshot }) => assistantCitation(
      assistantContext(facility, simulatedAt),
      `portfolio-${facility.id}`,
      `${facility.name} modeled health`,
      "portfolio.facility_rank",
      {
        rank: rows.findIndex((item) => item.facility.id === facility.id) + 1,
        risk: snapshot.forecast.risk,
        forecastPeakC: snapshot.forecast.baselinePeakC,
        openIncident: snapshot.incident.open,
        itPowerKw: snapshot.itPowerKw,
        pue: snapshot.pue,
      },
      simulatedAt,
    ));
    const summary = rows.map((row, index) =>
      `${index + 1}. ${row.facility.name}: ${row.snapshot.forecast.risk.toUpperCase()} risk, ` +
      `${row.snapshot.forecast.baselinePeakC.toFixed(1)}°C modeled peak, ` +
      `${row.snapshot.incident.open ? "open incident" : "no open incident"}`,
    ).join("; ");
    const limitations = [
      "Portfolio ranking uses the deterministic published scenario; it is not live telemetry.",
      ...(injectionLimitation ? [injectionLimitation] : []),
    ];
    const first = rows[0];
    const response = assistantAnswer(
      membership.role,
      tool,
      "portfolio facility ranking",
      `Authorized facilities ranked by modeled forecast attention: ${summary}.`,
      assistantContext(first.facility, first.simulatedAt),
      Math.min(...rows.map((row) => row.snapshot.forecast.confidence)),
      citations,
      limitations,
      [],
    );
    response.context.facilityId = null;
    response.context.scenarioId = null;
    response.context.simulatedAt = null;
    response.context.modelVersionId = null;
    response.context.provenance = null;
    response.context.quality = rows.every((row) => row.facility.quality === "GOOD") ? "GOOD" : "DEGRADED";
    await recordLearningEvent({
      organizationId: membership.organization_id,
      userId: req.userId!,
      eventName: "ASSISTANT_USED",
      route: "/ask-wattr",
      role: membership.role,
      dedupeKey: `assistant-${randomUUID()}`,
      properties: { tool, topic: tool },
    });
    return res.json(response);
  }

  const facilityId = typeof requestedFacilityId === "string"
    ? requestedFacilityId
    : facilities[0]?.id;
  if (!facilityId) {
    return res.json(assistantRefusal(membership.role, "No authorized facility with a published scenario is available."));
  }
  const facility = facilities.find((item) => item.id === facilityId);
  if (!facility) {
    return res.status(404).json(assistantRefusal(membership.role, "That facility is unavailable to your organization or facility grant."));
  }
  const timestamp = assistantTimestamp(req.body?.simulatedAt, facility);
  if (timestamp.error) return res.status(400).json(assistantRefusal(membership.role, timestamp.error));
  const simulatedAt = timestamp.simulatedAt!;
  const context = assistantContext(facility, simulatedAt);
  const snapshot = replaySnapshot(simulatedAt, facility.model_config);
  const limitations = [
    "Synthetic reduced-order model; values are not measured telemetry.",
    ...(facility.quality !== "GOOD" ? [`Facility data quality is ${facility.quality}; interpret this answer with caution.`] : []),
    ...(injectionLimitation ? [injectionLimitation] : []),
  ];
  let response: AssistantResponse;
  if (tool === "facility_state") {
    const citation = assistantCitation(context, `${facility.id}-snapshot-${simulatedAt}`, "Canonical facility snapshot", "simulation.snapshot", {
      risk: snapshot.forecast.risk,
      peakInletC: snapshot.peakInletC,
      forecastPeakC: snapshot.forecast.baselinePeakC,
      thresholdC: snapshot.forecast.thresholdC,
      itPowerKw: snapshot.itPowerKw,
      totalPowerKw: snapshot.totalPowerKw,
      pue: snapshot.pue,
      headroomKw: snapshot.headroomKw,
      racksAtRisk: snapshot.racksAtRisk,
    });
    const detail = membership.role === "ENGINEER"
      ? `The current modeled state is ${snapshot.forecast.risk.toUpperCase()}: ${snapshot.itPowerKw.toLocaleString()} kW IT load, ${snapshot.peakInletC.toFixed(1)}°C peak inlet, ${snapshot.headroomKw.toLocaleString()} kW headroom, and ${snapshot.racksAtRisk} rack(s) at risk.`
      : `Current modeled state: ${snapshot.forecast.risk.toUpperCase()} risk, ${snapshot.peakInletC.toFixed(1)}°C peak inlet, and ${snapshot.forecast.baselinePeakC.toFixed(1)}°C forecast peak against a ${snapshot.forecast.thresholdC.toFixed(1)}°C limit.`;
    response = assistantAnswer(membership.role, tool, "current facility state", detail, context, snapshot.forecast.confidence, [citation], limitations, assistantActions(facility, tool, membership.role));
  } else if (tool === "incident_context") {
    const result = await pool.query(
      `SELECT id, title, severity, status, affected_assets, raw_signal_count, likely_cause,
              forecast_minutes, correlated_signals, thermal_path, model_version_id,
              provenance, synthetic_status, quality, scenario_id, simulated_at, created_at
       FROM incidents
       WHERE facility_id = $1 AND scenario_id = $2 AND model_version_id = $3
         AND simulated_at <= $4
       ORDER BY simulated_at DESC, created_at DESC LIMIT 1`,
      [facility.id, facility.scenario_id, facility.model_version_id, simulatedAt],
    );
    const incident = result.rows[0];
    if (!incident) {
      response = assistantAnswer(membership.role, tool, "incident context", "No incident record is available for this authorized facility at the requested time.", context, null, [], [...limitations, "Incident data is unavailable; no cause or affected asset is inferred."], assistantActions(facility, tool, membership.role));
    } else {
      const citation = assistantRecordCitation(context, incident, incident.id, incident.title, "incident.record", {
        severity: incident.severity,
        status: incident.status,
        affectedAssets: incident.affected_assets,
        rawSignalCount: incident.raw_signal_count,
        likelyCause: incident.likely_cause,
        forecastMinutes: incident.forecast_minutes,
        correlatedSignals: incident.correlated_signals,
        thermalPath: incident.thermal_path,
      });
      const assets = Array.isArray(incident.affected_assets) ? incident.affected_assets.join(", ") : "unavailable";
      response = assistantAnswer(
        membership.role,
        tool,
        "incident, affected assets, likely cause, and thermal path",
        `The ${incident.severity} ${incident.status.toLowerCase()} incident is ${incident.title}. Affected assets: ${assets}. Likely cause: ${incident.likely_cause}. The record contains ${incident.raw_signal_count} correlated raw signal(s) and a ${incident.forecast_minutes}-minute forecast window.`,
        context,
        snapshot.forecast.confidence,
        [citation],
        limitations,
        assistantActions(facility, tool, membership.role, {
          incidentId: incident.id,
        }),
      );
    }
  } else if (tool === "recommendation" || tool === "what_if") {
    const result = await pool.query(
      `SELECT r.id, r.title, r.status, r.rationale, r.command, r.version, r.explanation,
              r.evidence, r.confidence, r.limitations, r.simulated_at, r.model_version_id,
              r.scenario_id, r.provenance, r.synthetic_status, r.quality, r.created_at
       FROM recommendations r
       WHERE r.facility_id = $1 AND r.scenario_id = $2 AND r.model_version_id = $3
         AND r.simulated_at <= $4
       ORDER BY r.simulated_at DESC, r.created_at DESC LIMIT 1`,
      [facility.id, facility.scenario_id, facility.model_version_id, simulatedAt],
    );
    const recommendation = result.rows[0];
    if (!recommendation) {
      response = assistantAnswer(membership.role, tool, "recommendation", "No recommendation is available for this authorized facility. I will not invent one.", context, null, [], [...limitations, "Recommendation data is unavailable."], []);
    } else {
      const command = parseAdvisoryCommand(recommendation.command);
      const citation = assistantRecordCitation(context, recommendation, recommendation.id, recommendation.title, "recommendation.record", {
        status: recommendation.status,
        version: recommendation.version,
        rationale: recommendation.rationale,
        command: recommendation.command,
        evidence: recommendation.evidence,
        confidence: Number(recommendation.confidence),
        limitations: recommendation.limitations,
      });
      if (tool === "what_if" && !command) {
        response = assistantAnswer(membership.role, tool, "recommendation counterfactual", "The persisted recommendation command is unavailable or invalid, so no what-if outcome can be calculated.", context, null, [citation], [...limitations, "No valid recommendation command was available for the read-only simulation."], []);
      } else if (tool === "what_if") {
        const inaction = replaySnapshot(simulatedAt, facility.model_config);
        const counterfactual = counterfactualCockpitSnapshot(simulatedAt, command!, facility.model_config);
        response = assistantAnswer(
          membership.role,
          tool,
          "read-only recommendation counterfactual",
          `If the recommendation (${command!.flowPercent}% CDU-03 flow for ${command!.durationMinutes} minutes) were modeled at this scenario time, the forecast peak is ${counterfactual.forecast.advisoryPeakC.toFixed(1)}°C versus ${inaction.forecast.baselinePeakC.toFixed(1)}°C with inaction, avoiding ${counterfactual.forecast.advisoryConstraintMinutes.toFixed(1)} of modeled constraint minutes versus ${inaction.forecast.baselineConstraintMinutes.toFixed(1)}.`,
          context,
          counterfactual.forecast.confidence,
          [citation, assistantCitation(context, `${recommendation.id}-what-if-${simulatedAt}`, "Read-only what-if outcome", "simulation.counterfactual", {
            inactionForecastPeakC: inaction.forecast.baselinePeakC,
            recommendationForecastPeakC: counterfactual.forecast.advisoryPeakC,
            inactionConstraintMinutes: inaction.forecast.baselineConstraintMinutes,
            recommendationConstraintMinutes: counterfactual.forecast.advisoryConstraintMinutes,
            command,
          })],
          [...limitations, "This is a counterfactual model outcome, not a command or a measured result.", "Human approval remains required; Ask Wattr cannot approve or send OT commands."],
          assistantActions(facility, tool, membership.role),
        );
      } else {
        const inaction = replaySnapshot(simulatedAt, facility.model_config);
        const counterfactual = command
          ? counterfactualCockpitSnapshot(simulatedAt, command, facility.model_config)
          : undefined;
        const modeledEffect = counterfactual
          ? `${Math.max(0, inaction.forecast.baselinePeakC - counterfactual.forecast.advisoryPeakC).toFixed(1)}°C lower modeled peak and ` +
            `${Math.max(0, inaction.forecast.baselineConstraintMinutes - counterfactual.forecast.advisoryConstraintMinutes).toFixed(1)} fewer modeled constraint minutes`
          : "unavailable because the persisted command is invalid";
        response = assistantAnswer(
          membership.role,
          tool,
          "recommendation and structured evidence",
          `Recommendation ${recommendation.status.toLowerCase()}: ${recommendation.title}. ${recommendation.rationale} Modeled effect: ${modeledEffect}. Confidence is ${Math.round(Number(recommendation.confidence) * 100)}%.`,
          context,
          Number(recommendation.confidence),
          [citation, ...(counterfactual ? [assistantCitation(context, `${recommendation.id}-snapshot-${simulatedAt}`, "Recommendation replay snapshot", "simulation.recommendation", {
            baselinePeakC: inaction.forecast.baselinePeakC,
            advisoryPeakC: counterfactual.forecast.advisoryPeakC,
            reductionC: Math.max(0, inaction.forecast.baselinePeakC - counterfactual.forecast.advisoryPeakC),
            constraintMinutesAvoided: Math.max(0, inaction.forecast.baselineConstraintMinutes - counterfactual.forecast.advisoryConstraintMinutes),
            command,
          })] : [])],
          [...limitations, ...(!counterfactual ? ["The persisted recommendation command is invalid; its effect was not modeled."] : []), "The recommendation is advisory only; no command is sent to operational technology."],
          assistantActions(facility, tool, membership.role),
        );
      }
    }
  } else if (tool === "audit_history") {
    const result = await pool.query(
      `SELECT id, action, scenario_id, simulated_at, model_version, model_version_id,
              payload, provenance, synthetic_status, quality, created_at
       FROM audit_records
       WHERE facility_id = $1 AND scenario_id = $2 AND model_version_id = $3
         AND simulated_at <= $4
       ORDER BY simulated_at DESC, created_at DESC LIMIT 10`,
      [facility.id, facility.scenario_id, facility.model_version_id, simulatedAt],
    );
    const citations = result.rows.map((row) => assistantRecordCitation(context, row, `audit-${row.id}`, `Audit ${row.id}`, "audit.record", {
      action: row.action,
      decision: row.payload?.decision ?? null,
      outcome: row.payload?.decision?.outcome ?? null,
    }));
    response = assistantAnswer(
      membership.role,
      tool,
      "immutable audit history",
      result.rows.length
        ? `${result.rows.length} immutable decision record(s) are available. Most recent: ${result.rows[0].action} at scenario time ${Number(result.rows[0].simulated_at)} with model ${result.rows[0].model_version}.`
        : "No immutable decision records are available for this facility. I will not infer an operator decision.",
      context,
      result.rows.length ? 1 : null,
      citations,
      result.rows.length ? limitations : [...limitations, "Decision history is unavailable."],
      [],
    );
  } else {
    const [versions, mappings] = await Promise.all([
      pool.query(
        `SELECT id, status, config, published_at, created_at
         FROM model_versions WHERE facility_id = $1 ORDER BY created_at DESC`,
        [facility.id],
      ),
      pool.query(
        `SELECT
           (SELECT count(*) FROM facility_hierarchy WHERE facility_id = $1) AS hierarchy_count,
           (SELECT count(*) FROM assets WHERE facility_id = $1) AS asset_count,
           (SELECT count(*) FROM sensors WHERE facility_id = $1) AS sensor_count,
           (SELECT count(*) FROM topology_edges WHERE facility_id = $1) AS topology_edge_count`,
        [facility.id],
      ),
    ]);
    const currentVersion = versions.rows.find((version) => version.id === facility.model_version_id);
    const citation = assistantCitation(context, `${facility.id}-model-${facility.model_version_id}`, "Published model and mappings", "model.state", {
      activeVersion: facility.model_version_id,
      activeStatus: currentVersion?.status ?? "UNAVAILABLE",
      parameters: facility.model_config,
      constraints: {
        inletTemperatureDomainMaxC: MODEL_DOMAIN_MAX_C,
        commandEnvelope: COMMAND_ENVELOPE,
        scenarioDurationS: facility.duration_s,
      },
      versions: versions.rows.map((version) => ({ id: version.id, status: version.status, publishedAt: version.published_at })),
      mappings: mappings.rows[0],
    });
    response = assistantAnswer(
      membership.role,
      tool,
      "model mappings, parameters, constraints, versions, and validation state",
      `The active published model is ${facility.model_version_id} (${currentVersion?.status ?? "status unavailable"}). Parameters: seed ${facility.model_config.seed}, thermal mass ${facility.model_config.thermalMass}, response lag ${facility.model_config.responseLag}s. Mappings include ${mappings.rows[0]?.hierarchy_count ?? 0} hierarchy nodes, ${mappings.rows[0]?.asset_count ?? 0} assets, ${mappings.rows[0]?.sensor_count ?? 0} sensors, and ${mappings.rows[0]?.topology_edge_count ?? 0} topology edges. The model domain ends at ${MODEL_DOMAIN_MAX_C}°C and the permitted advisory envelope is ${COMMAND_ENVELOPE.minFlowPercent}–${COMMAND_ENVELOPE.maxFlowPercent}% CDU flow.`,
      context,
      1,
      [citation],
      [...limitations, "Model configuration is disclosed for administration and validation; Ask Wattr cannot publish, rollback, or edit a model."],
      assistantActions(facility, tool, membership.role),
    );
  }
  await recordLearningEvent({
    organizationId: membership.organization_id,
    userId: req.userId!,
    facilityId: facility.id,
    scenarioId: facility.scenario_id,
    eventName: "ASSISTANT_USED",
    route: `/facilities/${facility.id}/ask-wattr`,
    role: membership.role,
    modelVersionId: facility.model_version_id,
    simulatedAt,
    dedupeKey: `assistant-${randomUUID()}`,
    properties: { tool, topic: tool },
  });
  return res.json(response);
});

app.post("/api/assistant/action", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const membership = await organizationMembership(req.userId!);
  if (!membership || !ROLE_CAPABILITIES[membership.role]?.assistant) {
    return res.status(403).json({ error: "Ask Wattr action access is unavailable for this role" });
  }
  const action = req.body?.action;
  const facilityId = req.body?.facilityId;
  if (typeof action !== "string" || typeof facilityId !== "string") {
    return res.status(400).json({ error: "A named action and facility are required" });
  }
  let target: { path: string; capability: Capability; resource?: { table: "incidents" | "recommendations"; id: string } } | undefined;
  if (action === "open-operations") {
    target = { path: `/facilities/${facilityId}/operations`, capability: "view" };
  } else if (action === "open-model-studio") {
    target = { path: `/facilities/${facilityId}/model`, capability: "model" };
  } else {
    const [kind, resourceId] = action.split(":");
    if (resourceId && /^[a-z0-9][a-z0-9._-]{1,127}$/i.test(resourceId)) {
      if (kind === "open-incident") {
        target = {
          path: `/facilities/${facilityId}/incidents/${resourceId}`,
          capability: "view",
          resource: { table: "incidents", id: resourceId },
        };
      }
    }
  }
  if (!target) {
    return res.status(403).json({ error: "Ask Wattr can only propose named navigation actions; it cannot approve decisions or issue OT commands" });
  }
  const permission = await facilityPermission(req.userId!, facilityId, target.capability);
  if (!permission) return res.status(404).json({ error: "Facility action unavailable" });
  if (target.resource) {
    const existing = await pool.query(
      `SELECT id FROM ${target.resource.table} WHERE id = $1 AND facility_id = $2`,
      [target.resource.id, facilityId],
    );
    if (!existing.rows[0]) return res.status(404).json({ error: "Facility action target unavailable" });
  }
  res.json({
    contractVersion: CONTRACT_VERSION,
    action: "NAVIGATE",
    actionId: action,
    path: target.path,
    facilityId,
    capability: target.capability,
    humanConfirmationRequired: false,
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
  const permission = await requireFacilityAccess(req.userId!, String(req.params.facilityId), res);
  if (!permission) return;
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
  await recordLearningEvent({
    organizationId: permission.organization_id,
    userId: req.userId!,
    facilityId: String(req.params.facilityId),
    scenarioId: record.scenario_id,
    eventName: "AUDIT_RECONSTRUCTED",
    route: `/facilities/${req.params.facilityId}/audit`,
    role: permission.role,
    modelVersionId: record.model_version,
    simulatedAt: Number(record.simulated_at),
    dedupeKey: `audit-${record.id}`,
    properties: { auditId: String(record.id) },
  });
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
  const permission = await requireFacilityAccess(req.userId!, String(req.params.facilityId), res);
  if (!permission) return;
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
  await recordLearningEvent({
    organizationId: permission.organization_id,
    userId: req.userId!,
    facilityId: String(req.params.facilityId),
    scenarioId: "gpu-training-ramp-v1",
    eventName: "INCIDENT_REVIEWED",
    route: `/facilities/${req.params.facilityId}/incidents/${req.params.incidentId}`,
    role: permission.role,
    modelVersionId: result.rows[0].model_version,
    simulatedAt: Number(result.rows[0].simulated_at),
    dedupeKey: `incident-${result.rows[0].id}`,
    properties: { incidentId: result.rows[0].id },
  });
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
  const membership = await organizationMembership(req.userId!);
  if (membership) {
    await recordLearningEvent({
      organizationId: membership.organization_id,
      userId: req.userId!,
      eventName: complete ? "TUTORIAL_COMPLETED" : "TUTORIAL_STEP_COMPLETED",
      route: "/help",
      role: membership.role,
      dedupeKey: complete ? "tutorial-complete" : `tutorial-step-${step}`,
      properties: { step, complete },
    });
  }
  res.json(result.rows[0]);
});

app.patch("/api/me/preferences", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const theme = req.body?.theme;
  if (theme !== "light" && theme !== "dark" && theme !== "system") {
    return res.status(400).json({ error: "Theme must be light, dark, or system" });
  }
  const result = await pool.query(
    `UPDATE user_preferences
     SET theme = $2, updated_at = now()
     WHERE user_id = $1
     RETURNING theme, updated_at`,
    [req.userId, theme],
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
  const permission = await requireFacilityAccess(req.userId!, String(req.params.facilityId), res, "assistant");
  if (!permission) return;
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
  const response = {
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
  };
  await recordLearningEvent({
    organizationId: permission.organization_id,
    userId: req.userId!,
    facilityId: String(req.params.facilityId),
    scenarioId: "gpu-training-ramp-v1",
    eventName: "WHAT_IF_USED",
    route: `/facilities/${req.params.facilityId}/recommendations/${req.params.recommendationId}`,
    role: permission.role,
    modelVersionId: row.model_version_id,
    simulatedAt,
    dedupeKey: `what-if-${req.params.recommendationId}-${simulatedAt}-${command.flowPercent}-${command.durationMinutes}`,
    properties: { recommendationId: String(req.params.recommendationId) },
  });
  res.json(response);
});

app.post("/api/facilities/:facilityId/recommendations/:recommendationId/evaluate", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const permission = await requireFacilityAccess(req.userId!, String(req.params.facilityId), res, "assistant");
  if (!permission) return;
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
  await recordLearningEvent({
    organizationId: permission.organization_id,
    userId: req.userId!,
    facilityId: String(req.params.facilityId),
    scenarioId: "gpu-training-ramp-v1",
    eventName: "SAFETY_RESULT",
    route: `/facilities/${req.params.facilityId}/recommendations/${req.params.recommendationId}`,
    role: permission.role,
    modelVersionId: model.model_version,
    simulatedAt,
    dedupeKey: `safety-${id}`,
    properties: { recommendationId: String(req.params.recommendationId), outcome },
  });
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
    await recordLearningEvent({
      organizationId: permission.organization_id,
      userId: req.userId!,
      facilityId: String(req.params.facilityId),
      scenarioId: "gpu-training-ramp-v1",
      eventName: "DECISION_RECORDED",
      route: `/facilities/${req.params.facilityId}/recommendations/${req.params.recommendationId}`,
      role: permission.role,
      modelVersionId: activeModel.model_version,
      simulatedAt,
      dedupeKey: `decision-${decisionId}`,
      properties: {
        recommendationId: String(req.params.recommendationId),
        decision,
        outcome,
      },
    });
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

void purgeExpiredLearningRecords().catch(() => {});
const learningRetentionTimer = setInterval(() => {
  lastLearningPurgeAt = 0;
  void purgeExpiredLearningRecords().catch(() => {});
}, 60 * 60 * 1000);
learningRetentionTimer.unref();

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  void recordLearningError({
    userId: (req as AuthedRequest).userId,
    category: /simulation|invariant|model contract/i.test(message) ? "SIMULATION_INVARIANT_FAILURE" : "APPLICATION_FAULT",
    code: /simulation|invariant|model contract/i.test(message) ? "SERVER_SIMULATION_INVARIANT" : "SERVER_UNHANDLED_ERROR",
    route: req.path,
  });
  res.status(500).json({ error: "Internal server error" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Wattr Operator Cockpit listening on ${port}`);
});