-- Rider engagement: optional rider accounts, QR pairing to tablets, coupon wallet, geofenced proximity alerts,
-- skill games and sponsor-funded non-cash rewards. Riders are a separate identity from staff/business users.

CREATE TABLE riders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext UNIQUE,                 -- NULL after account deletion
  password_hash     text,
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 50),
  birth_year        smallint,
  adult_confirmed   boolean NOT NULL DEFAULT false,
  terms_version     text NOT NULL,
  marketing_opt_in  boolean NOT NULL DEFAULT false,
  email_verified_at timestamptz,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED','DELETED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (status = 'DELETED' OR (email IS NOT NULL AND password_hash IS NOT NULL AND adult_confirmed))
);

CREATE TABLE rider_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id    uuid NOT NULL REFERENCES riders(id),
  kind        text NOT NULL CHECK (kind IN ('EMAIL_VERIFY','PHONE_SESSION','TABLET_SESSION')),
  token_hash  text NOT NULL UNIQUE,
  device_id   uuid REFERENCES devices(id),        -- TABLET_SESSION tokens only work from this tablet
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,                        -- consumed (verify) or ended (sessions)
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'TABLET_SESSION') = (device_id IS NOT NULL))
);
CREATE INDEX rider_tokens_rider_idx ON rider_tokens(rider_id, kind);

CREATE TABLE rider_pairings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      uuid NOT NULL REFERENCES devices(id),
  code_hash      text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  rider_id       uuid REFERENCES riders(id),
  paired_at      timestamptz,
  session_token_id uuid REFERENCES rider_tokens(id),
  delivered_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE coupon_codes ADD COLUMN rider_id uuid REFERENCES riders(id);

-- ---------- geofenced proximity promotions ----------
CREATE TABLE geofences (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid NOT NULL REFERENCES campaigns(id),
  advertiser_org_id   uuid NOT NULL REFERENCES organizations(id),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  message             text NOT NULL CHECK (length(message) BETWEEN 1 AND 120),
  latitude            double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude           double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_m            integer NOT NULL CHECK (radius_m BETWEEN 50 AND 2000),
  daily_cap_per_device smallint NOT NULL DEFAULT 2 CHECK (daily_cap_per_device BETWEEN 1 AND 10),
  cooldown_minutes    smallint NOT NULL DEFAULT 30 CHECK (cooldown_minutes BETWEEN 5 AND 1440),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX geofences_campaign_idx ON geofences(campaign_id);

-- Alerts record only device + geofence + time (for cooldowns, caps and reporting). No coordinates are stored.
CREATE TABLE geofence_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  geofence_id  uuid NOT NULL REFERENCES geofences(id),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id),
  device_id    uuid NOT NULL REFERENCES devices(id),
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  outcome      text CHECK (outcome IN ('SHOWN','OPENED','CLAIMED','DISMISSED','EXPIRED')),
  outcome_at   timestamptz
);
CREATE INDEX geofence_alerts_device_idx ON geofence_alerts(device_id, issued_at);

-- ---------- games and rewards ----------
CREATE TABLE games (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name                text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('MATCHING','MEMORY','TRIVIA','PUZZLE')),
  chance_based        boolean NOT NULL DEFAULT false,
  legal_approval_ref  text,
  config              jsonb NOT NULL,      -- e.g. {minDurationMs, maxScore} or trivia {questions:[{q, options, answer}]}
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Chance-based prize games cannot exist without a recorded legal approval (D-019).
  CHECK (NOT chance_based OR legal_approval_ref IS NOT NULL)
);

CREATE TABLE reward_programs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_org_id    uuid NOT NULL REFERENCES organizations(id),
  campaign_id          uuid REFERENCES campaigns(id),
  game_id              uuid REFERENCES games(id),          -- NULL = any game
  name                 text NOT NULL,
  reward_description   text NOT NULL CHECK (length(reward_description) BETWEEN 3 AND 140),
  face_value_minor     bigint NOT NULL CHECK (face_value_minor >= 0),
  currency             char(3) NOT NULL DEFAULT 'USD',
  total_quantity       integer NOT NULL CHECK (total_quantity > 0),
  min_score            integer NOT NULL DEFAULT 1 CHECK (min_score >= 0),
  per_rider_per_day    smallint NOT NULL DEFAULT 1 CHECK (per_rider_per_day BETWEEN 1 AND 5),
  valid_days           smallint NOT NULL DEFAULT 30 CHECK (valid_days BETWEEN 1 AND 365),
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')),
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE game_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id         uuid NOT NULL REFERENCES games(id),
  device_id       uuid NOT NULL REFERENCES devices(id),
  rider_id        uuid REFERENCES riders(id),           -- NULL = guest play (no rewards)
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  score           integer,
  verdict         text CHECK (verdict IN ('ACCEPTED','REJECTED_IMPLAUSIBLE','EXPIRED')),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX game_sessions_device_idx ON game_sessions(device_id, started_at);

CREATE TABLE reward_grants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id       uuid NOT NULL REFERENCES reward_programs(id),
  rider_id         uuid NOT NULL REFERENCES riders(id),
  game_session_id  uuid NOT NULL UNIQUE REFERENCES game_sessions(id),
  code             text NOT NULL UNIQUE CHECK (code ~ '^[A-Z2-9]{10}$'),
  issued_at        timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  redeemed_at      timestamptz,
  redeemed_via_key uuid REFERENCES integration_keys(id)
);
CREATE INDEX reward_grants_program_idx ON reward_grants(program_id);
CREATE INDEX reward_grants_rider_idx ON reward_grants(rider_id, issued_at);

ALTER TABLE integration_keys DROP CONSTRAINT integration_keys_scopes_check;
ALTER TABLE integration_keys ADD CONSTRAINT integration_keys_scopes_check CHECK (scopes <@ ARRAY['conversions:write','rewards:redeem']::text[] AND cardinality(scopes) > 0);

-- Seed the initial skill games (no prizes by themselves; prizes come only from sponsor reward programs).
INSERT INTO games (slug, name, kind, config) VALUES
  ('memory-match', 'Memory Match', 'MEMORY', '{"minDurationMs": 15000, "maxScore": 1000}'),
  ('picture-pairs', 'Picture Pairs', 'MATCHING', '{"minDurationMs": 10000, "maxScore": 500}'),
  ('slide-puzzle', 'Slide Puzzle', 'PUZZLE', '{"minDurationMs": 20000, "maxScore": 1000}'),
  ('city-trivia', 'City Trivia', 'TRIVIA', '{"minDurationMs": 5000, "questions": [
     {"q": "How many minutes are in two hours?", "options": ["90", "120", "150"], "answer": 1},
     {"q": "Which planet is known as the Red Planet?", "options": ["Mars", "Venus", "Jupiter"], "answer": 0},
     {"q": "What color do you get by mixing blue and yellow?", "options": ["Purple", "Orange", "Green"], "answer": 2}]}');

-- The tablet collects its rider session token exactly once; until then it is held encrypted, then cleared.
ALTER TABLE rider_pairings ADD COLUMN session_token_enc text;
