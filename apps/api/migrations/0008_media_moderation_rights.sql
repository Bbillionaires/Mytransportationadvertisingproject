-- Media uploads & processing, fail-closed content moderation, rights attestations, takedowns and appeals.

CREATE TABLE media_uploads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  purpose            text NOT NULL CHECK (purpose IN ('CREATOR_VIDEO','AD_CREATIVE')),
  filename           text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  declared_type      text NOT NULL,
  size_bytes         bigint NOT NULL CHECK (size_bytes > 0),
  sha256             text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  received_bytes     bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  status             text NOT NULL DEFAULT 'UPLOADING' CHECK (status IN ('UPLOADING','UPLOADED','PROCESSING','READY','FAILED')),
  detected_type      text,
  error              text,
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  processed_at       timestamptz,
  CHECK (received_bytes <= size_bytes)
);
CREATE INDEX media_uploads_pending_idx ON media_uploads(status) WHERE status = 'UPLOADED';

CREATE TABLE media_assets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id      uuid NOT NULL UNIQUE REFERENCES media_uploads(id),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  kind           text NOT NULL CHECK (kind IN ('VIDEO','IMAGE')),
  duration_ms    integer CHECK (duration_ms > 0),
  width          integer,
  height         integer,
  has_audio      boolean NOT NULL DEFAULT false,
  rendition_key  text NOT NULL,
  thumbnail_key  text NOT NULL,
  probe          jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'VIDEO' OR duration_ms IS NOT NULL)
);
CREATE TRIGGER media_assets_immutable BEFORE UPDATE OR DELETE ON media_assets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every processed asset gets a moderation case. AI findings are advisory; a human decides (MODERATION_POLICY_V1).
CREATE TABLE moderation_cases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id           uuid NOT NULL REFERENCES media_assets(id),
  subject_type       text NOT NULL CHECK (subject_type IN ('VIDEO','CREATIVE','ASSET')),
  subject_id         uuid,
  policy_version     text NOT NULL,
  ai_recommendation  text NOT NULL CHECK (ai_recommendation IN ('LIKELY_OK','NEEDS_REVIEW','LIKELY_VIOLATION')),
  priority           text NOT NULL CHECK (priority IN ('NORMAL','HIGH')),
  scores             jsonb NOT NULL,     -- category -> max score 0..1
  findings           jsonb NOT NULL,     -- per-provider status, notes, transcript excerpt
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DECIDED')),
  decision           text CHECK (decision IN ('APPROVE','REJECT')),
  decision_reasons   text[] NOT NULL DEFAULT '{}',
  decision_note      text,
  decided_by         uuid REFERENCES users(id),
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'DECIDED') = (decision IS NOT NULL AND decided_by IS NOT NULL))
);
CREATE INDEX moderation_cases_open_idx ON moderation_cases(status, priority, created_at) WHERE status = 'OPEN';
CREATE INDEX moderation_cases_subject_idx ON moderation_cases(subject_type, subject_id);
CREATE FUNCTION moderation_cases_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'moderation cases cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status = 'DECIDED' THEN RAISE EXCEPTION 'decided moderation cases are immutable; use an appeal' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.scores <> OLD.scores OR NEW.findings <> OLD.findings OR NEW.ai_recommendation <> OLD.ai_recommendation OR NEW.asset_id <> OLD.asset_id THEN
    RAISE EXCEPTION 'AI findings are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER moderation_cases_guard BEFORE UPDATE OR DELETE ON moderation_cases FOR EACH ROW EXECUTE FUNCTION moderation_cases_guard();

-- Videos: link to processed asset; extend lifecycle.
ALTER TABLE videos DROP CONSTRAINT videos_status_check;
ALTER TABLE videos ADD CONSTRAINT videos_status_check CHECK (status IN ('PROCESSING','PROCESSING_FAILED','PENDING_REVIEW','APPROVED','REJECTED','TAKEN_DOWN'));
ALTER TABLE videos
  ADD COLUMN description text CHECK (description IS NULL OR length(description) <= 5000),
  ADD COLUMN upload_id   uuid REFERENCES media_uploads(id),
  ADD COLUMN asset_id    uuid REFERENCES media_assets(id),
  ADD COLUMN created_by  uuid REFERENCES users(id),
  ALTER COLUMN duration_ms DROP NOT NULL;
ALTER TABLE videos ADD CONSTRAINT videos_duration_when_reviewable CHECK (status IN ('PROCESSING','PROCESSING_FAILED') OR duration_ms IS NOT NULL);

CREATE FUNCTION videos_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (
      ('PROCESSING','PENDING_REVIEW'), ('PROCESSING','PROCESSING_FAILED'), ('PENDING_REVIEW','APPROVED'), ('PENDING_REVIEW','REJECTED'),
      ('REJECTED','APPROVED'), ('APPROVED','TAKEN_DOWN'), ('TAKEN_DOWN','APPROVED'), ('APPROVED','REJECTED')) THEN
    RAISE EXCEPTION 'invalid video status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status NOT IN ('PROCESSING','PROCESSING_FAILED') AND (NEW.asset_id IS DISTINCT FROM OLD.asset_id OR NEW.media_key IS DISTINCT FROM OLD.media_key OR NEW.duration_ms IS DISTINCT FROM OLD.duration_ms) THEN
    RAISE EXCEPTION 'reviewed media cannot be swapped; upload a new video' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER videos_guard BEFORE UPDATE ON videos FOR EACH ROW EXECUTE FUNCTION videos_guard();

ALTER TABLE creatives ADD COLUMN asset_id uuid REFERENCES media_assets(id);

-- Rights attestations: required before a video can be submitted; immutable.
CREATE TABLE rights_attestations (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id                        uuid NOT NULL UNIQUE REFERENCES videos(id),
  statement_version               text NOT NULL,
  statement_sha256                text NOT NULL,
  owns_or_licensed_all_media      boolean NOT NULL CHECK (owns_or_licensed_all_media),
  no_third_party_platform_content boolean NOT NULL CHECK (no_third_party_platform_content),
  consent_of_people_shown         boolean NOT NULL CHECK (consent_of_people_shown),
  family_friendly                 boolean NOT NULL CHECK (family_friendly),
  attested_by                     uuid NOT NULL REFERENCES users(id),
  ip                              inet,
  created_at                      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER rights_attestations_immutable BEFORE UPDATE OR DELETE ON rights_attestations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE video_licenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id      uuid NOT NULL REFERENCES videos(id),
  licensor      text NOT NULL,
  scope         text NOT NULL,
  territory     text NOT NULL DEFAULT 'WORLDWIDE',
  expires_at    timestamptz,
  document_ref  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Appeals of moderation decisions: decided by someone other than the original reviewer.
CREATE TABLE moderation_appeals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES moderation_cases(id),
  video_id     uuid NOT NULL REFERENCES videos(id),
  appellant    uuid NOT NULL REFERENCES users(id),
  statement    text NOT NULL CHECK (length(statement) BETWEEN 20 AND 5000),
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','UPHELD','OVERTURNED')),
  decided_by   uuid REFERENCES users(id),
  decided_at   timestamptz,
  decision_note text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX moderation_appeals_one_per_case ON moderation_appeals(case_id);

-- Copyright takedown notices (DMCA-style), counter-notices and restoration.
CREATE TABLE takedown_notices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id                 uuid NOT NULL REFERENCES videos(id),
  complainant_name         text NOT NULL,
  complainant_email        citext NOT NULL,
  complainant_address      text NOT NULL,
  copyrighted_work         text NOT NULL,
  good_faith_statement     boolean NOT NULL CHECK (good_faith_statement),
  accuracy_under_penalty   boolean NOT NULL CHECK (accuracy_under_penalty),
  signature                text NOT NULL,
  status                   text NOT NULL DEFAULT 'ACTIONED' CHECK (status IN ('ACTIONED','COUNTER_NOTICED','RESTORED','UPHELD','WITHDRAWN')),
  video_status_before      text NOT NULL,
  received_at              timestamptz NOT NULL DEFAULT now(),
  counter_statement        text,
  counter_signature        text,
  counter_by               uuid REFERENCES users(id),
  counter_received_at      timestamptz,
  restore_eligible_at      timestamptz,
  resolved_by              uuid REFERENCES users(id),
  resolved_at              timestamptz,
  resolution_note          text,
  CHECK ((status = 'COUNTER_NOTICED') <= (counter_received_at IS NOT NULL))
);
CREATE INDEX takedown_notices_video_idx ON takedown_notices(video_id);

INSERT INTO permissions (code, description, requires_mfa) VALUES
  ('media.upload',     'Upload media for own organization', false),
  ('creator.read',     'Read own channels, videos, moderation outcomes and notices', false),
  ('creator.manage',   'Create channels, submit videos, appeal, file counter-notices', false),
  ('content.review',   'Decide moderation cases and appeals', true),
  ('takedown.manage',  'Manage copyright notices and restorations', true);
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('super_admin','media.upload'), ('super_admin','creator.read'), ('super_admin','creator.manage'), ('super_admin','content.review'), ('super_admin','takedown.manage'),
  ('moderator','content.review'), ('moderator','takedown.manage'), ('moderator','creator.read'),
  ('creator_owner','media.upload'), ('creator_owner','creator.read'), ('creator_owner','creator.manage'),
  ('advertiser_admin','media.upload');

CREATE UNIQUE INDEX videos_one_per_upload ON videos(upload_id) WHERE upload_id IS NOT NULL;
