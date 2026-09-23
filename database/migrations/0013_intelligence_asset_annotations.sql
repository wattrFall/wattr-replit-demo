-- Version-bound enrichment for the canonical asset projection. The authoritative
-- asset identity remains the layout id in the published model version.
CREATE TABLE IF NOT EXISTS intelligence_asset_annotations (
  facility_id text NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  model_version_id text NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
  layout_asset_id text NOT NULL CHECK (layout_asset_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
  manufacturer text,
  model text,
  location_status text NOT NULL DEFAULT 'RESOLVED'
    CHECK (location_status IN ('RESOLVED','UNRESOLVED')),
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance text NOT NULL DEFAULT 'IMPORTED'
    CHECK (provenance IN ('SIMULATED','IMPORTED','CURATED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, model_version_id, layout_asset_id)
);

CREATE INDEX IF NOT EXISTS intelligence_asset_annotations_model_idx
  ON intelligence_asset_annotations (facility_id, model_version_id);