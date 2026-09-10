import pg from "pg";

const userId = process.env.WATTR_OWNER_USER_ID;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!userId || userId.length < 2 || userId.length > 200) {
  throw new Error("Set WATTR_OWNER_USER_ID to the trusted Clerk user ID before provisioning.");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const organization = await client.query(
    "SELECT owner_user_id FROM organizations WHERE id = 'wattr-demo' FOR UPDATE",
  );
  if (!organization.rows[0]) throw new Error("The Wattr demo organization is not provisioned.");
  if (organization.rows[0].owner_user_id && organization.rows[0].owner_user_id !== userId) {
    throw new Error("An organization owner is already provisioned. Ownership transfer requires an audited product workflow.");
  }
  await client.query(
    `INSERT INTO users (id, display_name) VALUES ($1, 'Wattr Owner')
     ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
    [userId],
  );
  await client.query("INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
  await client.query(
    `INSERT INTO memberships (user_id, organization_id, role, is_admin)
     VALUES ($1, 'wattr-demo', 'MODEL_ADMIN', true)
     ON CONFLICT (user_id, organization_id) DO UPDATE SET is_admin = true`,
    [userId],
  );
  await client.query(
    `INSERT INTO facility_permissions
       (user_id, facility_id, can_view, can_operate, can_edit_model)
     SELECT $1, id, true, true, true FROM facilities WHERE organization_id = 'wattr-demo'
     ON CONFLICT (user_id, facility_id) DO UPDATE SET
       can_view = true, can_operate = true, can_edit_model = true`,
    [userId],
  );
  await client.query(
    "UPDATE organizations SET owner_user_id = $1 WHERE id = 'wattr-demo'",
    [userId],
  );
  await client.query("COMMIT");
  console.log("Trusted Wattr organization owner provisioned.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}