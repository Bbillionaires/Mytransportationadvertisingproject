-- One row per background job: when it last ran, succeeded and failed (System health page, no logs needed).
CREATE TABLE job_status (
  job                  text PRIMARY KEY,
  last_started_at      timestamptz,
  last_finished_at     timestamptz,
  last_ok_at           timestamptz,
  last_failed_at       timestamptz,
  last_error           text,
  last_summary         jsonb,
  consecutive_failures integer NOT NULL DEFAULT 0
);

INSERT INTO permissions (code, description, requires_mfa) VALUES
  ('platform.health.read', 'See system health: background jobs, backups, ledger balance, setup checklist', false);
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('super_admin', 'platform.health.read'), ('finance_admin', 'platform.health.read'), ('finance_approver', 'platform.health.read');
