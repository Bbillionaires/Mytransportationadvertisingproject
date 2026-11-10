/**
 * Nightly consistency check (R-024): compares the trigger-maintained spend counters with an exact recount for every
 * campaign in one consistent snapshot. Any drift is repaired from the events and the job exits non-zero so it alerts.
 */
import { loadConfig } from '../config.js';
import { createPool, withTx } from '../db/pool.js';
import { campaignSpend, campaignSpendRecount } from '../modules/campaigns/budget.js';
import { trackJob } from '../lib/jobStatus.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const r = await trackJob(db, 'verify-spend-counters', async () => {
  const drift: string[] = [];
  let checked = 0;
  const c = await db.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const ids = (await c.query('SELECT id FROM campaigns')).rows.map((r) => r.id as string);
    checked = ids.length;
    const now = new Date();
    const fast = await campaignSpend(c, ids, now), exact = await campaignSpendRecount(c, ids, now);
    const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    for (const id of ids) if (j(fast.get(id)) !== j(exact.get(id))) drift.push(id);
    await c.query('COMMIT');
  } finally { c.release(); }
  for (const id of drift) await withTx(db, (tx) => tx.query('SELECT rmn_rebuild_spend_counters($1)', [id]));
  return { checked, drift: drift.length, campaigns: drift };
}, { isFailure: (x) => (x.drift ? `spend counters drifted for ${x.drift} campaign(s) and were rebuilt; investigate` : null) });
console.log(JSON.stringify({ checked: r.checked, drift: r.drift }));
if (r.drift) { console.error(JSON.stringify({ msg: 'spend counters drifted and were rebuilt', campaigns: r.campaigns })); process.exitCode = 1; }
await db.end();
