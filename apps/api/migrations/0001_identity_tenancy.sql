-- Identity, tenancy, RBAC, sessions, immutable hash-chained audit log.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('PLATFORM','FLEET_OPERATOR','ADVERTISER','CREATOR_STUDIO')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  is_synthetic boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- exactly one platform organization
CREATE UNIQUE INDEX organizations_single_platform ON organizations ((kind)) WHERE kind = 'PLATFORM';

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  password_hash  text NOT NULL,
  display_name   text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  mfa_secret_enc text,            -- AES-256-GCM encrypted TOTP secret
  mfa_enabled    boolean NOT NULL DEFAULT false,
  mfa_last_step  bigint,          -- last accepted TOTP time-step (replay protection)
  failed_logins  integer NOT NULL DEFAULT 0,
  is_synthetic   boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT mfa_enabled OR mfa_secret_enc IS NOT NULL)
);

CREATE TABLE permissions (
  code        text PRIMARY KEY,
  description text NOT NULL,
  requires_mfa boolean NOT NULL DEFAULT false
);

CREATE TABLE roles (
  code        text PRIMARY KEY,
  org_kind    text NOT NULL CHECK (org_kind IN ('PLATFORM','FLEET_OPERATOR','ADVERTISER','CREATOR_STUDIO')),
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles(code),
  permission_code text NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  org_id     uuid NOT NULL REFERENCES organizations(id),
  role_code  text NOT NULL REFERENCES roles(code),
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  UNIQUE (user_id, org_id, role_code)
);
CREATE INDEX memberships_org_idx ON memberships(org_id);

-- A role may only be granted inside an organization of the matching kind.
CREATE FUNCTION memberships_check_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE okind text; rkind text;
BEGIN
  SELECT kind INTO okind FROM organizations WHERE id = NEW.org_id;
  SELECT org_kind INTO rkind FROM roles WHERE code = NEW.role_code;
  IF okind IS DISTINCT FROM rkind THEN
    RAISE EXCEPTION 'role % cannot be granted in a % organization', NEW.role_code, okind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_check_kind BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION memberships_check_kind();

CREATE TABLE sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id),
  token_hash           text NOT NULL UNIQUE,  -- sha256 of the opaque bearer token; the token itself is never stored
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  mfa_verified_at      timestamptz,
  revoked_at           timestamptz,
  ip                   inet,
  user_agent           text,
  impersonator_user_id uuid REFERENCES users(id),
  impersonation_reason text,
  CHECK (impersonator_user_id IS NULL OR impersonation_reason IS NOT NULL)
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Append-only, hash-chained audit log. Each row's hash covers the previous row's hash.
CREATE TABLE audit_log (
  id                   bigserial PRIMARY KEY,
  occurred_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id        uuid,
  actor_device_id      uuid,
  impersonator_user_id uuid,
  org_id               uuid,
  action               text NOT NULL,
  target_type          text,
  target_id            text,
  request_id           text,
  details              jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash            text NOT NULL,
  hash                 text NOT NULL
);
CREATE INDEX audit_log_org_idx ON audit_log(org_id, occurred_at);
CREATE INDEX audit_log_target_idx ON audit_log(target_type, target_id);

CREATE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(7342001);
  SELECT hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := coalesce(prev, 'GENESIS');
  NEW.hash := encode(sha256(convert_to(concat_ws('|',
      NEW.prev_hash, NEW.id::text, NEW.occurred_at::text, NEW.actor_user_id::text, NEW.actor_device_id::text,
      NEW.impersonator_user_id::text, NEW.org_id::text, NEW.action, NEW.target_type, NEW.target_id,
      NEW.request_id, NEW.details::text), 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden: records are immutable', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Support impersonation requires a recorded reason and a hard expiry; every action is audited with both identities.
CREATE TABLE support_impersonations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_user_id  uuid NOT NULL REFERENCES users(id),
  target_user_id   uuid NOT NULL REFERENCES users(id),
  reason           text NOT NULL CHECK (length(reason) >= 10),
  ticket_ref       text NOT NULL,
  session_id       uuid NOT NULL REFERENCES sessions(id),
  started_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  CHECK (support_user_id <> target_user_id),
  CHECK (expires_at <= started_at + interval '30 minutes')
);

-- ---------- seed: permissions & roles ----------
INSERT INTO permissions (code, description, requires_mfa) VALUES
  ('platform.orgs.manage',     'Create and manage organizations', true),
  ('platform.users.manage',    'Create users and grant memberships in any organization', true),
  ('platform.audit.read',      'Read the global audit log', true),
  ('support.impersonate',      'Start a time-boxed, audited support impersonation', true),
  ('org.members.manage',       'Manage members of own organization', false),
  ('fleet.read',               'Read fleets, vehicles and drivers in scope', false),
  ('fleet.manage',             'Create/update fleets, vehicles, drivers in scope', false),
  ('device.read',              'Read device registry and health in scope', false),
  ('device.manage',            'Enroll, assign, retire devices in scope', false),
  ('device.command',           'Send remote commands (suspend, refresh) to devices in scope', false),
  ('finance.read',             'Read ledger, trial balance, allocations', true),
  ('finance.journal.request',  'Request a manual journal entry (requires second approver)', true),
  ('finance.journal.approve',  'Approve a manual journal entry requested by someone else', true),
  ('finance.period.manage',    'Open and close accounting periods', true),
  ('finance.rules.draft',      'Draft revenue split rule versions', true),
  ('finance.rules.approve',    'Approve revenue split rule versions (two distinct approvers required)', true),
  ('finance.allocation.post',  'Post validated allocation batches to the ledger', true),
  ('driver.self.read',         'Driver reads own assignments, earnings and statements', false);

INSERT INTO roles (code, org_kind, description) VALUES
  ('super_admin',       'PLATFORM',       'Global administration; financial actions still require MFA and dual control'),
  ('finance_admin',     'PLATFORM',       'Prepares financial entries, rules and allocations'),
  ('finance_approver',  'PLATFORM',       'Approves financial entries and rules prepared by others'),
  ('support_agent',     'PLATFORM',       'Customer support with audited impersonation'),
  ('fleet_admin',       'FLEET_OPERATOR', 'Manages own fleet vehicles, drivers and devices'),
  ('fleet_viewer',      'FLEET_OPERATOR', 'Read-only fleet metrics'),
  ('driver',            'FLEET_OPERATOR', 'Driver participating in the network'),
  ('advertiser_admin',  'ADVERTISER',     'Manages advertiser account, campaigns and users'),
  ('advertiser_member', 'ADVERTISER',     'Advertiser team member'),
  ('creator_owner',     'CREATOR_STUDIO', 'Owns a creator channel');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'super_admin', code FROM permissions WHERE code NOT IN ('driver.self.read');
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('finance_admin','finance.read'), ('finance_admin','finance.journal.request'), ('finance_admin','finance.rules.draft'),
  ('finance_admin','finance.allocation.post'),
  ('finance_approver','finance.read'), ('finance_approver','finance.journal.approve'), ('finance_approver','finance.rules.approve'),
  ('finance_approver','finance.period.manage'),
  ('support_agent','support.impersonate'), ('support_agent','fleet.read'), ('support_agent','device.read'),
  ('fleet_admin','org.members.manage'), ('fleet_admin','fleet.read'), ('fleet_admin','fleet.manage'),
  ('fleet_admin','device.read'), ('fleet_admin','device.manage'), ('fleet_admin','device.command'),
  ('fleet_viewer','fleet.read'), ('fleet_viewer','device.read'),
  ('driver','driver.self.read'),
  ('advertiser_admin','org.members.manage'),
  ('creator_owner','org.members.manage');
