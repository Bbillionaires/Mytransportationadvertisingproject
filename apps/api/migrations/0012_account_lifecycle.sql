-- Account lifecycle: email verification, invitations, password reset, transactional email outbox.

-- Existing and admin-created users are treated as verified (an administrator vouched for the address);
-- self-registration explicitly inserts NULL and must verify.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz DEFAULT now(), ADD COLUMN password_changed_at timestamptz;

ALTER TABLE permissions ADD COLUMN requires_verified_email boolean NOT NULL DEFAULT false;
UPDATE permissions SET requires_verified_email = true
 WHERE code IN ('campaign.manage','billing.manage','creator.manage','media.upload','integrations.manage','org.members.manage','driver.subscription.manage');

CREATE TABLE user_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  purpose     text NOT NULL CHECK (purpose IN ('EMAIL_VERIFY','PASSWORD_RESET')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_tokens_user_idx ON user_tokens(user_id, purpose);

CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  email        citext NOT NULL,
  display_name text NOT NULL,
  role_code    text NOT NULL REFERENCES roles(code),
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid NOT NULL REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_user_id uuid REFERENCES users(id),
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_org_idx ON invitations(org_id);

CREATE TABLE email_outbox (
  id          bigserial PRIMARY KEY,
  to_email    citext NOT NULL,
  template    text NOT NULL,
  subject     text NOT NULL,
  body_text   text,                 -- purged after sending (may contain one-time links)
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX email_outbox_pending_idx ON email_outbox(created_at) WHERE status = 'PENDING';

ALTER TABLE support_impersonations ADD COLUMN ended_at timestamptz, ADD COLUMN ended_by uuid REFERENCES users(id);
