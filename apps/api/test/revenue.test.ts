import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_RULE_SPLITS, REVENUE_CATEGORIES } from '@rmn/finance-core';
import { withTx } from '../src/db/pool.js';
import { postEntry } from '../src/modules/ledger/service.js';
import { ensureOpenPeriod, org, platformOrg, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
let fin: Awaited<ReturnType<typeof userWithRole>>;
let ap1: Awaited<ReturnType<typeof userWithRole>>;
let ap2: Awaited<ReturnType<typeof userWithRole>>;
let advertiser: string;
let creators: string[];
let drivers: { eligible: string[]; pending: string };

beforeAll(async () => {
  ctx = await setupApp();
  await ensureOpenPeriod(ctx.db);
  const p = await platformOrg(ctx.db);
  fin = await userWithRole(ctx, p, 'finance_admin', { mfa: true });
  ap1 = await userWithRole(ctx, p, 'finance_approver', { mfa: true });
  ap2 = await userWithRole(ctx, p, 'finance_approver', { mfa: true });
  for (const cat of REVENUE_CATEGORIES) {
    const s = INITIAL_RULE_SPLITS[cat];
    await ctx.db.query(
      `INSERT INTO revenue_rule_versions (category, version, effective_from, driver_bps, creator_bps, platform_bps, unallocated_driver_share, unallocated_creator_share,
         eligible_revenue_definition, contract_ref, status, created_by, approved_by_1, approved_by_2, approved_at)
       VALUES ($1,1,'2026-01-01T00:00:00Z',$2,$3,$4,'TO_PLATFORM','TO_PLATFORM','validated net revenue (test)','TEST-v1','APPROVED',$5,$6,$7,now())
       ON CONFLICT DO NOTHING`,
      [cat, s.driverBps, s.creatorBps, s.platformBps, fin.userId, ap1.userId, ap2.userId],
    );
  }
  advertiser = await org(ctx.db, 'ADVERTISER');
  const studio = await org(ctx.db, 'CREATOR_STUDIO');
  creators = [];
  for (const n of ['A', 'B']) creators.push((await ctx.db.query(`INSERT INTO creator_profiles (org_id, display_name, monetization_status) VALUES ($1,$2,'ELIGIBLE') RETURNING id`, [studio, n])).rows[0].id);
  const op = await org(ctx.db, 'FLEET_OPERATOR');
  const fleet = (await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'F','Springfield','UTC') RETURNING id`, [op])).rows[0].id;
  const mk = async (status: string) => {
    const u = (await ctx.db.query(`INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','d') RETURNING id`, [`drv-${uid()}@example.test`])).rows[0].id;
    return (await ctx.db.query(`INSERT INTO drivers (org_id, fleet_id, user_id, eligibility_status) VALUES ($1,$2,$3,$4) RETURNING id`, [op, fleet, u, status])).rows[0].id as string;
  };
  drivers = { eligible: [await mk('ELIGIBLE'), await mk('ELIGIBLE')], pending: await mk('PENDING') };
  // Fund the advertiser: $5,000.00 prepaid.
  await withTx(ctx.db, (tx) => postEntry(tx, {
    idempotencyKey: `fund-${advertiser}`, entryDate: '2026-11-01', description: 'prepayment', sourceType: 'PAYMENT',
    lines: [{ accountCode: '1010', currency: 'USD', debit: 500_000n, processor: 'stripe-test' }, { accountCode: '2000', currency: 'USD', credit: 500_000n, partyType: 'ADVERTISER', partyId: advertiser }],
  }));
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

const base = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: `alloc-${uid()}`, kind: 'AD', sourceRef: `campaign-${uid()}:2026-11-01..2026-11-02`, advertiserOrgId: advertiser, fundingAccount: '2000',
  currency: 'USD', periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-11-02T00:00:00Z', entryDate: '2026-11-03',
  grossReceipts: '100000', deductions: [{ type: 'PAYMENT_PROCESSING_FEE', amount: '2930', description: 'card processing', contractRef: 'ADV-MSA-v1 §4.2' }],
  creators: [], drivers: [], ...over,
});
const post = (payload: object) => ctx.app.inject({ method: 'POST', url: '/v1/finance/allocations', headers: fin.h, payload });
const linesOf = async (entryId: string) => (await ctx.db.query('SELECT account_code, debit::text, credit::text, party_id FROM journal_lines WHERE entry_id = $1 ORDER BY line_no', [entryId])).rows;

describe('allocations post balanced, net-based splits to the ledger', () => {
  it('creator-content ad: 5/60/35 of NET, hybrid creator pool, driver pool, ineligible driver excluded, explicit rounding', async () => {
    const r = await post(base({
      creators: [
        { creatorId: creators[0], attributedRevenue: '60000', verifiedWatchSeconds: '3000', qualifiedViews: '40' },
        { creatorId: creators[1], attributedRevenue: '40000', verifiedWatchSeconds: '1000', qualifiedViews: '60' },
      ],
      drivers: [
        { driverId: drivers.eligible[0], monetizedAdDelivery: '300', qualifiedEngagement: '10', eligibleActiveSeconds: '36000' },
        { driverId: drivers.eligible[1], monetizedAdDelivery: '100', qualifiedEngagement: '30', eligibleActiveSeconds: '36000' },
        { driverId: drivers.pending, monetizedAdDelivery: '9999', qualifiedEngagement: '9999', eligibleActiveSeconds: '99999' },
      ],
    }));
    expect(r.statusCode).toBe(201);
    const out = r.json();
    expect(out.status).toBe('POSTED');
    const c = out.calculation;
    expect(c.category).toBe('CREATOR_CONTENT_AD');
    expect(c.waterfall.net).toBe('97070');           // 100000 gross - 2930 permitted fee
    expect(c.partySplit.driver).toBe('4853');        // floor(97070 * 5%)
    expect(c.partySplit.creator).toBe('58242');      // 60%
    expect(c.partySplit.platform).toBe('33974');     // floor(35%)
    expect(c.partySplit.roundingResidual).toBe('1');
    // creator A score = .5*.6 + .3*.75 + .2*.4 = .605 -> 35236.41 ; B = .395 -> 23005.59
    expect(Object.fromEntries(c.creatorPool.shares.map((s: any) => [s.key, s.amount]))).toEqual({ [creators[0]!]: '35236', [creators[1]!]: '23006' });
    expect(c.driverPool.shares.map((s: any) => s.key).sort()).toEqual([...drivers.eligible].sort());
    expect(c.driverPool.shares.reduce((a: bigint, s: any) => a + BigInt(s.amount), 0n)).toBe(4853n);

    const lines = await linesOf(out.journalEntryId);
    const dr = lines.reduce((a, l) => a + BigInt(l.debit), 0n), cr = lines.reduce((a, l) => a + BigInt(l.credit), 0n);
    expect(dr).toBe(100000n);
    expect(cr).toBe(100000n);
    expect(lines.find((l) => l.account_code === '5001')?.credit).toBe('2930');
    expect(lines.find((l) => l.account_code === '4020')?.credit).toBe('1');
    expect(lines.some((l) => l.party_id === drivers.pending)).toBe(false);
    expect(lines.some((l) => l.account_code === '4200')).toBe(false); // subscription revenue is never touched by pools
  });

  it('is idempotent on key, refuses double allocation of the same source, and survives concurrent retries', async () => {
    const payload = base({ creators: [{ creatorId: creators[0], attributedRevenue: '1', verifiedWatchSeconds: '1', qualifiedViews: '1' }] });
    const results = await Promise.all(Array.from({ length: 5 }, () => post(payload)));
    const ids = new Set(results.map((r) => r.json().batchId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const again = await post({ ...payload, idempotencyKey: `alloc-${uid()}` });
    expect(again.statusCode).toBe(409);
    const n = await ctx.db.query('SELECT count(*)::int n FROM journal_entries WHERE source_id = $1', [payload.sourceRef]);
    expect(n.rows[0].n).toBe(1);
  });

  it('standalone commercial: 5/0/95; no eligible driver redirects the 5% to platform per rule', async () => {
    const s = (await post(base({ grossReceipts: '10000', deductions: [], drivers: [{ driverId: drivers.eligible[0], monetizedAdDelivery: '1', qualifiedEngagement: '0', eligibleActiveSeconds: '0' }] }))).json();
    expect(s.calculation.category).toBe('STANDALONE_AD');
    expect([s.calculation.partySplit.driver, s.calculation.partySplit.creator, s.calculation.partySplit.platform]).toEqual(['500', '0', '9500']);
    const n = (await post(base({ grossReceipts: '10000', deductions: [], drivers: [{ driverId: drivers.pending, monetizedAdDelivery: '5', qualifiedEngagement: '5', eligibleActiveSeconds: '5' }] }))).json();
    expect(n.calculation.partySplit.platformFromUnallocatedDriver).toBe('500');
    expect((await linesOf(n.journalEntryId)).find((l) => l.account_code === '4010')?.credit).toBe('500');
  });

  it('sales commission: 15/10/75 with creator, 15/0/85 without; funded from receivable', async () => {
    const w = (await post(base({ kind: 'SALES_COMMISSION', fundingAccount: '1100', sourceRef: `order-${uid()}`, grossReceipts: '2000', deductions: [],
      creators: [{ creatorId: creators[1], attributedRevenue: '2000', verifiedWatchSeconds: '0', qualifiedViews: '0' }],
      drivers: [{ driverId: drivers.eligible[1], monetizedAdDelivery: '1', qualifiedEngagement: '0', eligibleActiveSeconds: '0' }] }))).json();
    expect(w.calculation.category).toBe('SALES_COMMISSION_WITH_CREATOR');
    expect([w.calculation.partySplit.driver, w.calculation.partySplit.creator, w.calculation.partySplit.platform]).toEqual(['300', '200', '1500']);
    const lines = await linesOf(w.journalEntryId);
    expect(lines[0]).toMatchObject({ account_code: '1100', debit: '2000' });
    expect(lines.find((l) => l.account_code === '4100')?.credit).toBe('1500');

    const wo = (await post(base({ kind: 'SALES_COMMISSION', fundingAccount: '1100', sourceRef: `order-${uid()}`, grossReceipts: '2000', deductions: [],
      drivers: [{ driverId: drivers.eligible[1], monetizedAdDelivery: '1', qualifiedEngagement: '0', eligibleActiveSeconds: '0' }] }))).json();
    expect(wo.calculation.category).toBe('SALES_COMMISSION_NO_CREATOR');
    expect([wo.calculation.partySplit.driver, wo.calculation.partySplit.creator, wo.calculation.partySplit.platform]).toEqual(['300', '0', '1700']);
  });

  it('holds the creator pool (liability 2400) when no creator has eligible activity', async () => {
    const r = (await post(base({ grossReceipts: '10000', deductions: [], creators: [{ creatorId: creators[0], attributedRevenue: '0', verifiedWatchSeconds: '0', qualifiedViews: '0' }] }))).json();
    expect(r.calculation.creatorPool.status).toBe('HELD_NO_ACTIVITY');
    expect((await linesOf(r.journalEntryId)).find((l) => l.account_code === '2400')?.credit).toBe('6000');
  });

  it('negative net goes to review with no journal entry; prohibited deductions and missing rules are refused', async () => {
    const neg = await post(base({ grossReceipts: '1000', refunds: '1500', deductions: [] }));
    expect(neg.json().status).toBe('REVIEW_NEGATIVE_NET');
    expect(neg.json().journalEntryId).toBeNull();
    const tax = await post(base({ deductions: [{ type: 'CORPORATE_INCOME_TAX', amount: '100', description: 'x', contractRef: 'x' }] }));
    expect(tax.statusCode).toBe(422);
    expect(tax.json().error.code).toBe('FINANCIAL_RULE_VIOLATION');
    const old = await post(base({ periodStart: '2025-01-01T00:00:00Z', periodEnd: '2025-01-02T00:00:00Z' }));
    expect(old.statusCode).toBe(422);
    expect(old.json().error.message).toMatch(/no single approved/);
  });

  it('refuses to allocate more than the advertiser has prepaid', async () => {
    const r = await post(base({ grossReceipts: '99999999' }));
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/underfunded/);
  });

  it('trial balance stays balanced and payables come from the ledger', async () => {
    const tb = (await ctx.app.inject({ method: 'GET', url: '/v1/finance/trial-balance', headers: fin.h })).json();
    expect(tb.balanced).toBe(true);
    const pay = (await ctx.app.inject({ method: 'GET', url: '/v1/finance/payables', headers: fin.h })).json().items;
    expect(pay.every((p: any) => BigInt(p.balance) > 0n)).toBe(true);
    expect(pay.some((p: any) => p.party_id === drivers.pending)).toBe(false);
  });
});

describe('revenue rule governance', () => {
  const draft = { category: 'STANDALONE_AD', effectiveFrom: '2027-01-01T00:00:00Z', driverBps: 600, creatorBps: 0, platformBps: 9400,
    unallocatedDriverShare: 'TO_PLATFORM', unallocatedCreatorShare: 'TO_PLATFORM', eligibleRevenueDefinition: 'validated net standalone commercial revenue', contractRef: 'DRV-TERMS-v2' };

  it('needs two distinct approvers who are not the drafter; supersedes v1 only from a future date', async () => {
    const d = await ctx.app.inject({ method: 'POST', url: '/v1/finance/revenue-rules', headers: fin.h, payload: draft });
    expect(d.statusCode).toBe(201);
    const id = d.json().id;
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/finance/revenue-rules/${id}/approve`, headers: fin.h, payload: {} })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/finance/revenue-rules/${id}/approve`, headers: ap1.h, payload: {} })).json().approvalsRemaining).toBe(1);
    const same = await ctx.app.inject({ method: 'POST', url: `/v1/finance/revenue-rules/${id}/approve`, headers: ap1.h, payload: {} });
    expect(same.json().error.code).toBe('SEPARATION_OF_DUTIES');
    const fin2 = await ctx.app.inject({ method: 'POST', url: `/v1/finance/revenue-rules/${id}/approve`, headers: ap2.h, payload: {} });
    expect(fin2.json().status).toBe('APPROVED');
    const rules = (await ctx.app.inject({ method: 'GET', url: '/v1/finance/revenue-rules', headers: fin.h })).json().items.filter((r: any) => r.category === 'STANDALONE_AD');
    expect(new Date(rules.find((r: any) => r.version === 1).effective_to).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects splits that do not total 100% and creator shares on standalone ads', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/finance/revenue-rules', headers: fin.h, payload: { ...draft, platformBps: 9300 } })).statusCode).toBe(422);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/finance/revenue-rules', headers: fin.h, payload: { ...draft, creatorBps: 100, platformBps: 9300 } })).statusCode).toBe(422);
  });

  it('approved rules are immutable and overlapping approved rules are impossible', async () => {
    const v1 = (await ctx.db.query(`SELECT id FROM revenue_rule_versions WHERE category = 'CREATOR_CONTENT_AD' AND version = 1`)).rows[0].id;
    await expect(ctx.db.query('UPDATE revenue_rule_versions SET driver_bps = 600, platform_bps = 3400 WHERE id = $1', [v1])).rejects.toThrow(/immutable/);
    await expect(ctx.db.query(`UPDATE revenue_rule_versions SET effective_to = '2026-02-01' WHERE id = $1`, [v1])).rejects.toThrow(/future/);
    await expect(ctx.db.query('DELETE FROM revenue_rule_versions WHERE id = $1', [v1])).rejects.toThrow(/cannot be deleted/);
    await expect(ctx.db.query(
      `INSERT INTO revenue_rule_versions (category, version, effective_from, driver_bps, creator_bps, platform_bps, unallocated_driver_share, unallocated_creator_share, eligible_revenue_definition, contract_ref, status, created_by, approved_by_1, approved_by_2, approved_at)
       VALUES ('CREATOR_CONTENT_AD', 99, '2026-06-01', 500, 6000, 3500, 'TO_PLATFORM','TO_PLATFORM','overlap test','X','APPROVED',$1,$2,$3,now())`,
      [fin.userId, ap1.userId, ap2.userId])).rejects.toThrow(/conflicting key|exclusion/);
  });

  it('a superseding rule dated in the past is refused so history cannot change', async () => {
    const d = await ctx.app.inject({ method: 'POST', url: '/v1/finance/revenue-rules', headers: fin.h, payload: { ...draft, category: 'SALES_COMMISSION_NO_CREATOR', effectiveFrom: '2026-06-01T00:00:00Z', driverBps: 1500, platformBps: 8500 } });
    await ctx.app.inject({ method: 'POST', url: `/v1/finance/revenue-rules/${d.json().id}/approve`, headers: ap1.h, payload: {} });
    const r = await ctx.app.inject({ method: 'POST', url: `/v1/finance/revenue-rules/${d.json().id}/approve`, headers: ap2.h, payload: {} });
    expect(r.statusCode).toBe(409);
  });
});
