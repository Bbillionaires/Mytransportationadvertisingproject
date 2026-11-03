/**
 * Nightly consistency check (R-024): compares the trigger-maintained spend counters with an exact recount for every
 * campaign in one consistent snapshot. Any drift is repaired from the events and the job exits non-zero so it alerts.
 */
import { loadConfig } from '../config.js';
import { createPool, withTx } from '../db/pool.js';
import { campaignSpend, campaignSpendRecount } from '../modules/campaigns/budget.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const drift: string[] = [];
const c = await db.connect();
try {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const ids = (await c.query('SELECT id FROM campaigns')).rows.map((r) => r.id as string);
  const now = new Date();
  const fast = await campaignSpend(c, ids, now), exact = await campaignSpendRecount(c, ids, now);
  for (const id of ids) if (JSON.stringify(fast.get(id), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) !== JSON.stringify(exact.get(id), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) drift.push(id);
  await c.query('COMMIT');
  console.log(JSON.stringify({ checked: ids.length, drift: drift.length }));
} finally { c.release(); }
for (const id of drift) await withTx(db, (tx) => tx.query('SELECT rmn_rebuild_spend_counters($1)', [id]));
if (drift.length) { console.error(JSON.stringify({ msg: 'spend counters drifted and were rebuilt', campaigns: drift })); process.exitCode = 1; }
await db.end();
