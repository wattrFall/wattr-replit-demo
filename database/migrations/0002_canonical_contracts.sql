-- Immutable forward migration registered as 0003_canonical_completion_gates.
-- The filename retains its original draft name; schema_migrations version IDs,
-- not filenames, are the stable migration identity.
-- New installations already have these definitions from schema.sql; every
-- statement remains idempotent so this migration also upgrades old databases.

ALTER TABLE facilities ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'GOOD';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS tutorial_step integer NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE facilities ADD CONSTRAINT facilities_synthetic_status_check
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE facilities ADD CONSTRAINT facilities_quality_check
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_tutorial_step_check
    CHECK (tutorial_step >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS facility_hierarchy (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  parent_id text REFERENCES facility_hierarchy(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('SITE','BUILDING','FLOOR','ROOM','ZONE','HALL')),
  name text NOT NULL,
  path text NOT NULL,
  model_version_id text REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED' CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC' CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD' CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  hierarchy_id text REFERENCES facility_hierarchy(id) ON DELETE SET NULL,
  parent_asset_id text REFERENCES assets(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('WORKLOAD','RACK','CRAC','CDU','CHILLER','LOOP','SENSOR')),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ONLINE' CHECK (status IN ('ONLINE','DEGRADED','OFFLINE','MAINTENANCE')),
  rated_capacity_kw numeric,
  unit_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_version_id text REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED' CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC' CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD' CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensors (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  asset_id text REFERENCES assets(id) ON DELETE SET NULL,
  hierarchy_id text REFERENCES facility_hierarchy(id) ON DELETE SET NULL,
  name text NOT NULL,
  metric text NOT NULL,
  unit text NOT NULL CHECK (unit IN ('kW','kWh','°C','K','%','s','min','count')),
  sample_period_s integer NOT NULL CHECK (sample_period_s > 0),
  quality text NOT NULL DEFAULT 'GOOD' CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  model_version_id text REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED' CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC' CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topology_edges (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  from_asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  to_asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('GENERATES_HEAT','THERMALLY_INFLUENCES','COOLS','CARRIES_COOLANT','REJECTS_HEAT','DEPENDS_ON')),
  model_version_id text REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED' CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC' CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD' CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, from_asset_id, to_asset_id, relation)
);

CREATE TABLE IF NOT EXISTS scenarios (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_key text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  simulated_start_at bigint NOT NULL,
  duration_s integer NOT NULL CHECK (duration_s > 0),
  seed integer NOT NULL,
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance text NOT NULL DEFAULT 'SIMULATED' CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC' CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD' CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, scenario_key, model_version_id)
);

INSERT INTO scenarios
  (id, facility_id, scenario_key, name, status, simulated_start_at, duration_s, seed, model_version_id, config)
SELECT 'gpu-training-ramp-v1', 'sfo-01', 'gpu-training-ramp-v1', 'GPU Training Ramp', 'PUBLISHED',
       1752676800, 1800, 4103, 'sfo-rom-1.0.0', '{"ratedCapacityKw":2160,"forecastHorizonS":300}'::jsonb
WHERE EXISTS (SELECT 1 FROM facilities WHERE id = 'sfo-01')
  AND EXISTS (SELECT 1 FROM model_versions WHERE id = 'sfo-rom-1.0.0')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE incidents ALTER COLUMN simulated_at TYPE bigint USING simulated_at::bigint;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS scenario_id text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS model_version_id text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'SIMULATED';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'GOOD';
UPDATE incidents SET scenario_id = 'gpu-training-ramp-v1'
  WHERE facility_id = 'sfo-01' AND scenario_id IS NULL;
UPDATE incidents SET model_version_id = model_version WHERE model_version_id IS NULL;
ALTER TABLE incidents ALTER COLUMN model_version_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE incidents ADD CONSTRAINT incidents_scenario_id_fkey
    FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE incidents ADD CONSTRAINT incidents_model_version_id_fkey
    FOREIGN KEY (model_version_id) REFERENCES model_versions(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE incidents ADD CONSTRAINT incidents_provenance_check
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE incidents ADD CONSTRAINT incidents_synthetic_status_check
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE incidents ADD CONSTRAINT incidents_quality_check
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS recommendations (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text REFERENCES scenarios(id) ON DELETE SET NULL,
  incident_id text REFERENCES incidents(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('ADVISORY','ACTION')),
  status text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED','EXPIRED')),
  title text NOT NULL,
  rationale text NOT NULL,
  command jsonb NOT NULL,
  simulated_at bigint NOT NULL,
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED' CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC' CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD' CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO recommendations
  (id, facility_id, scenario_id, incident_id, kind, status, title, rationale, command, simulated_at, model_version_id)
SELECT 'rec-17', 'sfo-01', 'gpu-training-ramp-v1', 'inc-204', 'ADVISORY', 'PROPOSED',
       'Pre-emptive CDU-03 flow adjustment',
       'Increase CDU-03 flow before the workload ramp reaches the thermal constraint.',
       '{"assetId":"cdu-03","flowPercent":78,"durationMinutes":20}'::jsonb,
       1752677460, 'sfo-rom-1.0.0'
WHERE EXISTS (SELECT 1 FROM incidents WHERE id = 'inc-204')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE safety_evaluations ALTER COLUMN simulated_at TYPE bigint USING simulated_at::bigint;
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS model_version text NOT NULL DEFAULT 'sfo-rom-1.0.0';
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS model_version_id text;
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS model_config jsonb NOT NULL DEFAULT '{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'::jsonb;
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'SIMULATED';
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'GOOD';
UPDATE safety_evaluations SET model_version_id = model_version WHERE model_version_id IS NULL;
ALTER TABLE safety_evaluations ALTER COLUMN model_version_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE safety_evaluations ADD CONSTRAINT safety_evaluations_recommendation_id_fkey
    FOREIGN KEY (recommendation_id) REFERENCES recommendations(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE safety_evaluations ADD CONSTRAINT safety_evaluations_model_version_id_fkey
    FOREIGN KEY (model_version_id) REFERENCES model_versions(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE safety_evaluations ADD CONSTRAINT safety_evaluations_provenance_check
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE safety_evaluations ADD CONSTRAINT safety_evaluations_synthetic_status_check
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE safety_evaluations ADD CONSTRAINT safety_evaluations_quality_check
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE audit_records ALTER COLUMN simulated_at TYPE bigint USING simulated_at::bigint;
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS model_version_id text;
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'SIMULATED';
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'GOOD';
UPDATE audit_records SET model_version_id = model_version WHERE model_version_id IS NULL;
ALTER TABLE audit_records ALTER COLUMN model_version_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE audit_records ADD CONSTRAINT audit_records_model_version_id_fkey
    FOREIGN KEY (model_version_id) REFERENCES model_versions(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE audit_records ADD CONSTRAINT audit_records_provenance_check
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE audit_records ADD CONSTRAINT audit_records_synthetic_status_check
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE audit_records ADD CONSTRAINT audit_records_quality_check
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS forecasts (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  simulated_at bigint NOT NULL,
  horizon_s integer NOT NULL CHECK (horizon_s > 0),
  baseline_peak_c numeric NOT NULL,
  advisory_peak_c numeric NOT NULL,
  baseline_constraint_minutes numeric NOT NULL DEFAULT 0,
  advisory_constraint_minutes numeric NOT NULL DEFAULT 0,
  risk text NOT NULL CHECK (risk IN ('CLEAR','WATCH','CRITICAL')),
  quality text NOT NULL DEFAULT 'GOOD' CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED' CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC' CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, simulated_at, model_version_id)
);

CREATE TABLE IF NOT EXISTS replay_checkpoints (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  simulated_at bigint NOT NULL,
  elapsed_s integer NOT NULL CHECK (elapsed_s >= 0),
  state jsonb NOT NULL,
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED' CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC' CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD' CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, simulated_at, model_version_id)
);

CREATE TABLE IF NOT EXISTS operator_decisions (
  id uuid PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text REFERENCES scenarios(id) ON DELETE SET NULL,
  recommendation_id text NOT NULL REFERENCES recommendations(id) ON DELETE RESTRICT,
  safety_evaluation_id uuid REFERENCES safety_evaluations(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT','ACKNOWLEDGE')),
  outcome text NOT NULL CHECK (outcome IN ('ALLOWED_AS_ADVISORY','REJECTED','ACKNOWLEDGED')),
  simulated_at bigint NOT NULL,
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance text NOT NULL DEFAULT 'SIMULATED' CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC' CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD' CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_views (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id text REFERENCES facilities(id) ON DELETE CASCADE,
  name text NOT NULL,
  view_type text NOT NULL CHECK (view_type IN ('PORTFOLIO','OPERATIONS','TOPOLOGY','INCIDENTS','AUDIT')),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, facility_id, name)
);

CREATE TABLE IF NOT EXISTS tutorials (
  id text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('PORTFOLIO_MANAGER','OPERATOR','ENGINEER','MODEL_ADMIN','VIEWER')),
  version integer NOT NULL CHECK (version > 0),
  steps jsonb NOT NULL,
  provenance text NOT NULL DEFAULT 'CURATED' CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, version)
);

CREATE INDEX IF NOT EXISTS facility_hierarchy_facility_idx ON facility_hierarchy(facility_id, path);
CREATE INDEX IF NOT EXISTS assets_facility_kind_idx ON assets(facility_id, kind);
CREATE INDEX IF NOT EXISTS sensors_facility_asset_idx ON sensors(facility_id, asset_id);
CREATE INDEX IF NOT EXISTS topology_edges_facility_idx ON topology_edges(facility_id);
CREATE INDEX IF NOT EXISTS forecasts_scenario_time_idx ON forecasts(scenario_id, simulated_at DESC);
CREATE INDEX IF NOT EXISTS replay_checkpoints_scenario_time_idx ON replay_checkpoints(scenario_id, simulated_at);
CREATE INDEX IF NOT EXISTS operator_decisions_facility_created_idx ON operator_decisions(facility_id, created_at DESC);
CREATE INDEX IF NOT EXISTS saved_views_user_idx ON saved_views(user_id, updated_at DESC);

INSERT INTO facility_hierarchy
  (id, facility_id, parent_id, kind, name, path, model_version_id)
VALUES
  ('sfo-01-site', 'sfo-01', NULL, 'SITE', 'SFO-01', 'SFO-01', 'sfo-rom-1.0.0'),
  ('sfo-01-building', 'sfo-01', 'sfo-01-site', 'BUILDING', 'GPU Compute Building', 'SFO-01/GPU Compute Building', 'sfo-rom-1.0.0'),
  ('gpu-hall-b', 'sfo-01', 'sfo-01-building', 'HALL', 'GPU Hall B', 'SFO-01/GPU Compute Building/GPU Hall B', 'sfo-rom-1.0.0'),
  ('gpu-hall-b-zone', 'sfo-01', 'gpu-hall-b', 'ZONE', 'GPU Training Zone', 'SFO-01/GPU Compute Building/GPU Hall B/GPU Training Zone', 'sfo-rom-1.0.0')
ON CONFLICT (id) DO NOTHING;

INSERT INTO assets
  (id, facility_id, hierarchy_id, kind, name, status, rated_capacity_kw, model_version_id)
VALUES
  ('gpu-b', 'sfo-01', 'gpu-hall-b-zone', 'WORKLOAD', 'GPU Cluster B', 'ONLINE', 2050, 'sfo-rom-1.0.0'),
  ('rack-a01', 'sfo-01', 'gpu-hall-b-zone', 'RACK', 'Rack A01', 'ONLINE', 500, 'sfo-rom-1.0.0'),
  ('rack-a02', 'sfo-01', 'gpu-hall-b-zone', 'RACK', 'Rack A02', 'ONLINE', 500, 'sfo-rom-1.0.0'),
  ('rack-b01', 'sfo-01', 'gpu-hall-b-zone', 'RACK', 'Rack B01', 'ONLINE', 500, 'sfo-rom-1.0.0'),
  ('rack-b02', 'sfo-01', 'gpu-hall-b-zone', 'RACK', 'Rack B02', 'ONLINE', 500, 'sfo-rom-1.0.0'),
  ('cdu-03', 'sfo-01', 'gpu-hall-b-zone', 'CDU', 'CDU-03', 'DEGRADED', 1800, 'sfo-rom-1.0.0'),
  ('chiller-01', 'sfo-01', 'sfo-01-building', 'CHILLER', 'Chiller-01', 'ONLINE', 2160, 'sfo-rom-1.0.0'),
  ('primary-loop', 'sfo-01', 'sfo-01-building', 'LOOP', 'Primary Cooling Loop', 'ONLINE', 2160, 'sfo-rom-1.0.0')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sensors
  (id, facility_id, asset_id, hierarchy_id, name, metric, unit, sample_period_s, model_version_id)
VALUES
  ('sensor-rack-a01-inlet', 'sfo-01', 'rack-a01', 'gpu-hall-b-zone', 'Rack A01 inlet', 'inlet_temperature', '°C', 1, 'sfo-rom-1.0.0'),
  ('sensor-rack-a02-inlet', 'sfo-01', 'rack-a02', 'gpu-hall-b-zone', 'Rack A02 inlet', 'inlet_temperature', '°C', 1, 'sfo-rom-1.0.0'),
  ('sensor-rack-b01-inlet', 'sfo-01', 'rack-b01', 'gpu-hall-b-zone', 'Rack B01 inlet', 'inlet_temperature', '°C', 1, 'sfo-rom-1.0.0'),
  ('sensor-rack-b02-inlet', 'sfo-01', 'rack-b02', 'gpu-hall-b-zone', 'Rack B02 inlet', 'inlet_temperature', '°C', 1, 'sfo-rom-1.0.0'),
  ('sensor-cdu-03-flow', 'sfo-01', 'cdu-03', 'gpu-hall-b-zone', 'CDU-03 flow command', 'pump_speed', '%', 1, 'sfo-rom-1.0.0'),
  ('sensor-chiller-01-water', 'sfo-01', 'chiller-01', 'sfo-01-building', 'Chiller-01 water', 'chilled_water_temperature', '°C', 1, 'sfo-rom-1.0.0')
ON CONFLICT (id) DO NOTHING;

INSERT INTO topology_edges
  (id, facility_id, from_asset_id, to_asset_id, relation, model_version_id)
VALUES
  ('edge-gpu-b-rack-a01', 'sfo-01', 'gpu-b', 'rack-a01', 'GENERATES_HEAT', 'sfo-rom-1.0.0'),
  ('edge-gpu-b-rack-a02', 'sfo-01', 'gpu-b', 'rack-a02', 'GENERATES_HEAT', 'sfo-rom-1.0.0'),
  ('edge-gpu-b-rack-b01', 'sfo-01', 'gpu-b', 'rack-b01', 'GENERATES_HEAT', 'sfo-rom-1.0.0'),
  ('edge-gpu-b-rack-b02', 'sfo-01', 'gpu-b', 'rack-b02', 'GENERATES_HEAT', 'sfo-rom-1.0.0'),
  ('edge-cdu-rack-a01', 'sfo-01', 'cdu-03', 'rack-a01', 'COOLS', 'sfo-rom-1.0.0'),
  ('edge-cdu-rack-a02', 'sfo-01', 'cdu-03', 'rack-a02', 'COOLS', 'sfo-rom-1.0.0'),
  ('edge-cdu-rack-b01', 'sfo-01', 'cdu-03', 'rack-b01', 'COOLS', 'sfo-rom-1.0.0'),
  ('edge-cdu-rack-b02', 'sfo-01', 'cdu-03', 'rack-b02', 'COOLS', 'sfo-rom-1.0.0'),
  ('edge-primary-cdu', 'sfo-01', 'primary-loop', 'cdu-03', 'CARRIES_COOLANT', 'sfo-rom-1.0.0'),
  ('edge-chiller-primary', 'sfo-01', 'chiller-01', 'primary-loop', 'REJECTS_HEAT', 'sfo-rom-1.0.0')
ON CONFLICT (facility_id, from_asset_id, to_asset_id, relation) DO NOTHING;

INSERT INTO tutorials (id, role, version, steps)
VALUES
  ('tutorial-portfolio-manager-v1', 'PORTFOLIO_MANAGER', 1, '[{"title":"Portfolio health","route":"/portfolio"}]'::jsonb),
  ('tutorial-operator-v1', 'OPERATOR', 1, '[{"title":"Operations","route":"/operations"},{"title":"Safety Shield","route":"/recommendations/rec-17"}]'::jsonb),
  ('tutorial-engineer-v1', 'ENGINEER', 1, '[{"title":"Operating twin","route":"/operations"},{"title":"Thermal graph","route":"/topology"}]'::jsonb),
  ('tutorial-model-admin-v1', 'MODEL_ADMIN', 1, '[{"title":"Model Studio","route":"/model"}]'::jsonb),
  ('tutorial-viewer-v1', 'VIEWER', 1, '[{"title":"Read-only operations","route":"/operations"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;