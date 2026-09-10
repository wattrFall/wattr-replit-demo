-- Canonical Wattr product schema, migration 0001 baseline.
-- This file is executed once by scripts/setup-database.ts and is safe to
-- replay while developing against an existing database.

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('PORTFOLIO_MANAGER','OPERATOR','ENGINEER','MODEL_ADMIN','VIEWER')),
  is_admin boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS facilities (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  location text NOT NULL,
  model_version text NOT NULL,
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facility_permissions (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT true,
  can_operate boolean NOT NULL DEFAULT false,
  can_edit_model boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, facility_id)
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  tutorial_complete boolean NOT NULL DEFAULT false,
  tutorial_step integer NOT NULL DEFAULT 0 CHECK (tutorial_step >= 0),
  tutorial_role text CHECK (tutorial_role IN ('PORTFOLIO_MANAGER','OPERATOR','ENGINEER','MODEL_ADMIN','VIEWER')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_tutorial_progress (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('PORTFOLIO_MANAGER','OPERATOR','ENGINEER','MODEL_ADMIN','VIEWER')),
  tutorial_step integer NOT NULL DEFAULT 0 CHECK (tutorial_step >= 0),
  tutorial_complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS model_versions (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('DRAFT','VALIDATED','PUBLISHED','ARCHIVED')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A single hierarchy table keeps site/building/room/zone semantics explicit
-- without creating a different persistence contract for every facility shape.
CREATE TABLE IF NOT EXISTS facility_hierarchy (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  parent_id text REFERENCES facility_hierarchy(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('SITE','BUILDING','FLOOR','ROOM','ZONE','HALL')),
  name text NOT NULL,
  path text NOT NULL,
  model_version_id text REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
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
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
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
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  model_version_id text REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
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
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
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
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, scenario_key, model_version_id)
);

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
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, simulated_at, model_version_id)
);

CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text REFERENCES scenarios(id) ON DELETE SET NULL,
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('WATCH','HIGH')),
  status text NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
  simulated_at bigint NOT NULL,
  affected_assets jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_signal_count integer NOT NULL DEFAULT 0,
  likely_cause text NOT NULL,
  forecast_minutes integer NOT NULL,
  correlated_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  thermal_path jsonb NOT NULL DEFAULT '[]'::jsonb,
  deduplication_key text NOT NULL DEFAULT gen_random_uuid()::text,
  model_version text NOT NULL DEFAULT 'sfo-rom-1.0.0',
  model_version_id text REFERENCES model_versions(id) ON DELETE RESTRICT,
  model_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recommendations (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text REFERENCES scenarios(id) ON DELETE SET NULL,
  incident_id text REFERENCES incidents(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('ADVISORY','ACTION')),
  status text NOT NULL CHECK (status IN ('PROPOSED','APPROVED','REJECTED','DEFERRED','ALTERNATIVE_REQUESTED','EXPIRED')),
  title text NOT NULL,
  rationale text NOT NULL,
  command jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  limitations jsonb NOT NULL DEFAULT '[]'::jsonb,
  simulated_at bigint NOT NULL,
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replay_checkpoints (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  simulated_at bigint NOT NULL,
  elapsed_s integer NOT NULL CHECK (elapsed_s >= 0),
  state jsonb NOT NULL,
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, simulated_at, model_version_id)
);

CREATE TABLE IF NOT EXISTS safety_evaluations (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  recommendation_id text NOT NULL REFERENCES recommendations(id) ON DELETE RESTRICT,
  simulated_at bigint NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('PASS', 'WARNING', 'BLOCK')),
  checks jsonb NOT NULL,
  command jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommendation_version integer NOT NULL DEFAULT 1 CHECK (recommendation_version > 0),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_version text NOT NULL DEFAULT 'sfo-rom-1.0.0',
  model_version_id text REFERENCES model_versions(id) ON DELETE RESTRICT,
  model_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operator_decisions (
  id uuid PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text REFERENCES scenarios(id) ON DELETE SET NULL,
  recommendation_id text NOT NULL REFERENCES recommendations(id) ON DELETE RESTRICT,
  safety_evaluation_id uuid REFERENCES safety_evaluations(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT','DEFER','REQUEST_ALTERNATIVE','ACKNOWLEDGE')),
  outcome text NOT NULL CHECK (outcome IN ('ALLOWED_AS_ADVISORY','REJECTED','DEFERRED','ALTERNATIVE_REQUESTED','ACKNOWLEDGED')),
  simulated_at bigint NOT NULL,
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
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
  provenance text NOT NULL DEFAULT 'CURATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, version)
);

CREATE TABLE IF NOT EXISTS audit_records (
  id bigserial PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  scenario_id text NOT NULL,
  simulated_at bigint NOT NULL,
  model_version text NOT NULL,
  model_version_id text REFERENCES model_versions(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL,
  provenance text NOT NULL DEFAULT 'SIMULATED'
    CHECK (provenance IN ('SIMULATED','MEASURED','IMPORTED','CURATED')),
  synthetic_status text NOT NULL DEFAULT 'SYNTHETIC'
    CHECK (synthetic_status IN ('SYNTHETIC','OBSERVED','MIXED')),
  quality text NOT NULL DEFAULT 'GOOD'
    CHECK (quality IN ('GOOD','DEGRADED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Organization administration is deliberately separate from product roles.
-- A portfolio manager is not implicitly allowed to change another user's access.
CREATE TABLE IF NOT EXISTS administrative_audit_records (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id text REFERENCES users(id) ON DELETE SET NULL,
  facility_id text REFERENCES facilities(id) ON DELETE SET NULL,
  action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Product learning records are deliberately sparse: they describe workflow
-- outcomes and friction, not replay ticks or facility telemetry. Properties are
-- allowlisted by the API and contain only small categorical values.
CREATE TABLE IF NOT EXISTS product_learning_events (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id text REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text,
  event_name text NOT NULL CHECK (event_name IN (
    'TUTORIAL_STEP_COMPLETED', 'TUTORIAL_COMPLETED', 'FACILITY_DRILLDOWN',
    'INCIDENT_REVIEWED', 'RECOMMENDATION_INSPECTED', 'WHAT_IF_USED',
    'SAFETY_RESULT', 'DECISION_RECORDED', 'ASSISTANT_USED',
    'AUDIT_RECONSTRUCTED', 'ENGINEERING_TOOL_USED', 'SCENARIO_COMPLETED'
  )),
  route text NOT NULL CHECK (char_length(route) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('PORTFOLIO_MANAGER','OPERATOR','ENGINEER','MODEL_ADMIN','VIEWER')),
  model_version_id text REFERENCES model_versions(id) ON DELETE SET NULL,
  simulated_at bigint CHECK (simulated_at IS NULL OR simulated_at >= 0),
  session_id text NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 120),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 240),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days',
  UNIQUE (organization_id, user_id, event_name, dedupe_key)
);

CREATE TABLE IF NOT EXISTS operator_test_sessions (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text NOT NULL,
  model_version_id text REFERENCES model_versions(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('PORTFOLIO_MANAGER','OPERATOR','ENGINEER','MODEL_ADMIN','VIEWER')),
  status text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED','ABANDONED')),
  scenario_completed boolean NOT NULL DEFAULT false,
  time_to_understanding_s integer CHECK (time_to_understanding_s IS NULL OR time_to_understanding_s >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  abandonment_code text CHECK (abandonment_code IS NULL OR abandonment_code IN (
    'NAVIGATION_FRICTION','UNCLEAR_FORECAST','UNCLEAR_RECOMMENDATION',
    'PERMISSION_BLOCK','TECHNICAL_ERROR','MODERATOR_ENDED','OTHER'
  )),
  qualitative_feedback_code text CHECK (qualitative_feedback_code IS NULL OR qualitative_feedback_code IN (
    'CLEAR','PARTLY_CLEAR','UNCLEAR','TOO_SLOW','MISSING_CONTEXT','OTHER'
  )),
  last_route text CHECK (last_route IS NULL OR char_length(last_route) <= 200),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days'
);

CREATE TABLE IF NOT EXISTS product_feedback (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id text REFERENCES facilities(id) ON DELETE CASCADE,
  scenario_id text,
  model_version_id text REFERENCES model_versions(id) ON DELETE SET NULL,
  route text NOT NULL CHECK (char_length(route) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('PORTFOLIO_MANAGER','OPERATOR','ENGINEER','MODEL_ADMIN','VIEWER')),
  sentiment text NOT NULL CHECK (sentiment IN ('POSITIVE','NEUTRAL','NEGATIVE')),
  feedback_code text NOT NULL CHECK (feedback_code IN (
    'HELPFUL','UNCLEAR','MISSING_CONTEXT','TOO_SLOW','UNEXPECTED_RESULT','OTHER'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days'
);

CREATE TABLE IF NOT EXISTS product_learning_errors (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  facility_id text REFERENCES facilities(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN (
    'APPLICATION_FAULT', 'SIMULATION_INVARIANT_FAILURE',
    'PERMISSION_FAILURE', 'EXTERNAL_SERVICE_UNAVAILABLE'
  )),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_:-]{1,120}$'),
  route text CHECK (route IS NULL OR char_length(route) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days'
);

CREATE INDEX IF NOT EXISTS facility_hierarchy_facility_idx ON facility_hierarchy(facility_id, path);
CREATE INDEX IF NOT EXISTS assets_facility_kind_idx ON assets(facility_id, kind);
CREATE INDEX IF NOT EXISTS sensors_facility_asset_idx ON sensors(facility_id, asset_id);
CREATE INDEX IF NOT EXISTS topology_edges_facility_idx ON topology_edges(facility_id);
CREATE INDEX IF NOT EXISTS forecasts_scenario_time_idx ON forecasts(scenario_id, simulated_at DESC);
CREATE INDEX IF NOT EXISTS replay_checkpoints_scenario_time_idx ON replay_checkpoints(scenario_id, simulated_at);
CREATE INDEX IF NOT EXISTS operator_decisions_facility_created_idx ON operator_decisions(facility_id, created_at DESC);
CREATE INDEX IF NOT EXISTS saved_views_user_idx ON saved_views(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS audit_records_facility_created_idx ON audit_records(facility_id, created_at DESC);
CREATE INDEX IF NOT EXISTS safety_evaluations_lookup_idx ON safety_evaluations(user_id, facility_id, recommendation_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS administrative_audit_org_created_idx ON administrative_audit_records(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_learning_events_org_created_idx ON product_learning_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_learning_events_facility_event_idx ON product_learning_events(facility_id, event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS operator_test_sessions_org_status_idx ON operator_test_sessions(organization_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS product_feedback_org_created_idx ON product_feedback(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_learning_errors_org_category_idx ON product_learning_errors(organization_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS product_learning_events_expiry_idx ON product_learning_events(expires_at);
CREATE INDEX IF NOT EXISTS operator_test_sessions_expiry_idx ON operator_test_sessions(expires_at);
CREATE INDEX IF NOT EXISTS product_feedback_expiry_idx ON product_feedback(expires_at);
CREATE INDEX IF NOT EXISTS product_learning_errors_expiry_idx ON product_learning_errors(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_deduplication_idx
  ON incidents(facility_id, scenario_id, model_version_id, deduplication_key);

CREATE OR REPLACE FUNCTION reject_administrative_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'administrative audit records are immutable';
END;
$$;
DROP TRIGGER IF EXISTS administrative_audit_records_immutable ON administrative_audit_records;
CREATE TRIGGER administrative_audit_records_immutable
BEFORE UPDATE OR DELETE ON administrative_audit_records
FOR EACH ROW EXECUTE FUNCTION reject_administrative_audit_mutation();

CREATE OR REPLACE FUNCTION reject_decision_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'decision history records are immutable';
END;
$$;
DROP TRIGGER IF EXISTS audit_records_immutable ON audit_records;
CREATE TRIGGER audit_records_immutable
BEFORE UPDATE OR DELETE ON audit_records
FOR EACH ROW EXECUTE FUNCTION reject_decision_history_mutation();
DROP TRIGGER IF EXISTS audit_records_no_truncate ON audit_records;
CREATE TRIGGER audit_records_no_truncate
BEFORE TRUNCATE ON audit_records
FOR EACH STATEMENT EXECUTE FUNCTION reject_decision_history_mutation();
DROP TRIGGER IF EXISTS operator_decisions_immutable ON operator_decisions;
CREATE TRIGGER operator_decisions_immutable
BEFORE UPDATE OR DELETE ON operator_decisions
FOR EACH ROW EXECUTE FUNCTION reject_decision_history_mutation();
DROP TRIGGER IF EXISTS operator_decisions_no_truncate ON operator_decisions;
CREATE TRIGGER operator_decisions_no_truncate
BEFORE TRUNCATE ON operator_decisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_decision_history_mutation();

-- These ALTERs make the baseline safe for databases created by the previous
-- cockpit release before the canonical tables were introduced.
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'GOOD';
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS tutorial_step integer NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS tutorial_role text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS owner_user_id text;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS scenario_id text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS model_version_id text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'SIMULATED';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'GOOD';
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS model_version_id text;
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'SIMULATED';
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'GOOD';
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS model_version_id text;
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'SIMULATED';
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
ALTER TABLE audit_records ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'GOOD';

INSERT INTO organizations (id, name)
VALUES ('wattr-demo', 'Wattr Demonstration')
ON CONFLICT (id) DO NOTHING;

INSERT INTO facilities
  (id, organization_id, name, location, model_version, provenance, synthetic_status, quality)
VALUES ('sfo-01', 'wattr-demo', 'SFO-01', 'San Francisco, CA', 'sfo-rom-1.0.0', 'SIMULATED', 'SYNTHETIC', 'GOOD')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, location = EXCLUDED.location,
  provenance = EXCLUDED.provenance, synthetic_status = EXCLUDED.synthetic_status, quality = EXCLUDED.quality;

INSERT INTO model_versions (id, facility_id, status, config, published_at)
VALUES (
  'sfo-rom-1.0.0', 'sfo-01', 'PUBLISHED',
  '{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'::jsonb, now()
)
ON CONFLICT (id) DO UPDATE SET config = CASE
  WHEN model_versions.id = 'sfo-rom-1.0.0' THEN EXCLUDED.config
  ELSE model_versions.config
END;

INSERT INTO scenarios
  (id, facility_id, scenario_key, name, status, simulated_start_at, duration_s, seed, model_version_id, config)
VALUES (
  'gpu-training-ramp-v1', 'sfo-01', 'gpu-training-ramp-v1', 'GPU Training Ramp', 'PUBLISHED',
  1752676800, 1800, 4103, 'sfo-rom-1.0.0',
  '{"ratedCapacityKw":2160,"forecastHorizonS":300}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET model_version_id = EXCLUDED.model_version_id, status = EXCLUDED.status;

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

INSERT INTO incidents
  (id, facility_id, scenario_id, title, severity, status, simulated_at, affected_assets,
   raw_signal_count, likely_cause, forecast_minutes, correlated_signals, thermal_path,
   deduplication_key, model_version, model_version_id, model_config)
VALUES (
  'inc-204', 'sfo-01', 'gpu-training-ramp-v1', 'CDU-03 thermal response degradation', 'HIGH', 'OPEN',
  1752677460, '["GPU Hall B","Rows 12–16","CDU-03"]'::jsonb, 17,
  'Reduced CDU flow response during the workload ramp', 11,
  '[{"id":"signal-workload-ramp","assetId":"gpu-b","metric":"scheduled_load","direction":"rising"},{"id":"signal-rack-inlet","assetId":"rack-b02","metric":"inlet_temperature","direction":"rising"},{"id":"signal-cdu-lag","assetId":"cdu-03","metric":"pump_response","direction":"lagging"}]'::jsonb,
  '["gpu-b","rack-b02","cdu-03","primary-loop","chiller-01"]'::jsonb,
  'gpu-training-ramp-v1:cdu-03:thermal-response', 'sfo-rom-1.0.0', 'sfo-rom-1.0.0',
  '{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET scenario_id = EXCLUDED.scenario_id,
  model_version_id = EXCLUDED.model_version_id,
  correlated_signals = EXCLUDED.correlated_signals,
  thermal_path = EXCLUDED.thermal_path,
  deduplication_key = EXCLUDED.deduplication_key;

INSERT INTO recommendations
  (id, facility_id, scenario_id, incident_id, kind, status, title, rationale, command,
   version, explanation, evidence, confidence, limitations, simulated_at, model_version_id)
VALUES (
  'rec-17', 'sfo-01', 'gpu-training-ramp-v1', 'inc-204', 'ADVISORY', 'PROPOSED',
  'Pre-emptive CDU-03 flow adjustment',
  'Increase CDU-03 flow before the workload ramp reaches the thermal constraint.',
  '{"assetId":"cdu-03","flowPercent":78,"durationMinutes":20}'::jsonb,
  1,
  '{"what":"Increase CDU-03 flow to 78% for 20 minutes.","why":"Pre-empt the modeled CDU-03 response lag before the workload ramp reaches the thermal constraint.","where":"GPU Hall B · GPU Training Zone · CDU-03 serving racks A01–B02.","expectedEffect":"Reduce modeled peak inlet temperature and constraint exposure.","confidence":"Forecast confidence declines with horizon and is valid only inside the disclosed model domain.","provenance":"SIMULATED"}'::jsonb,
  '["GPU Training Ramp event stream","Rack inlet temperature trend","CDU-03 response lag","Primary-loop thermal path"]'::jsonb,
  0.80,
  '["Synthetic reduced-order model; values are not measured telemetry.","No command is sent to operational technology.","Results are not a claim of measured savings or calibrated customer accuracy."]'::jsonb,
  1752677460, 'sfo-rom-1.0.0'
)
ON CONFLICT (id) DO UPDATE SET model_version_id = EXCLUDED.model_version_id,
  version = EXCLUDED.version,
  explanation = EXCLUDED.explanation,
  evidence = EXCLUDED.evidence,
  confidence = EXCLUDED.confidence,
  limitations = EXCLUDED.limitations;

INSERT INTO tutorials (id, role, version, steps)
VALUES
  ('tutorial-portfolio-manager-v1', 'PORTFOLIO_MANAGER', 1, '[{"title":"Portfolio health","route":"/portfolio"}]'::jsonb),
  ('tutorial-operator-v1', 'OPERATOR', 1, '[{"title":"Operations","route":"/operations"},{"title":"Safety Shield","route":"/recommendations/rec-17"}]'::jsonb),
  ('tutorial-engineer-v1', 'ENGINEER', 1, '[{"title":"Operating twin","route":"/operations"},{"title":"Thermal graph","route":"/topology"}]'::jsonb),
  ('tutorial-model-admin-v1', 'MODEL_ADMIN', 1, '[{"title":"Model Studio","route":"/model"}]'::jsonb),
  ('tutorial-viewer-v1', 'VIEWER', 1, '[{"title":"Read-only operations","route":"/operations"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;