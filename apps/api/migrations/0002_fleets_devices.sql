-- Fleets, vehicles, drivers, tablets. Composite (id, org_id) keys make cross-tenant references impossible.
CREATE TABLE fleets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  market     text NOT NULL,
  timezone   text NOT NULL,
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, name)
);

CREATE TABLE vehicles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  fleet_id    uuid NOT NULL,
  label       text NOT NULL,           -- operator's internal unit number; no VIN/plate stored by default
  make_model  text,
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','OUT_OF_SERVICE','RETIRED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (fleet_id, org_id) REFERENCES fleets(id, org_id),
  UNIQUE (id, org_id),
  UNIQUE (fleet_id, label)
);
CREATE INDEX vehicles_org_idx ON vehicles(org_id);

CREATE TABLE drivers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  fleet_id           uuid NOT NULL,
  user_id            uuid NOT NULL REFERENCES users(id),
  -- Eligibility to receive pool earnings; set by onboarding (subscription active, payout KYC, agreement signed).
  eligibility_status text NOT NULL DEFAULT 'PENDING' CHECK (eligibility_status IN ('PENDING','ELIGIBLE','SUSPENDED','TERMINATED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (fleet_id, org_id) REFERENCES fleets(id, org_id),
  UNIQUE (id, org_id),
  UNIQUE (user_id, org_id)
);
CREATE INDEX drivers_fleet_idx ON drivers(fleet_id);

CREATE TABLE devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  serial             text NOT NULL UNIQUE,
  label              text,
  public_key_der     bytea NOT NULL,      -- Ed25519 SubjectPublicKeyInfo; private key never leaves the tablet
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','RETIRED')),
  app_version        text,
  os_version         text,
  storage_free_bytes bigint,
  connectivity       text,
  last_heartbeat_at  timestamptz,
  last_sync_at       timestamptz,
  enrolled_at        timestamptz NOT NULL DEFAULT now(),
  enrolled_via       uuid,
  UNIQUE (id, org_id)
);
CREATE INDEX devices_org_idx ON devices(org_id);

CREATE TABLE device_enrollment_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  code_hash   text NOT NULL UNIQUE,
  label       text,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  device_id   uuid REFERENCES devices(id)
);

CREATE TABLE device_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  device_id  uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  driver_id  uuid,
  starts_at  timestamptz NOT NULL DEFAULT now(),
  ends_at    timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  FOREIGN KEY (device_id, org_id)  REFERENCES devices(id, org_id),
  FOREIGN KEY (vehicle_id, org_id) REFERENCES vehicles(id, org_id),
  FOREIGN KEY (driver_id, org_id)  REFERENCES drivers(id, org_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  -- a device can be in only one vehicle at a time, and a vehicle holds one passenger tablet at a time
  EXCLUDE USING gist (device_id WITH =, tstzrange(starts_at, ends_at) WITH &&),
  EXCLUDE USING gist (vehicle_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
);

CREATE TABLE device_nonces (
  device_id uuid NOT NULL REFERENCES devices(id),
  nonce     text NOT NULL,
  seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX device_nonces_seen_idx ON device_nonces(seen_at);

CREATE TABLE device_heartbeats (
  id          bigserial PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES devices(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  device_time timestamptz NOT NULL,
  payload     jsonb NOT NULL
);
CREATE INDEX device_heartbeats_device_idx ON device_heartbeats(device_id, received_at DESC);

CREATE TABLE device_commands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  device_id   uuid NOT NULL,
  command     text NOT NULL CHECK (command IN ('REFRESH_PLAYBACK','SUSPEND','RESUME','UPDATE_CONFIG','PURGE_RIDER_DATA')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','ACKED','FAILED','EXPIRED')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  acked_at    timestamptz,
  result      jsonb,
  FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
);
CREATE INDEX device_commands_pending_idx ON device_commands(device_id) WHERE status IN ('PENDING','DELIVERED');

-- Minimal creator profile so allocations can reference eligible creators (full channel model arrives in Phase 2).
CREATE TABLE creator_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  display_name        text NOT NULL,
  monetization_status text NOT NULL DEFAULT 'PENDING' CHECK (monetization_status IN ('PENDING','ELIGIBLE','SUSPENDED','TERMINATED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
