import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_RULE_SPLITS, REVENUE_CATEGORIES } from '@rmn/finance-core';
import { withTx } from '../src/db/pool.js';
import { postEntry } from '../src/modules/ledger/service.js';
import { runScheduledAllocations } from '../src/modules/events/scheduler.js';
import { ensureOpenPeriod, FakeTablet, org, platformOrg, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

type User = Awaited<ReturnType<typeof userWithRole>>;
let ctx: Ctx;
let fin: User, advAdmin: User, fleetAdmin: User;
let advertiser: string, fleetOrg: string;
let tablet: FakeTablet;
const M = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
let clock = Date.now() - 9 * M; // non-overlapping 20 s plays, all within the last 9 minutes (not "offline")

const api = (method: 'GET' | 'POST' | 'PATCH', url: string, h: object, payload?: object) => ctx.app.inject({ method, url, headers: h as any, payload });

async function campaign(over: Record<string, unknown> = {}, advertiserOrg = advertiser) {
  const c = (await ctx.db.query(
    `INSERT INTO campaigns (advertiser_org_id, name, status, starts_at, ends_at, pricing_model, rate_minor, total_budget_minor, daily_budget_minor)
     VALUES ($1,$2,'APPROVED', now() - interval '1 hour', now() + interval '1 day', $3, $4, $5, $6) RETURNING id`,
    [advertiserOrg, `c-${uid()}`, over.pricing ?? 'CPQV', over.rate ?? 50, over.total ?? null, over.daily ?? null])).rows[0].id as string;
  const cr = (await ctx.db.query(`INSERT INTO creatives (campaign_id, kind, status, duration_ms) VALUES ($1,'VIDEO','APPROVED',30000) RETURNING id`, [c])).rows[0].id as string;
  return { id: c, creative: cr };
}
async function play(c: { id: string; creative: string }, n: number) {
  const events = Array.from({ length: n }, () => {
    const start = clock; clock += 21_000;
    return { type: 'AD_PLAYBACK', eventId: randomUUID(), campaignId: c.id, creativeId: c.creative, startedAt: iso(start), endedAt: iso(start + 20_000), visibleMs: 20_000, mutedMs: 0, completed: true };
  });
  expect((await tablet.call('POST', '/v1/devices/events', { batchId: randomUUID(), events })).json().accepted).toBe(n);
  await api('POST', '/v1/events/validate', fin.h, {});
  const r = await ctx.db.query(`SELECT v.status, v.reasons FROM validated_events v JOIN raw_events r ON r.id = v.raw_event_id WHERE r.event_id = ANY($1::uuid[]) ORDER BY v.occurred_at`, [events.map((e) => e.eventId)]);
  return r.rows.map((x) => (x.status === 'VALID' ? 'VALID' : x.reasons.join(',')));
}
const inPlaylist = async (id: string) => (await tablet.call('GET', '/v1/devices/playlist')).json().ads.some((a: any) => a.campaignId === id);
const spend = async (id: string) => (await api('GET', `/v1/orgs/${advertiser}/campaigns/${id}/spend`, advAdmin.h)).json();
async function fund(orgId: string, amount: bigint) {
  await withTx(ctx.db, (tx) => postEntry(tx, { idempotencyKey: `fund-${orgId}-${uid()}`, entryDate: new Date().toISOString().slice(0, 10), description: 'prepayment', sourceType: 'PAYMENT',
    lines: [{ accountCode: '1010', currency: 'USD', debit: amount, processor: 'stripe-test' }, { accountCode: '2000', currency: 'USD', credit: amount, partyType: 'ADVERTISER', partyId: orgId }] }));
}

beforeAll(async () => {
  ctx = await setupApp();
  await ensureOpenPeriod(ctx.db);
  const p = await platformOrg(ctx.db);
  fin = await userWithRole(ctx, p, 'finance_admin', { mfa: true });
  const ap1 = await userWithRole(ctx, p, 'finance_approver', { mfa: true });
  const ap2 = await userWithRole(ctx, p, 'finance_approver', { mfa: true });
  for (const cat of REVENUE_CATEGORIES) {
    const s = INITIAL_RULE_SPLITS[cat];
    await ctx.db.query(
      `INSERT INTO revenue_rule_versions (category, version, effective_from, driver_bps, creator_bps, platform_bps, unallocated_driver_share, unallocated_creator_share,
         eligible_revenue_definition, contract_ref, status, created_by, approved_by_1, approved_by_2, approved_at)
       SELECT $1,1,'2026-01-01T00:00:00Z',$2,$3,$4,'TO_PLATFORM','TO_PLATFORM','validated net revenue (test)','TEST-v1','APPROVED',$5,$6,$7,now()
       WHERE NOT EXISTS (SELECT 1 FROM revenue_rule_versions WHERE category = $1)`, [cat, s.driverBps, s.creatorBps, s.platformBps, fin.userId, ap1.userId, ap2.userId]);
  }
  advertiser = await org(ctx.db, 'ADVERTISER');
  advAdmin = await userWithRole(ctx, advertiser, 'advertiser_admin');
  await fund(advertiser, 100_000n);
  fleetOrg = await org(ctx.db, 'FLEET_OPERATOR');
  fleetAdmin = await userWithRole(ctx, fleetOrg, 'fleet_admin');
  const fleet = (await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'Main','Springfield','UTC') RETURNING id`, [fleetOrg])).rows[0].id;
  const vehicle = (await ctx.db.query(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,'V1') RETURNING id`, [fleetOrg, fleet])).rows[0].id;
  const code = (await api('POST', `/v1/orgs/${fleetOrg}/devices/enrollment-codes`, fleetAdmin.h, {})).json().code;
  tablet = new FakeTablet(ctx.app);
  tablet.deviceId = (await api('POST', '/v1/devices/enroll', {}, { code, serial: tablet.serial, publicKey: tablet.publicKeyB64, appVersion: '1' })).json().deviceId;
  await ctx.db.query(`INSERT INTO device_status_history (device_id, status, changed_at) VALUES ($1,'ACTIVE', now() - interval '2 hours')`, [tablet.deviceId]);
  await ctx.db.query(`INSERT INTO device_assignments (org_id, device_id, vehicle_id, created_by, starts_at) VALUES ($1,$2,$3,$4, now() - interval '2 hours')`, [fleetOrg, tablet.deviceId, vehicle, fleetAdmin.userId]);
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('campaign budgets stop both delivery and billing', () => {
  it('total budget: $1.50 at $0.50 per qualified view allows exactly three billable views', async () => {
    const c = await campaign({ total: 150 });
    expect(await inPlaylist(c.id)).toBe(true);
    expect(await play(c, 4)).toEqual(['VALID', 'VALID', 'VALID', 'BUDGET_EXHAUSTED']);
    expect(await inPlaylist(c.id)).toBe(false);
    expect(await spend(c.id)).toMatchObject({ spent: '150', remainingBudget: '0', deliveryBlockedBy: 'BUDGET_EXHAUSTED' });
    // Budgets are delivery controls, not billing terms: raising one on a live campaign resumes delivery.
    const raised = await api('PATCH', `/v1/orgs/${advertiser}/campaigns/${c.id}`, advAdmin.h, { totalBudgetMinor: '200' });
    expect(raised.statusCode).toBe(200);
    expect(await inPlaylist(c.id)).toBe(true);
    expect(await play(c, 2)).toEqual(['VALID', 'BUDGET_EXHAUSTED']);
  });

  it('daily budget is measured on the campaign-local day', async () => {
    const c = await campaign({ daily: 100 });
    expect(await play(c, 3)).toEqual(['VALID', 'VALID', 'DAILY_BUDGET_EXHAUSTED']);
    expect((await spend(c.id)).deliveryBlockedBy).toBe('DAILY_BUDGET_EXHAUSTED');
  });

  it('CPM spend is exact to the thousandth of a cent', async () => {
    const c = await campaign({ pricing: 'CPM', rate: 1250, total: 3 }); // $12.50 CPM => 1.25c per impression; $0.03 budget => 2 impressions
    expect(await play(c, 3)).toEqual(['VALID', 'VALID', 'BUDGET_EXHAUSTED']);
    expect((await spend(c.id)).spentMilliMinor).toBe('2500');
  });

  it('advertiser funds: committed unbilled spend across campaigns can never exceed the prepaid balance', async () => {
    const poor = await org(ctx.db, 'ADVERTISER');
    await fund(poor, 100n); // $1.00 covers two $0.50 views in total
    const a = await campaign({}, poor), b = await campaign({}, poor);
    expect(await play(a, 1)).toEqual(['VALID']);
    expect(await play(b, 2)).toEqual(['VALID', 'ADVERTISER_FUNDS_EXHAUSTED']);
    expect(await inPlaylist(a.id)).toBe(false);
    expect(await inPlaylist(b.id)).toBe(false);
    const admin = await userWithRole(ctx, poor, 'advertiser_admin');
    expect((await api('GET', `/v1/orgs/${poor}/balance`, admin.h)).json().balances.USD).toMatchObject({ prepaidBalance: '100', committedUnbilled: '100', available: '0' });
    // Because billing never outran funds, allocation succeeds instead of failing as underfunded.
    const r = await runScheduledAllocations(ctx.db, ctx.config);
    expect(r.results.filter((x) => [a.id, b.id].includes(x.campaignId)).map((x) => `${x.status}${x.reason ?? ''}`)).toEqual(['ALLOCATED', 'ALLOCATED']);
    expect((await api('GET', `/v1/orgs/${poor}/balance`, admin.h)).json().balances.USD).toMatchObject({ prepaidBalance: '0', committedUnbilled: '0', available: '0' });
  });

  it('budget edits are allowed on live campaigns created through the API, and must be positive', async () => {
    const c = (await api('POST', `/v1/orgs/${advertiser}/campaigns`, advAdmin.h, { name: 'Budgeted', pricingModel: 'CPQV', rateMinor: '50', startsAt: iso(Date.now()), endsAt: iso(Date.now() + 86_400_000), totalBudgetMinor: '5000', dailyBudgetMinor: '1000' })).json();
    expect(c).toMatchObject({ totalBudgetMinor: '5000', dailyBudgetMinor: '1000' });
    await ctx.db.query(`UPDATE campaigns SET status = 'PENDING_REVIEW' WHERE id = $1`, [c.id]);
    await ctx.db.query(`UPDATE campaigns SET status = 'APPROVED' WHERE id = $1`, [c.id]);
    expect((await api('PATCH', `/v1/orgs/${advertiser}/campaigns/${c.id}`, advAdmin.h, { totalBudgetMinor: '9000', dailyBudgetMinor: null })).json()).toMatchObject({ totalBudgetMinor: '9000', dailyBudgetMinor: null });
    expect((await api('PATCH', `/v1/orgs/${advertiser}/campaigns/${c.id}`, advAdmin.h, { totalBudgetMinor: '0' })).statusCode).toBe(422);
  });
});

describe('scheduled allocation windows', () => {
  it('allocates every campaign with unbilled valid events up to the closed boundary, once', async () => {
    const c = await campaign();
    expect(await play(c, 2)).toEqual(['VALID', 'VALID']);
    const before = await runScheduledAllocations(ctx.db, ctx.config);
    expect(before.results.find((x) => x.campaignId === c.id)?.status).toBe('ALLOCATED');
    expect(before.allocated).toBeGreaterThan(0);
    const again = await runScheduledAllocations(ctx.db, ctx.config);
    expect(again.results.find((x) => x.campaignId === c.id)).toBeUndefined(); // nothing left to allocate for it
    const tb = (await api('GET', '/v1/finance/trial-balance', fin.h)).json();
    expect(tb.balanced).toBe(true);
    const sys = await ctx.db.query(`SELECT count(*)::int n FROM allocation_windows WHERE created_by = '00000000-0000-0000-0000-000000000001'`);
    expect(sys.rows[0].n).toBeGreaterThan(0);
  });

  it('skips and reports a window blocked by held events instead of forcing it', async () => {
    const c = await campaign();
    const offline = { type: 'AD_PLAYBACK', eventId: randomUUID(), campaignId: c.id, creativeId: c.creative, startedAt: iso(Date.now() - 30 * M), endedAt: iso(Date.now() - 30 * M + 20_000), visibleMs: 20_000, mutedMs: 0 };
    await tablet.call('POST', '/v1/devices/events', { batchId: randomUUID(), events: [offline] });
    await api('POST', '/v1/events/validate', fin.h, {});
    await play(c, 1);
    const r = await api('POST', '/v1/finance/allocation-windows/run', fin.h, {});
    const mine = r.json().results.find((x: any) => x.campaignId === c.id);
    expect(mine).toMatchObject({ status: 'SKIPPED' });
    expect(mine.reason).toMatch(/held event/);
  });
});

describe('advertiser daily report', () => {
  it('reports validated plays and exact billable spend per day, as JSON and spreadsheet-safe CSV', async () => {
    await fund(advertiser, 100_000n);
    const c = await campaign({ pricing: 'CPM', rate: 2000 }); // $20 CPM = 2 cents per impression
    expect(await play(c, 3)).toEqual(['VALID', 'VALID', 'VALID']);
    const r = (await api('GET', `/v1/orgs/${advertiser}/campaigns/${c.id}/report`, advAdmin.h)).json();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ impressions: 3, billablePlays: 3, spendMilliMinor: '6000', spend: '0.06', currency: 'USD' });
    expect(BigInt(r.rows[0].spendMilliMinor)).toBe(BigInt((await spend(c.id)).spentMilliMinor)); // same rule as budgets and billing
    const csv = await api('GET', `/v1/orgs/${advertiser}/campaigns/${c.id}/report?format=csv`, advAdmin.h);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\r\n')[0]).toBe('date,impressions,qualifiedViews,completions,clicks,billablePlays,spend,currency,spendMilliMinor,rejectedEvents');
    const empty = await campaign();
    expect((await api('GET', `/v1/orgs/${advertiser}/campaigns/${empty.id}/report?format=csv`, advAdmin.h)).body.split('\r\n')[0]).toMatch(/^date,/); // headers even with no rows
    const conv = await api('GET', `/v1/orgs/${advertiser}/conversions?format=csv`, advAdmin.h);
    expect(conv.body.split('\r\n')[0]).toMatch(/^occurredAt,orderId,status/);
    const other = await org(ctx.db, 'ADVERTISER');
    const otherAdmin = await userWithRole(ctx, other, 'advertiser_admin');
    expect((await api('GET', `/v1/orgs/${advertiser}/campaigns/${c.id}/report`, otherAdmin.h)).statusCode).toBe(403);
  });
});
