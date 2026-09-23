-- Historical facility configuration events and isolated replay scenarios.
-- All records retain the historical model snapshot used to produce a result.

CREATE TABLE IF NOT EXISTS replay_change_events (
  id uuid PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  asset_id text,
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('MODEL_PUBLISH', 'MODEL_ROLLBACK', 'MODEL_CONFIGURATION')),
  change_type text NOT NULL CHECK (change_type IN ('MODEL_CONFIGURATION_CHANGED', 'RACK_RELOCATED', 'SUPPORTED_CONFIGURATION_CHANGED')),
  before_config jsonb NOT NULL,
  after_config jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS replay_change_events_facility_time_idx
  ON replay_change_events(facility_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS replay_change_events_facility_asset_time_idx
  ON replay_change_events(facility_id, asset_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS replay_datasets (
  id uuid PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  uploaded_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('UPLOADED_CSV', 'SYNTHETIC_DEMO')),
  source_name text NOT NULL CHECK (char_length(source_name) BETWEEN 1 AND 160),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  input_rows jsonb NOT NULL,
  validation jsonb NOT NULL,
  period_start_at bigint NOT NULL CHECK (period_start_at >= 0),
  period_end_at bigint NOT NULL CHECK (period_end_at >= period_start_at),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(facility_id, model_version_id, checksum)
);

CREATE INDEX IF NOT EXISTS replay_datasets_facility_created_idx
  ON replay_datasets(facility_id, created_at DESC);

CREATE TABLE IF NOT EXISTS replay_historical_scenarios (
  id uuid PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES replay_datasets(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  status text NOT NULL CHECK (status IN ('DRAFT', 'SAVED_FOR_REVIEW')),
  period_start_at bigint NOT NULL CHECK (period_start_at >= 0),
  period_end_at bigint NOT NULL CHECK (period_end_at >= period_start_at),
  historical_model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  baseline_model_config jsonb NOT NULL,
  relocation jsonb NOT NULL,
  assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_status text NOT NULL CHECK (validation_status IN ('VALID', 'INVALID')),
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS replay_historical_scenarios_facility_created_idx
  ON replay_historical_scenarios(facility_id, created_at DESC);

CREATE TABLE IF NOT EXISTS replay_historical_results (
  scenario_id uuid PRIMARY KEY REFERENCES replay_historical_scenarios(id) ON DELETE CASCADE,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  result jsonb NOT NULL,
  input_checksum text NOT NULL CHECK (input_checksum ~ '^[a-f0-9]{64}$'),
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS replay_historical_results_facility_generated_idx
  ON replay_historical_results(facility_id, generated_at DESC);

CREATE OR REPLACE FUNCTION replay_reject_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'replay history records are immutable';
END;
$$;

DROP TRIGGER IF EXISTS replay_change_events_immutable ON replay_change_events;
CREATE TRIGGER replay_change_events_immutable
BEFORE UPDATE OR DELETE ON replay_change_events
FOR EACH ROW EXECUTE FUNCTION replay_reject_immutable_mutation();
DROP TRIGGER IF EXISTS replay_change_events_no_truncate ON replay_change_events;
CREATE TRIGGER replay_change_events_no_truncate
BEFORE TRUNCATE ON replay_change_events
FOR EACH STATEMENT EXECUTE FUNCTION replay_reject_immutable_mutation();

DROP TRIGGER IF EXISTS replay_historical_scenarios_immutable ON replay_historical_scenarios;
CREATE TRIGGER replay_historical_scenarios_immutable
BEFORE UPDATE OR DELETE ON replay_historical_scenarios
FOR EACH ROW EXECUTE FUNCTION replay_reject_immutable_mutation();
DROP TRIGGER IF EXISTS replay_historical_scenarios_no_truncate ON replay_historical_scenarios;
CREATE TRIGGER replay_historical_scenarios_no_truncate
BEFORE TRUNCATE ON replay_historical_scenarios
FOR EACH STATEMENT EXECUTE FUNCTION replay_reject_immutable_mutation();

DROP TRIGGER IF EXISTS replay_datasets_immutable ON replay_datasets;
CREATE TRIGGER replay_datasets_immutable
BEFORE UPDATE OR DELETE ON replay_datasets
FOR EACH ROW EXECUTE FUNCTION replay_reject_immutable_mutation();
DROP TRIGGER IF EXISTS replay_datasets_no_truncate ON replay_datasets;
CREATE TRIGGER replay_datasets_no_truncate
BEFORE TRUNCATE ON replay_datasets
FOR EACH STATEMENT EXECUTE FUNCTION replay_reject_immutable_mutation();

DROP TRIGGER IF EXISTS replay_historical_results_immutable ON replay_historical_results;
CREATE TRIGGER replay_historical_results_immutable
BEFORE UPDATE OR DELETE ON replay_historical_results
FOR EACH ROW EXECUTE FUNCTION replay_reject_immutable_mutation();
DROP TRIGGER IF EXISTS replay_historical_results_no_truncate ON replay_historical_results;
CREATE TRIGGER replay_historical_results_no_truncate
BEFORE TRUNCATE ON replay_historical_results
FOR EACH STATEMENT EXECUTE FUNCTION replay_reject_immutable_mutation();