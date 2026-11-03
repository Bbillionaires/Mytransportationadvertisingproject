import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_RULE_SPLITS, REVENUE_CATEGORIES } from '@rmn/finance-core';
import { withTx } from '../src/db/pool.js';
import { postEntry } from '../src/modules/ledger/service.js';
import { ensureOpenPeriod, org, platformOrg, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

type User = Awaited<ReturnType<typeof userWithRole>>;
let ctx: Ctx;
let fin: User, approver: User;
let advertiser: string, creatorA: string, creatorB: string, d1: string, d2: string;
let batch: { batchId: string; journalEntryId: string };

const today = '2026-11-03';
const api = (method: 'GET' | 'POST', url: string, h: object, payload?: object) => ctx.app.inject({ method, url, headers: h as any, payload });
const balance = async (account: string, partyId: string | null) =>
  BigInt((await ctx.db.query(`SELECT coalesce(sum(balance), 0)::text b FROM ledger_balances WHERE account_code = $1 AND ($2::uuid IS NULL OR party_id = $2)`, [account, partyId])).rows[0].b);

async function requestAndApprove(batchId: string, body: Record<string, unknown>) {
  const r = await api('POST', `/v1/finance/allocations/${batchId}/reversal-requests`, fin.h, { idempotencyKey: `rv-${uid()}`, entryDate: today, ...body });
  if (r.statusCode !== 201) return { request: r, decision: null };
  const decision = await api('POST', `/v1/finance/journal-requests/${r.json().request.id}/decision`, approver.h, { decision: 'APPROVE' });
  return { request: r, decision };
}

beforeAll(async () => {
  ctx = await setupApp();
  await ensureOpenPeriod(ctx.db);
  const p = await platformOrg(ctx.db);
  fin = await userWithRole(ctx, p, 'finance_admin', { mfa: true });
  approver = await userWithRole(ctx, p, 'finance_approver', { mfa: true });
  const ap2 = await userWithRole(ctx, p, 'finance_approver', { mfa: true });
  for (const cat of REVENUE_CATEGORIES) {
    const s = INITIAL_RULE_SPLITS[cat];
    await ctx.db.query(
      `INSERT INTO revenue_rule_versions (category, version, effective_from, driver_bps, creator_bps, platform_bps, unallocated_driver_share, unallocated_creator_share,
         eligible_revenue_definition, contract_ref, status, created_by, approved_by_1, approved_by_2, approved_at)
       SELECT $1,1,'2026-01-01T00:00:00Z',$2,$3,$4,'TO_PLATFORM','TO_PLATFORM','validated net revenue (test)','TEST-v1','APPROVED',$5,$6,$7,now()
       WHERE NOT EXISTS (SELECT 1 FROM revenue_rule_versions WHERE category = $1)`,
      [cat, s.driverBps, s.creatorBps, s.platformBps, fin.userId, approver.userId, ap2.userId]);
  }
  advertiser = await org(ctx.db, 'ADVERTISER');
  await withTx(ctx.db, (tx) => postEntry(tx, { idempotencyKey: `fund-${advertiser}`, entryDate: today, description: 'prepayment', sourceType: 'PAYMENT',
    lines: [{ accountCode: '1010', currency: 'USD', debit: 500_000n, processor: 'stripe-test' }, { accountCode: '2000', currency: 'USD', credit: 500_000n, partyType: 'ADVERTISER', partyId: advertiser }] }));
  const studio = await org(ctx.db, 'CREATOR_STUDIO');
  const creator = async () => (await ctx.db.query(`INSERT INTO creator_profiles (org_id, display_name, monetization_status) VALUES ($1,'c','ELIGIBLE') RETURNING id`, [studio])).rows[0].id;
  creatorA = await creator(); creatorB = await creator();
  const op = await org(ctx.db, 'FLEET_OPERATOR');
  const fleet = (await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'F','M','UTC') RETURNING id`, [op])).rows[0].id;
  const driver = async () => {
    const u = (await ctx.db.query(`INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','d') RETURNING id`, [`d-${uid()}@example.test`])).rows[0].id;
    return (await ctx.db.query(`INSERT INTO drivers (org_id, fleet_id, user_id, eligibility_status) VALUES ($1,$2,$3,'ELIGIBLE') RETURNING id`, [op, fleet, u])).rows[0].id;
  };
  d1 = await driver(); d2 = await driver();
  // Same scenario as docs/LEDGER.md §5.2: lines 2930 fee, 2730 + 2123 drivers, 35236 + 23006 creators, 33974 platform, 1 rounding = 100000.
  const r = await api('POST', '/v1/finance/allocations', fin.h, {
    idempotencyKey: `alloc-${uid()}`, kind: 'AD', sourceRef: `campaign-${uid()}`, advertiserOrgId: advertiser, fundingAccount: '2000', currency: 'USD',
    periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-11-02T00:00:00Z', entryDate: today, grossReceipts: '100000',
    deductions: [{ type: 'PAYMENT_PROCESSING_FEE', amount: '2930', description: 'card', contractRef: 'ADV-MSA-v1 §4.2' }],
    creators: [{ creatorId: creatorA, attributedRevenue: '60000', verifiedWatchSeconds: '3000', qualifiedViews: '40' }, { creatorId: creatorB, attributedRevenue: '40000', verifiedWatchSeconds: '1000', qualifiedViews: '60' }],
    drivers: [{ driverId: d1, monetizedAdDelivery: '300', qualifiedEngagement: '10', eligibleActiveSeconds: '36000' }, { driverId: d2, monetizedAdDelivery: '100', qualifiedEngagement: '30', eligibleActiveSeconds: '36000' }],
  });
  expect(r.statusCode).toBe(201);
  batch = r.json();
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('refunds, chargebacks and credits against posted allocations', () => {
  it('a 10% refund reverses every share proportionally, needs a second approver, and credits refunds payable', async () => {
    const before = { a: await balance('2200', creatorA), d1: await balance('2210', d1), plat: await balance('4000', null) };
    expect(before.a).toBe(35236n);
    const req = await api('POST', `/v1/finance/allocations/${batch.batchId}/reversal-requests`, fin.h, { idempotencyKey: `rv-${uid()}`, type: 'REFUND', amount: '10000', entryDate: today, reason: 'Advertiser disputed one day of delivery' });
    expect(req.statusCode).toBe(201);
    const plan = req.json().plan.lines;
    expect(plan.reduce((a: bigint, l: any) => a + BigInt(l.amount), 0n)).toBe(10000n);
    expect(plan.find((l: any) => l.partyId === creatorA).amount).toBe('3524'); // 3523.6 rounded by largest remainder

    // finance_admin cannot approve; approver can.
    expect((await api('POST', `/v1/finance/journal-requests/${req.json().request.id}/decision`, fin.h, { decision: 'APPROVE' })).statusCode).toBe(403);
    const ok = await api('POST', `/v1/finance/journal-requests/${req.json().request.id}/decision`, approver.h, { decision: 'APPROVE' });
    expect(ok.statusCode).toBe(200);
    expect((await api('POST', `/v1/finance/journal-requests/${req.json().request.id}/decision`, approver.h, { decision: 'APPROVE' })).statusCode).toBe(409);

    expect(await balance('2200', creatorA)).toBe(35236n - 3524n);
    expect(await balance('2210', d1)).toBe(before.d1 - BigInt(plan.find((l: any) => l.partyId === d1).amount));
    expect(await balance('4000', null)).toBe(before.plat - BigInt(plan.find((l: any) => l.kind === 'PLATFORM').amount));
    expect(await balance('2600', advertiser)).toBe(10000n);
    const e = (await api('GET', `/v1/finance/journal-entries/${ok.json().journal_entry_id}`, fin.h)).json();
    expect(e.source_type).toBe('REFUND');
    expect(e.posted_by).toBe(fin.userId);
    expect(e.approved_by).toBe(approver.userId);
  });

  it('a chargeback after a creator was paid books that share as a clawback receivable', async () => {
    await ctx.db.query(`UPDATE allocation_lines SET status = 'PAID' WHERE batch_id = $1 AND party_id = $2`, [batch.batchId, creatorB]);
    const payableB = await balance('2200', creatorB);
    const { request, decision } = await requestAndApprove(batch.batchId, { type: 'CHARGEBACK', amount: '5000', reason: 'Card issuer chargeback (synthetic)', processor: 'stripe-test' });
    expect(request.statusCode).toBe(201);
    expect(decision!.statusCode).toBe(200);
    const bShare = BigInt(request.json().plan.lines.find((l: any) => l.partyId === creatorB).amount);
    expect(request.json().plan.lines.find((l: any) => l.partyId === creatorB).clawback).toBe(true);
    expect(await balance('2200', creatorB)).toBe(payableB);          // paid payable untouched
    expect(await balance('1200', creatorB)).toBe(bShare);             // recover from future earnings
    const lines = (await ctx.db.query('SELECT account_code, credit::text, processor FROM journal_lines WHERE entry_id = $1 AND credit > 0', [decision!.json().journal_entry_id])).rows;
    expect(lines).toEqual([{ account_code: '1010', credit: '5000', processor: 'stripe-test' }]);
  });

  it('refuses requests beyond what remains, and the database refuses over-reversal even if code is bypassed', async () => {
    const remaining = 100000n - 10000n - 5000n;
    const over = await api('POST', `/v1/finance/allocations/${batch.batchId}/reversal-requests`, fin.h, { idempotencyKey: `rv-${uid()}`, type: 'REFUND', amount: (remaining + 1n).toString(), entryDate: today, reason: 'too much requested' });
    expect(over.statusCode).toBe(422);
    const line = (await ctx.db.query(`SELECT id, amount FROM allocation_lines WHERE batch_id = $1 AND line_kind = 'PLATFORM'`, [batch.batchId])).rows[0];
    const rev = (await ctx.db.query('SELECT id FROM allocation_reversals WHERE batch_id = $1 LIMIT 1', [batch.batchId])).rows[0];
    await expect(ctx.db.query('INSERT INTO allocation_reversal_lines (reversal_id, allocation_line_id, amount) VALUES ($1,$2,$3)', [rev.id, line.id, line.amount])).rejects.toThrow(/exceed/);
  });

  it('reversing the remainder zeroes every line exactly; nothing more can be reversed', async () => {
    const { decision } = await requestAndApprove(batch.batchId, { type: 'CREDIT', amount: '85000', reason: 'Campaign cancelled, full credit to balance' });
    expect(decision!.statusCode).toBe(200);
    const detail = (await api('GET', `/v1/finance/allocations/${batch.batchId}`, fin.h)).json();
    for (const l of detail.lines) expect(l.reversed).toBe(l.amount);
    expect(detail.lines.filter((l: any) => l.status === 'REVERSED')).toHaveLength(detail.lines.length - 1); // creator B line stays PAID
    expect(detail.reversals.map((r: any) => r.type)).toEqual(['REFUND', 'CHARGEBACK', 'CREDIT']);
    expect(await balance('2200', creatorA)).toBe(0n);
    expect(await balance('2210', d1)).toBe(0n);
    expect(await balance('4000', null)).toBe(0n);
    expect(await balance('5001', null)).toBe(0n);
    const more = await api('POST', `/v1/finance/allocations/${batch.batchId}/reversal-requests`, fin.h, { idempotencyKey: `rv-${uid()}`, type: 'REFUND', amount: '1', entryDate: today, reason: 'nothing left to reverse' });
    expect(more.statusCode).toBe(422);
    expect((await api('GET', '/v1/finance/trial-balance', fin.h)).json().balanced).toBe(true);
  });

  it('allocation entries cannot be reversed through the generic journal reversal', async () => {
    const r = await api('POST', `/v1/finance/journal-entries/${batch.journalEntryId}/reversal-requests`, fin.h, { idempotencyKey: `rv-${uid()}`, entryDate: today, reason: 'bypass attempt here' });
    expect(r.statusCode).toBe(422);
  });

  it('a credit on a commission batch reduces the advertiser receivable', async () => {
    const c = await api('POST', '/v1/finance/allocations', fin.h, {
      idempotencyKey: `alloc-${uid()}`, kind: 'SALES_COMMISSION', sourceRef: `order-${uid()}`, advertiserOrgId: advertiser, fundingAccount: '1100', currency: 'USD',
      periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-11-02T00:00:00Z', entryDate: today, grossReceipts: '2000',
      creators: [{ creatorId: creatorA, attributedRevenue: '2000', verifiedWatchSeconds: '0', qualifiedViews: '0' }],
      drivers: [{ driverId: d1, monetizedAdDelivery: '1', qualifiedEngagement: '0', eligibleActiveSeconds: '0' }],
    });
    const ar = await balance('1100', advertiser);
    const { decision } = await requestAndApprove(c.json().batchId, { type: 'CREDIT', amount: '2000', reason: 'Order cancelled by customer within return window' });
    expect(decision!.statusCode).toBe(200);
    expect(await balance('1100', advertiser)).toBe(ar - 2000n);
  });
});
