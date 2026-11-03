-- Double-entry ledger. Amounts are bigint minor units. Posted entries are immutable;
-- corrections are made by reversing entries. Balance is enforced at COMMIT by a deferred
-- constraint trigger, so no transaction can commit an unbalanced entry.

CREATE TABLE ledger_accounts (
  code           text PRIMARY KEY CHECK (code ~ '^[0-9]{4}$'),
  name           text NOT NULL,
  type           text NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
  subledger      text,              -- which party dimension lines on this account must carry, if any
  is_client_liability boolean NOT NULL DEFAULT false, -- funds owed to others; never platform revenue
  is_active      boolean NOT NULL DEFAULT true,
  description    text NOT NULL
);

INSERT INTO ledger_accounts (code, name, type, normal_balance, subledger, is_client_liability, description) VALUES
 ('1000','Cash - operating bank','ASSET','DEBIT',NULL,false,'Settled cash in platform operating account'),
 ('1010','Payment processor clearing','ASSET','DEBIT',NULL,false,'Funds held at processor pending settlement (line.processor identifies processor)'),
 ('1100','Accounts receivable - advertisers','ASSET','DEBIT','ADVERTISER',false,'Invoiced/owed advertiser amounts incl. advertiser-funded commissions'),
 ('1200','Recipient clawback receivable','ASSET','DEBIT','RECIPIENT',false,'Amounts recoverable from creators/drivers after post-payout refunds'),
 ('2000','Advertiser prepaid balances','LIABILITY','CREDIT','ADVERTISER',true,'Advertiser prepayments not yet earned (campaign funding)'),
 ('2100','Sales tax payable','LIABILITY','CREDIT',NULL,true,'Taxes collected on behalf of governments'),
 ('2200','Creator earnings payable','LIABILITY','CREDIT','CREATOR',true,'Allocated creator earnings not yet paid'),
 ('2210','Driver earnings payable','LIABILITY','CREDIT','DRIVER',true,'Allocated driver earnings not yet paid'),
 ('2300','Rewards and coupon liability','LIABILITY','CREDIT','ADVERTISER',true,'Advertiser-funded reward budgets and outstanding redemption obligations'),
 ('2400','Held undistributed pools','LIABILITY','CREDIT',NULL,true,'Pools held pending eligibility/activity/review; never platform revenue until released by rule'),
 ('2500','Payouts in transit','LIABILITY','CREDIT','RECIPIENT',true,'Payouts submitted to provider, awaiting confirmation'),
 ('2600','Refunds payable','LIABILITY','CREDIT','ADVERTISER',true,'Refunds approved but not yet returned'),
 ('2700','Reserves','LIABILITY','CREDIT',NULL,false,'Rolling/chargeback reserves per approved policy'),
 ('3000','Owner contributions','EQUITY','CREDIT',NULL,false,'Paid-in capital'),
 ('3100','Retained earnings','EQUITY','CREDIT',NULL,false,'Accumulated earnings (period close)'),
 ('4000','Platform advertising revenue share','REVENUE','CREDIT',NULL,false,'Platform contractual share of net advertising pools'),
 ('4010','Platform share of unallocated party shares','REVENUE','CREDIT',NULL,false,'Shares redirected to platform because no eligible recipient existed, per signed terms'),
 ('4020','Rounding residual','REVENUE','CREDIT',NULL,false,'Sub-cent residuals from deterministic rounding (policy RESIDUAL_TO_PLATFORM_V1)'),
 ('4100','Platform sales commission revenue share','REVENUE','CREDIT',NULL,false,'Platform share of net advertiser-funded commission pools'),
 ('4200','Driver subscription revenue','REVENUE','CREDIT','DRIVER',false,'$30/month driver participation subscriptions; never enters revenue pools'),
 ('5000','Payment processing fees','EXPENSE','DEBIT',NULL,false,'Fees charged by payment processors'),
 ('5001','Processing fees recovered from pools','EXPENSE','CREDIT',NULL,false,'Contra-expense: contractually permitted fee deductions taken from pools'),
 ('5100','Direct campaign costs','EXPENSE','DEBIT',NULL,false,'Defined direct campaign costs'),
 ('5101','Direct campaign costs recovered from pools','EXPENSE','CREDIT',NULL,false,'Contra-expense: permitted direct cost deductions taken from pools'),
 ('5200','Chargeback losses','EXPENSE','DEBIT',NULL,false,'Unrecovered chargebacks'),
 ('5900','General and administrative overhead','EXPENSE','DEBIT',NULL,false,'Overhead; never deducted from distributable pools');

CREATE TABLE accounting_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start date NOT NULL,
  period_end   date NOT NULL,          -- inclusive
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_by    uuid REFERENCES users(id),
  closed_at    timestamptz,
  CHECK (period_end >= period_start),
  CHECK ((status = 'CLOSED') = (closed_by IS NOT NULL AND closed_at IS NOT NULL)),
  EXCLUDE USING gist (daterange(period_start, period_end, '[]') WITH &&)
);

CREATE FUNCTION accounting_periods_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'accounting periods cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status = 'CLOSED' THEN RAISE EXCEPTION 'closed accounting periods cannot be modified or reopened' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.period_start <> OLD.period_start OR NEW.period_end <> OLD.period_end THEN
    RAISE EXCEPTION 'period boundaries are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounting_periods_guard BEFORE UPDATE OR DELETE ON accounting_periods FOR EACH ROW EXECUTE FUNCTION accounting_periods_guard();

CREATE TABLE journal_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number      bigserial UNIQUE,
  idempotency_key   text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  entry_date        date NOT NULL,
  description       text NOT NULL,
  source_type       text NOT NULL CHECK (source_type IN ('MANUAL','ALLOCATION','PAYMENT','SUBSCRIPTION','PAYOUT','REFUND','CHARGEBACK','REVERSAL','ADJUSTMENT','PERIOD_CLOSE')),
  source_id         text,
  reverses_entry_id uuid UNIQUE REFERENCES journal_entries(id),
  posted_at         timestamptz NOT NULL DEFAULT now(),
  posted_by         uuid REFERENCES users(id),
  approved_by       uuid REFERENCES users(id),
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_txid      bigint NOT NULL DEFAULT txid_current(),
  CHECK (approved_by IS NULL OR posted_by IS NULL OR approved_by <> posted_by),
  CHECK ((source_type = 'REVERSAL') = (reverses_entry_id IS NOT NULL))
);
CREATE INDEX journal_entries_date_idx ON journal_entries(entry_date);
CREATE INDEX journal_entries_source_idx ON journal_entries(source_type, source_id);

CREATE TABLE journal_lines (
  id         bigserial PRIMARY KEY,
  entry_id   uuid NOT NULL REFERENCES journal_entries(id),
  line_no    integer NOT NULL CHECK (line_no > 0),
  account_code text NOT NULL REFERENCES ledger_accounts(code),
  currency   char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  debit      bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit     bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
  party_type text CHECK (party_type IN ('ADVERTISER','CREATOR','DRIVER','RECIPIENT','PLATFORM')),
  party_id   uuid,
  processor  text,
  memo       text,
  CHECK ((debit = 0) <> (credit = 0)),
  CHECK ((party_type IS NULL) = (party_id IS NULL)),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX journal_lines_account_idx ON journal_lines(account_code, currency);
CREATE INDEX journal_lines_party_idx ON journal_lines(party_type, party_id) WHERE party_id IS NOT NULL;

-- Posting window: entries may only be dated inside an OPEN accounting period.
CREATE FUNCTION journal_entries_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounting_periods p WHERE p.status = 'OPEN' AND NEW.entry_date BETWEEN p.period_start AND p.period_end) THEN
    RAISE EXCEPTION 'entry date % is not inside an open accounting period', NEW.entry_date USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_txid := txid_current();
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_period_guard BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION journal_entries_period_guard();

-- Lines may only be added in the same transaction that created the entry, against active accounts,
-- and must carry the party dimension the account's subledger requires.
CREATE FUNCTION journal_lines_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE txid bigint; acct ledger_accounts%ROWTYPE;
BEGIN
  SELECT created_txid INTO txid FROM journal_entries WHERE id = NEW.entry_id;
  IF txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'cannot add lines to an already posted journal entry' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO acct FROM ledger_accounts WHERE code = NEW.account_code;
  IF NOT acct.is_active THEN RAISE EXCEPTION 'account % is inactive', NEW.account_code USING ERRCODE = 'check_violation'; END IF;
  IF acct.subledger IS NOT NULL THEN
    IF NEW.party_id IS NULL THEN
      RAISE EXCEPTION 'account % requires a % party', NEW.account_code, acct.subledger USING ERRCODE = 'check_violation';
    END IF;
    IF acct.subledger <> 'RECIPIENT' AND NEW.party_type <> acct.subledger THEN
      RAISE EXCEPTION 'account % requires party type %, got %', NEW.account_code, acct.subledger, NEW.party_type USING ERRCODE = 'check_violation';
    END IF;
    IF acct.subledger = 'RECIPIENT' AND NEW.party_type NOT IN ('CREATOR','DRIVER') THEN
      RAISE EXCEPTION 'account % requires a CREATOR or DRIVER party', NEW.account_code USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_insert_guard BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION journal_lines_insert_guard();

-- Deferred balance check: at COMMIT every entry must have >= 2 lines and balance per currency.
CREATE FUNCTION journal_entry_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE eid uuid; n integer; bad text;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN eid := NEW.id; ELSE eid := NEW.entry_id; END IF;
  SELECT count(*) INTO n FROM journal_lines WHERE entry_id = eid;
  IF n < 2 THEN RAISE EXCEPTION 'journal entry % must have at least two lines', eid USING ERRCODE = 'check_violation'; END IF;
  SELECT string_agg(currency || ':' || (sum_d - sum_c)::text, ',') INTO bad FROM (
    SELECT currency, sum(debit) AS sum_d, sum(credit) AS sum_c FROM journal_lines WHERE entry_id = eid GROUP BY currency
  ) t WHERE sum_d <> sum_c;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'journal entry % is unbalanced (%)', eid, bad USING ERRCODE = 'check_violation'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_assert_balanced();
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_assert_balanced();

CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_immutable   BEFORE UPDATE OR DELETE ON journal_lines   FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_no_truncate   BEFORE TRUNCATE ON journal_lines   FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Signed balances by account / currency / party (positive = normal-balance direction).
CREATE VIEW ledger_balances AS
SELECT l.account_code, a.name AS account_name, a.type, a.normal_balance, l.currency, l.party_type, l.party_id,
       sum(l.debit) AS total_debit, sum(l.credit) AS total_credit,
       CASE WHEN a.normal_balance = 'DEBIT' THEN sum(l.debit) - sum(l.credit) ELSE sum(l.credit) - sum(l.debit) END AS balance
FROM journal_lines l JOIN ledger_accounts a ON a.code = l.account_code
GROUP BY l.account_code, a.name, a.type, a.normal_balance, l.currency, l.party_type, l.party_id;

-- Manual journal entries always require a second, different approver before posting.
CREATE TABLE journal_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  requested_by    uuid NOT NULL REFERENCES users(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  reason          text NOT NULL CHECK (length(reason) >= 10),
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  decision_note   text,
  journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'APPROVED') = (journal_entry_id IS NOT NULL))
);
CREATE FUNCTION journal_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'journal requests cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status <> 'PENDING' THEN RAISE EXCEPTION 'decided journal requests are immutable' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.payload <> OLD.payload OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'journal request content is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_requests_guard BEFORE UPDATE OR DELETE ON journal_requests FOR EACH ROW EXECUTE FUNCTION journal_requests_guard();
