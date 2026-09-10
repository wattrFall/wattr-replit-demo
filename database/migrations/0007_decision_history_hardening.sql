-- Follow-on hardening for environments that applied the initial decision
-- workflow migration before statement-level immutability was introduced.

UPDATE incidents
SET deduplication_key = 'legacy:' || id
WHERE deduplication_key IS NULL OR deduplication_key = 'gpu-ramp-cdu-response';

UPDATE incidents
SET deduplication_key = 'gpu-training-ramp-v1:cdu-03:thermal-response'
WHERE id = 'inc-204';

ALTER TABLE incidents ALTER COLUMN deduplication_key SET DEFAULT gen_random_uuid()::text;
ALTER TABLE incidents ALTER COLUMN deduplication_key SET NOT NULL;

DROP TRIGGER IF EXISTS audit_records_no_truncate ON audit_records;
CREATE TRIGGER audit_records_no_truncate
BEFORE TRUNCATE ON audit_records
FOR EACH STATEMENT EXECUTE FUNCTION reject_decision_history_mutation();

DROP TRIGGER IF EXISTS operator_decisions_no_truncate ON operator_decisions;
CREATE TRIGGER operator_decisions_no_truncate
BEFORE TRUNCATE ON operator_decisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_decision_history_mutation();