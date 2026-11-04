-- Media object storage and backups (R-021). The verified original of every upload is stored once under
-- originals/<upload id> and copied to each configured backup bucket. Backups only ever add objects.
ALTER TABLE media_uploads ADD COLUMN original_key text CHECK (original_key IS NULL OR original_key = 'originals/' || id::text);

CREATE TABLE media_backups (
  upload_id   uuid NOT NULL REFERENCES media_uploads(id),
  target      text NOT NULL CHECK (target ~ '^[a-z0-9-]{1,40}$'),   -- backup1 / backup2
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes  bigint NOT NULL CHECK (size_bytes >= 0),
  copied_at   timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  PRIMARY KEY (upload_id, target)
);

-- Results of the nightly media audit (jobs:verify-media), kept for the staff dashboard and alerting.
CREATE TABLE media_audit_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  deep        boolean NOT NULL DEFAULT false,
  checked     integer NOT NULL DEFAULT 0,
  repaired    integer NOT NULL DEFAULT 0,
  problems    jsonb NOT NULL DEFAULT '[]'::jsonb
);
