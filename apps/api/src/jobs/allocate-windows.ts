/** Scheduled job: allocate closed campaign windows from validated events. Run hourly, after jobs:validate-events. */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { runScheduledAllocations } from '../modules/events/scheduler.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const r = await runScheduledAllocations(db, config);
console.log(JSON.stringify(r, null, 2));
await db.end();
if (r.skipped > 0) process.exitCode = 2; // surface blocked windows to the scheduler's alerting
