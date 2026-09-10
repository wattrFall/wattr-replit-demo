-- Role security migration. Safe for both clean installs and legacy cockpit data.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS owner_user_id text;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

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

CREATE INDEX IF NOT EXISTS administrative_audit_org_created_idx
  ON administrative_audit_records(organization_id, created_at DESC);

-- Preserve the original demo administrator as the durable owner when upgrading
-- a database that predates explicit organization administration.
UPDATE organizations o
SET owner_user_id = (
  SELECT m.user_id FROM memberships m
  WHERE m.organization_id = o.id AND m.role = 'MODEL_ADMIN'
  ORDER BY m.user_id
  LIMIT 1
)
WHERE o.owner_user_id IS NULL
  AND EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.organization_id = o.id AND m.role = 'MODEL_ADMIN'
  );

UPDATE memberships m
SET is_admin = true
FROM organizations o
WHERE o.owner_user_id = m.user_id
  AND o.id = m.organization_id;