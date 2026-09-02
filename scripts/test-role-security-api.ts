import { spawn } from "node:child_process";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { ROLES, type Role } from "../src/lib/security/rolePolicy";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prefix = `api-security-${randomUUID().slice(0, 8)}`;
const users = new Map<Role, string>(ROLES.map((role) => [role, `${prefix}-${role.toLowerCase()}`]));
const adminId = `${prefix}-admin`;
const targetId = `${prefix}-target`;
const outsiderId = `${prefix}-outsider`;
const outsiderOrganizationId = `${prefix}-organization`;
const port = 5001;
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
    if (topology.status !== (["OPERATOR", "ENGINEER"].includes(role) ? 200 : 404)) throw new Error(`${role} topology policy failed`);
    const evaluation = await request(userId, "/api/facilities/sfo-01/recommendations/rec-17/evaluate", {
      method: "POST",
      body: JSON.stringify({ simulatedAt: 1752676800 }),
    });
    if (evaluation.status !== (["PORTFOLIO_MANAGER", "OPERATOR", "ENGINEER"].includes(role) ? 201 : 404)) {
      throw new Error(`${role} assistant-action policy failed`);
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