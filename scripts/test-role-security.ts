import pg from "pg";
import { randomUUID } from "node:crypto";
import { ROLE_CAPABILITIES, ROLES, type Capability, type Role } from "../src/lib/security/rolePolicy";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const prefix = `security-test-${randomUUID().slice(0, 8)}`;

async function allowed(userId: string, capability: Capability) {
  const result = await client.query(
    `SELECT 1
     FROM facility_permissions p
     JOIN facilities f ON f.id = p.facility_id
     JOIN memberships m ON m.organization_id = f.organization_id AND m.user_id = p.user_id
     WHERE p.user_id = $1 AND p.facility_id = 'sfo-01' AND f.organization_id = 'wattr-demo'
       AND (
         ($2 = 'view' AND p.can_view)
         OR ($2 = 'operate' AND p.can_operate AND m.role = 'OPERATOR')
         OR ($2 = 'engineer' AND p.can_view AND m.role = 'ENGINEER')
         OR ($2 = 'model' AND p.can_edit_model AND m.role = 'MODEL_ADMIN')
          OR ($2 = 'assistant' AND p.can_view AND m.role IN ('PORTFOLIO_MANAGER', 'OPERATOR', 'ENGINEER', 'MODEL_ADMIN', 'VIEWER'))
       )`,
    [userId, capability],
  );
  return Boolean(result.rowCount);
}

try {
  await client.query("BEGIN");
  const roleUsers = new Map<Role, string>();
  for (const role of ROLES) {
    const userId = `${prefix}-${role.toLowerCase()}`;
    roleUsers.set(role, userId);
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

  for (const role of ROLES) {
    const userId = roleUsers.get(role)!;
    for (const capability of ["view", "operate", "engineer", "model", "assistant"] as Capability[]) {
      const actual = await allowed(userId, capability);
      const expected = ROLE_CAPABILITIES[role][capability];
      if (actual !== expected) throw new Error(`${role} ${capability}: expected ${expected}, received ${actual}`);
    }
  }

  const outsider = `${prefix}-outsider`;
  const outsiderOrganization = `${prefix}-organization`;
  await client.query("INSERT INTO users (id, display_name) VALUES ($1, 'Outsider')", [outsider]);
  await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Isolation test')", [outsiderOrganization]);
  await client.query(
    "INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'MODEL_ADMIN')",
    [outsider, outsiderOrganization],
  );
  await client.query(
    `INSERT INTO facility_permissions
       (user_id, facility_id, can_view, can_operate, can_edit_model)
     VALUES ($1, 'sfo-01', true, true, true)`,
    [outsider],
  );
  if (await allowed(outsider, "view")) throw new Error("Cross-organization permission leaked facility access");

  const operator = roleUsers.get("OPERATOR")!;
  await client.query("DELETE FROM facility_permissions WHERE user_id = $1 AND facility_id = 'sfo-01'", [operator]);
  if (await allowed(operator, "view")) throw new Error("Revoked facility permission remained effective");

  const engineer = roleUsers.get("ENGINEER")!;
  await client.query(
    "UPDATE memberships SET role = 'VIEWER' WHERE user_id = $1 AND organization_id = 'wattr-demo'",
    [engineer],
  );
  if (await allowed(engineer, "engineer") || await allowed(engineer, "operate") || await allowed(engineer, "model")) {
    throw new Error("Role change did not take effect immediately");
  }

  const auditId = randomUUID();
  await client.query(
    `INSERT INTO administrative_audit_records
       (id, organization_id, actor_user_id, target_user_id, action, payload)
     VALUES ($1, 'wattr-demo', $2, $2, 'IMMUTABILITY_TEST', '{}'::jsonb)`,
    [auditId, roleUsers.get("MODEL_ADMIN")],
  );
  await client.query("SAVEPOINT immutable_update");
  try {
    await client.query("UPDATE administrative_audit_records SET action = 'ALTERED' WHERE id = $1", [auditId]);
    throw new Error("Administrative audit update unexpectedly succeeded");
  } catch (error) {
    if (error instanceof Error && error.message === "Administrative audit update unexpectedly succeeded") throw error;
    await client.query("ROLLBACK TO SAVEPOINT immutable_update");
  }
  await client.query("SAVEPOINT immutable_delete");
  try {
    await client.query("DELETE FROM administrative_audit_records WHERE id = $1", [auditId]);
    throw new Error("Administrative audit delete unexpectedly succeeded");
  } catch (error) {
    if (error instanceof Error && error.message === "Administrative audit delete unexpectedly succeeded") throw error;
    await client.query("ROLLBACK TO SAVEPOINT immutable_delete");
  }

  console.log("Role matrix, isolation, revocation, role-change, and immutable-audit checks passed.");
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}