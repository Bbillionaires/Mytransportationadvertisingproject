-- Playback event pipeline: raw (append-only, as received) -> validated (policy-versioned, reviewable).
-- Only VALID validated events can feed allocations; offline/anomalous events are HELD for human review.

-- ---------- minimal campaign & media catalogue (full management UI/API arrives with M2.4/M2.7) ----------
CREATE TABLE campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_org_id uuid NOT NULL REFERENCES organizations(id),
  name              text NOT NULL,
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_REVIEW','APPROVED','PAUSED','ENDED','REJECTED')),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  currency          char(3) NOT NULL DEFAULT 'USD',
  pricing_model     text NOT NULL CHECK (pricing_model IN ('CPM','CPQV')),  -- per 1000 impressions | per qualified view
  rate_minor        bigint NOT NULL CHECK (rate_minor > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (id, advertiser_org_id)
);

CREATE TABLE creatives (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       uuid NOT NULL REFERENCES campaigns(id),
  kind              text NOT NULL CHECK (kind IN ('VIDEO','BANNER','DISPLAY')),
  status            text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW','APPROVED','REJECTED')),
  duration_ms       integer CHECK (duration_ms > 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'VIDEO' OR duration_ms IS NOT NULL)
);
CREATE INDEX creatives_campaign_idx ON creatives(campaign_id);

CREATE TABLE videos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id  uuid NOT NULL REFERENCES creator_profiles(id),
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW','APPROVED','REJECTED','TAKEN_DOWN')),
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX videos_creator_idx ON videos(creator_id);

-- ---------- device status history (eligibility at event time) ----------
CREATE TABLE device_status_history (
  id         bigserial PRIMARY KEY,
  device_id  uuid NOT NULL REFERENCES devices(id),
  status     text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','RETIRED')),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX device_status_history_idx ON device_status_history(device_id, changed_at);
INSERT INTO device_status_history (device_id, status, changed_at) SELECT id, 'ACTIVE', enrolled_at FROM devices;
INSERT INTO device_status_history (device_id, status) SELECT id, status FROM devices WHERE status <> 'ACTIVE';

CREATE FUNCTION devices_status_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO device_status_history (device_id, status, changed_at) VALUES (NEW.id, NEW.status, NEW.enrolled_at);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO device_status_history (device_id, status) VALUES (NEW.id, NEW.status);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER devices_status_history AFTER INSERT OR UPDATE OF status ON devices FOR EACH ROW EXECUTE FUNCTION devices_status_history();
CREATE TRIGGER device_status_history_immutable BEFORE UPDATE OR DELETE ON device_status_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- raw events: exactly what the signed device sent, deduplicated by (device, event id) ----------
CREATE TABLE raw_events (
  id                  bigserial PRIMARY KEY,
  device_id           uuid NOT NULL REFERENCES devices(id),
  event_id            uuid NOT NULL,
  batch_id            uuid NOT NULL,
  type                text NOT NULL CHECK (type IN ('AD_PLAYBACK','CONTENT_PLAYBACK','CLICK','ACTIVE_SEGMENT')),
  device_occurred_at  timestamptz NOT NULL,   -- device clock
  occurred_at         timestamptz NOT NULL,   -- corrected by the batch's measured clock offset
  clock_offset_ms     integer NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  payload             jsonb NOT NULL,
  UNIQUE (device_id, event_id)
);
CREATE INDEX raw_events_received_idx ON raw_events(received_at);
CREATE TRIGGER raw_events_immutable BEFORE UPDATE OR DELETE ON raw_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- validated events ----------
CREATE TABLE validated_events (
  id                     bigserial PRIMARY KEY,
  raw_event_id           bigint NOT NULL UNIQUE REFERENCES raw_events(id),
  device_id              uuid NOT NULL REFERENCES devices(id),
  fleet_org_id           uuid REFERENCES organizations(id),
  vehicle_id             uuid,
  driver_id              uuid REFERENCES drivers(id),
  type                   text NOT NULL,
  occurred_at            timestamptz NOT NULL,
  ended_at               timestamptz NOT NULL,
  campaign_id            uuid REFERENCES campaigns(id),
  creative_id            uuid REFERENCES creatives(id),
  video_id               uuid REFERENCES videos(id),   -- content shown (or adjacent to the ad)
  creator_id             uuid REFERENCES creator_profiles(id),
  visible_ms             integer NOT NULL DEFAULT 0 CHECK (visible_ms >= 0),
  unmuted_visible_ms     integer NOT NULL DEFAULT 0 CHECK (unmuted_visible_ms >= 0),
  impression             boolean NOT NULL DEFAULT false,
  qualified              boolean NOT NULL DEFAULT false, -- qualified ad view or qualified content view
  completed              boolean NOT NULL DEFAULT false,
  skipped                boolean NOT NULL DEFAULT false,
  click                  boolean NOT NULL DEFAULT false,
  watch_seconds          integer NOT NULL DEFAULT 0 CHECK (watch_seconds >= 0),
  eligible_active_seconds integer NOT NULL DEFAULT 0 CHECK (eligible_active_seconds >= 0),
  offline                boolean NOT NULL DEFAULT false,
  status                 text NOT NULL CHECK (status IN ('VALID','INVALID','HELD_REVIEW')),
  reasons                text[] NOT NULL DEFAULT '{}',
  policy_version         text NOT NULL,
  validated_at           timestamptz NOT NULL DEFAULT now(),
  reviewed_by            uuid REFERENCES users(id),
  reviewed_at            timestamptz,
  review_note            text,
  CHECK (ended_at >= occurred_at),
  CHECK (status <> 'VALID' OR NOT (reasons && ARRAY['OFFLINE_DELAYED','RATE_ANOMALY','ACTIVE_CAP_EXCEEDED','LATE_AFTER_ALLOCATION']::text[]) OR reviewed_by IS NOT NULL)
);
CREATE INDEX validated_events_campaign_idx ON validated_events(campaign_id, occurred_at) WHERE campaign_id IS NOT NULL;
CREATE INDEX validated_events_device_idx ON validated_events(device_id, occurred_at);
CREATE INDEX validated_events_creator_idx ON validated_events(creator_id, occurred_at) WHERE creator_id IS NOT NULL;
CREATE INDEX validated_events_driver_idx ON validated_events(driver_id, occurred_at) WHERE driver_id IS NOT NULL;
CREATE INDEX validated_events_held_idx ON validated_events(status) WHERE status = 'HELD_REVIEW';

-- Validation outcomes are immutable, except a HELD_REVIEW event may be decided once by a human reviewer.
CREATE FUNCTION validated_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'validated events cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'HELD_REVIEW' OR NEW.status NOT IN ('VALID','INVALID') OR NEW.reviewed_by IS NULL THEN
    RAISE EXCEPTION 'only held events can be reviewed, once, by a named reviewer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note') <> (to_jsonb(OLD) - 'status' - 'reviewed_by' - 'reviewed_at' - 'review_note') THEN
    RAISE EXCEPTION 'validated event measurements are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validated_events_guard BEFORE UPDATE OR DELETE ON validated_events FOR EACH ROW EXECUTE FUNCTION validated_events_guard();

-- ---------- allocation windows: a campaign's events can be allocated for any instant at most once ----------
CREATE TABLE allocation_windows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text NOT NULL UNIQUE,
  campaign_id      uuid NOT NULL REFERENCES campaigns(id),
  period_start     timestamptz NOT NULL,
  period_end       timestamptz NOT NULL,
  result           jsonb NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  EXCLUDE USING gist (campaign_id WITH =, tstzrange(period_start, period_end) WITH &&)
);
CREATE TRIGGER allocation_windows_immutable BEFORE UPDATE OR DELETE ON allocation_windows FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- permissions ----------
INSERT INTO permissions (code, description, requires_mfa) VALUES
  ('events.validate', 'Run the playback event validator', true),
  ('events.review',   'Approve or reject held (offline/anomalous) events', true);
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('super_admin','events.validate'), ('super_admin','events.review'),
  ('finance_admin','events.validate'),
  ('finance_approver','events.review');
