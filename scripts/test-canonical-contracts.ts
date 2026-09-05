import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  CONTRACT_VERSION,
  assertModelConfig,
  isCanonicalId,
  isFiniteQuantity,
  isScenarioTimestamp,
  provenanceForRecord,
  quantity,
  syntheticProvenance,
} from "../src/lib/cockpit/contracts";
import {
  DEFAULT_FACILITY_MODEL,
  SCENARIO_DURATION_S,
  SCENARIO_START_S,
  replayCockpitSnapshot,
  snapshotForAudit,
} from "../src/lib/cockpit/simulation";

assert.equal(CONTRACT_VERSION, "wattr.contracts.v1");
assert(isCanonicalId("gpu-training-ramp-v1"));
assert(!isCanonicalId("GPU Training Ramp"));
assert(isScenarioTimestamp(SCENARIO_START_S, SCENARIO_START_S, SCENARIO_DURATION_S));
assert(!isScenarioTimestamp(SCENARIO_START_S - 1, SCENARIO_START_S, SCENARIO_DURATION_S));
assert.doesNotThrow(() => assertModelConfig(DEFAULT_FACILITY_MODEL));
assert.throws(() => assertModelConfig({ ...DEFAULT_FACILITY_MODEL, responseLag: 0 }));
assert(isFiniteQuantity(quantity(2160, "kW"), "kW"));
assert.equal(syntheticProvenance().syntheticStatus, "SYNTHETIC");
assert.deepEqual(
  provenanceForRecord({
    provenance: "SIMULATED",
    synthetic_status: "SYNTHETIC",
    created_at: "2026-09-02T00:00:00.000Z",
    model_version_id: "sfo-rom-1.0.0",
  }),
  {
    kind: "SIMULATED",
    syntheticStatus: "SYNTHETIC",
    source: "Wattr deterministic simulation",
    sourceRevision: "sfo-rom-1.0.0",
    generatedAt: "2026-09-02T00:00:00.000Z",
  },
);
assert.doesNotThrow(() => JSON.stringify(snapshotForAudit(replayCockpitSnapshot(SCENARIO_START_S + 300))));

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for canonical contract tests");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const migrations = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(migrations.rows.map((row) => row.version), [
    "0001_baseline",
    "0002_canonical_contracts",
    "0002_canonical_indexes",
    "0003_canonical_completion_gates",
    "0004_role_security",
    "0005_immutable_administrative_audit",
    "0006_decision_workflow",
    "0007_decision_history_hardening",
    "0008_product_learning",
    "0009_product_learning_retention",
    "0010_product_learning_privacy",
    "0011_guided_tutorial_progress",
    "0012_role_scoped_tutorial_progress",
  ]);

  const counts = await pool.query(`
    SELECT
      (SELECT count(*)::integer FROM facility_hierarchy WHERE facility_id = 'sfo-01') AS hierarchy,
      (SELECT count(*)::integer FROM assets WHERE facility_id = 'sfo-01') AS assets,
      (SELECT count(*)::integer FROM sensors WHERE facility_id = 'sfo-01') AS sensors,
      (SELECT count(*)::integer FROM topology_edges WHERE facility_id = 'sfo-01') AS edges,
      (SELECT count(*)::integer FROM scenarios WHERE id = 'gpu-training-ramp-v1') AS scenarios,
      (SELECT count(*)::integer FROM forecasts WHERE scenario_id = 'gpu-training-ramp-v1') AS forecasts,
      (SELECT count(*)::integer FROM recommendations WHERE id = 'rec-17') AS recommendations,
      (SELECT count(*)::integer FROM replay_checkpoints WHERE scenario_id = 'gpu-training-ramp-v1') AS checkpoints
  `);
  const seeded = counts.rows[0];
  for (const key of ["hierarchy", "assets", "sensors", "edges", "scenarios", "forecasts", "recommendations", "checkpoints"]) {
    assert(seeded[key] > 0, `${key} must be seeded`);
  }
  assert(seeded.checkpoints < SCENARIO_DURATION_S, "replay checkpoints must remain sparse");

  const integrity = await pool.query(`
    SELECT
      bool_and(model_version_id = 'sfo-rom-1.0.0') AS one_model,
      bool_and(provenance = 'SIMULATED') AS simulated,
      bool_and(synthetic_status = 'SYNTHETIC') AS synthetic,
      bool_and(quality = 'GOOD') AS good
    FROM replay_checkpoints
    WHERE scenario_id = 'gpu-training-ramp-v1'
  `);
  assert.deepEqual(integrity.rows[0], {
    one_model: true,
    simulated: true,
    synthetic: true,
    good: true,
  });

  // This is the persisted query shape used by the canonical scenario snapshot
  // route. Keep scenario config and model config separately named so replay can
  // never validate or execute against the scenario metadata by accident.
  const snapshotContext = await pool.query(`
    SELECT s.id, s.simulated_start_at, s.duration_s, s.model_version_id,
           s.config AS scenario_config, mv.config AS model_config
    FROM scenarios s JOIN model_versions mv ON mv.id = s.model_version_id
    WHERE s.facility_id = 'sfo-01' AND s.id = 'gpu-training-ramp-v1'
  `);
  const routeScenario = snapshotContext.rows[0];
  assert(routeScenario);
  assertModelConfig(routeScenario.model_config);
  assert.equal(routeScenario.scenario_config.ratedCapacityKw, 2160);
  const endpointSnapshot = replayCockpitSnapshot(
    Number(routeScenario.simulated_start_at) + 300,
    routeScenario.model_config,
  );
  assert.equal(endpointSnapshot.simulatedAt, SCENARIO_START_S + 300);
  assert.equal(routeScenario.model_version_id, "sfo-rom-1.0.0");

  const telemetryTables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('telemetry', 'telemetry_ticks', 'sensor_readings')
  `);
  assert.equal(telemetryTables.rowCount, 0, "high-frequency telemetry must be reconstructed, not stored");

  const learningContracts = await pool.query(`
    SELECT
      to_regclass('public.product_learning_events') IS NOT NULL AS events,
      to_regclass('public.operator_test_sessions') IS NOT NULL AS sessions,
      to_regclass('public.product_feedback') IS NOT NULL AS feedback,
      to_regclass('public.product_learning_errors') IS NOT NULL AS errors,
      NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('product_feedback', 'operator_test_sessions')
          AND column_name IN ('comment', 'qualitative_feedback', 'abandonment_reason')
      ) AS no_free_text,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'product_learning_events'
          AND column_name = 'expires_at' AND is_nullable = 'NO'
      ) AS event_expiry
  `);
  assert.deepEqual(learningContracts.rows[0], {
    events: true,
    sessions: true,
    feedback: true,
    errors: true,
    no_free_text: true,
    event_expiry: true,
  });

  // Exercise the forward migration against the shape that existed before the
  // canonical release, including a recorded baseline version.
  const schemaName = `contract_upgrade_${process.pid}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}`);
    await client.query(`
      CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO schema_migrations(version) VALUES
        ('0001_baseline'), ('0002_canonical_contracts'), ('0002_canonical_indexes');
      CREATE TABLE organizations (id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE users (id text PRIMARY KEY, email text, display_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE memberships (user_id text NOT NULL REFERENCES users(id), organization_id text NOT NULL REFERENCES organizations(id), role text NOT NULL, PRIMARY KEY(user_id, organization_id));
      CREATE TABLE facilities (id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), name text NOT NULL, location text NOT NULL, model_version text NOT NULL, provenance text NOT NULL DEFAULT 'SIMULATED', created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE facility_permissions (user_id text NOT NULL REFERENCES users(id), facility_id text NOT NULL REFERENCES facilities(id), can_view boolean NOT NULL DEFAULT true, can_operate boolean NOT NULL DEFAULT false, can_edit_model boolean NOT NULL DEFAULT false, PRIMARY KEY(user_id, facility_id));
      CREATE TABLE user_preferences (user_id text PRIMARY KEY REFERENCES users(id), theme text NOT NULL DEFAULT 'system', tutorial_complete boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE model_versions (id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), status text NOT NULL, config jsonb NOT NULL DEFAULT '{}'::jsonb, published_at timestamptz, created_by text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE incidents (id text PRIMARY KEY, facility_id text NOT NULL REFERENCES facilities(id), title text NOT NULL, severity text NOT NULL, status text NOT NULL, simulated_at integer NOT NULL, affected_assets jsonb NOT NULL DEFAULT '[]'::jsonb, raw_signal_count integer NOT NULL DEFAULT 0, likely_cause text NOT NULL, forecast_minutes integer NOT NULL, model_version text NOT NULL DEFAULT 'sfo-rom-1.0.0', model_config jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE audit_records (id bigserial PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id), facility_id text NOT NULL REFERENCES facilities(id), user_id text NOT NULL REFERENCES users(id), action text NOT NULL, scenario_id text NOT NULL, simulated_at integer NOT NULL, model_version text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE safety_evaluations (id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), facility_id text NOT NULL REFERENCES facilities(id), recommendation_id text NOT NULL, simulated_at integer NOT NULL, outcome text NOT NULL, checks jsonb NOT NULL, model_version text NOT NULL DEFAULT 'sfo-rom-1.0.0', model_config jsonb NOT NULL DEFAULT '{}'::jsonb, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO organizations(id, name) VALUES ('wattr-demo', 'Wattr Demonstration');
      INSERT INTO facilities(id, organization_id, name, location, model_version) VALUES ('sfo-01', 'wattr-demo', 'SFO-01', 'San Francisco, CA', 'sfo-rom-1.0.0');
      INSERT INTO model_versions(id, facility_id, status, config) VALUES ('sfo-rom-1.0.0', 'sfo-01', 'PUBLISHED', '{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'::jsonb);
      INSERT INTO incidents(id, facility_id, title, severity, status, simulated_at, likely_cause, forecast_minutes)
        VALUES ('inc-204', 'sfo-01', 'Legacy incident', 'HIGH', 'OPEN', 1752677460, 'Legacy cause', 11);
    `);
    const canonicalSql = await readFile(new URL("../database/migrations/0002_canonical_contracts.sql", import.meta.url), "utf8");
    await client.query(canonicalSql);
    const upgraded = await client.query(`
      SELECT to_regclass('${schemaName}.assets') IS NOT NULL AS assets,
             to_regclass('${schemaName}.scenarios') IS NOT NULL AS scenarios,
             to_regclass('${schemaName}.replay_checkpoints') IS NOT NULL AS checkpoints
    `);
    assert.deepEqual(upgraded.rows[0], { assets: true, scenarios: true, checkpoints: true });

    const columns = await client.query(`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1
        AND (
          (table_name IN ('incidents','safety_evaluations','audit_records') AND column_name = 'simulated_at')
          OR (table_name IN ('incidents','safety_evaluations','audit_records') AND column_name = 'model_version_id')
          OR (table_name IN ('incidents','safety_evaluations','audit_records') AND column_name IN ('provenance','synthetic_status','quality'))
        )
      ORDER BY table_name, column_name
    `, [schemaName]);
    for (const row of columns.rows.filter((item) => item.column_name === "simulated_at")) {
      assert.equal(row.data_type, "bigint", `${row.table_name}.simulated_at must be bigint`);
    }
    for (const row of columns.rows.filter((item) => item.column_name === "model_version_id")) {
      assert.equal(row.is_nullable, "NO", `${row.table_name}.model_version_id must be required`);
    }
    assert.equal(columns.rows.length, 15, "every legacy workflow table must have canonical metadata");

    const constraints = await client.query(`
      SELECT conname
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1 AND conname IN (
        'incidents_scenario_id_fkey',
        'incidents_model_version_id_fkey',
        'safety_evaluations_recommendation_id_fkey',
        'safety_evaluations_model_version_id_fkey',
        'audit_records_model_version_id_fkey',
        'incidents_provenance_check',
        'safety_evaluations_provenance_check',
        'audit_records_provenance_check',
        'safety_evaluations_quality_check',
        'audit_records_quality_check'
      )
    `, [schemaName]);
    assert.equal(constraints.rowCount, 10, "legacy workflow tables must gain canonical FKs and checks");
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    client.release();
  }
} finally {
  await pool.end();
}

console.log("Canonical contract, migration, seed, unit, provenance, and serialization tests passed.");