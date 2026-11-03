import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { HttpError } from '../../lib/errors.js';
import { postWindow } from './aggregate.js';

export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Scheduled allocation: for every campaign with valid ad events not yet covered by a window, allocate one
 * window from the end of its last window (or its start) to the latest whole hour that closed at least
 * ALLOCATION_SETTLE_MINUTES ago. Windows that are blocked (unvalidated or held events) or fail (closed period,
 * missing rule) are skipped and reported; nothing is forced. Automated windows apply no deductions (D-038).
 */
export async function runScheduledAllocations(db: Db, config: Config, opts: { now?: Date; actorUserId?: string } = {}) {
  const now = opts.now ?? new Date();
  const grain = config.ALLOCATION_WINDOW_MINUTES * 60_000;
  const cutoff = new Date(Math.floor((now.getTime() - config.ALLOCATION_SETTLE_MINUTES * 60_000) / grain) * grain);
  const due = await db.query(
    `SELECT c.id, c.starts_at, (SELECT max(period_end) FROM allocation_windows w WHERE w.campaign_id = c.id) AS last_end
       FROM campaigns c
      WHERE EXISTS (SELECT 1 FROM validated_events v WHERE v.campaign_id = c.id AND v.status = 'VALID' AND v.occurred_at < $1
                      AND NOT EXISTS (SELECT 1 FROM allocation_windows w WHERE w.campaign_id = c.id AND tstzrange(w.period_start, w.period_end) @> v.occurred_at))
      ORDER BY c.id`, [cutoff]);
  const results: Array<{ campaignId: string; periodStart?: string; periodEnd?: string; status: 'ALLOCATED' | 'SKIPPED'; reason?: string; windowId?: string }> = [];
  for (const c of due.rows) {
    const start = new Date(c.last_end ?? c.starts_at);
    if (start >= cutoff) { results.push({ campaignId: c.id, status: 'SKIPPED', reason: 'no closed period since last window' }); continue; }
    const w = { campaignId: c.id, periodStart: start.toISOString(), periodEnd: cutoff.toISOString(), entryDate: new Date(cutoff.getTime() - 1).toISOString().slice(0, 10),
      idempotencyKey: `auto:${c.id}:${start.toISOString()}:${cutoff.toISOString()}`, deductions: [] };
    try {
      const out = await withTx(db, async (tx) => {
        const r = await postWindow(tx, w, opts.actorUserId ?? SYSTEM_USER_ID, config.ALLOCATION_SETTLE_MINUTES);
        if (!r.idempotent) await audit(tx, { userId: opts.actorUserId ?? SYSTEM_USER_ID }, 'finance.window_allocated_scheduled', { type: 'allocation_window', id: r.windowId }, { campaignId: c.id, periodStart: w.periodStart, periodEnd: w.periodEnd });
        return r;
      });
      results.push({ campaignId: c.id, periodStart: w.periodStart, periodEnd: w.periodEnd, status: 'ALLOCATED', windowId: out.windowId });
    } catch (e) {
      const reason = e instanceof HttpError ? e.message : `${(e as Error).message}`.slice(0, 300);
      results.push({ campaignId: c.id, periodStart: w.periodStart, periodEnd: w.periodEnd, status: 'SKIPPED', reason });
    }
  }
  return { cutoff: cutoff.toISOString(), allocated: results.filter((r) => r.status === 'ALLOCATED').length, skipped: results.filter((r) => r.status === 'SKIPPED').length, results };
}
