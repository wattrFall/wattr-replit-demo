import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  SCENARIO_START_S,
  SCENARIO_DURATION_S,
  createCockpitSimulation,
  advanceCockpitSimulation,
  snapshotForAudit,
} from "../src/lib/cockpit/simulation";
import { assertModelConfig, CONTRACT_VERSION } from "../src/lib/cockpit/contracts";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to provision the Wattr schema.");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrations = [
    { version: "0001_baseline", file: new URL("../database/schema.sql", import.meta.url) },
    // Preserve the historical association: early task-6 builds recorded this
    // version after replaying the clean-schema bootstrap.
    {
      version: "0002_canonical_contracts",
      file: new URL("../database/schema.sql", import.meta.url),
    },
    {
      version: "0002_canonical_indexes",
      file: new URL("../database/migrations/0002_canonical_indexes.sql", import.meta.url),
    },
    // Never reuse an applied version. This new gate converges legacy table
    // types and constraints even when both earlier 0002 markers are present.
    {
      version: "0003_canonical_completion_gates",
      file: new URL("../database/migrations/0002_canonical_contracts.sql", import.meta.url),
    },
    {
      version: "0004_role_security",
      file: new URL("../database/migrations/0004_role_security.sql", import.meta.url),
    },
    {
      version: "0005_immutable_administrative_audit",
      file: new URL("../database/migrations/0005_immutable_administrative_audit.sql", import.meta.url),
    },
    {
      version: "0006_decision_workflow",
      file: new URL("../database/migrations/0006_decision_workflow.sql", import.meta.url),
    },
    {
      version: "0007_decision_history_hardening",
      file: new URL("../database/migrations/0007_decision_history_hardening.sql", import.meta.url),
    },
    {
      version: "0008_product_learning",
      file: new URL("../database/migrations/0008_product_learning.sql", import.meta.url),
    },
    {
      version: "0009_product_learning_retention",
      file: new URL("../database/migrations/0009_product_learning_retention.sql", import.meta.url),
    },
    {
      version: "0010_product_learning_privacy",
      file: new URL("../database/migrations/0010_product_learning_privacy.sql", import.meta.url),
    },
    {
      version: "0011_guided_tutorial_progress",
      file: new URL("../database/migrations/0011_guided_tutorial_progress.sql", import.meta.url),
    },
    {
      version: "0012_role_scoped_tutorial_progress",
      file: new URL("../database/migrations/0012_role_scoped_tutorial_progress.sql", import.meta.url),
    },
  ];

  for (const migration of migrations) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [migration.version]);
    if (applied.rowCount) continue;
    const sql = await readFile(migration.file, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // Checkpoints are sparse by design. They retain enough state to inspect a
  // known point, while replayCockpitSnapshot remains the source of truth for
  // high-frequency telemetry between checkpoints.
  const seededModel = await pool.query(
    `SELECT mv.config, s.seed, s.simulated_start_at, s.duration_s
     FROM model_versions mv JOIN scenarios s ON s.model_version_id = mv.id
     WHERE mv.id = 'sfo-rom-1.0.0' AND s.id = 'gpu-training-ramp-v1'`,
  );
  if (!seededModel.rows[0]) throw new Error("Canonical SFO-01 model and scenario seed are missing");
  const modelConfig = seededModel.rows[0].config;
  assertModelConfig(modelConfig);
  if (modelConfig.seed !== seededModel.rows[0].seed ||
      Number(seededModel.rows[0].simulated_start_at) !== SCENARIO_START_S ||
      seededModel.rows[0].duration_s !== SCENARIO_DURATION_S) {
    throw new Error("Canonical SFO-01 scenario does not match its persisted model contract");
  }

  const checkpointSeconds = [0, 300, 900, SCENARIO_DURATION_S];
  for (const elapsedS of checkpointSeconds) {
    const simulation = advanceCockpitSimulation(
      createCockpitSimulation(SCENARIO_START_S, modelConfig),
      elapsedS,
      SCENARIO_START_S,
      modelConfig,
    );
    await pool.query(
      `INSERT INTO replay_checkpoints
        (id, facility_id, scenario_id, simulated_at, elapsed_s, state, model_version_id,
         provenance, synthetic_status, quality)
       VALUES ($1, 'sfo-01', 'gpu-training-ramp-v1', $2, $3, $4::jsonb,
               'sfo-rom-1.0.0', 'SIMULATED', 'SYNTHETIC', 'GOOD')
       ON CONFLICT (scenario_id, simulated_at, model_version_id)
       DO UPDATE SET state = EXCLUDED.state, elapsed_s = EXCLUDED.elapsed_s`,
      [
        `checkpoint-gpu-training-ramp-${elapsedS}`,
        SCENARIO_START_S + elapsedS,
        elapsedS,
        JSON.stringify({
          contractVersion: CONTRACT_VERSION,
          snapshot: snapshotForAudit(simulation.snapshot),
          thermal: simulation.thermal,
        }),
      ],
    );

    await pool.query(
      `INSERT INTO forecasts
        (id, facility_id, scenario_id, simulated_at, horizon_s, baseline_peak_c, advisory_peak_c,
         baseline_constraint_minutes, advisory_constraint_minutes, risk, model_version_id,
         provenance, synthetic_status, quality)
       VALUES ($1, 'sfo-01', 'gpu-training-ramp-v1', $2, $3, $4, $5, $6, $7, $8,
               'sfo-rom-1.0.0', 'SIMULATED', 'SYNTHETIC', 'GOOD')
       ON CONFLICT (scenario_id, simulated_at, model_version_id)
       DO UPDATE SET baseline_peak_c = EXCLUDED.baseline_peak_c,
         advisory_peak_c = EXCLUDED.advisory_peak_c,
         baseline_constraint_minutes = EXCLUDED.baseline_constraint_minutes,
         advisory_constraint_minutes = EXCLUDED.advisory_constraint_minutes,
         risk = EXCLUDED.risk`,
      [
        `forecast-gpu-training-ramp-${elapsedS}`,
        SCENARIO_START_S + elapsedS,
        simulation.snapshot.forecast.horizonS,
        simulation.snapshot.forecast.baselinePeakC,
        simulation.snapshot.forecast.advisoryPeakC,
        simulation.snapshot.forecast.baselineConstraintMinutes,
        simulation.snapshot.forecast.advisoryConstraintMinutes,
        simulation.snapshot.forecast.risk.toUpperCase(),
      ],
    );
  }
  console.log("Wattr database schema, migrations, and canonical seed are ready.");
} finally {
  await pool.end();
}