-- Audit immutability is a separate forward migration because 0004 may already
-- be applied on development and production databases.
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