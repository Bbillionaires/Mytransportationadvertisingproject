import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_RULE_SPLITS, REVENUE_CATEGORIES } from '@rmn/finance-core';
import { withTx } from '../src/db/pool.js';
import { postEntry } from '../src/modules/ledger/service.js';
import { csvCell } from '../src/lib/csv.js';
import { ensureOpenPeriod, org, platformOrg, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

type User = Awaited<ReturnType<typeof userWithRole>>;
let ctx: Ctx;
let fin: User, approver: User, creatorUser: User, otherCreatorUser: User, driverUser: User;
let studio: string, creatorId: string, driverId: string, advertiser: string, batchId: string;
let creatorShare: bigint, creatorReversed: bigint, driverShare: bigint;
const month = new Date().toISOString().slice(0, 7);
const today = new Date().toISOString().slice(0, 10);

const api = (url: string, h: object, method: 'GET' | 'POST' = 'GET', payload?: object) => ctx.app.inject({ method, url, headers: h as any, payload });

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
       WHERE NOT EXISTS (SELECT 1 FROM revenue_rule_versions WHERE category = $1)`, [cat, s.driverBps, s.creatorBps, s.platformBps, fin.userId, approver.userId, ap2.userId]);
  }
  studio = await org(ctx.db, 'CREATOR_STUDIO', 'Walks Studio');
  creatorUser = await userWithRole(ctx, studio, 'creator_owner');
  creatorId = (await ctx.db.query(`INSERT INTO creator_profiles (org_id, display_name, monetization_status) VALUES ($1,'City Walks','ELIGIBLE') RETURNING id`, [studio])).rows[0].id;
  await ctx.db.query(`INSERT INTO videos (creator_id, title, status, duration_ms) VALUES ($1,'Murals','APPROVED',600000)`, [creatorId]);
  const otherStudio = await org(ctx.db, 'CREATOR_STUDIO');
  otherCreatorUser = await userWithRole(ctx, otherStudio, 'creator_owner');
  const fleetOrg = await org(ctx.db, 'FLEET_OPERATOR');
  driverUser = await userWithRole(ctx, fleetOrg, 'driver');
  const fleet = (await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'F','Springfield','UTC') RETURNING id`, [fleetOrg])).rows[0].id;
  driverId = (await ctx.db.query(`INSERT INTO drivers (org_id, fleet_id, user_id, eligibility_status) VALUES ($1,$2,$3,'ELIGIBLE') RETURNING id`, [fleetOrg, fleet, driverUser.userId])).rows[0].id;
  advertiser = await org(ctx.db, 'ADVERTISER');
  await withTx(ctx.db, (tx) => postEntry(tx, { idempotencyKey: `fund-${advertiser}`, entryDate: today, description: 'prepayment', sourceType: 'PAYMENT',
    lines: [{ accountCode: '1010', currency: 'USD', debit: 200_000n, processor: 'stripe-test', memo: '=HYPERLINK("http://evil.example")' },
            { accountCode: '2000', currency: 'USD', credit: 200_000n, partyType: 'ADVERTISER', partyId: advertiser }] }));
  const a = await api('/v1/finance/allocations', fin.h, 'POST', {
    idempotencyKey: `alloc-${uid()}`, kind: 'AD', sourceRef: `campaign-${uid()}`, advertiserOrgId: advertiser, fundingAccount: '2000', currency: 'USD',
    periodStart: `${today}T00:00:00Z`, periodEnd: new Date().toISOString(), entryDate: today, grossReceipts: '100000',
    deductions: [{ type: 'PAYMENT_PROCESSING_FEE', amount: '2930', description: 'card', contractRef: 'ADV-MSA-v1 §4.2' }],
    creators: [{ creatorId, attributedRevenue: '100', verifiedWatchSeconds: '100', qualifiedViews: '1' }],
    drivers: [{ driverId, monetizedAdDelivery: '1', qualifiedEngagement: '0', eligibleActiveSeconds: '0' }],
  });
  expect(a.statusCode, a.body).toBe(201);
  batchId = a.json().batchId;
  creatorShare = BigInt(a.json().calculation.partySplit.creator);
  driverShare = BigInt(a.json().calculation.partySplit.driver);
  const rr = await api(`/v1/finance/allocations/${batchId}/reversal-requests`, fin.h, 'POST', { idempotencyKey: `rv-${uid()}`, type: 'REFUND', amount: '10000', entryDate: today, reason: 'Ten percent refund for testing' });
  await api(`/v1/finance/journal-requests/${rr.json().request.id}/decision`, approver.h, 'POST', { decision: 'APPROVE' });
  creatorReversed = BigInt(rr.json().plan.lines.find((l: any) => l.partyId === creatorId).amount);
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('creator dashboard', () => {
  it('shows gross -> deductions -> net -> split -> share -> reversals, matching the ledger', async () => {
    const e = (await api(`/v1/orgs/${studio}/earnings`, creatorUser.h)).json();
    expect(creatorShare).toBe(58242n);
    expect(e.summary).toMatchObject({ earned: String(creatorShare), reversed: String(creatorReversed), net: String(creatorShare - creatorReversed), payableBalance: String(creatorShare - creatorReversed), paidOut: '0' });
    const line = e.lines.find((l: any) => l.batchId === batchId);
    expect(line.batch).toMatchObject({ gross: '100000', deductions: '2930', net: '97070', split: { driverBps: 500, creatorBps: 6000, platformBps: 3500 } });
    expect(line.basis.score).toBeTruthy();
    expect(e.estimate.indicativeOnly).toBe(true);
    expect(e.disclosure).toMatch(/not guaranteed/);
    expect((await api(`/v1/orgs/${studio}/earnings`, otherCreatorUser.h)).statusCode).toBe(403);
  });

  it('ranks videos and exports CSV', async () => {
    const v = (await api(`/v1/orgs/${studio}/videos/performance?sort=watchHours`, creatorUser.h)).json();
    expect(v.items[0]).toMatchObject({ title: 'Murals', status: 'APPROVED', qualifiedViews: 0 });
    const csv = await api(`/v1/orgs/${studio}/earnings?format=csv`, creatorUser.h);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\r\n')[0]).toContain('netAmount');
  });

  it('monthly statement reconciles opening + earnings - reductions = closing, in JSON, CSV and a valid PDF', async () => {
    const s = (await api(`/v1/orgs/${studio}/statements/${month}`, creatorUser.h)).json();
    expect(s).toMatchObject({ openingPayable: '0', earnings: String(creatorShare), reductions: String(creatorReversed), closingPayable: String(creatorShare - creatorReversed) });
    expect(s.lines.map((l: any) => l.kind)).toEqual(['EARNINGS', 'REFUND_OR_CHARGEBACK']);
    const csv = await api(`/v1/orgs/${studio}/statements/${month}?format=csv`, creatorUser.h);
    expect(csv.body.split('\r\n').filter(Boolean)).toHaveLength(3);
    const pdf = await api(`/v1/orgs/${studio}/statements/${month}?format=pdf`, creatorUser.h);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const buf = pdf.rawPayload, text = buf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('(Creator earnings statement)');
    // Every xref offset must point at its object header.
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    const offsets = text.slice(xrefAt).split('\n').slice(3).filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
});

describe('driver dashboard', () => {
  it('shows earnings, devices, subscription, eligibility and statement', async () => {
    const e = (await api('/v1/drivers/me/earnings', driverUser.h)).json();
    expect(BigInt(e.summary.earned)).toBe(driverShare);
    expect(e).toMatchObject({ subscription: null, eligibility: [{ id: driverId, eligibility_status: 'ELIGIBLE' }], conversions: { count: 0 } });
    expect(e.disclosure).toMatch(/not guaranteed/);
    const pdf = await api(`/v1/drivers/me/statements/${month}?format=pdf`, driverUser.h);
    expect(pdf.rawPayload.toString('latin1')).toContain('(Driver earnings statement)');
    expect((await api('/v1/drivers/me/earnings', creatorUser.h)).statusCode).toBe(404);
  });
});

describe('financial reports', () => {
  it('balance sheet balances (A = L + E) over the whole ledger and separates client funds', async () => {
    const bs = (await api('/v1/finance/reports/balance-sheet', fin.h)).json();
    expect(bs.currencies.USD.balanced).toBe(true);
    expect(BigInt(bs.currencies.USD.clientFundLiabilities)).toBeGreaterThan(0n);
  });

  it('income statement nets contra-expense recoveries; net income = revenue - expenses', async () => {
    const is = (await api(`/v1/finance/reports/income-statement?from=${today}`, fin.h)).json().currencies.USD;
    expect(BigInt(is.netIncome)).toBe(BigInt(is.totalRevenue) - BigInt(is.totalExpenses));
    expect(is.revenue.map((r: any) => r.account)).toContain('4000');
  });

  it('general ledger running balance ends at the account balance; CSV neutralises formulas', async () => {
    const gl = (await api(`/v1/finance/reports/general-ledger?account=2200&from=2026-01-01&to=2028-01-01`, fin.h)).json();
    const tb = (await api('/v1/finance/trial-balance', fin.h)).json().rows.find((r: any) => r.accountCode === '2200');
    expect(gl.at(-1).balance).toBe(tb.balance);
    const csv = (await api(`/v1/finance/reports/general-ledger?account=1010&from=${today}&format=csv`, fin.h)).body;
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(csvCell('-42')).toBe('-42');
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('cash flow, liabilities, receivables and recipient earnings are consistent', async () => {
    const cf = (await api(`/v1/finance/reports/cash-flow?from=${today}`, fin.h)).json().currencies.USD;
    expect(BigInt(cf.closingCash)).toBe(BigInt(cf.openingCash) + BigInt(cf.netChange));
    const li = (await api('/v1/finance/reports/liabilities', fin.h)).json();
    expect(li.find((x: any) => x.account === '2200' && x.party_id === creatorId).balance).toBe(String(creatorShare - creatorReversed));
    expect(Array.isArray((await api('/v1/finance/reports/receivables', fin.h)).json())).toBe(true);
    const re = (await api(`/v1/finance/reports/recipient-earnings?year=${today.slice(0, 4)}`, fin.h)).json();
    expect(re.find((x: any) => x.partyId === creatorId)).toMatchObject({ name: 'City Walks', netEarnings: String(creatorShare - creatorReversed) });
    const st = (await api(`/v1/finance/statements/CREATOR/${creatorId}/${month}`, fin.h)).json();
    expect(st.closingPayable).toBe(String(creatorShare - creatorReversed));
  });

  it('reports are finance-only', async () => {
    expect((await api('/v1/finance/reports/balance-sheet', creatorUser.h)).statusCode).toBe(403);
    expect((await api(`/v1/finance/statements/CREATOR/${creatorId}/${month}`, creatorUser.h)).statusCode).toBe(403);
  });
});
