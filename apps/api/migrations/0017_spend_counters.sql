-- Incremental per-campaign spend counters (R-024). Budget checks (playlist, validator, balances) read these instead of
-- recounting every validated play. They are maintained by triggers, so every code path updates them, and are exact:
--   * billable plays per campaign per campaign-local day (VALID + HELD_REVIEW plays that are billable under the
--     campaign's pricing: qualified views for CPQV, impressions for CPM — the same rule as COUNTABLE in budget.ts);
--   * billable plays inside allocated windows. Windows are allocated only when no held plays remain in them and no
--     new valid plays can enter an allocated window (LATE_AFTER_ALLOCATION), so this count is final when written.
CREATE TABLE campaign_spend_daily (
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  day         date NOT NULL,                 -- in the campaign's time zone
  billable    bigint NOT NULL DEFAULT 0 CHECK (billable >= 0),
  PRIMARY KEY (campaign_id, day)
);
CREATE TABLE campaign_spend_allocated (
  campaign_id uuid PRIMARY KEY REFERENCES campaigns(id),
  billable    bigint NOT NULL DEFAULT 0 CHECK (billable >= 0)
);

CREATE FUNCTION rmn_play_billable(pricing text, qualified boolean, impression boolean) RETURNS boolean LANGUAGE sql IMMUTABLE AS
  $$ SELECT CASE WHEN pricing = 'CPQV' THEN qualified ELSE impression END $$;

CREATE FUNCTION rmn_spend_counter_bump(p_campaign uuid, p_at timestamptz, p_delta int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO campaign_spend_daily (campaign_id, day, billable)
  SELECT p_campaign, (p_at AT TIME ZONE c.timezone)::date, p_delta FROM campaigns c WHERE c.id = p_campaign
  ON CONFLICT (campaign_id, day) DO UPDATE SET billable = campaign_spend_daily.billable + EXCLUDED.billable;
END $$;

CREATE FUNCTION rmn_spend_counters_on_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pricing text; was boolean := false; now_ boolean := false;
BEGIN
  IF NEW.type <> 'AD_PLAYBACK' OR NEW.campaign_id IS NULL THEN RETURN NEW; END IF;
  SELECT pricing_model INTO pricing FROM campaigns WHERE id = NEW.campaign_id;
  now_ := NEW.status IN ('VALID','HELD_REVIEW') AND rmn_play_billable(pricing, NEW.qualified, NEW.impression);
  IF TG_OP = 'UPDATE' THEN was := OLD.status IN ('VALID','HELD_REVIEW') AND rmn_play_billable(pricing, OLD.qualified, OLD.impression); END IF;
  IF now_ = was THEN RETURN NEW; END IF;
  PERFORM rmn_spend_counter_bump(NEW.campaign_id, NEW.occurred_at, CASE WHEN now_ THEN 1 ELSE -1 END);
  -- A late play inside an already-allocated window (held as LATE_AFTER_ALLOCATION, never billable) belongs to that
  -- window's count, exactly as the recount treats it.
  IF EXISTS (SELECT 1 FROM allocation_windows w WHERE w.campaign_id = NEW.campaign_id AND tstzrange(w.period_start, w.period_end) @> NEW.occurred_at) THEN
    INSERT INTO campaign_spend_allocated (campaign_id, billable) VALUES (NEW.campaign_id, CASE WHEN now_ THEN 1 ELSE -1 END)
    ON CONFLICT (campaign_id) DO UPDATE SET billable = campaign_spend_allocated.billable + EXCLUDED.billable;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spend_counters AFTER INSERT OR UPDATE OF status ON validated_events FOR EACH ROW EXECUTE FUNCTION rmn_spend_counters_on_event();

CREATE FUNCTION rmn_spend_counters_on_window() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO campaign_spend_allocated (campaign_id, billable)
  SELECT NEW.campaign_id, count(*) FROM validated_events v JOIN campaigns c ON c.id = v.campaign_id
   WHERE v.campaign_id = NEW.campaign_id AND v.type = 'AD_PLAYBACK' AND v.status IN ('VALID','HELD_REVIEW')
     AND rmn_play_billable(c.pricing_model, v.qualified, v.impression) AND tstzrange(NEW.period_start, NEW.period_end) @> v.occurred_at
  ON CONFLICT (campaign_id) DO UPDATE SET billable = campaign_spend_allocated.billable + EXCLUDED.billable;
  RETURN NEW;
END $$;
CREATE TRIGGER spend_counters AFTER INSERT ON allocation_windows FOR EACH ROW EXECUTE FUNCTION rmn_spend_counters_on_window();

-- Rebuild one campaign's counters from its events (used when a re-editable campaign changes pricing or time zone,
-- by the backfill below, and by the consistency check job).
CREATE FUNCTION rmn_rebuild_spend_counters(p_campaign uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM campaign_spend_daily WHERE campaign_id = p_campaign;
  DELETE FROM campaign_spend_allocated WHERE campaign_id = p_campaign;
  INSERT INTO campaign_spend_daily (campaign_id, day, billable)
  SELECT v.campaign_id, (v.occurred_at AT TIME ZONE c.timezone)::date, count(*) FROM validated_events v JOIN campaigns c ON c.id = v.campaign_id
   WHERE v.campaign_id = p_campaign AND v.type = 'AD_PLAYBACK' AND v.status IN ('VALID','HELD_REVIEW') AND rmn_play_billable(c.pricing_model, v.qualified, v.impression)
   GROUP BY 1, 2;
  INSERT INTO campaign_spend_allocated (campaign_id, billable)
  SELECT p_campaign, count(*) FROM validated_events v JOIN campaigns c ON c.id = v.campaign_id
   WHERE v.campaign_id = p_campaign AND v.type = 'AD_PLAYBACK' AND v.status IN ('VALID','HELD_REVIEW') AND rmn_play_billable(c.pricing_model, v.qualified, v.impression)
     AND EXISTS (SELECT 1 FROM allocation_windows w WHERE w.campaign_id = v.campaign_id AND tstzrange(w.period_start, w.period_end) @> v.occurred_at);
END $$;

CREATE FUNCTION rmn_spend_counters_on_campaign() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pricing_model IS DISTINCT FROM OLD.pricing_model OR NEW.timezone IS DISTINCT FROM OLD.timezone THEN PERFORM rmn_rebuild_spend_counters(NEW.id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER spend_counters AFTER UPDATE OF pricing_model, timezone ON campaigns FOR EACH ROW EXECUTE FUNCTION rmn_spend_counters_on_campaign();

-- Backfill existing campaigns.
DO $$ DECLARE c uuid; BEGIN FOR c IN SELECT id FROM campaigns LOOP PERFORM rmn_rebuild_spend_counters(c); END LOOP; END $$;
