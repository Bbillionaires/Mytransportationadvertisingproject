import { expect } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { campaignSpend, campaignSpendRecount } from '../src/modules/campaigns/budget.js';

/** Counters (migration 0017) must equal an exact recount for every campaign, read in one consistent snapshot. */
export async function expectSpendCountersExact(db: Db, at = new Date()) {
  const c = await db.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const ids = (await c.query('SELECT id FROM campaigns')).rows.map((r) => r.id as string);
    const fast = await campaignSpend(c, ids, at), exact = await campaignSpendRecount(c, ids, at);
    for (const id of ids) expect({ id, ...fast.get(id) }).toEqual({ id, ...exact.get(id) });
    await c.query('COMMIT');
    return ids.length;
  } finally { c.release(); }
}
