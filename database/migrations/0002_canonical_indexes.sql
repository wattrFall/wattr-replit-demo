-- Canonical extension migration. Every statement is idempotent so a partial
-- development database can be repaired by rerunning setup.
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'GOOD';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS scenario_id text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS model_version_id text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'SIMULATED';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT 'GOOD';
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS model_version_id text;
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'SIMULATED';
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS synthetic_status text NOT NULL DEFAULT 'SYNTHETIC';
CREATE INDEX IF NOT EXISTS canonical_incidents_facility_time_idx ON incidents(facility_id, simulated_at DESC);
CREATE INDEX IF NOT EXISTS canonical_safety_model_idx ON safety_evaluations(model_version_id, created_at DESC);