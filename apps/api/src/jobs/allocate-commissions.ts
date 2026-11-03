/** Scheduled job: allocate attributed commissions whose refund-hold period has passed. Run daily. */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { runCommissionAllocations } from '../modules/commissions/routes.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const r = await runCommissionAllocations(db);
console.log(JSON.stringify(r, null, 2));
await db.end();
if (r.skipped > 0) process.exitCode = 2;
