import type { FastifyInstance } from 'fastify';
import { authorize } from '../../auth/context.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { mediaStores } from '../../lib/objectStore.js';

/**
 * System health for the platform owner (portal → System health): background jobs, money integrity, backups and the
 * launch checklist, in plain language with what to do. Read-only. Complements /metrics (for machines).
 */
export type HealthStatus = 'ok' | 'warn' | 'fail' | 'todo';
export interface HealthCheck { id: string; group: 'Background jobs' | 'Money' | 'Media and backups' | 'Tablets' | 'Launch checklist'; title: string; status: HealthStatus; detail: string; action?: string }

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** How often each job runs and how stale "last success" may get before it is a problem. */
export const JOBS: Array<{ job: string; title: string; every: string; maxAgeMs: number; when?: (c: Config) => boolean }> = [
  { job: 'process-media', title: 'Video processing (worker)', every: 'every 5 seconds', maxAgeMs: 5 * MIN },
  { job: 'validate-events', title: 'Ad play validation', every: 'every 30 seconds', maxAgeMs: 10 * MIN },
  { job: 'send-email', title: 'Outgoing email queue', every: 'every 15 seconds', maxAgeMs: 10 * MIN },
  { job: 'process-webhooks', title: 'Payment notifications', every: 'every 15 seconds', maxAgeMs: 10 * MIN, when: (c) => c.PAYMENTS_PROVIDER !== 'disabled' },
  { job: 'backup-media', title: 'Copy new videos to the AWS backup', every: 'every 5 minutes', maxAgeMs: 20 * MIN },
  { job: 'verify-media', title: 'Daily check of every video and its backups', every: 'daily', maxAgeMs: 26 * HOUR },
  { job: 'allocate-windows', title: 'Revenue split for ad plays', every: 'hourly', maxAgeMs: 2 * HOUR },
  { job: 'allocate-commissions', title: 'Sales commissions', every: 'daily', maxAgeMs: 26 * HOUR },
  { job: 'verify-spend-counters', title: 'Advertiser spend totals check', every: 'nightly', maxAgeMs: 26 * HOUR },
  { job: 'check-attestation-roots', title: 'Google tablet-security certificates', every: 'weekly', maxAgeMs: 8 * DAY },
];

const ago = (ms: number) => ms < 2 * MIN ? 'just now' : ms < 2 * HOUR ? `${Math.round(ms / MIN)} minutes ago` : ms < 2 * DAY ? `${Math.round(ms / HOUR)} hours ago` : `${Math.round(ms / DAY)} days ago`;

export async function systemHealth(db: Db, config: Config, now = new Date()) {
  const checks: HealthCheck[] = [];
  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0] ?? {};
  const n = async (sql: string, p: unknown[] = []) => Number((await one(sql, p)).v ?? 0);

  // --- Background jobs -------------------------------------------------------------------------------------------
  const rows = new Map((await db.query('SELECT * FROM job_status')).rows.map((r) => [r.job as string, r]));
  const deployedAt = Number((await one(`SELECT extract(epoch FROM min(last_started_at)) * 1000 AS t FROM job_status`)).t ?? now.getTime());
  for (const j of JOBS) {
    if (j.when && !j.when(config)) continue;
    const r = rows.get(j.job);
    const base = { id: `job:${j.job}`, group: 'Background jobs' as const, title: j.title };
    if (!r?.last_started_at) {
      // A daily/weekly job that hasn't had its first turn yet is expected right after setup.
      const young = now.getTime() - deployedAt < j.maxAgeMs;
      checks.push({ ...base, status: young ? 'todo' : 'fail', detail: `Hasn't run yet (runs ${j.every}).`,
        action: young ? undefined : 'Check this service is deployed and its schedule is set in Railway (docs/RAILWAY_DEPLOY.md).' });
      continue;
    }
    const okAge = r.last_ok_at ? now.getTime() - new Date(r.last_ok_at).getTime() : Infinity;
    if (r.consecutive_failures > 0) {
      checks.push({ ...base, status: 'fail', detail: `Failing (${r.consecutive_failures} time${r.consecutive_failures > 1 ? 's' : ''} in a row, last ${ago(now.getTime() - new Date(r.last_failed_at).getTime())}): ${String(r.last_error ?? '').slice(0, 300)}`,
        action: 'Open this service’s logs in Railway, or ask for help with the error above.' });
    } else if (okAge > j.maxAgeMs) {
      checks.push({ ...base, status: 'fail', detail: `Last succeeded ${r.last_ok_at ? ago(okAge) : 'never'}; it should run ${j.every}.`,
        action: j.job === 'process-media' ? 'The worker seems to be stopped. In Railway, open the worker service and restart it.' : 'Check the service and its schedule in Railway.' });
    } else {
      checks.push({ ...base, status: 'ok', detail: `Last succeeded ${ago(okAge)} (runs ${j.every}).` });
    }
  }

  // --- Money ------------------------------------------------------------------------------------------------------
  const unbalanced = await n(`SELECT count(*) v FROM (SELECT currency FROM journal_lines GROUP BY currency HAVING sum(debit) <> sum(credit)) t`);
  checks.push({ id: 'ledger-balanced', group: 'Money', title: 'Ledger balances (debits equal credits)', status: unbalanced ? 'fail' : 'ok',
    detail: unbalanced ? `${unbalanced} currency total(s) don’t balance.` : 'Every currency balances.', action: unbalanced ? 'Stop payouts and investigate before anything else (docs/LEDGER.md).' : undefined });
  const recon = await n(`SELECT count(*) v FROM reconciliation_exceptions WHERE status = 'OPEN'`);
  checks.push({ id: 'reconciliation', group: 'Money', title: 'Reconciliation exceptions', status: recon ? 'warn' : 'ok',
    detail: recon ? `${recon} open.` : 'None open.', action: recon ? 'Review them in Finance.' : undefined });
  const journals = await n(`SELECT count(*) v FROM journal_requests WHERE status = 'PENDING'`);
  if (journals) checks.push({ id: 'journals', group: 'Money', title: 'Journal entries waiting for a second approver', status: 'warn', detail: `${journals} waiting.`, action: 'A different finance approver should review them.' });
  const failedHooks = await n(`SELECT count(*) v FROM webhook_inbox WHERE status = 'FAILED'`);
  if (failedHooks) checks.push({ id: 'webhooks', group: 'Money', title: 'Payment notifications that failed', status: 'fail', detail: `${failedHooks} failed.`, action: 'Investigate before trusting balances.' });

  // --- Media and backups ------------------------------------------------------------------------------------------
  const backups = mediaStores(config).backups;
  const stuck = await n(`SELECT count(*) v FROM media_uploads WHERE status IN ('UPLOADED','PROCESSING') AND created_at < now() - interval '30 minutes'`);
  checks.push({ id: 'media-processing', group: 'Media and backups', title: 'Uploads waiting to be processed', status: stuck ? 'warn' : 'ok',
    detail: stuck ? `${stuck} upload(s) waiting more than 30 minutes.` : 'Nothing stuck.', action: stuck ? 'Check the worker is running.' : undefined });
  // Only the worker holds the backup keys, so on the API the backup jobs' records are the evidence.
  const unbacked = await n(`SELECT count(*) v FROM media_uploads u WHERE u.original_key IS NOT NULL AND u.created_at < now() - interval '30 minutes'
                              AND NOT EXISTS (SELECT 1 FROM media_backups b WHERE b.upload_id = u.id)`);
  const backupRan = rows.get('backup-media')?.last_ok_at;
  const backupTargets = Number(rows.get('backup-media')?.last_summary?.targets ?? 0) || backups.length;
  checks.push({ id: 'backups', group: 'Media and backups', title: 'Every video has a locked backup copy', status: unbacked ? 'fail' : backupTargets ? 'ok' : 'todo',
    detail: unbacked ? `${unbacked} video(s) older than 30 minutes have no backup copy.` : backupTargets ? 'All videos are backed up.' : backupRan ? 'The backup job runs, but no backup bucket is connected.' : 'No backup has run yet.',
    action: unbacked ? 'Check the worker’s BACKUP1_* variables and logs (docs/MEDIA_STORAGE.md).' : undefined });
  const audit = await one(`SELECT jsonb_array_length(problems) AS problems FROM media_audit_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`);
  if (Number(audit.problems ?? 0) > 0) checks.push({ id: 'media-audit', group: 'Media and backups', title: 'Last video audit', status: 'fail', detail: `${audit.problems} problem(s) found.`, action: 'See the worker logs for the list; restore with jobs:restore-media.' });

  // --- Tablets ----------------------------------------------------------------------------------------------------
  const active = await n(`SELECT count(*) v FROM devices WHERE status = 'ACTIVE'`);
  const online = await n(`SELECT count(*) v FROM devices WHERE status = 'ACTIVE' AND last_heartbeat_at > now() - interval '10 minutes'`);
  checks.push({ id: 'tablets', group: 'Tablets', title: 'Tablets online', status: active === 0 ? 'todo' : online === 0 ? 'fail' : online < active ? 'warn' : 'ok',
    detail: active === 0 ? 'No tablets enrolled yet.' : `${online} of ${active} online in the last 10 minutes.`,
    action: active === 0 ? 'A fleet adds tablets from its portal (Add a tablet).' : online < active ? 'Fleets see which ones are offline on their Tablets page.' : undefined });

  // --- Launch checklist -------------------------------------------------------------------------------------------
  const todo = (id: string, title: string, done: boolean, doneText: string, todoText: string, action?: string, warnOnly = false) =>
    checks.push({ id, group: 'Launch checklist', title, status: done ? 'ok' : warnOnly ? 'warn' : 'todo', detail: done ? doneText : todoText, action: done ? undefined : action });
  const approved = (await db.query(`SELECT DISTINCT category FROM revenue_rule_versions WHERE status = 'APPROVED' AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())`)).rows.map((r) => r.category as string);
  const cats = ['CREATOR_CONTENT_AD', 'STANDALONE_AD', 'SALES_COMMISSION_WITH_CREATOR', 'SALES_COMMISSION_NO_CREATOR'];
  const missing = cats.filter((c) => !approved.includes(c));
  todo('revenue-rules', 'Revenue split rules approved', missing.length === 0, 'All four categories have an approved rule in effect.',
    `${missing.length} of 4 categories have no approved rule yet. Ad revenue can’t be split until they do.`, 'Finance → Revenue rules: draft each one, then two different approvers sign off with the contract reference.');
  const staffNoMfa = await n(`SELECT count(DISTINCT u.id) v FROM users u JOIN memberships m ON m.user_id = u.id JOIN organizations o ON o.id = m.org_id
                               WHERE o.kind = 'PLATFORM' AND m.status = 'ACTIVE' AND u.status = 'ACTIVE' AND NOT u.mfa_enabled`);
  todo('staff-mfa', 'All staff use two-step verification', staffNoMfa === 0, 'Everyone on the platform team has it on.', `${staffNoMfa} staff member(s) haven’t turned it on.`, 'Each person: Security → Set up two-step verification.', true);
  todo('backup-configured', 'Locked backup bucket connected', backupTargets > 0, `Connected (${backupTargets} backup bucket${backupTargets > 1 ? 's' : ''}).`, 'No backup bucket is configured.', 'docs/MEDIA_STORAGE.md');
  todo('email', 'Email sending', config.EMAIL_PROVIDER !== 'log', `Connected (${config.EMAIL_PROVIDER === 'smtp' ? `Google Workspace / SMTP via ${config.SMTP_HOST}` : 'Resend'}).`,
    'Not connected: invitations and password resets aren’t delivered yet (staff can copy links meanwhile).', 'Google Workspace: set EMAIL_PROVIDER=smtp with SMTP_USER, SMTP_PASSWORD (an App Password) and EMAIL_FROM on the worker (docs/RAILWAY_DEPLOY.md).');
  todo('payments', 'Payments', config.PAYMENTS_PROVIDER !== 'disabled', 'Enabled (test mode).', 'Off for now (advertisers can’t add funds). Planned last.', 'Choose a processor (DECISIONS D-026).');
  todo('attestation', 'Only hardware-verified tablets', config.DEVICE_ATTESTATION === 'required', 'Required network-wide.', 'Optional: web-browser players are still accepted (fleets can require it themselves).', 'Switch DEVICE_ATTESTATION to required once every tablet runs the Android app (D-059).');

  const rank: Record<HealthStatus, number> = { fail: 3, warn: 2, todo: 1, ok: 0 };
  const worst = checks.reduce<HealthStatus>((w, c) => (c.group !== 'Launch checklist' && rank[c.status] > rank[w] ? c.status : w), 'ok');
  return { generatedAt: now.toISOString(), overall: worst === 'todo' ? 'ok' : worst, checks };
}

export async function healthRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  app.get('/v1/platform/health', async (req) => {
    await authorize(db, req, 'platform.health.read');
    return systemHealth(db, config);
  });
}
