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
  { name: 'backup-media', everyMs: 5 * 60_000, run: () => runBackups(db, config), next: 0 },
];

log({ msg: 'worker started', jobs: jobs.map((j) => `${j.name}/${j.everyMs / 1000}s`) });
while (!stopping) {
  const now = Date.now();
  for (const j of jobs) {
    if (stopping || now < j.next) continue;
    const t0 = Date.now();
    try {
      const r = await j.run();
      if (r && typeof r === 'object' && Object.values(r).some((v) => typeof v === 'number' && v > 0)) log({ job: j.name, ms: Date.now() - t0, result: r });
    } catch (e) {
      log({ job: j.name, level: 'error', error: (e as Error).message.slice(0, 500) });
    }
    j.next = Date.now() + j.everyMs;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
await db.end();
