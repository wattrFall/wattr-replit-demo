import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { availableTestPort } from "./test-port";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { SCENARIO_START_S } from "../src/lib/cockpit/simulation";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().slice(0, 8);
const operatorId = `learning-operator-${suffix}`;
const managerId = `learning-manager-${suffix}`;
const restrictedManagerId = `learning-restricted-manager-${suffix}`;
const viewerId = `learning-viewer-${suffix}`;
const users = [operatorId, managerId, restrictedManagerId, viewerId];
const port = await availableTestPort();
const baseUrl = `http://127.0.0.1:${port}`;

async function request(userId: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "x-test-user-id": userId,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE audit_records DISABLE TRIGGER audit_records_immutable");
    await client.query("ALTER TABLE operator_decisions DISABLE TRIGGER operator_decisions_immutable");
    await client.query("DELETE FROM audit_records WHERE user_id = ANY($1::text[])", [users]);
    await client.query("DELETE FROM operator_decisions WHERE user_id = ANY($1::text[])", [users]);
    await client.query("ALTER TABLE operator_decisions ENABLE TRIGGER operator_decisions_immutable");
    await client.query("ALTER TABLE audit_records ENABLE TRIGGER audit_records_immutable");
    await client.query("DELETE FROM safety_evaluations WHERE user_id = ANY($1::text[])", [users]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await pool.query("DELETE FROM product_learning_errors WHERE user_id = ANY($1::text[])", [users]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [users]);
  await pool.query("UPDATE recommendations SET status = 'PROPOSED' WHERE id = 'rec-17'");
}

await cleanup();
for (const [userId, role] of [
  [operatorId, "OPERATOR"],
  [managerId, "PORTFOLIO_MANAGER"],
  [restrictedManagerId, "PORTFOLIO_MANAGER"],
  [viewerId, "VIEWER"],
] as const) {
  await pool.query("INSERT INTO users (id, display_name) VALUES ($1, $2)", [userId, role]);
  await pool.query(
    "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, 'wattr-demo', $2)",
    [userId, role],
  );
}
for (const userId of [operatorId, managerId]) {
  await pool.query(
    `INSERT INTO facility_permissions
       (user_id, facility_id, can_view, can_operate, can_edit_model)
     VALUES ($1, 'sfo-01', true, $2, false)`,
    [userId, userId === operatorId],
  );
}

const server = spawn("node_modules/.bin/tsx", ["server/index.ts"], {
  env: { ...process.env, NODE_ENV: "test", PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
server.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!(await fetch(`${baseUrl}/api/health`)).ok) throw new Error(`Test server did not start: ${stderr}`);

  const eventBody = {
    eventName: "FACILITY_DRILLDOWN",
    facilityId: "sfo-01",
    simulatedAt: SCENARIO_START_S,
    sessionId: randomUUID(),
  };
  const first = await request(operatorId, "/api/learning/events", { method: "POST", body: JSON.stringify(eventBody) });
  assert.equal(first.status, 201);
  assert.equal(first.body.deduplicated, false);
  const duplicate = await request(operatorId, "/api/learning/events", { method: "POST", body: JSON.stringify(eventBody) });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.deduplicated, true);
  const unscoped = await request(operatorId, "/api/learning/events", {
    method: "POST",
    body: JSON.stringify({ ...eventBody, facilityId: undefined, sessionId: randomUUID() }),
  });
  assert.equal(unscoped.status, 400);

  const sensitive = await request(operatorId, "/api/learning/events", {
    method: "POST",
    body: JSON.stringify({ ...eventBody, sessionId: randomUUID(), properties: { topic: "Jane at restricted facility" } }),
  });
  assert.equal(sensitive.status, 400);
  const sensitiveRoute = await request(operatorId, "/api/learning/events", {
    method: "POST",
    body: JSON.stringify({ ...eventBody, sessionId: randomUUID(), route: "/portfolio/Jane-at-restricted-facility" }),
  });
  assert.equal(sensitiveRoute.status, 400);
  const invalidSession = await request(operatorId, "/api/learning/events", {
    method: "POST",
    body: JSON.stringify({ ...eventBody, sessionId: "Jane at restricted facility" }),
  });
  assert.equal(invalidSession.status, 400);
  const telemetryTick = await request(operatorId, "/api/learning/events", {
    method: "POST",
    body: JSON.stringify({ ...eventBody, eventName: "SIMULATION_TICK", sessionId: randomUUID() }),
  });
  assert.equal(telemetryTick.status, 400);
  const forgedOutcome = await request(operatorId, "/api/learning/events", {
    method: "POST",
    body: JSON.stringify({ ...eventBody, eventName: "SAFETY_RESULT", sessionId: randomUUID() }),
  });
  assert.equal(forgedOutcome.status, 400);

  const inaccessible = await request(viewerId, "/api/learning/events", {
    method: "POST",
    body: JSON.stringify({ ...eventBody, sessionId: randomUUID() }),
  });
  assert.equal(inaccessible.status, 404);

  const feedback = await request(operatorId, "/api/learning/feedback", {
    method: "POST",
    body: JSON.stringify({
      facilityId: "sfo-01",
      surface: "OPERATIONS",
      sentiment: "NEUTRAL",
      feedbackCode: "UNCLEAR",
    }),
  });
  assert.equal(feedback.status, 201);
  const sensitiveFeedbackRoute = await request(operatorId, "/api/learning/feedback", {
    method: "POST",
    body: JSON.stringify({
      facilityId: "sfo-01", surface: "OPERATIONS", route: "/Jane-at-restricted-facility",
      sentiment: "NEUTRAL", feedbackCode: "UNCLEAR",
    }),
  });
  assert.equal(sensitiveFeedbackRoute.status, 400);

  const started = await request(operatorId, "/api/learning/operator-sessions", {
    method: "POST",
    body: JSON.stringify({ facilityId: "sfo-01" }),
  });
  assert.equal(started.status, 201);
  const sensitiveScenario = await request(operatorId, "/api/learning/operator-sessions", {
    method: "POST",
    body: JSON.stringify({ facilityId: "sfo-01", scenarioId: "Jane-at-restricted-facility" }),
  });
  assert.equal(sensitiveScenario.status, 400);
  const completed = await request(operatorId, `/api/learning/operator-sessions/${started.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "COMPLETED",
      scenarioCompleted: true,
      timeToUnderstandingS: 94,
      errorCount: 1,
      qualitativeFeedbackCode: "CLEAR",
      surface: "RECOMMENDATIONS",
    }),
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.status, "COMPLETED");
  const sensitiveSessionRoute = await request(operatorId, `/api/learning/operator-sessions/${started.body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ route: "/Jane-at-restricted-facility" }),
  });
  assert.equal(sensitiveSessionRoute.status, 400);

  const wrongRole = await request(managerId, "/api/learning/operator-sessions", {
    method: "POST",
    body: JSON.stringify({ facilityId: "sfo-01" }),
  });
  assert.equal(wrongRole.status, 403);

  const classifiedError = await request(operatorId, "/api/learning/errors", {
    method: "POST",
    body: JSON.stringify({
      category: "EXTERNAL_SERVICE_UNAVAILABLE",
      code: "HTTP_503",
      surface: "ASK_WATTR",
      facilityId: "sfo-01",
    }),
  });
  assert.equal(classifiedError.status, 202);
  const sensitiveErrorRoute = await request(operatorId, "/api/learning/errors", {
    method: "POST",
    body: JSON.stringify({
      category: "EXTERNAL_SERVICE_UNAVAILABLE", code: "HTTP_503",
      surface: "ASK_WATTR", facilityId: "sfo-01", route: "/Jane-at-restricted-facility",
    }),
  });
  assert.equal(sensitiveErrorRoute.status, 400);

  const forbiddenSummary = await request(viewerId, "/api/learning/outcomes");
  assert.equal(forbiddenSummary.status, 403);
  const restrictedSummary = await request(restrictedManagerId, "/api/learning/outcomes");
  assert.equal(restrictedSummary.status, 200);
  assert(!restrictedSummary.body.journeyEvents.some((item: any) => item.event_name === "FACILITY_DRILLDOWN"));
  const summary = await request(managerId, "/api/learning/outcomes");
  assert.equal(summary.status, 200);
  assert(summary.body.journeyEvents.some((item: any) => item.event_name === "FACILITY_DRILLDOWN" && item.count >= 1));
  assert(summary.body.operatorSessions.completed >= 1);
  assert(summary.body.feedback.count >= 1);
  assert(summary.body.errors.some((item: any) => item.category === "EXTERNAL_SERVICE_UNAVAILABLE"));

  const stored = await pool.query(
    `SELECT count(*)::int AS total,
            array_agg(event_name ORDER BY event_name) AS event_names,
            count(*) FILTER (WHERE properties ? 'question')::int AS raw_questions,
            count(*) FILTER (WHERE event_name = 'SIMULATION_TICK')::int AS ticks
     FROM product_learning_events WHERE user_id = $1`,
    [operatorId],
  );
  assert.equal(stored.rows[0].total, 2);
  assert.deepEqual(stored.rows[0].event_names, ["FACILITY_DRILLDOWN", "SCENARIO_COMPLETED"]);
  assert.equal(stored.rows[0].raw_questions, 0);
  assert.equal(stored.rows[0].ticks, 0);
  const feedbackColumns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name IN ('product_feedback', 'operator_test_sessions')
       AND column_name IN ('comment', 'qualitative_feedback', 'abandonment_reason')`,
  );
  assert.equal(feedbackColumns.rowCount, 0);

  await pool.query(`
    CREATE OR REPLACE FUNCTION reject_test_learning_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.user_id = TG_ARGV[0] THEN
        RAISE EXCEPTION 'forced learning write failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await pool.query(
    `CREATE TRIGGER reject_test_learning_event_trigger
     BEFORE INSERT ON product_learning_events
     FOR EACH ROW EXECUTE FUNCTION reject_test_learning_event('${operatorId}')`,
  );
  try {
    const decisionWithLearningFailure = await request(operatorId, "/api/facilities/sfo-01/recommendations/rec-17/decisions", {
      method: "POST",
      body: JSON.stringify({
        decision: "REJECT",
        simulatedAt: SCENARIO_START_S,
        command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 },
      }),
    });
    assert.equal(decisionWithLearningFailure.status, 201);
    const decisionPersisted = await pool.query(
      "SELECT 1 FROM operator_decisions WHERE user_id = $1 AND decision = 'REJECT'",
      [operatorId],
    );
    assert.equal(decisionPersisted.rowCount, 1);
  } finally {
    await pool.query("DROP TRIGGER IF EXISTS reject_test_learning_event_trigger ON product_learning_events");
    await pool.query("DROP FUNCTION IF EXISTS reject_test_learning_event()");
  }
  console.log("Product learning deduplication, privacy, access, sessions, feedback, errors, and outcome summaries passed.");
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await cleanup();
  await pool.end();
}