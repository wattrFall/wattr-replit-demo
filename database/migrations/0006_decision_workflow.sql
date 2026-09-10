-- Complete decision workflow: explainable recommendations, correlated evidence,
-- bound counterfactual evaluations, full dispositions, and immutable history.

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS correlated_signals jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS thermal_path jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS deduplication_key text;

UPDATE incidents
SET deduplication_key = 'legacy:' || id
WHERE deduplication_key IS NULL;

ALTER TABLE incidents ALTER COLUMN deduplication_key SET DEFAULT gen_random_uuid()::text;
ALTER TABLE incidents ALTER COLUMN deduplication_key SET NOT NULL;

UPDATE incidents
SET correlated_signals =
      '[{"id":"signal-workload-ramp","assetId":"gpu-b","metric":"scheduled_load","direction":"rising"},{"id":"signal-rack-inlet","assetId":"rack-b02","metric":"inlet_temperature","direction":"rising"},{"id":"signal-cdu-lag","assetId":"cdu-03","metric":"pump_response","direction":"lagging"}]'::jsonb,
    thermal_path = '["gpu-b","rack-b02","cdu-03","primary-loop","chiller-01"]'::jsonb,
    deduplication_key = 'gpu-training-ramp-v1:cdu-03:thermal-response'
WHERE id = 'inc-204';

CREATE UNIQUE INDEX IF NOT EXISTS incidents_deduplication_idx
  ON incidents(facility_id, scenario_id, model_version_id, deduplication_key);

ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS explanation jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS confidence numeric NOT NULL DEFAULT 0;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS limitations jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE recommendations DROP CONSTRAINT IF EXISTS recommendations_status_check;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_status_check
  CHECK (status IN ('PROPOSED','APPROVED','REJECTED','DEFERRED','ALTERNATIVE_REQUESTED','EXPIRED'));
DO $$ BEGIN
  ALTER TABLE recommendations ADD CONSTRAINT recommendations_version_check CHECK (version > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE recommendations ADD CONSTRAINT recommendations_confidence_check CHECK (confidence >= 0 AND confidence <= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE recommendations
SET version = 1,
    explanation = '{"what":"Increase CDU-03 flow to 78% for 20 minutes.","why":"Pre-empt the modeled CDU-03 response lag before the workload ramp reaches the thermal constraint.","where":"GPU Hall B · GPU Training Zone · CDU-03 serving racks A01–B02.","expectedEffect":"Reduce modeled peak inlet temperature and constraint exposure.","confidence":"Forecast confidence declines with horizon and is valid only inside the disclosed model domain.","provenance":"SIMULATED"}'::jsonb,
    evidence = '["GPU Training Ramp event stream","Rack inlet temperature trend","CDU-03 response lag","Primary-loop thermal path"]'::jsonb,
    confidence = 0.80,
    limitations = '["Synthetic reduced-order model; values are not measured telemetry.","No command is sent to operational technology.","Results are not a claim of measured savings or calibrated customer accuracy."]'::jsonb
WHERE id = 'rec-17';

ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS command jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS recommendation_version integer NOT NULL DEFAULT 1;
ALTER TABLE safety_evaluations ADD COLUMN IF NOT EXISTS snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  ALTER TABLE safety_evaluations ADD CONSTRAINT safety_evaluations_recommendation_version_check
    CHECK (recommendation_version > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE operator_decisions DROP CONSTRAINT IF EXISTS operator_decisions_decision_check;
ALTER TABLE operator_decisions DROP CONSTRAINT IF EXISTS operator_decisions_outcome_check;
ALTER TABLE operator_decisions ADD CONSTRAINT operator_decisions_decision_check
  CHECK (decision IN ('APPROVE','REJECT','DEFER','REQUEST_ALTERNATIVE','ACKNOWLEDGE'));
ALTER TABLE operator_decisions ADD CONSTRAINT operator_decisions_outcome_check
  CHECK (outcome IN ('ALLOWED_AS_ADVISORY','REJECTED','DEFERRED','ALTERNATIVE_REQUESTED','ACKNOWLEDGED'));

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