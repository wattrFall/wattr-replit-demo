-- Source files and reviewable import sessions. Files are retained in Postgres,
-- not a transient server directory, so a draft always retains its reference.
CREATE TABLE IF NOT EXISTS facility_import_files (
  id uuid PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  uploaded_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('FLOORPLAN','IFC')),
  original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 160),
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf','image/png','image/jpeg','image/svg+xml','application/x-step','application/ifc')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS facility_import_files_facility_created_idx
  ON facility_import_files (facility_id, created_at DESC);

CREATE TABLE IF NOT EXISTS facility_import_sessions (
  id uuid PRIMARY KEY,
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES facility_import_files(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('FLOORPLAN','IFC')),
  preview jsonb NOT NULL,
  status text NOT NULL DEFAULT 'REVIEW' CHECK (status IN ('REVIEW','DRAFT_CREATED')),
  draft_model_version_id text REFERENCES model_versions(id) ON DELETE SET NULL,
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS facility_import_sessions_facility_created_idx
  ON facility_import_sessions (facility_id, created_at DESC);