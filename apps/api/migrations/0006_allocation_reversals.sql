-- Refunds, chargebacks and credits applied to an already-posted allocation batch.
-- Each reversal spreads its amount across the batch's allocation lines in proportion to what remains
-- un-reversed (largest remainder), so cumulative reversals can never exceed what was allocated.

CREATE TABLE allocation_reversals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key   text NOT NULL UNIQUE,
  batch_id          uuid NOT NULL REFERENCES allocation_batches(id),
  type              text NOT NULL CHECK (type IN ('REFUND','CHARGEBACK','CREDIT')),
  amount            bigint NOT NULL CHECK (amount > 0),
  settlement_account text NOT NULL CHECK (settlement_account IN ('2600','1010','2000','1100')),
  processor         text,
  reason            text NOT NULL CHECK (length(reason) >= 10),
  journal_entry_id  uuid NOT NULL UNIQUE REFERENCES journal_entries(id),
  requested_by      uuid NOT NULL REFERENCES users(id),
  approved_by       uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_by <> approved_by),
  CHECK ((type = 'CHARGEBACK') = (settlement_account = '1010')),
  CHECK (type <> 'CHARGEBACK' OR processor IS NOT NULL)
);
CREATE INDEX allocation_reversals_batch_idx ON allocation_reversals(batch_id);

CREATE TABLE allocation_reversal_lines (
  id                 bigserial PRIMARY KEY,
  reversal_id        uuid NOT NULL REFERENCES allocation_reversals(id),
  allocation_line_id bigint NOT NULL REFERENCES allocation_lines(id),
  amount             bigint NOT NULL CHECK (amount > 0),
  clawback           boolean NOT NULL DEFAULT false,  -- share had already been paid: recover via 1200
  UNIQUE (reversal_id, allocation_line_id)
);
CREATE INDEX allocation_reversal_lines_line_idx ON allocation_reversal_lines(allocation_line_id);

-- Database backstop: a line can never be reversed beyond its original amount, and only within its own batch.
CREATE FUNCTION allocation_reversal_lines_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_amount bigint; line_batch uuid; rev_batch uuid; total bigint;
BEGIN
  SELECT amount, batch_id INTO line_amount, line_batch FROM allocation_lines WHERE id = NEW.allocation_line_id FOR UPDATE;
  SELECT batch_id INTO rev_batch FROM allocation_reversals WHERE id = NEW.reversal_id;
  IF line_batch <> rev_batch THEN RAISE EXCEPTION 'reversal line belongs to a different batch' USING ERRCODE = 'check_violation'; END IF;
  SELECT coalesce(sum(amount), 0) + NEW.amount INTO total FROM allocation_reversal_lines WHERE allocation_line_id = NEW.allocation_line_id;
  IF total > line_amount THEN
    RAISE EXCEPTION 'cumulative reversals (%) exceed allocation line % amount (%)', total, NEW.allocation_line_id, line_amount USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_reversal_lines_cap BEFORE INSERT ON allocation_reversal_lines FOR EACH ROW EXECUTE FUNCTION allocation_reversal_lines_cap();

CREATE TRIGGER allocation_reversals_immutable BEFORE UPDATE OR DELETE ON allocation_reversals FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER allocation_reversal_lines_immutable BEFORE UPDATE OR DELETE ON allocation_reversal_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
