-- Campaign & creative management: scheduling, targeting, review workflow, and billing-term immutability.

ALTER TABLE campaigns
  ADD COLUMN category               text NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN destination_url        text CHECK (destination_url IS NULL OR destination_url ~ '^https://'),
  ADD COLUMN timezone               text NOT NULL DEFAULT 'UTC',
  ADD COLUMN days_of_week           smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',  -- 0 = Sunday
  ADD COLUMN start_minute           smallint NOT NULL DEFAULT 0 CHECK (start_minute BETWEEN 0 AND 1439),
  ADD COLUMN end_minute             smallint NOT NULL DEFAULT 1440 CHECK (end_minute BETWEEN 1 AND 1440),
  ADD COLUMN markets                text[] NOT NULL DEFAULT '{}',                    -- empty = all markets
  ADD COLUMN frequency_cap_per_hour smallint CHECK (frequency_cap_per_hour IS NULL OR frequency_cap_per_hour > 0),
  ADD COLUMN priority               smallint NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  ADD COLUMN skip_delay_seconds     smallint NOT NULL DEFAULT 5 CHECK (skip_delay_seconds BETWEEN 0 AND 60),
  ADD COLUMN created_by             uuid REFERENCES users(id),
  ADD COLUMN submitted_at           timestamptz,
  ADD COLUMN reviewed_by            uuid REFERENCES users(id),
  ADD COLUMN reviewed_at            timestamptz,
  ADD COLUMN review_note            text,
  ADD CONSTRAINT campaigns_days_valid CHECK (days_of_week <@ '{0,1,2,3,4,5,6}'::smallint[] AND cardinality(days_of_week) > 0),
  ADD CONSTRAINT campaigns_minutes_valid CHECK (start_minute <> end_minute);
CREATE INDEX campaigns_advertiser_idx ON campaigns(advertiser_org_id);
CREATE INDEX campaigns_review_idx ON campaigns(status) WHERE status = 'PENDING_REVIEW';

ALTER TABLE creatives
  ADD COLUMN name            text NOT NULL DEFAULT 'creative',
  ADD COLUMN headline        text CHECK (headline IS NULL OR length(headline) <= 90),
  ADD COLUMN body_text       text CHECK (body_text IS NULL OR length(body_text) <= 280),
  ADD COLUMN media_key       text CHECK (media_key IS NULL OR (media_key ~ '^[A-Za-z0-9/_.-]+$' AND length(media_key) <= 300)),
  ADD COLUMN destination_url text CHECK (destination_url IS NULL OR destination_url ~ '^https://'),
  ADD COLUMN reviewed_by     uuid REFERENCES users(id),
  ADD COLUMN reviewed_at     timestamptz,
  ADD COLUMN review_note     text;

-- Status machine + immutability of billing terms once a campaign has been submitted.
CREATE FUNCTION campaigns_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'only draft campaigns can be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.status <> OLD.status THEN
    ok := (OLD.status, NEW.status) IN (('DRAFT','PENDING_REVIEW'), ('REJECTED','PENDING_REVIEW'), ('PENDING_REVIEW','APPROVED'), ('PENDING_REVIEW','REJECTED'),
            ('APPROVED','PAUSED'), ('PAUSED','APPROVED'), ('APPROVED','ENDED'), ('PAUSED','ENDED'), ('DRAFT','ENDED'), ('REJECTED','ENDED'));
    IF NOT ok THEN RAISE EXCEPTION 'invalid campaign status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation'; END IF;
  END IF;
  IF OLD.status NOT IN ('DRAFT','REJECTED') THEN
    IF NEW.pricing_model <> OLD.pricing_model OR NEW.rate_minor <> OLD.rate_minor OR NEW.currency <> OLD.currency
       OR NEW.advertiser_org_id <> OLD.advertiser_org_id OR NEW.starts_at <> OLD.starts_at OR NEW.category <> OLD.category
       OR NEW.markets <> OLD.markets OR NEW.days_of_week <> OLD.days_of_week OR NEW.start_minute <> OLD.start_minute
       OR NEW.end_minute <> OLD.end_minute OR NEW.timezone <> OLD.timezone OR NEW.frequency_cap_per_hour IS DISTINCT FROM OLD.frequency_cap_per_hour THEN
      RAISE EXCEPTION 'billing and delivery terms of a submitted campaign are immutable; create a new campaign' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.ends_at > OLD.ends_at THEN
      RAISE EXCEPTION 'a submitted campaign can only be shortened, not extended' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_guard BEFORE UPDATE OR DELETE ON campaigns FOR EACH ROW EXECUTE FUNCTION campaigns_guard();

CREATE FUNCTION creatives_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'creatives cannot be deleted; reject them instead' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status = 'APPROVED' AND (to_jsonb(NEW) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note') <> (to_jsonb(OLD) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note') THEN
    RAISE EXCEPTION 'approved creatives are immutable; upload a new creative' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'APPROVED' AND NEW.status <> 'REJECTED' AND NEW.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'an approved creative can only be withdrawn (REJECTED)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER creatives_guard BEFORE UPDATE OR DELETE ON creatives FOR EACH ROW EXECUTE FUNCTION creatives_guard();

-- ---------- permissions and a platform moderator role ----------
INSERT INTO permissions (code, description, requires_mfa) VALUES
  ('campaign.read',   'Read own advertiser campaigns, creatives, metrics and balance', false),
  ('campaign.manage', 'Create, edit, submit, pause and end own advertiser campaigns', false),
  ('campaign.review', 'Approve or reject submitted campaigns and creatives', true);
INSERT INTO roles (code, org_kind, description) VALUES ('moderator', 'PLATFORM', 'Reviews campaigns, creatives and content against policy');
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('super_admin','campaign.read'), ('super_admin','campaign.manage'), ('super_admin','campaign.review'),
  ('moderator','campaign.review'), ('moderator','campaign.read'),
  ('advertiser_admin','campaign.read'), ('advertiser_admin','campaign.manage'),
  ('advertiser_member','campaign.read');

-- Content media reference for tablet playlists (upload pipeline arrives with M2.1).
ALTER TABLE videos ADD COLUMN media_key text CHECK (media_key IS NULL OR (media_key ~ '^[A-Za-z0-9/_.-]+$' AND length(media_key) <= 300));
