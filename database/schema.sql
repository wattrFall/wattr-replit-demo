BEGIN;

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
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
  PRIMARY KEY (user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS facilities (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  location text NOT NULL,
  model_version text NOT NULL,
  provenance text NOT NULL DEFAULT 'SIMULATED',
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
  tutorial_step integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS tutorial_step integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS model_versions (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('DRAFT','VALIDATED','PUBLISHED','ARCHIVED')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('WATCH','HIGH')),
  status text NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
  simulated_at integer NOT NULL,
  affected_assets jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_signal_count integer NOT NULL DEFAULT 0,
  likely_cause text NOT NULL,
  forecast_minutes integer NOT NULL,
  model_version text NOT NULL DEFAULT 'sfo-rom-1.0.0',
  model_config jsonb NOT NULL DEFAULT '{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS model_version text NOT NULL DEFAULT 'sfo-rom-1.0.0';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS model_config jsonb NOT NULL DEFAULT '{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'::jsonb;

CREATE TABLE IF NOT EXISTS audit_records (
  id bigserial PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  scenario_id text NOT NULL,
  simulated_at integer NOT NULL,
  model_version text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS safety_evaluations (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  recommendation_id text NOT NULL,
  simulated_at integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('PASS', 'WARNING', 'BLOCK')),
  checks jsonb NOT NULL,
  model_version text NOT NULL DEFAULT 'sfo-rom-1.0.0',
  model_config jsonb NOT NULL DEFAULT '{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'::jsonb,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS model_version text NOT NULL DEFAULT 'sfo-rom-1.0.0';
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS model_config jsonb NOT NULL DEFAULT '{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'::jsonb;

CREATE INDEX IF NOT EXISTS audit_records_facility_created_idx
  ON audit_records(facility_id, created_at DESC);
CREATE INDEX IF NOT EXISTS safety_evaluations_lookup_idx
  ON safety_evaluations(user_id, facility_id, recommendation_id, expires_at DESC);

INSERT INTO organizations (id, name)
VALUES ('wattr-demo', 'Wattr Demonstration')
ON CONFLICT (id) DO NOTHING;

INSERT INTO facilities (id, organization_id, name, location, model_version, provenance)
VALUES ('sfo-01', 'wattr-demo', 'SFO-01', 'San Francisco, CA', 'sfo-rom-1.0.0', 'SIMULATED')
ON CONFLICT (id) DO NOTHING;

INSERT INTO model_versions (id, facility_id, status, config, published_at)
VALUES (
  'sfo-rom-1.0.0',
  'sfo-01',
  'PUBLISHED',
  '{"scenario":"gpu-training-ramp-v1","seed":4103,"thermalMass":0.82,"responseLag":12}'::jsonb,
  now()
)
ON CONFLICT (id) DO UPDATE SET config = CASE
  WHEN model_versions.config ? 'thermalMass' AND model_versions.config ? 'responseLag' THEN model_versions.config
  ELSE EXCLUDED.config
END;

INSERT INTO incidents
  (id, facility_id, title, severity, status, simulated_at, affected_assets, raw_signal_count, likely_cause, forecast_minutes)
VALUES
  ('inc-204', 'sfo-01', 'CDU-03 thermal response degradation', 'HIGH', 'OPEN',
   1752677460, '["GPU Hall B","Rows 12–16","CDU-03"]'::jsonb, 17,
   'Reduced CDU flow response during the workload ramp', 11)
ON CONFLICT (id) DO NOTHING;

COMMIT;