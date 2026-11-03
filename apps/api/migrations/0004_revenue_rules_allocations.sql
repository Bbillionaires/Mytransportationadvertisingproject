-- Versioned, effective-dated revenue split rules and immutable allocation batches.

CREATE TABLE revenue_rule_versions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category                  text NOT NULL CHECK (category IN ('CREATOR_CONTENT_AD','STANDALONE_AD','SALES_COMMISSION_WITH_CREATOR','SALES_COMMISSION_NO_CREATOR')),
  version                   integer NOT NULL CHECK (version > 0),
  effective_from            timestamptz NOT NULL,
  effective_to              timestamptz,
  driver_bps                integer NOT NULL CHECK (driver_bps BETWEEN 0 AND 10000),
  creator_bps               integer NOT NULL CHECK (creator_bps BETWEEN 0 AND 10000),
  platform_bps              integer NOT NULL CHECK (platform_bps BETWEEN 0 AND 10000),
  unallocated_driver_share  text NOT NULL CHECK (unallocated_driver_share IN ('TO_PLATFORM','HOLD')),
  unallocated_creator_share text NOT NULL CHECK (unallocated_creator_share IN ('TO_PLATFORM','HOLD')),
  permitted_deductions      text[] NOT NULL DEFAULT ARRAY['PAYMENT_PROCESSING_FEE','DIRECT_CAMPAIGN_COST'],
  eligible_revenue_definition text NOT NULL,
  contract_ref              text NOT NULL,
  status                    text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
  created_by                uuid NOT NULL REFERENCES users(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  approved_by_1             uuid REFERENCES users(id),
  approved_by_2             uuid REFERENCES users(id),
  approved_at               timestamptz,
  UNIQUE (category, version),
  CHECK (driver_bps + creator_bps + platform_bps = 10000),
  CHECK (category NOT IN ('STANDALONE_AD','SALES_COMMISSION_NO_CREATOR') OR creator_bps = 0),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (status = 'DRAFT' OR (approved_by_1 IS NOT NULL AND approved_by_2 IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (approved_by_1 IS NULL OR approved_by_2 IS NULL OR approved_by_1 <> approved_by_2),
  CHECK (approved_by_1 IS NULL OR approved_by_1 <> created_by),
  CHECK (approved_by_2 IS NULL OR approved_by_2 <> created_by),
  EXCLUDE USING gist (category WITH =, tstzrange(effective_from, effective_to) WITH &&) WHERE (status <> 'DRAFT')
);

-- Approved rules are frozen. The only permitted change is closing an open-ended rule at a FUTURE
-- instant (to make room for a superseding version) or retiring it; history can never be rewritten.
CREATE FUNCTION revenue_rule_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'approved rule versions cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'DRAFT' THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW) - 'effective_to' - 'status') <> (to_jsonb(OLD) - 'effective_to' - 'status') THEN
    RAISE EXCEPTION 'approved rule versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    IF OLD.effective_to IS NOT NULL OR NEW.effective_to < now() THEN
      RAISE EXCEPTION 'an approved rule may only be closed once, at a future time' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'APPROVED' AND NEW.status = 'RETIRED') THEN
    RAISE EXCEPTION 'invalid rule status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revenue_rule_versions_guard BEFORE UPDATE OR DELETE ON revenue_rule_versions FOR EACH ROW EXECUTE FUNCTION revenue_rule_versions_guard();

CREATE TABLE allocation_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text NOT NULL UNIQUE,
  category         text NOT NULL,
  rule_version_id  uuid NOT NULL REFERENCES revenue_rule_versions(id),
  currency         char(3) NOT NULL,
  source_type      text NOT NULL CHECK (source_type IN ('CAMPAIGN_SPEND','SALES_COMMISSION')),
  source_ref       text NOT NULL,
  advertiser_org_id uuid NOT NULL REFERENCES organizations(id),
  funding_account  text NOT NULL CHECK (funding_account IN ('2000','1100')),
  period_start     timestamptz NOT NULL,
  period_end       timestamptz NOT NULL,
  gross_receipts   bigint NOT NULL CHECK (gross_receipts >= 0),
  tax_excluded     bigint NOT NULL CHECK (tax_excluded >= 0),
  refunds          bigint NOT NULL CHECK (refunds >= 0),
  credits          bigint NOT NULL CHECK (credits >= 0),
  chargebacks      bigint NOT NULL CHECK (chargebacks >= 0),
  total_deductions bigint NOT NULL CHECK (total_deductions >= 0),
  net              bigint NOT NULL,
  status           text NOT NULL CHECK (status IN ('POSTED','NO_DISTRIBUTION','REVIEW_NEGATIVE_NET')),
  calculation      jsonb NOT NULL,      -- full waterfall, party split, pool scores, policies
  journal_entry_id uuid UNIQUE REFERENCES journal_entries(id),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK ((status = 'POSTED') = (journal_entry_id IS NOT NULL)),
  CHECK (net = gross_receipts - tax_excluded - refunds - credits - chargebacks - total_deductions)
);
CREATE INDEX allocation_batches_source_idx ON allocation_batches(source_type, source_ref);

CREATE TABLE allocation_lines (
  id         bigserial PRIMARY KEY,
  batch_id   uuid NOT NULL REFERENCES allocation_batches(id),
  line_kind  text NOT NULL CHECK (line_kind IN ('DRIVER','CREATOR','PLATFORM','PLATFORM_UNALLOCATED_DRIVER','PLATFORM_UNALLOCATED_CREATOR','ROUNDING','HELD','DEDUCTION')),
  party_id   uuid,
  amount     bigint NOT NULL CHECK (amount >= 0),
  status     text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','PAYABLE','PAID','HELD','REVERSED')),
  basis      jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((line_kind IN ('DRIVER','CREATOR')) = (party_id IS NOT NULL))
);
CREATE INDEX allocation_lines_batch_idx ON allocation_lines(batch_id);
CREATE INDEX allocation_lines_party_idx ON allocation_lines(party_id) WHERE party_id IS NOT NULL;

CREATE TRIGGER allocation_batches_immutable BEFORE UPDATE OR DELETE ON allocation_batches FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- Allocation line amounts/parties are immutable; only the settlement status may advance (Phase 4 payout workflow).
CREATE FUNCTION allocation_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'allocation lines cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'allocation line amounts and parties are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_lines_guard BEFORE UPDATE OR DELETE ON allocation_lines FOR EACH ROW EXECUTE FUNCTION allocation_lines_guard();
