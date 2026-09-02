-- Sparse product-learning records. This migration mirrors the canonical
-- definitions in database/schema.sql for databases already past the baseline.
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

CREATE INDEX IF NOT EXISTS product_learning_events_org_created_idx ON product_learning_events(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_learning_events_facility_event_idx ON product_learning_events(facility_id, event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS operator_test_sessions_org_status_idx ON operator_test_sessions(organization_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS product_feedback_org_created_idx ON product_feedback(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_learning_errors_org_category_idx ON product_learning_errors(organization_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS product_learning_events_expiry_idx ON product_learning_events(expires_at);
CREATE INDEX IF NOT EXISTS operator_test_sessions_expiry_idx ON operator_test_sessions(expires_at);
CREATE INDEX IF NOT EXISTS product_feedback_expiry_idx ON product_feedback(expires_at);
CREATE INDEX IF NOT EXISTS product_learning_errors_expiry_idx ON product_learning_errors(expires_at);
