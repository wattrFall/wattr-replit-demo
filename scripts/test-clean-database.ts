import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const schema = `release_clean_${randomUUID().replace(/-/g, "")}`;
const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await adminPool.query(`CREATE SCHEMA "${schema}"`);
const isolatedUrl = new URL(process.env.DATABASE_URL);
isolatedUrl.searchParams.set("options", `-c search_path=${schema},public`);
const setup = spawnSync("node_modules/.bin/tsx", ["scripts/setup-database.ts"], {
  env: { ...process.env, DATABASE_URL: isolatedUrl.toString() },
  encoding: "utf8",
});
if (setup.status !== 0) {
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminPool.end();
  throw new Error(`Clean bootstrap failed:\n${setup.stdout}\n${setup.stderr}`);
}

const pool = new pg.Pool({ connectionString: isolatedUrl.toString() });
const client = await pool.connect();
try {
  const counts = await client.query(`
    SELECT
      (SELECT count(*)::int FROM organizations) AS organizations,
      (SELECT count(*)::int FROM facilities) AS facilities,
      (SELECT count(*)::int FROM model_versions) AS models,
      (SELECT count(*)::int FROM scenarios) AS scenarios,
      (SELECT count(*)::int FROM assets) AS assets,
      (SELECT count(*)::int FROM incidents) AS incidents,
      (SELECT count(*)::int FROM recommendations) AS recommendations,
      (SELECT count(*)::int FROM replay_checkpoints) AS checkpoints,
      (SELECT count(*)::int FROM forecasts) AS forecasts,
      (SELECT count(*)::int FROM schema_migrations) AS migrations
  `);
  assert.deepEqual(counts.rows[0], {
    organizations: 1,
    facilities: 1,
    models: 1,
    scenarios: 1,
    assets: 8,
    incidents: 1,
    recommendations: 1,
    checkpoints: 4,
    forecasts: 4,
    migrations: 13,
  });

  const triggers = await client.query(`
    SELECT tgname
    FROM pg_trigger
    WHERE tgrelid IN ('administrative_audit_records'::regclass, 'audit_records'::regclass,
                      'operator_decisions'::regclass)
      AND NOT tgisinternal
    ORDER BY tgname
  `);
  assert.deepEqual(
    triggers.rows.map((row) => row.tgname),
    [
      "administrative_audit_records_immutable",
      "audit_records_immutable",
      "audit_records_no_truncate",
      "operator_decisions_immutable",
      "operator_decisions_no_truncate",
    ],
  );
} finally {
  client.release();
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminPool.end();
}

console.log("Clean-database schema, seed, foreign-key, and immutability startup checks passed.");