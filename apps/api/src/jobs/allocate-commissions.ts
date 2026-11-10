/** Scheduled job: allocate attributed commissions whose refund-hold period has passed. Run daily. */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { runCommissionAllocations } from '../modules/commissions/routes.js';
import { trackJob } from '../lib/jobStatus.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const r = await trackJob(db, 'allocate-commissions', () => runCommissionAllocations(db),
  { isFailure: (x) => (x.skipped > 0 ? `${x.skipped} commission(s) could not be allocated` : null) });
console.log(JSON.stringify(r, null, 2));
await db.end();
if (r.skipped > 0) process.exitCode = 2;
