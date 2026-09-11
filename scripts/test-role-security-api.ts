import { spawn } from "node:child_process";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { ROLES, type Role } from "../src/lib/security/rolePolicy";
import { availableTestPort } from "./test-port";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prefix = `api-security-${randomUUID().slice(0, 8)}`;
const users = new Map<Role, string>(ROLES.map((role) => [role, `${prefix}-${role.toLowerCase()}`]));
const adminId = `${prefix}-admin`;
const targetId = `${prefix}-target`;
const outsiderId = `${prefix}-outsider`;
const outsiderOrganizationId = `${prefix}-organization`;
const port = await availableTestPort();
const baseUrl = `http://127.0.0.1:${port}`;

async function request(userId: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "x-test-user-id": userId, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, body };
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [role, userId] of users) {
      await client.query("INSERT INTO users (id, display_name) VALUES ($1, $2)", [userId, role]);
      await client.query(
        "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, 'wattr-demo', $2)",
        [userId, role],
      );
      await client.query(
        `INSERT INTO facility_permissions
           (user_id, facility_id, can_view, can_operate, can_edit_model)
         VALUES ($1, 'sfo-01', true, true, true)`,
        [userId],
      );
    }
    await client.query("INSERT INTO users (id, display_name) VALUES ($1, 'Test administrator')", [adminId]);
    await client.query(
      "INSERT INTO memberships (user_id, organization_id, role, is_admin) VALUES ($1, 'wattr-demo', 'VIEWER', true)",
      [adminId],
    );
    await client.query("INSERT INTO users (id, display_name) VALUES ($1, 'Outsider')", [outsiderId]);
    await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Outsider organization')", [outsiderOrganizationId]);
    await client.query(
      "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'MODEL_ADMIN')",
      [outsiderId, outsiderOrganizationId],
    );
    await client.query(
      `INSERT INTO facility_permissions
         (user_id, facility_id, can_view, can_operate, can_edit_model)
       VALUES ($1, 'sfo-01', true, true, true)`,
      [outsiderId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Test cleanup deliberately bypasses the immutable trigger after the test
    // has separately proved ordinary updates/deletes are rejected.
    await client.query("ALTER TABLE administrative_audit_records DISABLE TRIGGER administrative_audit_records_immutable");
    await client.query(
      "DELETE FROM administrative_audit_records WHERE actor_user_id = $1 OR target_user_id = $2",
      [adminId, targetId],
    );
    await client.query("ALTER TABLE administrative_audit_records ENABLE TRIGGER administrative_audit_records_immutable");
    await client.query("DELETE FROM users WHERE id LIKE $1", [`${prefix}%`]);
    await client.query("DELETE FROM organizations WHERE id = $1", [outsiderOrganizationId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

await seed();
// Start without a Clerk secret key: public routes must not depend on Clerk.
const serverEnv = { ...process.env, NODE_ENV: "test", PORT: String(port) };
delete serverEnv.CLERK_SECRET_KEY;
const server = spawn("node_modules/.bin/tsx", ["server/index.ts"], {
  env: serverEnv,
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

  // Without Clerk configured, public pages still load and protected routes fail closed.
  const landing = await fetch(`${baseUrl}/`);
  if (landing.status !== 200) throw new Error(`Landing page depends on Clerk: ${landing.status}`);
  const anonymous = await fetch(`${baseUrl}/api/me`);
  if (anonymous.status !== 401) throw new Error(`Unauthenticated API request without Clerk returned ${anonymous.status}, expected 401`);

  for (const role of ROLES) {
    const userId = users.get(role)!;
    const facilities = await request(userId, "/api/facilities");
    if (facilities.status !== 200 || !Array.isArray(facilities.body) || facilities.body.length !== 1) {
      throw new Error(`${role} did not receive its authorized facility`);
    }
    const context = await request(userId, "/api/facilities/sfo-01/context");
    if (context.status !== 200) throw new Error(`${role} could not read authorized facility context: ${context.status} ${JSON.stringify(context.body)} ${stderr}`);
    const model = await request(userId, "/api/facilities/sfo-01/model/versions");
    if (model.status !== (role === "MODEL_ADMIN" ? 200 : 404)) throw new Error(`${role} model policy failed`);
    const topology = await request(userId, "/api/facilities/sfo-01/topology");
    if (topology.status !== (["OPERATOR", "ENGINEER", "MODEL_ADMIN"].includes(role) ? 200 : 404)) throw new Error(`${role} topology policy failed`);
    const evaluation = await request(userId, "/api/facilities/sfo-01/recommendations/rec-17/evaluate", {
      method: "POST",
      body: JSON.stringify({ simulatedAt: 1752676800 }),
    });
    if (evaluation.status !== (["PORTFOLIO_MANAGER", "OPERATOR", "ENGINEER", "MODEL_ADMIN", "VIEWER"].includes(role) ? 201 : 404)) {
      throw new Error(`${role} assistant-action policy failed`);
    }
  }

  // Facility Builder: for now every role with a view grant can save, validate,
  // publish and roll back a build. The published model is restored afterwards,
  // even if a check fails, so later suites still run on the reference model.
  const facilityBefore = await pool.query("SELECT model_version FROM facilities WHERE id = 'sfo-01'");
  const originalModelVersion: string = facilityBefore.rows[0].model_version;
  const createdVersions: string[] = [];
  // The scenario incident and recommendation, as Operations and Safety Shield read them.
  const scenarioRecordsQuery = `
    SELECT r.title, r.rationale, r.command, r.explanation, r.evidence, r.model_version_id, r.version, r.status,
           i.title AS incident_title, i.affected_assets, i.likely_cause, i.correlated_signals,
           i.thermal_path, i.deduplication_key, i.model_version_id AS incident_model_version_id
    FROM recommendations r JOIN incidents i ON i.id = r.incident_id
    WHERE r.id = 'rec-17'`;
  try {
    const { FACILITY_TEMPLATES, SFO_01_LAYOUT } = await import("../src/lib/facility/templates");
    const seededRecords = (await pool.query(scenarioRecordsQuery)).rows[0];

    for (const role of ROLES) {
      const draft = await request(users.get(role)!, "/api/facilities/sfo-01/builds", {
        method: "POST",
        body: JSON.stringify({ name: `${role} build`, layout: SFO_01_LAYOUT }),
      });
      if (draft.status !== 201 || draft.body?.status !== "DRAFT") {
        throw new Error(`${role} could not save a draft build: ${draft.status} ${JSON.stringify(draft.body)}`);
      }
      createdVersions.push(draft.body.id);
    }

    const builder = users.get("VIEWER")!;
    const buildId = createdVersions[createdVersions.length - 1];
    const listing = await request(builder, "/api/facilities/sfo-01/builds");
    if (
      listing.status !== 200 ||
      listing.body?.published?.reference !== true ||
      listing.body.published.layout?.items?.length !== SFO_01_LAYOUT.items.length ||
      !listing.body.versions?.some((version: any) => version.id === buildId && version.hasLayout)
    ) {
      throw new Error(`Builds listing did not describe the reference layout and saved drafts: ${JSON.stringify(listing.body)}`);
    }

    const malformed = await request(builder, "/api/facilities/sfo-01/builds", {
      method: "POST",
      body: JSON.stringify({ layout: { zones: [], items: "nope", connections: [] } }),
    });
    if (malformed.status !== 400) throw new Error(`A malformed build was accepted: ${malformed.status}`);

    const miswiredLayout = structuredClone(SFO_01_LAYOUT);
    miswiredLayout.connections.push({ id: "link-chiller-rack", fromId: "chiller-01", toId: "rack-a01" });
    const miswired = await request(builder, "/api/facilities/sfo-01/builds", {
      method: "POST",
      body: JSON.stringify({ layout: miswiredLayout }),
    });
    if (miswired.status !== 201) throw new Error("A structurally valid draft could not be saved");
    createdVersions.push(miswired.body.id);
    const refused = await request(builder, `/api/facilities/sfo-01/builds/${miswired.body.id}/validate`, { method: "POST" });
    if (refused.status !== 409 || !refused.body?.findings?.some((finding: any) => /wiring rule/.test(finding.message))) {
      throw new Error(`A miswired build passed validation: ${refused.status} ${JSON.stringify(refused.body)}`);
    }

    const validated = await request(builder, `/api/facilities/sfo-01/builds/${buildId}/validate`, { method: "POST" });
    if (validated.status !== 200 || validated.body?.status !== "VALIDATED") {
      throw new Error(`A sound build did not validate: ${validated.status} ${JSON.stringify(validated.body)}`);
    }
    const published = await request(builder, `/api/facilities/sfo-01/builds/${buildId}/publish`, { method: "POST" });
    if (published.status !== 200) throw new Error(`A validated build did not publish: ${JSON.stringify(published.body)}`);
    const operations = await request(builder, "/api/facilities");
    if (
      operations.body?.[0]?.model_version !== buildId ||
      operations.body[0].model_config?.layout?.items?.length !== SFO_01_LAYOUT.items.length
    ) {
      throw new Error("Operations did not receive the published build");
    }
    // Compared structurally: jsonb does not keep object keys in the order they were written.
    const { isDeepStrictEqual } = await import("node:util");
    const loaded = await request(builder, `/api/facilities/sfo-01/builds/${buildId}`);
    if (loaded.status !== 200 || !isDeepStrictEqual(loaded.body?.layout, SFO_01_LAYOUT)) {
      throw new Error(`A saved build did not load back unchanged: ${JSON.stringify(loaded.body?.layout).slice(0, 300)}`);
    }
    const reboundToBuild = (await pool.query(scenarioRecordsQuery)).rows[0];
    if (
      reboundToBuild.model_version_id !== buildId ||
      reboundToBuild.incident_model_version_id !== buildId ||
      reboundToBuild.version !== seededRecords.version + 1 ||
      reboundToBuild.status !== "PROPOSED"
    ) {
      throw new Error(`Publishing a build did not rebind the scenario incident and recommendation: ${JSON.stringify(reboundToBuild)}`);
    }

    const studioDraft = await request(users.get("MODEL_ADMIN")!, "/api/facilities/sfo-01/model/versions", {
      method: "POST",
      body: JSON.stringify({ config: { scenario: "gpu-training-ramp-v1", seed: 4103, thermalMass: 0.9, responseLag: 12 } }),
    });
    if (studioDraft.status !== 201 || studioDraft.body?.config?.layout?.items?.length !== SFO_01_LAYOUT.items.length) {
      throw new Error(`A Model Studio draft dropped the published build's layout: ${JSON.stringify(studioDraft.body)}`);
    }
    createdVersions.push(studioDraft.body.id);

    // A build with different equipment: advice, Safety Shield and what-if move to its CRAC unit.
    const airLayout = FACILITY_TEMPLATES.find((template) => template.id === "air-cooled-rows")!.layout;
    const airDraft = await request(builder, "/api/facilities/sfo-01/builds", {
      method: "POST",
      body: JSON.stringify({ name: "Air-cooled rows", layout: airLayout }),
    });
    if (airDraft.status !== 201) throw new Error(`The air-cooled template could not be saved: ${JSON.stringify(airDraft.body)}`);
    createdVersions.push(airDraft.body.id);
    const airValidated = await request(builder, `/api/facilities/sfo-01/builds/${airDraft.body.id}/validate`, { method: "POST" });
    const airPublished = await request(builder, `/api/facilities/sfo-01/builds/${airDraft.body.id}/publish`, { method: "POST" });
    if (airValidated.status !== 200 || airPublished.status !== 200) {
      throw new Error(`The air-cooled template did not validate and publish: ${airValidated.status} ${airPublished.status} ${JSON.stringify(airValidated.body)}`);
    }
    const airRecords = (await pool.query(scenarioRecordsQuery)).rows[0];
    if (
      airRecords.model_version_id !== airDraft.body.id ||
      !/^crac-0[12]$/.test(airRecords.command?.assetId) ||
      !/^Pre-emptive CRAC-0[12] flow adjustment$/.test(airRecords.title) ||
      !/^CRAC-0[12] thermal response degradation$/.test(airRecords.incident_title)
    ) {
      throw new Error(`The scenario records did not follow the air-cooled build: ${JSON.stringify(airRecords)}`);
    }
    const operator = users.get("OPERATOR")!;
    const airEvaluation = await request(operator, "/api/facilities/sfo-01/recommendations/rec-17/evaluate", {
      method: "POST",
      body: JSON.stringify({ simulatedAt: 1752677400 }),
    });
    if (
      airEvaluation.status !== 201 ||
      airEvaluation.body?.command?.assetId !== airRecords.command.assetId ||
      airEvaluation.body?.modelVersionId !== airDraft.body.id
    ) {
      throw new Error(`Safety Shield did not evaluate the build's advisory: ${airEvaluation.status} ${JSON.stringify(airEvaluation.body)}`);
    }
    const wrongUnit = await request(operator, "/api/facilities/sfo-01/recommendations/rec-17/evaluate", {
      method: "POST",
      body: JSON.stringify({ simulatedAt: 1752677400, command: { assetId: "cdu-03", flowPercent: 78, durationMinutes: 20 } }),
    });
    if (wrongUnit.status !== 400) throw new Error(`An advisory for a unit the build does not advise was evaluated: ${wrongUnit.status}`);
    const airWhatIf = await request(operator, "/api/facilities/sfo-01/recommendations/rec-17/what-if", {
      method: "POST",
      body: JSON.stringify({ simulatedAt: 1752677400, command: { ...airRecords.command, flowPercent: 70 } }),
    });
    if (airWhatIf.status !== 200 || !airWhatIf.body?.sharedInputs?.events?.some((event: string) => /^CRAC-0[12] modeled response lag$/.test(event))) {
      throw new Error(`What-if did not run on the build's advised unit: ${airWhatIf.status} ${JSON.stringify(airWhatIf.body).slice(0, 300)}`);
    }

    const restored = await request(builder, "/api/facilities/sfo-01/builds/rollback", {
      method: "POST",
      body: JSON.stringify({ versionId: originalModelVersion }),
    });
    const afterRollback = await request(builder, "/api/facilities");
    if (restored.status !== 200 || afterRollback.body?.[0]?.model_version !== originalModelVersion) {
      throw new Error("Rolling back did not restore the original model");
    }
    const restoredRecords = (await pool.query(scenarioRecordsQuery)).rows[0];
    const recordContent = (row: Record<string, unknown>) => ({ ...row, version: undefined, status: undefined });
    if (!isDeepStrictEqual(recordContent(restoredRecords), recordContent(seededRecords)) || restoredRecords.status !== "PROPOSED") {
      throw new Error(`Restoring the reference model did not restore the seeded scenario records: ${JSON.stringify(restoredRecords)}`);
    }
  } finally {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE model_versions SET status = 'ARCHIVED' WHERE facility_id = 'sfo-01' AND status = 'PUBLISHED' AND id <> $1",
        [originalModelVersion],
      );
      await client.query("UPDATE model_versions SET status = 'PUBLISHED' WHERE id = $1", [originalModelVersion]);
      await client.query("UPDATE facilities SET model_version = $1 WHERE id = 'sfo-01'", [originalModelVersion]);
      if (createdVersions.length) {
        // A check that failed part-way can leave the scenario records bound to a
        // build; put them back on the original model before removing the builds.
        const { REFERENCE_SCENARIO_RECORDS } = await import("../src/lib/cockpit/scenarioRecords");
        const { incident, recommendation } = REFERENCE_SCENARIO_RECORDS;
        await client.query(
          "UPDATE scenarios SET model_version_id = $1 WHERE facility_id = 'sfo-01' AND model_version_id = ANY($2::text[])",
          [originalModelVersion, createdVersions],
        );
        await client.query(
          `UPDATE incidents
           SET model_version = $1, model_version_id = $1, model_config = (SELECT config FROM model_versions WHERE id = $1),
               title = $3, affected_assets = $4::jsonb, likely_cause = $5, correlated_signals = $6::jsonb,
               thermal_path = $7::jsonb, deduplication_key = $8
           WHERE facility_id = 'sfo-01' AND model_version_id = ANY($2::text[])`,
          [
            originalModelVersion, createdVersions, incident.title, JSON.stringify(incident.affectedAssets),
            incident.likelyCause, JSON.stringify(incident.correlatedSignals), JSON.stringify(incident.thermalPath),
            incident.deduplicationKey,
          ],
        );
        await client.query(
          `UPDATE recommendations
           SET model_version_id = $1, title = $3, rationale = $4, command = $5::jsonb, explanation = $6::jsonb, evidence = $7::jsonb
           WHERE facility_id = 'sfo-01' AND model_version_id = ANY($2::text[])`,
          [
            originalModelVersion, createdVersions, recommendation.title, recommendation.rationale,
            JSON.stringify(recommendation.command), JSON.stringify(recommendation.explanation), JSON.stringify(recommendation.evidence),
          ],
        );
        await client.query("DELETE FROM safety_evaluations WHERE model_version_id = ANY($1::text[])", [createdVersions]);
      }
      if (createdVersions.length) await client.query("DELETE FROM model_versions WHERE id = ANY($1::text[])", [createdVersions]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const deniedAdmin = await request(users.get("VIEWER")!, "/api/admin/memberships");
  if (deniedAdmin.status !== 403) throw new Error("Viewer reached organization administration");
  const createMember = await request(adminId, "/api/admin/memberships", {
    method: "POST",
    body: JSON.stringify({ userId: targetId, displayName: "Provisioned target", role: "OPERATOR" }),
  });
  if (createMember.status !== 201) throw new Error(`Administrator could not provision membership: ${JSON.stringify(createMember.body)}`);
  const grant = await request(adminId, `/api/admin/memberships/${targetId}/facilities/sfo-01`, {
    method: "PATCH",
    body: JSON.stringify({ canView: true, canOperate: true, canEditModel: false }),
  });
  if (grant.status !== 200) throw new Error("Administrator could not grant facility access");
  const targetFacilities = await request(targetId, "/api/facilities");
  if (targetFacilities.status !== 200 || targetFacilities.body?.[0]?.can_operate !== true) {
    throw new Error("Provisioned operator grant did not take effect");
  }
  const audit = await request(adminId, "/api/admin/audit");
  if (audit.status !== 200 || audit.body?.items?.filter((item: any) => item.target_user_id === targetId).length < 2) {
    throw new Error("Administrative changes were not traceable");
  }

  const outsider = await request(outsiderId, "/api/facilities");
  if (outsider.status !== 403) throw new Error("Cross-organization membership reached demo facilities");
  const viewer = users.get("VIEWER")!;
  const unknown = await request(viewer, "/api/facilities/not-a-facility/context");
  await pool.query("DELETE FROM facility_permissions WHERE user_id = $1 AND facility_id = 'sfo-01'", [viewer]);
  const revoked = await request(viewer, "/api/facilities/sfo-01/context");
  if (unknown.status !== revoked.status || JSON.stringify(unknown.body) !== JSON.stringify(revoked.body)) {
    throw new Error("Facility denial reveals whether a facility exists");
  }

  console.log("HTTP role, route, admin, audit, cross-organization, and revocation checks passed.");
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await cleanup();
  await pool.end();
}