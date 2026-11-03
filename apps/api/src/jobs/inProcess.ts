import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { deliverPendingEmail, LogEmailSender } from '../lib/email.js';
import { runValidation } from '../modules/events/validator.js';
import { processPendingUploads } from '../modules/media/process.js';
import { processPendingWebhooks } from '../modules/payments/webhooks.js';

/**
 * Development convenience (DEV_IN_PROCESS_JOBS=true): run the background jobs inside the API process so a single
 * `npm run dev` gives a working system. Production runs each job separately on a schedule (docs/DEPLOYMENT.md).
 * Money-moving jobs (allocations, commissions) are deliberately not included; run them explicitly.
 */
export function startInProcessJobs(db: Db, config: Config, log: FastifyBaseLogger): () => void {
  if (config.NODE_ENV === 'production') throw new Error('in-process jobs are for development only');
  const email = new LogEmailSender();
  const busy = new Set<string>();
  const every = (name: string, ms: number, fn: () => Promise<unknown>) => setInterval(async () => {
    if (busy.has(name)) return;
    busy.add(name);
    try { await fn(); } catch (e) { log.error({ err: e, job: name }, 'in-process job failed'); } finally { busy.delete(name); }
  }, ms);
  const timers = [
    every('process-media', 3_000, () => processPendingUploads(db, config)),
    every('process-webhooks', 5_000, () => processPendingWebhooks(db)),
    every('send-email', 5_000, () => deliverPendingEmail(db, email)),
    every('validate-events', 15_000, () => runValidation(db, 5000)),
  ];
  log.info('development: background jobs running in-process (media, webhooks, email log, event validation)');
  return () => timers.forEach(clearInterval);
}
