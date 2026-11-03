import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { postEntry } from '../src/modules/ledger/service.js';
import { ensureOpenPeriod, org, platformOrg, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
let advertiser: string;
beforeAll(async () => {
  ctx = await setupApp();
  await ensureOpenPeriod(ctx.db);
  advertiser = await org(ctx.db, 'ADVERTISER');
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

const prepay = (key: string, amount: bigint) => ({
  idempotencyKey: key, entryDate: '2026-11-03', description: 'advertiser prepayment', sourceType: 'PAYMENT' as const,
  lines: [
    { accountCode: '1010', currency: 'USD', debit: amount, processor: 'stripe-test' },
    { accountCode: '2000', currency: 'USD', credit: amount, partyType: 'ADVERTISER' as const, partyId: advertiser },
  ],
});

describe('ledger integrity (database-enforced)', () => {
  it('posts a balanced entry', async () => {
    const e = await withTx(ctx.db, (tx) => postEntry(tx, prepay(`pp-${uid()}`, 100_000n)));
    const lines = await ctx.db.query('SELECT debit, credit FROM journal_lines WHERE entry_id = $1', [e.id]);
    expect(lines.rows).toHaveLength(2);
  });

  it('rejects an unbalanced entry at COMMIT even when application validation is bypassed', async () => {
    const c = await ctx.db.connect();
    try {
      await c.query('BEGIN');
      const e = await c.query(`INSERT INTO journal_entries (idempotency_key, entry_date, description, source_type) VALUES ($1,'2026-11-03','x','MANUAL') RETURNING id`, [`raw-${uid()}`]);
      await c.query(`INSERT INTO journal_lines (entry_id, line_no, account_code, currency, debit) VALUES ($1,1,'1000','USD',100)`, [e.rows[0].id]);
      await c.query(`INSERT INTO journal_lines (entry_id, line_no, account_code, currency, credit) VALUES ($1,2,'3000','USD',99)`, [e.rows[0].id]);
      await expect(c.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally { c.release(); }
  });

  it('rejects multi-currency entries that do not balance per currency', async () => {
    await expect(withTx(ctx.db, async (tx) => {
      const e = await tx.query(`INSERT INTO journal_entries (idempotency_key, entry_date, description, source_type) VALUES ($1,'2026-11-03','x','MANUAL') RETURNING id`, [`fx-${uid()}`]);
      await tx.query(`INSERT INTO journal_lines (entry_id, line_no, account_code, currency, debit) VALUES ($1,1,'1000','USD',100)`, [e.rows[0].id]);
      await tx.query(`INSERT INTO journal_lines (entry_id, line_no, account_code, currency, credit) VALUES ($1,2,'3000','CAD',100)`, [e.rows[0].id]);
    })).rejects.toThrow(/unbalanced/);
  });

  it('posted entries and lines are immutable and cannot be extended later', async () => {
    const e = await withTx(ctx.db, (tx) => postEntry(tx, prepay(`pp-${uid()}`, 500n)));
    await expect(ctx.db.query('UPDATE journal_lines SET debit = 1 WHERE entry_id = $1', [e.id])).rejects.toThrow(/immutable/);
    await expect(ctx.db.query('DELETE FROM journal_entries WHERE id = $1', [e.id])).rejects.toThrow(/immutable/);
    await expect(ctx.db.query('TRUNCATE journal_lines')).rejects.toThrow();
    await expect(withTx(ctx.db, (tx) => tx.query(`INSERT INTO journal_lines (entry_id, line_no, account_code, currency, debit) VALUES ($1,9,'1000','USD',1)`, [e.id]))).rejects.toThrow(/already posted/);
  });

  it('requires the subledger party dimension on party accounts', async () => {
    await expect(withTx(ctx.db, (tx) => postEntry(tx, {
      idempotencyKey: `np-${uid()}`, entryDate: '2026-11-03', description: 'x', sourceType: 'PAYMENT',
      lines: [{ accountCode: '1010', currency: 'USD', debit: 1n }, { accountCode: '2000', currency: 'USD', credit: 1n }],
    }))).rejects.toThrow(/requires a ADVERTISER party/);
  });

  it('is idempotent on key and rejects key reuse with different content', async () => {
    const key = `idem-${uid()}`;
    const a = await withTx(ctx.db, (tx) => postEntry(tx, prepay(key, 700n)));
    const b = await withTx(ctx.db, (tx) => postEntry(tx, prepay(key, 700n)));
    expect(b).toEqual({ ...a, idempotent: true });
    await expect(withTx(ctx.db, (tx) => postEntry(tx, prepay(key, 701n)))).rejects.toThrow(/different journal entry/);
    const n = await ctx.db.query('SELECT count(*)::int n FROM journal_entries WHERE idempotency_key = $1', [key]);
    expect(n.rows[0].n).toBe(1);
  });

  it('concurrent posts with the same key produce exactly one entry', async () => {
    const key = `race-${uid()}`;
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => withTx(ctx.db, (tx) => postEntry(tx, prepay(key, 900n)))));
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = new Set(results.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(1);
  });

  it('refuses entries outside an open period, and closed periods cannot reopen', async () => {
    await expect(withTx(ctx.db, (tx) => postEntry(tx, { ...prepay(`old-${uid()}`, 1n), entryDate: '2025-06-01' }))).rejects.toThrow(/open accounting period/);
    const p = await ctx.db.query(`INSERT INTO accounting_periods (period_start, period_end) VALUES ('2025-01-01','2025-01-31') RETURNING id`);
    const u = (await ctx.db.query(`INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','closer') RETURNING id`, [`closer-${uid()}@example.test`])).rows[0].id;
    await ctx.db.query(`UPDATE accounting_periods SET status = 'CLOSED', closed_by = $2, closed_at = now() WHERE id = $1`, [p.rows[0].id, u]);
    await expect(withTx(ctx.db, (tx) => postEntry(tx, { ...prepay(`closed-${uid()}`, 1n), entryDate: '2025-01-15' }))).rejects.toThrow(/open accounting period/);
    await expect(ctx.db.query(`UPDATE accounting_periods SET status = 'OPEN', closed_by = NULL, closed_at = NULL WHERE id = $1`, [p.rows[0].id])).rejects.toThrow(/cannot be modified or reopened/);
  });
});

describe('manual journal entries: dual control', () => {
  it('requester cannot approve; a different approver posts it; reversal mirrors it exactly once', async () => {
    const p = await platformOrg(ctx.db);
    const preparer = await userWithRole(ctx, p, 'finance_admin', { mfa: true });
    const approver = await userWithRole(ctx, p, 'finance_approver', { mfa: true });
    const req = await ctx.app.inject({
      method: 'POST', url: '/v1/finance/journal-requests', headers: preparer.h,
      payload: { idempotencyKey: `jr-${uid()}`, entryDate: '2026-11-03', description: 'Owner capital contribution', reason: 'Initial capitalization per board resolution (synthetic)',
        lines: [{ accountCode: '1000', currency: 'USD', debit: '1000000' }, { accountCode: '3000', currency: 'USD', credit: '1000000' }] },
    });
    expect(req.statusCode).toBe(201);
    const id = req.json().id;

    // finance_admin lacks approve permission entirely; a super_admin who requested would be blocked by separation of duties.
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/finance/journal-requests/${id}/decision`, headers: preparer.h, payload: { decision: 'APPROVE' } })).statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: 'POST', url: `/v1/finance/journal-requests/${id}/decision`, headers: approver.h, payload: { decision: 'APPROVE' } });
    expect(ok.statusCode).toBe(200);
    const entryId = ok.json().journal_entry_id;
    const entry = (await ctx.app.inject({ method: 'GET', url: `/v1/finance/journal-entries/${entryId}`, headers: approver.h })).json();
    expect(entry.posted_by).toBe(preparer.userId);
    expect(entry.approved_by).toBe(approver.userId);
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/finance/journal-requests/${id}/decision`, headers: approver.h, payload: { decision: 'APPROVE' } })).statusCode).toBe(409);

    const rr = await ctx.app.inject({ method: 'POST', url: `/v1/finance/journal-entries/${entryId}/reversal-requests`, headers: preparer.h, payload: { idempotencyKey: `rv-${uid()}`, entryDate: '2026-11-03', reason: 'Entered against the wrong account' } });
    const rok = await ctx.app.inject({ method: 'POST', url: `/v1/finance/journal-requests/${rr.json().id}/decision`, headers: approver.h, payload: { decision: 'APPROVE' } });
    expect(rok.statusCode).toBe(200);
    const rev = (await ctx.app.inject({ method: 'GET', url: `/v1/finance/journal-entries/${rok.json().journal_entry_id}`, headers: approver.h })).json();
    expect(rev.reverses_entry_id).toBe(entryId);
    expect(rev.lines.map((l: any) => [l.account_code, l.debit, l.credit])).toEqual([['1000', '0', '1000000'], ['3000', '1000000', '0']]);

    const rr2 = await ctx.app.inject({ method: 'POST', url: `/v1/finance/journal-entries/${entryId}/reversal-requests`, headers: preparer.h, payload: { idempotencyKey: `rv-${uid()}`, entryDate: '2026-11-03', reason: 'Trying to reverse twice' } });
    const twice = await ctx.app.inject({ method: 'POST', url: `/v1/finance/journal-requests/${rr2.json().id}/decision`, headers: approver.h, payload: { decision: 'APPROVE' } });
    expect(twice.statusCode).toBe(409);
  });

  it('a super admin who requests an entry still cannot approve it', async () => {
    const p = await platformOrg(ctx.db);
    const sa = await userWithRole(ctx, p, 'super_admin', { mfa: true });
    const req = await ctx.app.inject({ method: 'POST', url: '/v1/finance/journal-requests', headers: sa.h, payload: { idempotencyKey: `jr-${uid()}`, entryDate: '2026-11-03', description: 'test entry', reason: 'reason long enough', lines: [{ accountCode: '1000', currency: 'USD', debit: '1' }, { accountCode: '3000', currency: 'USD', credit: '1' }] } });
    const d = await ctx.app.inject({ method: 'POST', url: `/v1/finance/journal-requests/${req.json().id}/decision`, headers: sa.h, payload: { decision: 'APPROVE' } });
    expect(d.statusCode).toBe(403);
    expect(d.json().error.code).toBe('SEPARATION_OF_DUTIES');
  });

  it('rejects unbalanced manual requests up front', async () => {
    const preparer = await userWithRole(ctx, await platformOrg(ctx.db), 'finance_admin', { mfa: true });
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/finance/journal-requests', headers: preparer.h, payload: { idempotencyKey: `jr-${uid()}`, entryDate: '2026-11-03', description: 'test entry', reason: 'reason long enough', lines: [{ accountCode: '1000', currency: 'USD', debit: '2' }, { accountCode: '3000', currency: 'USD', credit: '1' }] } });
    expect(r.statusCode).toBe(422);
  });
});
