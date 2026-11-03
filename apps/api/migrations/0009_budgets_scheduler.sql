-- Campaign budgets (delivery controls, editable while live) and a system identity for scheduled jobs.
ALTER TABLE campaigns
  ADD COLUMN total_budget_minor bigint CHECK (total_budget_minor IS NULL OR total_budget_minor > 0),
  ADD COLUMN daily_budget_minor bigint CHECK (daily_budget_minor IS NULL OR daily_budget_minor > 0);

CREATE INDEX validated_events_campaign_status_idx ON validated_events(campaign_id, status) WHERE campaign_id IS NOT NULL AND type = 'AD_PLAYBACK';

-- Non-login identity recorded as the actor for automated postings (scheduled allocation windows).
INSERT INTO users (id, email, password_hash, display_name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'system-scheduler@rmn.invalid', '!', 'System scheduler', 'DISABLED');
