import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_RULE_SPLITS, REVENUE_CATEGORIES } from '@rmn/finance-core';
import { runCommissionAllocations } from '../src/modules/commissions/routes.js';
import { ensureOpenPeriod, FakeTablet, org, platformOrg, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

type User = Awaited<ReturnType<typeof userWithRole>>;
let ctx: Ctx;
let fin: User, approver: User, advAdmin: User, otherAdmin: User;
let advertiser: string, other: string, campaignId: string, creativeId: string, offerId: string;
let creatorId: string, videoId: string, driverId: string, tablet: FakeTablet;
let keyHeader: Record<string, string>;
const DAY = 86_400_000;

const api = (method: 'GET' | 'POST', url: string, h: object = {}, payload?: object) => ctx.app.inject({ method, url, headers: h as any, payload });
const report = (body: object, h = keyHeader) => api('POST', '/v1/conversions', h, { occurredAt: new Date().toISOString(), currency: 'USD', ...body });
const receivable = async () => BigInt((await ctx.db.query(`SELECT coalesce(sum(debit) - sum(credit), 0)::text b FROM journal_lines WHERE account_code = '1100' AND party_id = $1`, [advertiser])).rows[0].b);

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
  advertiser = await org(ctx.db, 'ADVERTISER'); advAdmin = await userWithRole(ctx, advertiser, 'advertiser_admin');
  other = await org(ctx.db, 'ADVERTISER'); otherAdmin = await userWithRole(ctx, other, 'advertiser_admin');
  campaignId = (await ctx.db.query(`INSERT INTO campaigns (advertiser_org_id, name, status, starts_at, ends_at, pricing_model, rate_minor) VALUES ($1,'Latte promo','APPROVED', now() - interval '1 day', now() + interval '30 days','CPQV',50) RETURNING id`, [advertiser])).rows[0].id;
  creativeId = (await ctx.db.query(`INSERT INTO creatives (campaign_id, kind, status, headline) VALUES ($1,'BANNER','APPROVED','2-for-1 lattes') RETURNING id`, [campaignId])).rows[0].id;
  const studio = await org(ctx.db, 'CREATOR_STUDIO');
  creatorId = (await ctx.db.query(`INSERT INTO creator_profiles (org_id, display_name, monetization_status) VALUES ($1,'Chef','ELIGIBLE') RETURNING id`, [studio])).rows[0].id;
  videoId = (await ctx.db.query(`INSERT INTO videos (creator_id, title, status, duration_ms) VALUES ($1,'Coffee 101','APPROVED',600000) RETURNING id`, [creatorId])).rows[0].id;
  const fleetOrg = await org(ctx.db, 'FLEET_OPERATOR');
  const fleetAdmin = await userWithRole(ctx, fleetOrg, 'fleet_admin');
  const fleet = (await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'F','Springfield','UTC') RETURNING id`, [fleetOrg])).rows[0].id;
  const vehicle = (await ctx.db.query(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,'V1') RETURNING id`, [fleetOrg, fleet])).rows[0].id;
  const du = (await ctx.db.query(`INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','d') RETURNING id`, [`d-${uid()}@example.test`])).rows[0].id;
  driverId = (await ctx.db.query(`INSERT INTO drivers (org_id, fleet_id, user_id, eligibility_status) VALUES ($1,$2,$3,'ELIGIBLE') RETURNING id`, [fleetOrg, fleet, du])).rows[0].id;
  const code = (await api('POST', `/v1/orgs/${fleetOrg}/devices/enrollment-codes`, fleetAdmin.h, {})).json().code;
  tablet = new FakeTablet(ctx.app);
  tablet.deviceId = (await api('POST', '/v1/devices/enroll', {}, { code, serial: tablet.serial, publicKey: tablet.publicKeyB64, appVersion: '1' })).json().deviceId;
  await ctx.db.query(`INSERT INTO device_status_history (device_id, status, changed_at) VALUES ($1,'ACTIVE', now() - interval '2 hours')`, [tablet.deviceId]);
  await ctx.db.query(`INSERT INTO device_assignments (org_id, device_id, vehicle_id, driver_id, created_by, starts_at) VALUES ($1,$2,$3,$4,$5, now() - interval '2 hours')`, [fleetOrg, tablet.deviceId, vehicle, driverId, fleetAdmin.userId]);
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('commission offers and API keys', () => {
  it('advertisers create immutable offers scoped to their own campaigns', async () => {
    const bad = await api('POST', `/v1/orgs/${advertiser}/campaigns/${campaignId}/commission-offers`, advAdmin.h, { name: 'x', kind: 'PERCENT_OF_SALE', fixedMinor: '100', validFrom: new Date(Date.now() - DAY).toISOString(), validTo: new Date(Date.now() + 30 * DAY).toISOString() });
    expect(bad.statusCode).toBe(400);
    const o = await api('POST', `/v1/orgs/${advertiser}/campaigns/${campaignId}/commission-offers`, advAdmin.h, {
      name: '8% of every order', kind: 'PERCENT_OF_SALE', rateBps: 800, couponDescription: '2-for-1 lattes this week',
      validFrom: new Date(Date.now() - DAY).toISOString(), validTo: new Date(Date.now() + 30 * DAY).toISOString() });
    expect(o.statusCode).toBe(201);
    expect(o.json()).toMatchObject({ rateBps: 800, clickWindowHours: 168, couponWindowHours: 720, holdDays: 14 });
    offerId = o.json().id;
    await expect(ctx.db.query('UPDATE commission_offers SET rate_bps = 100 WHERE id = $1', [offerId])).rejects.toThrow(/immutable/);
    expect((await api('POST', `/v1/orgs/${other}/campaigns/${campaignId}/commission-offers`, otherAdmin.h, { name: 'x', kind: 'PERCENT_OF_SALE', rateBps: 1, validFrom: new Date().toISOString(), validTo: new Date(Date.now() + DAY).toISOString() })).statusCode).toBe(404);
  });

  it('API keys are shown once, stored hashed, and revocable', async () => {
    const k = await api('POST', `/v1/orgs/${advertiser}/integration-keys`, advAdmin.h, { name: 'POS integration' });
    expect(k.json().key).toMatch(/^rmnk_[a-f0-9]{12}_/);
    keyHeader = { authorization: `Bearer ${k.json().key}` };
    const listed = JSON.stringify((await api('GET', `/v1/orgs/${advertiser}/integration-keys`, advAdmin.h)).json());
    // The secret is everything after "rmnk_<12-hex prefix>_"; it is random base64url and may itself contain "_".
    const secret = k.json().key.slice('rmnk_'.length + 12 + 1);
    expect(secret.length).toBeGreaterThanOrEqual(40);
    expect(listed).not.toContain(secret);
    expect((await report({ orderId: 'x', saleAmountMinor: '100' }, {})).statusCode).toBe(401);
    const k2 = (await api('POST', `/v1/orgs/${advertiser}/integration-keys`, advAdmin.h, { name: 'old' })).json();
    await api('POST', `/v1/orgs/${advertiser}/integration-keys/${k2.id}/revoke`, advAdmin.h, {});
    expect((await report({ orderId: 'x', saleAmountMinor: '100' }, { authorization: `Bearer ${k2.key}` })).statusCode).toBe(401);
  });
});

describe('attribution', () => {
  let coupon: string;
  it('tablets issue unique, rate-limited coupon codes tied to the device, driver and creator content', async () => {
    const r = await tablet.call('POST', '/v1/devices/coupons', { campaignId, creativeId, contentVideoId: videoId });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ description: '2-for-1 lattes this week', qrPayload: expect.stringMatching(/^RMNCOUPON:[A-Z2-9]{10}$/) });
    coupon = r.json().code;
    const row = (await ctx.db.query('SELECT driver_id, creator_id FROM coupon_codes WHERE code = $1', [coupon])).rows[0];
    expect(row).toEqual({ driver_id: driverId, creator_id: creatorId });
    await tablet.call('POST', '/v1/devices/coupons', { campaignId, creativeId });
    await tablet.call('POST', '/v1/devices/coupons', { campaignId, creativeId });
    expect((await tablet.call('POST', '/v1/devices/coupons', { campaignId, creativeId })).statusCode).toBe(409);
  });

  it('a coupon order attributes to the code: commission is 8% of the sale; duplicates are idempotent; a code works once', async () => {
    const r = await report({ orderId: 'ORD-1', saleAmountMinor: '12345', couponCode: coupon });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'ATTRIBUTED', touchType: 'COUPON', commissionMinor: '987' });
    expect((await report({ orderId: 'ORD-1', saleAmountMinor: '12345', couponCode: coupon })).json().duplicate).toBe(true);
    expect((await report({ orderId: 'ORD-1', saleAmountMinor: '99999', couponCode: coupon })).statusCode).toBe(409);
    const again = await report({ orderId: 'ORD-2', saleAmountMinor: '5000', couponCode: coupon });
    expect(again.json()).toMatchObject({ status: 'UNATTRIBUTED', commissionMinor: '0' });
    expect(again.json().attributionReason).toMatch(/already redeemed/);
  });

  it('a validated tablet tap attributes within the click window; earlier orders and missing touchpoints do not', async () => {
    const clickId = randomUUID();
    await tablet.call('POST', '/v1/devices/events', { batchId: randomUUID(), events: [{ type: 'CLICK', eventId: clickId, campaignId, creativeId, contentVideoId: videoId, target: 'LANDING_PAGE', occurredAt: new Date(Date.now() - 60_000).toISOString() }] });
    await api('POST', '/v1/events/validate', fin.h, {});
    const ok = await report({ orderId: 'ORD-3', saleAmountMinor: '20000', clickId });
    expect(ok.json()).toMatchObject({ status: 'ATTRIBUTED', touchType: 'CLICK', commissionMinor: '1600' });
    const early = await report({ orderId: 'ORD-4', saleAmountMinor: '20000', clickId, occurredAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect(early.json().attributionReason).toMatch(/precedes/);
    expect((await report({ orderId: 'ORD-5', saleAmountMinor: '20000' })).json()).toMatchObject({ status: 'UNATTRIBUTED', attributionReason: expect.stringMatching(/no touchpoint/) });
    const k = (await api('POST', `/v1/orgs/${other}/integration-keys`, otherAdmin.h, { name: 'k' })).json().key;
    const foreign = await report({ orderId: 'ORD-X', saleAmountMinor: '20000', clickId }, { authorization: `Bearer ${k}` });
    expect(foreign.json().attributionReason).toMatch(/not found for this advertiser/);
  });

  it('advertisers see only their own conversions', async () => {
    const mine = (await api('GET', `/v1/orgs/${advertiser}/conversions`, advAdmin.h)).json().items;
    expect(mine.map((c: any) => c.orderId).sort()).toEqual(['ORD-1', 'ORD-2', 'ORD-3', 'ORD-4', 'ORD-5']);
    expect((await api('GET', `/v1/orgs/${advertiser}/conversions`, otherAdmin.h)).statusCode).toBe(403);
  });
});

describe('commission allocation and refunds', () => {
  it('nothing is allocated during the refund-hold period', async () => {
    const r = await runCommissionAllocations(ctx.db);
    expect(r.results.filter((x) => x.conversionId)).toHaveLength(0);
  });

  it('a refund before allocation simply reduces (or cancels) the commission', async () => {
    // Last-click: a single validated tap may lead to several separate orders within its window.
    const c3 = (await ctx.db.query(`SELECT r.event_id FROM conversions c JOIN validated_events v ON v.id = c.click_event_id JOIN raw_events r ON r.id = v.raw_event_id WHERE c.order_id = 'ORD-3'`)).rows[0].event_id;
    expect((await report({ orderId: 'ORD-6', saleAmountMinor: '10000', clickId: c3 })).json().commissionMinor).toBe('800');
    const half = await api('POST', '/v1/conversions/refunds', keyHeader, { orderId: 'ORD-6', refundRef: 'R1', saleAmountMinor: '5000' });
    expect(half.json()).toMatchObject({ commissionReductionMinor: '400', reversalRequestId: null });
    await api('POST', '/v1/conversions/refunds', keyHeader, { orderId: 'ORD-6', refundRef: 'R2', saleAmountMinor: '5000' });
    expect((await api('POST', '/v1/conversions/refunds', keyHeader, { orderId: 'ORD-6', refundRef: 'R3', saleAmountMinor: '1' })).statusCode).toBe(422);
    const c = (await api('GET', `/v1/orgs/${advertiser}/conversions`, advAdmin.h)).json().items.find((x: any) => x.orderId === 'ORD-6');
    expect(c).toMatchObject({ status: 'FULLY_REFUNDED', commissionMinor: '0' });
  });

  it('after the hold, commissions allocate 15/10/75 with the attributed creator and driver, funded by the advertiser receivable', async () => {
    const before = await receivable();
    const r = await runCommissionAllocations(ctx.db, { now: new Date(Date.now() + 15 * DAY) });
    const mine = r.results.filter((x) => x.status === 'ALLOCATED');
    expect(mine).toHaveLength(2); // ORD-1 (coupon) and ORD-3 (click); unattributed and fully refunded orders are not allocated
    const b1 = (await ctx.db.query(`SELECT b.calculation FROM conversions c JOIN allocation_batches b ON b.id = c.allocation_batch_id WHERE c.order_id = 'ORD-1'`)).rows[0].calculation;
    expect(b1.category).toBe('SALES_COMMISSION_WITH_CREATOR');
    expect([b1.partySplit.driver, b1.partySplit.creator, b1.partySplit.platform, b1.partySplit.roundingResidual]).toEqual(['148', '98', '740', '1']); // of 987
    expect(b1.creatorPool.shares).toEqual([{ key: creatorId, amount: '98' }]);
    expect(b1.driverPool.shares).toEqual([{ key: driverId, amount: '148' }]);
    expect(await receivable()).toBe(before + 987n + 1600n);
    expect((await runCommissionAllocations(ctx.db, { now: new Date(Date.now() + 15 * DAY) })).allocated).toBe(0); // once only
  });

  it('a refund after allocation creates a reversal request that a finance approver must approve', async () => {
    const r = await api('POST', '/v1/conversions/refunds', keyHeader, { orderId: 'ORD-1', refundRef: 'R-1', saleAmountMinor: '6172' });
    expect(r.json().commissionReductionMinor).toBe('494'); // 987 -> floor(8% of 6173) = 493
    const reqId = r.json().reversalRequestId;
    expect(reqId).toBeTruthy();
    const before = await receivable();
    const ok = await api('POST', `/v1/finance/journal-requests/${reqId}/decision`, approver.h, { decision: 'APPROVE' });
    expect(ok.statusCode).toBe(200);
    expect(await receivable()).toBe(before - 494n);
    expect((await api('GET', '/v1/finance/trial-balance', fin.h)).json().balanced).toBe(true);
  });
});
