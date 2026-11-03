/** Scheduled job: validate all pending raw events. Run every minute (cron / k8s CronJob). */
import { createPool } from '../db/pool.js';
import { runValidation } from '../modules/events/validator.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createPool(url);
let total = 0;
for (;;) {
  const r = await runValidation(db, 5000);
  total += r.processed;
  if (r.busy) { console.log('another validator is running'); break; }
  if (r.processed === 0) break;
}
console.log(`validated ${total} events`);
await db.end();
