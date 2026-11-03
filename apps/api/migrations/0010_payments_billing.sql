-- Payment provider integration (test mode): webhook inbox, driver subscriptions, advertiser prepayments,
-- invoices/receipts, refunds, and reconciliation against provider balance transactions.

CREATE TABLE webhook_inbox (
  id              bigserial PRIMARY KEY,
  provider        text NOT NULL,
  event_id        text NOT NULL,
  type            text NOT NULL,
  livemode        boolean NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
CREATE INDEX webhook_inbox_pending_idx ON webhook_inbox(next_attempt_at) WHERE status IN ('RECEIVED','FAILED');

CREATE TABLE checkout_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL,
  provider_session_id text NOT NULL UNIQUE,
  purpose             text NOT NULL CHECK (purpose IN ('DRIVER_SUBSCRIPTION','ADVERTISER_PREPAYMENT')),
  org_id              uuid REFERENCES organizations(id),
  driver_id           uuid REFERENCES drivers(id),
  amount_minor        bigint,
  currency            char(3) NOT NULL DEFAULT 'USD',
  url                 text NOT NULL,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE driver_subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id                uuid NOT NULL REFERENCES drivers(id),
  provider                 text NOT NULL,
  provider_customer_id     text NOT NULL,
  provider_subscription_id text NOT NULL UNIQUE,
  status                   text NOT NULL CHECK (status IN ('INCOMPLETE','ACTIVE','PAST_DUE','CANCELED')),
  price_minor              bigint NOT NULL,
  currency                 char(3) NOT NULL,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  canceled_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX driver_subscriptions_one_live ON driver_subscriptions(driver_id) WHERE status IN ('ACTIVE','PAST_DUE','INCOMPLETE');

CREATE TABLE payments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                  text NOT NULL,
  purpose                   text NOT NULL CHECK (purpose IN ('ADVERTISER_PREPAYMENT','DRIVER_SUBSCRIPTION')),
  org_id                    uuid REFERENCES organizations(id),
  driver_id                 uuid REFERENCES drivers(id),
  provider_payment_ref      text NOT NULL UNIQUE,     -- payment intent (prepayment) or invoice (subscription)
  provider_charge_id        text UNIQUE,
  currency                  char(3) NOT NULL,
  amount_minor              bigint NOT NULL CHECK (amount_minor > 0),
  tax_minor                 bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  refunded_minor            bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  journal_entry_id          uuid NOT NULL REFERENCES journal_entries(id),
  paid_at                   timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (refunded_minor <= amount_minor),
  CHECK ((purpose = 'ADVERTISER_PREPAYMENT') = (org_id IS NOT NULL)),
  CHECK ((purpose = 'DRIVER_SUBSCRIPTION') = (driver_id IS NOT NULL))
);

CREATE TABLE payment_refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL,
  provider_refund_id text NOT NULL UNIQUE,
  payment_id         uuid NOT NULL REFERENCES payments(id),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  journal_entry_id   uuid NOT NULL REFERENCES journal_entries(id),
  requested_by       uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE invoice_number_seq START 1001;
CREATE TABLE invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             text NOT NULL UNIQUE DEFAULT ('RMN-' || lpad(nextval('invoice_number_seq')::text, 7, '0')),
  kind               text NOT NULL CHECK (kind IN ('PREPAYMENT_RECEIPT','DRIVER_SUBSCRIPTION','PREPAYMENT_REFUND')),
  org_id             uuid REFERENCES organizations(id),
  driver_id          uuid REFERENCES drivers(id),
  payment_id         uuid REFERENCES payments(id),
  currency           char(3) NOT NULL,
  subtotal_minor     bigint NOT NULL,
  tax_minor          bigint NOT NULL DEFAULT 0,
  total_minor        bigint NOT NULL,
  status             text NOT NULL CHECK (status IN ('PAID','REFUNDED','PARTIALLY_REFUNDED','CREDIT_NOTE')),
  lines              jsonb NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (total_minor = subtotal_minor + tax_minor),
  CHECK (org_id IS NOT NULL OR driver_id IS NOT NULL)
);

CREATE TABLE reconciliation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  started_by    uuid NOT NULL REFERENCES users(id),
  summary       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid REFERENCES reconciliation_runs(id),
  provider      text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('UNMATCHED_PROVIDER_TRANSACTION','MISSING_PROVIDER_TRANSACTION','AMOUNT_MISMATCH','BALANCE_MISMATCH','DISPUTE','REFUND_EXCEEDS_AVAILABLE_FUNDS','UNHANDLED_EVENT')),
  provider_ref  text NOT NULL,
  amount_minor  bigint,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  resolution_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, kind, provider_ref)
);

INSERT INTO permissions (code, description, requires_mfa) VALUES
  ('billing.manage',               'Advertiser: buy prepaid balance, view invoices and receipts', false),
  ('driver.subscription.manage',   'Driver: start, view and cancel own $30 participation subscription', false),
  ('finance.reconcile',            'Run payment reconciliation and resolve exceptions; request prepayment refunds', true);
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('advertiser_admin','billing.manage'), ('super_admin','billing.manage'),
  ('driver','driver.subscription.manage'),
  ('finance_admin','finance.reconcile'), ('finance_approver','finance.reconcile'), ('super_admin','finance.reconcile');

-- Processor refunds are approved before the ledger can post (it posts on the processor's confirmation webhook),
-- so an approved PREPAYMENT_REFUND request carries the processor refund id instead of a journal entry.
ALTER TABLE journal_requests ADD COLUMN provider_ref text;
ALTER TABLE journal_requests DROP CONSTRAINT journal_requests_check1;
ALTER TABLE journal_requests ADD CONSTRAINT journal_requests_approved_outcome CHECK (
  CASE WHEN payload->>'kind' = 'PREPAYMENT_REFUND'
       THEN (status = 'APPROVED') = (provider_ref IS NOT NULL) AND journal_entry_id IS NULL
       ELSE (status = 'APPROVED') = (journal_entry_id IS NOT NULL) END);
