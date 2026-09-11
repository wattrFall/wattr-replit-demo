import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  DEFAULT_FACILITY_MODEL,
  SCENARIO_START_S,
  counterfactualCockpitSnapshot,
  replayCockpitSnapshot,
} from "../src/lib/cockpit/simulation";
import { availableTestPort } from "./test-port";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const userId = `decision-workflow-${randomUUID().slice(0, 8)}`;
const port = await availableTestPort();
const baseUrl = `http://127.0.0.1:${port}`;

async function request(path: string, init: RequestInit = {}) {
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
    await client.query("DELETE FROM audit_records WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM operator_decisions WHERE user_id = $1", [userId]);
    await client.query("ALTER TABLE operator_decisions ENABLE TRIGGER operator_decisions_immutable");
    await client.query("ALTER TABLE audit_records ENABLE TRIGGER audit_records_immutable");
    await client.query("DELETE FROM safety_evaluations WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM users WHERE id = $1", [userId]);
    await client.query("UPDATE recommendations SET status = 'PROPOSED' WHERE id = 'rec-17'");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

await cleanup();
await pool.query("INSERT INTO users (id, display_name) VALUES ($1, 'Decision workflow operator')", [userId]);
await pool.query(
  "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, 'wattr-demo', 'OPERATOR')",
  [userId],
);
await pool.query(
  `INSERT INTO facility_permissions
     (user_id, facility_id, can_view, can_operate, can_edit_model)
   VALUES ($1, 'sfo-01', true, true, false)`,
  [userId],
);

const actual = replayCockpitSnapshot(SCENARIO_START_S + 300, DEFAULT_FACILITY_MODEL);
const alternative = counterfactualCockpitSnapshot(
  SCENARIO_START_S + 300,
  { flowPercent: 64, durationMinutes: 1 },
  DEFAULT_FACILITY_MODEL,
);
assert.equal(actual.forecast.series.length, actual.forecast.horizonS);
assert.equal(alternative.forecast.series.length, actual.forecast.series.length);
assert.deepEqual(alternative.modelConfig, actual.modelConfig);
assert.equal(alternative.forecast.series[0].simulatedAt, actual.forecast.series[0].simulatedAt);
assert.notEqual(alternative.forecast.advisoryPeakC, actual.forecast.advisoryPeakC);

const server = spawn("node_modules/.bin/tsx", ["server/index.ts"], {
  env: { ...process.env, NODE_ENV: "test", PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
server.stderr.on("data", (chunk) => { stderr += String(chunk); });

try {
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!healthy) throw new Error(`Test server did not start on ${port}: ${stderr}`);

  const whatIf = await request("/api/facilities/sfo-01/recommendations/rec-17/what-if", {
    method: "POST",
    body: JSON.stringify({
      simulatedAt: SCENARIO_START_S + 300,
      command: { assetId: "cdu-03", flowPercent: 64, durationMinutes: 1 },
    }),
  });
  assert.equal(whatIf.status, 200);
  assert.deepEqual(whatIf.body.options.map((option: any) => option.id), ["inaction", "recommendation", "alternative"]);
  assert(whatIf.body.options.every((option: any) => option.series.length === 300));

  const pass = await request("/api/facilities/sfo-01/recommendations/rec-17/evaluate", {
    method: "POST",
    body: JSON.stringify({
      simulatedAt: SCENARIO_START_S,
      command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 },
    }),
  });
  assert.equal(pass.status, 201);
  assert.equal(pass.body.outcome, "PASS");

  const warning = await request("/api/facilities/sfo-01/recommendations/rec-17/evaluate", {
    method: "POST",
    body: JSON.stringify({
      simulatedAt: SCENARIO_START_S + 900,
      command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 },
    }),
  });
  assert.equal(warning.status, 201);
  assert.equal(warning.body.outcome, "WARNING");

  const block = await request("/api/facilities/sfo-01/recommendations/rec-17/evaluate", {
    method: "POST",
    body: JSON.stringify({
      simulatedAt: SCENARIO_START_S,
      command: { assetId: "cdu-03", flowPercent: 50, durationMinutes: 20 },
    }),
  });
  assert.equal(block.status, 201);
  assert.equal(block.body.outcome, "BLOCK");
  assert(block.body.checks.some((check: any) => check.id === "COMMAND_ENVELOPE" && check.status === "BLOCK"));

  const bypass = await request("/api/facilities/sfo-01/recommendations/rec-17/decisions", {
    method: "POST",
    body: JSON.stringify({
      decision: "APPROVE",
      simulatedAt: SCENARIO_START_S,
      command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 },
    }),
  });
  assert.equal(bypass.status, 409);

  const warningApproval = await request("/api/facilities/sfo-01/recommendations/rec-17/decisions", {
    method: "POST",
    body: JSON.stringify({
      decision: "APPROVE",
      simulatedAt: SCENARIO_START_S + 900,
      safetyEvaluationId: warning.body.id,
      command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 },
    }),
  });
  assert.equal(warningApproval.status, 409);

  const mismatchedCommand = await request("/api/facilities/sfo-01/recommendations/rec-17/decisions", {
    method: "POST",
    body: JSON.stringify({
      decision: "APPROVE",
      simulatedAt: SCENARIO_START_S,
      safetyEvaluationId: pass.body.id,
      command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 1 },
    }),
  });
  assert.equal(mismatchedCommand.status, 409);

  const legacyBypass = await request("/api/facilities/sfo-01/audit", {
    method: "POST",
    body: JSON.stringify({
      action: "APPROVE_ADVISORY",
      simulatedAt: SCENARIO_START_S,
      safetyEvaluationId: pass.body.id,
      payload: {
        recommendationId: "rec-17",
        outcome: "ALLOWED_AS_ADVISORY",
        provenance: "SIMULATED",
        command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 },
      },
    }),
  });
  assert.equal(legacyBypass.status, 410);

  const approval = await request("/api/facilities/sfo-01/recommendations/rec-17/decisions", {
    method: "POST",
    body: JSON.stringify({
      decision: "APPROVE",
      simulatedAt: SCENARIO_START_S,
      safetyEvaluationId: pass.body.id,
      command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 },
      note: "Approved as advisory only",
    }),
  });
  assert.equal(approval.status, 201);
  assert.equal(approval.body.payload.decision.outcome, "ALLOWED_AS_ADVISORY");

  const replayAttack = await request("/api/facilities/sfo-01/recommendations/rec-17/decisions", {
    method: "POST",
    body: JSON.stringify({
      decision: "APPROVE",
      simulatedAt: SCENARIO_START_S,
      safetyEvaluationId: pass.body.id,
      command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 },
    }),
  });
  assert.equal(replayAttack.status, 409);

  // A later disposition replaces the current one only once the caller confirms
  // which disposition it replaces. Every decision stays in the history.
  let alternativeAuditId: number | undefined;
  let currentDecisionId = approval.body.payload.decision.id as string;
  let currentDecision: string = "APPROVE";
  const statusFor = { REJECT: "REJECTED", DEFER: "DEFERRED", REQUEST_ALTERNATIVE: "ALTERNATIVE_REQUESTED" } as const;
  for (const decision of ["REJECT", "DEFER", "REQUEST_ALTERNATIVE"] as const) {
    const body = {
      decision,
      simulatedAt: SCENARIO_START_S + 300,
      command: { assetId: "cdu-03", flowPercent: decision === "REQUEST_ALTERNATIVE" ? 64 : 78, durationMinutes: 1 },
    };
    const unconfirmed = await request("/api/facilities/sfo-01/recommendations/rec-17/decisions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(unconfirmed.status, 409, `${decision} replaced a disposition without confirmation`);
    assert.equal(unconfirmed.body.code, "DISPOSITION_REPLACEMENT_REQUIRED");
    assert.equal(unconfirmed.body.currentDecision.id, currentDecisionId);
    assert.equal(unconfirmed.body.currentDecision.decision, currentDecision);

    const result = await request("/api/facilities/sfo-01/recommendations/rec-17/decisions", {
      method: "POST",
      body: JSON.stringify({ ...body, replacesDecisionId: currentDecisionId }),
    });
    assert.equal(result.status, 201, `${decision} failed: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.payload.decision.replaces.decisionId, currentDecisionId);
    const status = await pool.query("SELECT status FROM recommendations WHERE id = 'rec-17'");
    assert.equal(status.rows[0].status, statusFor[decision], "status must show the latest disposition");
    currentDecisionId = result.body.payload.decision.id;
    currentDecision = decision;
    if (decision === "REQUEST_ALTERNATIVE") alternativeAuditId = result.body.id;
  }

  const staleReplacement = await request("/api/facilities/sfo-01/recommendations/rec-17/decisions", {
    method: "POST",
    body: JSON.stringify({
      decision: "REJECT",
      simulatedAt: SCENARIO_START_S + 300,
      command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 1 },
      replacesDecisionId: approval.body.payload.decision.id,
    }),
  });
  assert.equal(staleReplacement.status, 409, "a stale confirmation must not overwrite a newer disposition");
  assert.equal(staleReplacement.body.currentDecision.id, currentDecisionId);
  const history = await pool.query(
    "SELECT decision FROM operator_decisions WHERE user_id = $1 AND recommendation_id = 'rec-17' ORDER BY created_at",
    [userId],
  );
  assert.deepEqual(
    history.rows.map((row) => row.decision),
    ["APPROVE", "REJECT", "DEFER", "REQUEST_ALTERNATIVE"],
    "replaced dispositions must remain in the history",
  );

  const filtered = await request("/api/facilities/sfo-01/audit?decision=DEFER");
  assert.equal(filtered.status, 200);
  assert(filtered.body.length >= 1);
  assert(filtered.body.every((record: any) => record.payload.decision.decision === "DEFER"));

  const detail = await request(`/api/facilities/sfo-01/audit/${approval.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.snapshot.simulatedAt, SCENARIO_START_S);
  assert.equal(detail.body.model.version, "sfo-rom-1.0.0");
  assert.equal(detail.body.safetyEvaluation.outcome, "PASS");
  assert.equal(detail.body.decision.note, "Approved as advisory only");
  for (const invalidId of ["not-a-number", "1.5", "0", "-1", "99999999999999999999"]) {
    const invalid = await request(`/api/facilities/sfo-01/audit/${invalidId}`);
    assert.equal(invalid.status, 404, `audit id ${invalidId} returned ${invalid.status}, expected 404`);
  }

  const legacyInsert = await pool.query(
    `INSERT INTO audit_records
       (organization_id, facility_id, user_id, action, scenario_id, simulated_at, model_version, model_version_id, payload)
     VALUES ('wattr-demo', 'sfo-01', $1, 'DECISION_APPROVE', 'gpu-training-ramp-v1', $2, 'sfo-rom-1.0.0', 'sfo-rom-1.0.0', $3)
     RETURNING id`,
    [userId, SCENARIO_START_S + 300, { recommendationId: "rec-17", outcome: "ALLOWED_AS_ADVISORY" }],
  );
  const legacyDetail = await request(`/api/facilities/sfo-01/audit/${legacyInsert.rows[0].id}`);
  assert.equal(legacyDetail.status, 200);
  assert.equal(legacyDetail.body.reconstructionSource, "REPLAYED_LEGACY");
  assert.equal(legacyDetail.body.snapshot.simulatedAt, SCENARIO_START_S + 300);

  assert(alternativeAuditId);
  const alternativeDetail = await request(`/api/facilities/sfo-01/audit/${alternativeAuditId}`);
  assert.equal(alternativeDetail.status, 200);
  assert.equal(alternativeDetail.body.decision.command.flowPercent, 64);
  assert.equal(alternativeDetail.body.decision.command.durationMinutes, 1);
  assert.equal(alternativeDetail.body.safetyEvaluation.command.flowPercent, 64);
  assert.equal(alternativeDetail.body.safetyEvaluation.command.durationMinutes, 1);
  assert.equal(alternativeDetail.body.snapshot.recommendation.flowPercent, 64);
  assert.equal(alternativeDetail.body.snapshot.recommendation.durationMinutes, 1);
  assert.equal(alternativeDetail.body.snapshot.recommendation.command.flowPercent, 64);
  assert.equal(alternativeDetail.body.snapshot.recommendation.command.durationMinutes, 1);

  await assert.rejects(
    pool.query("UPDATE audit_records SET action = 'ALTERED' WHERE id = $1", [approval.body.id]),
    /immutable/,
  );
  await assert.rejects(
    pool.query("DELETE FROM operator_decisions WHERE id = $1", [approval.body.payload.decision.id]),
    /immutable/,
  );
  await assert.rejects(pool.query("TRUNCATE audit_records"), /immutable/);
  await assert.rejects(pool.query("TRUNCATE operator_decisions"), /immutable/);
  console.log("Decision workflow series, alternatives, safety, replay defense, dispositions, filtering, reconstruction, and immutability tests passed.");
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await cleanup();
  await pool.end();
}