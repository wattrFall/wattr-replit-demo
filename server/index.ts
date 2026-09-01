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
} from "../src/lib/cockpit/simulation";

const app = express();
const port = Number(process.env.PORT || 5000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const isDatabaseTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const isScenarioTimestamp = (value: unknown): value is number =>
  isDatabaseTimestamp(value) &&
  value >= SCENARIO_START_S &&
  value <= SCENARIO_START_S + SCENARIO_DURATION_S;

function replaySnapshot(simulatedAt: number) {
  return replayCockpitSnapshot(simulatedAt);
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
    `SELECT u.id, u.display_name, m.role, p.theme, p.tutorial_complete
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
    `SELECT f.id, f.name, f.location, f.model_version, f.provenance,
            p.can_operate, p.can_edit_model
     FROM facilities f
     JOIN facility_permissions p ON p.facility_id = f.id
     WHERE p.user_id = $1 AND p.can_view = true`,
    [req.userId],
  );
  res.json(result.rows);
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

app.post("/api/facilities/:facilityId/recommendations/rec-17/evaluate", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const permission = await pool.query(
    "SELECT can_view FROM facility_permissions WHERE user_id = $1 AND facility_id = $2",
    [req.userId, req.params.facilityId],
  );
  if (!permission.rows[0]?.can_view) return res.status(403).json({ error: "Facility permission required" });
  const simulatedAt = req.body?.simulatedAt;
  if (!isScenarioTimestamp(simulatedAt)) return res.status(400).json({ error: "Invalid simulation timestamp" });

  const snapshot = replaySnapshot(simulatedAt);
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
      (id, user_id, facility_id, recommendation_id, simulated_at, outcome, checks, expires_at)
     VALUES ($1, $2, $3, 'rec-17', $4, $5, $6::jsonb, now() + interval '10 minutes')`,
    [id, req.userId, req.params.facilityId, simulatedAt, outcome, JSON.stringify(checks)],
  );
  res.status(201).json({ id, outcome, checks, simulatedAt });
});

app.post("/api/facilities/:facilityId/audit", requireAuth, async (req: AuthedRequest, res) => {
  await ensureDemoAccess(req.userId!);
  const permission = await pool.query(
    "SELECT can_operate FROM facility_permissions WHERE user_id = $1 AND facility_id = $2",
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
      `SELECT id FROM safety_evaluations
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
    const snapshot = replaySnapshot(simulatedAt);
    const result = await client.query(
      `INSERT INTO audit_records
        (organization_id, facility_id, user_id, action, scenario_id, simulated_at, model_version, payload)
       VALUES ('wattr-demo', $1, $2, $3, 'gpu-training-ramp-v1', $4, 'sfo-rom-1.0.0', $5::jsonb)
       RETURNING id, action, created_at`,
      [req.params.facilityId, req.userId, action, simulatedAt, JSON.stringify({
        ...payload,
        safetyEvaluationId,
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