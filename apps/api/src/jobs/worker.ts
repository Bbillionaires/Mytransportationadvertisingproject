/**
 * Always-on production worker (one Railway service, same image as the API): runs the frequent background jobs in a
 * loop — media processing, media backups, payment webhooks, outgoing email, event validation. Each job runs on its own
 * cadence, never overlaps itself, and logs failures without stopping the others. Money-moving allocations and the
 * nightly integrity checks run as separate scheduled (cron) services. See docs/RAILWAY_DEPLOY.md.
 *   npm run jobs:worker -w @rmn/api
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { deliverPendingEmail, emailSender } from '../lib/email.js';
import { runValidation } from '../modules/events/validator.js';
import { runBackups } from '../modules/media/backup.js';
import { processPendingUploads } from '../modules/media/process.js';
import { processPendingWebhooks } from '../modules/payments/webhooks.js';
import { bootstrapFromEnv } from '../modules/platform/bootstrap.js';
import { rotateEncryptedValues } from '../modules/platform/rotateKeys.js';
import { trackJob } from '../lib/jobStatus.js';
import { ensureMediaCors } from '../lib/objectStore.js';
import { verifyMedia } from '../modules/media/backup.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const email = emailSender(config); // EMAIL_PROVIDER=resend in production (D-044)
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true; log({ msg: 'worker stopping', sig }); });

const jobs: Array<{ name: string; everyMs: number; run: () => Promise<unknown>; next: number }> = [
  { name: 'process-media', everyMs: 5_000, run: () => processPendingUploads(db, config), next: 0 },
  { name: 'validate-events', everyMs: 30_000, run: () => runValidation(db, 5000), next: 0 },
  { name: 'process-webhooks', everyMs: 15_000, run: () => (config.PAYMENTS_PROVIDER === 'disabled' ? Promise.resolve() : processPendingWebhooks(db)), next: 0 },
  { name: 'send-email', everyMs: 15_000, run: () => deliverPendingEmail(db, email), next: 0 },
  { name: 'backup-media', everyMs: 5 * 60_000, next: 0, run: async () => {
    // Flattened so System health can see how many backup buckets are connected (only this service holds their keys).
    const r = Object.values(await runBackups(db, config));
    const s = { targets: r.length, copied: r.reduce((n, x) => n + x.copied, 0), failed: r.reduce((n, x) => n + x.failed, 0) };
    if (s.failed) throw new Error(`${s.failed} video(s) could not be copied to the backup this round (will retry)`);
    return s;
  } },
  // Nightly media audit here (not a cron service) because only this service holds the backup keys. Problems are logged
  // as errors; a monthly deep re-hash stays a manual/cron run (jobs:verify-media -- --deep).
  { name: 'verify-media', everyMs: 24 * 3600_000, next: Date.now() + 10 * 60_000, run: async () => {
    const r = await verifyMedia(db, config, { deep: false });
    if (r.problems.length || r.backups.length === 0) throw new Error(`media audit: ${r.problems.length} problem(s), ${r.backups.length} backup(s): ${JSON.stringify(r.problems.slice(0, 5))}`);
    return { checked: r.checked, repaired: r.repaired };
  } },
];

// First admin without a terminal (docs/RAILWAY_DEPLOY.md): BOOTSTRAP_ADMIN_EMAIL on this service.
const boot = await bootstrapFromEnv(db, config, process.env);
if (boot.status === 'link') log({ msg: 'FIRST ADMIN: open this single-use link within 30 minutes to choose your password, then remove BOOTSTRAP_ADMIN_EMAIL', link: boot.link });
else if (boot.status === 'refused') log({ msg: 'first-admin setup skipped', reason: boot.reason });

// Key rotation without a terminal (docs/KEY_ROTATION.md): while APP_ENCRYPTION_KEY_PREVIOUS is set, move every stored
// secret to the current key on start, and say when the previous key can be removed.
if (config.APP_ENCRYPTION_KEY_PREVIOUS) {
  try {
    const r = await rotateEncryptedValues(db, config);
    const done = r.remaining === 0 && r.unreadable === 0;
    log({ msg: done ? 'KEY ROTATION complete: every secret uses the current key; you can now delete APP_ENCRYPTION_KEY_PREVIOUS'
      : 'KEY ROTATION incomplete: keep APP_ENCRYPTION_KEY_PREVIOUS', level: done ? 'info' : 'error', result: r });
  } catch (e) { log({ msg: 'KEY ROTATION failed: keep APP_ENCRYPTION_KEY_PREVIOUS', level: 'error', error: (e as Error).message }); }
}

// Media bucket CORS for the tablet player's offline cache, kept in step with APP_PUBLIC_URL (no command needed).
await trackJob(db, 'media-cors', () => ensureMediaCors(config))
  .then((r) => log({ msg: r.applied ? 'media bucket CORS set' : 'media bucket CORS skipped', ...r }))
  .catch((e) => log({ msg: 'media bucket CORS failed (tablets stream but cannot cache offline)', level: 'error', error: (e as Error).message.slice(0, 300) }));

log({ msg: 'worker started', jobs: jobs.map((j) => `${j.name}/${j.everyMs / 1000}s`) });
while (!stopping) {
  const now = Date.now();
  for (const j of jobs) {
    if (stopping || now < j.next) continue;
    const t0 = Date.now();
    try {
      const r = await trackJob(db, j.name, j.run);
      if (r && typeof r === 'object' && Object.values(r).some((v) => typeof v === 'number' && v > 0)) log({ job: j.name, ms: Date.now() - t0, result: r });
    } catch (e) {
      log({ job: j.name, level: 'error', error: (e as Error).message.slice(0, 500) });
    }
    j.next = Date.now() + j.everyMs;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
await db.end();
