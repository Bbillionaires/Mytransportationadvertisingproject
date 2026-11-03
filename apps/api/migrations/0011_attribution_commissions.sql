-- Advertiser-funded sales commissions: offers, unique coupon/QR codes, integration API keys,
-- conversions with explicit attribution, and refunds.

CREATE TABLE commission_offers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id          uuid NOT NULL REFERENCES campaigns(id),
  advertiser_org_id    uuid NOT NULL REFERENCES organizations(id),
  name                 text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('PERCENT_OF_SALE','FIXED_PER_SALE')),
  rate_bps             integer CHECK (rate_bps BETWEEN 1 AND 10000),
  fixed_minor          bigint CHECK (fixed_minor > 0),
  currency             char(3) NOT NULL DEFAULT 'USD',
  product_sku          text,                       -- null = any product
  coupon_enabled       boolean NOT NULL DEFAULT true,
  coupon_description   text,
  click_window_hours   integer NOT NULL DEFAULT 168 CHECK (click_window_hours BETWEEN 1 AND 2160),
  coupon_window_hours  integer NOT NULL DEFAULT 720 CHECK (coupon_window_hours BETWEEN 1 AND 2160),
  hold_days            integer NOT NULL DEFAULT 14 CHECK (hold_days BETWEEN 0 AND 120),
  valid_from           timestamptz NOT NULL,
  valid_to             timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')),
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'PERCENT_OF_SALE') = (rate_bps IS NOT NULL)),
  CHECK ((kind = 'FIXED_PER_SALE') = (fixed_minor IS NOT NULL)),
  CHECK (valid_to > valid_from)
);
CREATE INDEX commission_offers_campaign_idx ON commission_offers(campaign_id);
-- Offer terms are frozen once created; only ending the offer (or shortening it) is allowed.
CREATE FUNCTION commission_offers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'commission offers cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'valid_to') <> (to_jsonb(OLD) - 'status' - 'valid_to') OR NEW.valid_to > OLD.valid_to OR (OLD.status = 'ENDED' AND NEW.status <> 'ENDED') THEN
    RAISE EXCEPTION 'commission offer terms are immutable; end it and create a new offer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_offers_guard BEFORE UPDATE OR DELETE ON commission_offers FOR EACH ROW EXECUTE FUNCTION commission_offers_guard();

CREATE TABLE coupon_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE CHECK (code ~ '^[A-Z2-9]{10}$'),
  offer_id          uuid NOT NULL REFERENCES commission_offers(id),
  campaign_id       uuid NOT NULL REFERENCES campaigns(id),
  device_id         uuid NOT NULL REFERENCES devices(id),
  driver_id         uuid REFERENCES drivers(id),
  creator_id        uuid REFERENCES creator_profiles(id),
  video_id          uuid REFERENCES videos(id),
  issued_at         timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  redeemed_at       timestamptz
);
CREATE INDEX coupon_codes_device_idx ON coupon_codes(device_id, campaign_id, issued_at);

CREATE TABLE integration_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  name          text NOT NULL,
  prefix        text NOT NULL UNIQUE,
  key_hash      text NOT NULL,
  scopes        text[] NOT NULL CHECK (scopes <@ ARRAY['conversions:write']::text[] AND cardinality(scopes) > 0),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

CREATE TABLE conversions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_org_id     uuid NOT NULL REFERENCES organizations(id),
  order_id              text NOT NULL CHECK (length(order_id) BETWEEN 1 AND 200),
  offer_id              uuid REFERENCES commission_offers(id),
  campaign_id           uuid REFERENCES campaigns(id),
  touch_type            text NOT NULL CHECK (touch_type IN ('COUPON','CLICK','NONE')),
  click_event_id        bigint REFERENCES validated_events(id),
  coupon_code_id        uuid UNIQUE REFERENCES coupon_codes(id),       -- one conversion per code
  device_id             uuid REFERENCES devices(id),
  driver_id             uuid REFERENCES drivers(id),
  creator_id            uuid REFERENCES creator_profiles(id),
  currency              char(3) NOT NULL,
  sale_amount_minor     bigint NOT NULL CHECK (sale_amount_minor > 0),
  refunded_sale_minor   bigint NOT NULL DEFAULT 0 CHECK (refunded_sale_minor >= 0),
  commission_minor      bigint NOT NULL DEFAULT 0 CHECK (commission_minor >= 0),
  product_sku           text,
  status                text NOT NULL CHECK (status IN ('ATTRIBUTED','UNATTRIBUTED','FULLY_REFUNDED')),
  attribution_reason    text NOT NULL,
  occurred_at           timestamptz NOT NULL,
  received_at           timestamptz NOT NULL DEFAULT now(),
  allocatable_after     timestamptz,
  allocation_batch_id   uuid REFERENCES allocation_batches(id),
  integration_key_id    uuid REFERENCES integration_keys(id),
  UNIQUE (advertiser_org_id, order_id),
  CHECK (refunded_sale_minor <= sale_amount_minor),
  CHECK ((touch_type = 'CLICK') = (click_event_id IS NOT NULL)),
  CHECK ((touch_type = 'COUPON') = (coupon_code_id IS NOT NULL))
);
CREATE INDEX conversions_allocatable_idx ON conversions(allocatable_after) WHERE status = 'ATTRIBUTED' AND allocation_batch_id IS NULL;

CREATE TABLE conversion_refunds (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversion_id            uuid NOT NULL REFERENCES conversions(id),
  refund_ref               text NOT NULL,
  sale_amount_minor        bigint NOT NULL CHECK (sale_amount_minor > 0),
  commission_reduction_minor bigint NOT NULL CHECK (commission_reduction_minor >= 0),
  journal_request_id       uuid REFERENCES journal_requests(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversion_id, refund_ref)
);

INSERT INTO permissions (code, description, requires_mfa) VALUES ('integrations.manage', 'Create and revoke API keys for own organization', false);
INSERT INTO role_permissions (role_code, permission_code) VALUES ('advertiser_admin','integrations.manage'), ('super_admin','integrations.manage');
