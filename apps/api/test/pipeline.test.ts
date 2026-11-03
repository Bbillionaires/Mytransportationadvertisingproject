import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INITIAL_RULE_SPLITS, REVENUE_CATEGORIES } from '@rmn/finance-core';
import { withTx } from '../src/db/pool.js';
import { postEntry } from '../src/modules/ledger/service.js';
import { ensureOpenPeriod, FakeTablet, org, platformOrg, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

type User = Awaited<ReturnType<typeof userWithRole>>;
let ctx: Ctx;
let fin: User, reviewer: User, fleetAdmin: User;
let advertiser: string, fleetOrg: string;
let c1: string, c1Video: string, c1Banner: string, cRate: string, cRateBanner: string, cDraft: string, cDraftCreative: string;
let creatorA: string, creatorB: string, vA: string, vB: string, vPending: string;
let d1: string, d2: string;
let t1: FakeTablet, t2: FakeTablet, t3: FakeTablet;
let windowStart: string, windowEnd: string;

const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const ad = (campaignId: string, creativeId: string, startMs: number, visibleMs: number, o: { mutedMs?: number; wallMs?: number; contentVideoId?: string } = {}) => ({
  type: 'AD_PLAYBACK', eventId: randomUUID(), campaignId, creativeId, contentVideoId: o.contentVideoId,
  startedAt: iso(startMs), endedAt: iso(startMs + (o.wallMs ?? visibleMs)), visibleMs, mutedMs: o.mutedMs ?? 0, completed: true,
});
const content = (videoId: string, startMs: number, visibleMs: number) => ({ type: 'CONTENT_PLAYBACK', eventId: randomUUID(), videoId, startedAt: iso(startMs), endedAt: iso(startMs + visibleMs), visibleMs, mutedMs: 0 });
const click = (campaignId: string, creativeId: string, atMs: number) => ({ type: 'CLICK', eventId: randomUUID(), campaignId, creativeId, target: 'LANDING_PAGE', occurredAt: iso(atMs) });
const segment = (startMs: number, ms: number, interactions: number) => ({ type: 'ACTIVE_SEGMENT', eventId: randomUUID(), startedAt: iso(startMs), endedAt: iso(startMs + ms), screenOn: true, interactions });
const send = (t: FakeTablet, events: object[], over: { ts?: number } = {}) => t.call('POST', '/v1/devices/events', { batchId: randomUUID(), events }, over);
const validate = () => ctx.app.inject({ method: 'POST', url: '/v1/events/validate', headers: fin.h, payload: {} });
const statusOf = async (eventId: string) => (await ctx.db.query(
  `SELECT v.status, v.reasons, v.qualified, v.impression, v.creator_id, v.driver_id, v.watch_seconds, v.eligible_active_seconds, v.id::text
     FROM validated_events v JOIN raw_events r ON r.id = v.raw_event_id WHERE r.event_id = $1`, [eventId])).rows[0];

async function tablet(driverId: string, vehicleLabel: string) {
  const code = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${fleetOrg}/devices/enrollment-codes`, headers: fleetAdmin.h, payload: {} })).json().code;
  const t = new FakeTablet(ctx.app);
  t.deviceId = (await ctx.app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { code, serial: t.serial, publicKey: t.publicKeyB64, appVersion: '0.2.0' } })).json().deviceId;
  const fleet = (await ctx.db.query('SELECT id FROM fleets WHERE org_id = $1', [fleetOrg])).rows[0].id;
  const v = (await ctx.db.query('INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,$3) RETURNING id', [fleetOrg, fleet, vehicleLabel])).rows[0].id;
  // Backdate enrollment and assignment so the test can include events from the last hour.
  await ctx.db.query(`INSERT INTO device_status_history (device_id, status, changed_at) VALUES ($1, 'ACTIVE', now() - interval '2 hours')`, [t.deviceId]);
  await ctx.db.query(`INSERT INTO device_assignments (org_id, device_id, vehicle_id, driver_id, created_by, starts_at) VALUES ($1,$2,$3,$4,$5, now() - interval '2 hours')`,
    [fleetOrg, t.deviceId, v, driverId, fleetAdmin.userId]);
  return t;
}

beforeAll(async () => {
  ctx = await setupApp();
  await ensureOpenPeriod(ctx.db);
  const p = await platformOrg(ctx.db);
  fin = await userWithRole(ctx, p, 'finance_admin', { mfa: true });
  reviewer = await userWithRole(ctx, p, 'finance_approver', { mfa: true });
  const ap2 = await userWithRole(ctx, p, 'finance_approver', { mfa: true });
  for (const cat of REVENUE_CATEGORIES) {
    const s = INITIAL_RULE_SPLITS[cat];
    await ctx.db.query(
      `INSERT INTO revenue_rule_versions (category, version, effective_from, driver_bps, creator_bps, platform_bps, unallocated_driver_share, unallocated_creator_share,
         eligible_revenue_definition, contract_ref, status, created_by, approved_by_1, approved_by_2, approved_at)
       SELECT $1,1,'2026-01-01T00:00:00Z',$2,$3,$4,'TO_PLATFORM','TO_PLATFORM','validated net revenue (test)','TEST-v1','APPROVED',$5,$6,$7,now()
       WHERE NOT EXISTS (SELECT 1 FROM revenue_rule_versions WHERE category = $1)`,
      [cat, s.driverBps, s.creatorBps, s.platformBps, fin.userId, reviewer.userId, ap2.userId]);
  }
  advertiser = await org(ctx.db, 'ADVERTISER');
  await withTx(ctx.db, (tx) => postEntry(tx, { idempotencyKey: `fund-${advertiser}`, entryDate: new Date().toISOString().slice(0, 10), description: 'prepayment', sourceType: 'PAYMENT',
    lines: [{ accountCode: '1010', currency: 'USD', debit: 100_000n, processor: 'stripe-test' }, { accountCode: '2000', currency: 'USD', credit: 100_000n, partyType: 'ADVERTISER', partyId: advertiser }] }));
  const campaign = async (status: string) => (await ctx.db.query(
    `INSERT INTO campaigns (advertiser_org_id, name, status, starts_at, ends_at, pricing_model, rate_minor) VALUES ($1,$2,$3, now() - interval '3 hours', now() + interval '3 hours', 'CPQV', 50) RETURNING id`,
    [advertiser, `c-${uid()}`, status])).rows[0].id as string;
  const creative = async (campaignId: string, kind: string, durationMs: number | null) =>
    (await ctx.db.query(`INSERT INTO creatives (campaign_id, kind, status, duration_ms) VALUES ($1,$2,'APPROVED',$3) RETURNING id`, [campaignId, kind, durationMs])).rows[0].id as string;
  c1 = await campaign('APPROVED'); c1Video = await creative(c1, 'VIDEO', 30_000); c1Banner = await creative(c1, 'BANNER', null);
  cRate = await campaign('APPROVED'); cRateBanner = await creative(cRate, 'BANNER', null);
  cDraft = await campaign('DRAFT'); cDraftCreative = await creative(cDraft, 'VIDEO', 30_000);

  const studio = await org(ctx.db, 'CREATOR_STUDIO');
  const creator = async (n: string) => (await ctx.db.query(`INSERT INTO creator_profiles (org_id, display_name, monetization_status) VALUES ($1,$2,'ELIGIBLE') RETURNING id`, [studio, n])).rows[0].id as string;
  creatorA = await creator('A'); creatorB = await creator('B');
  const video = async (c: string, status: string) => (await ctx.db.query(`INSERT INTO videos (creator_id, title, status, duration_ms) VALUES ($1,'v',$2,600000) RETURNING id`, [c, status])).rows[0].id as string;
  vA = await video(creatorA, 'APPROVED'); vB = await video(creatorB, 'APPROVED'); vPending = await video(creatorA, 'PENDING_REVIEW');

  fleetOrg = await org(ctx.db, 'FLEET_OPERATOR');
  fleetAdmin = await userWithRole(ctx, fleetOrg, 'fleet_admin');
  const fleet = (await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'Main','Springfield','UTC') RETURNING id`, [fleetOrg])).rows[0].id;
  const driver = async () => {
    const u = (await ctx.db.query(`INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','d') RETURNING id`, [`drv-${uid()}@example.test`])).rows[0].id;
    return (await ctx.db.query(`INSERT INTO drivers (org_id, fleet_id, user_id, eligibility_status) VALUES ($1,$2,$3,'ELIGIBLE') RETURNING id`, [fleetOrg, fleet, u])).rows[0].id as string;
  };
  d1 = await driver(); d2 = await driver();
  t1 = await tablet(d1, 'V1'); t2 = await tablet(d2, 'V2'); t3 = await tablet(d2, 'V3');
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

const M = 60_000;
const ev: Record<string, any> = {};

describe('ingestion', () => {
  it('stores signed batches raw, dedupes replays, and rejects malformed events individually', async () => {
    const T = now();
    ev.contentA = content(vA, T - 9 * M, 60_000);
    ev.adA = ad(c1, c1Video, T - 8 * M, 30_000, { contentVideoId: vA });
    ev.overlap = ad(c1, c1Video, T - 8 * M + 5_000, 20_000, { contentVideoId: vA });
    ev.adB = ad(c1, c1Video, T - 7 * M, 20_000, { contentVideoId: vB });
    ev.muted = ad(c1, c1Video, T - 6 * M, 30_000, { mutedMs: 30_000, contentVideoId: vA });
    ev.impossible = ad(c1, c1Video, T - 5.5 * M, 25_000, { wallMs: 10_000 });
    ev.click1 = click(c1, c1Banner, T - 5 * M);
    ev.click2 = click(c1, c1Banner, T - 4 * M);
    ev.seg1 = segment(T - 9 * M, 8 * M, 3);
    const batch = [ev.contentA, ev.adA, ev.overlap, ev.adB, ev.muted, ev.impossible, ev.click1, ev.click2, ev.seg1, { type: 'AD_PLAYBACK', eventId: 'not-a-uuid' }];
    const r = await send(t1, batch);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ received: 10, accepted: 9, duplicates: 0 });
    expect(r.json().rejected).toHaveLength(1);
    const again = await send(t1, batch.slice(0, 9));
    expect(again.json()).toMatchObject({ accepted: 0, duplicates: 9 });

    ev.standalone = ad(c1, c1Video, T - 9 * M, 30_000);
    ev.contentB = content(vB, T - 8 * M, 40_000);
    ev.pendingVideoAd = ad(c1, c1Video, T - 7 * M, 30_000, { contentVideoId: vPending });
    ev.offline = ad(c1, c1Video, T - 30 * M, 30_000);
    ev.idle = segment(T - 3 * M, M, 0);
    ev.draft = ad(cDraft, cDraftCreative, T - 2.5 * M, 30_000);
    expect((await send(t2, [ev.standalone, ev.contentB, ev.pendingVideoAd, ev.offline, ev.idle, ev.draft])).json().accepted).toBe(6);

    // Unsigned or wrongly signed uploads never reach the raw store.
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/devices/events', payload: { batchId: randomUUID(), events: [ev.adA] } })).statusCode).toBe(401);
    await expect(ctx.db.query('DELETE FROM raw_events')).rejects.toThrow(/immutable/);
  });

  it('a suspended tablet\'s events are invalid; suspension is recorded in status history', async () => {
    await ctx.db.query(`INSERT INTO device_status_history (device_id, status, changed_at) VALUES ($1,'SUSPENDED', now() - interval '20 minutes')`, [t3.deviceId]);
    ev.suspended = ad(c1, c1Video, now() - 5 * M, 30_000);
    await send(t3, [ev.suspended]);
    const cmd = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${fleetOrg}/devices/${t3.deviceId}/commands`, headers: fleetAdmin.h, payload: { command: 'SUSPEND' } });
    expect(cmd.statusCode).toBe(201);
    const h = await ctx.db.query(`SELECT status FROM device_status_history WHERE device_id = $1 ORDER BY id DESC LIMIT 1`, [t3.deviceId]);
    expect(h.rows[0].status).toBe('SUSPENDED');
  });
});

describe('allocation from validated events only', () => {
  const windowBody = (key = `win-${uid()}`) => ({ idempotencyKey: key, periodStart: windowStart, periodEnd: windowEnd, entryDate: new Date().toISOString().slice(0, 10) });
  const postWin = (body: object) => ctx.app.inject({ method: 'POST', url: `/v1/finance/campaigns/${c1}/allocation-windows`, headers: fin.h, payload: body });

  it('refuses to allocate while events are unvalidated', async () => {
    windowStart = iso(now() - 60 * M);
    windowEnd = iso(now());
    const r = await postWin(windowBody());
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/not yet validated/);
  });

  it('validator applies VALIDATION_POLICY_V1', async () => {
    const r = (await validate()).json();
    expect(r.processed).toBe(16);
    const s = async (k: string) => statusOf(ev[k].eventId);
    expect(await s('adA')).toMatchObject({ status: 'VALID', qualified: true, creator_id: creatorA, driver_id: d1 });
    expect(await s('adB')).toMatchObject({ status: 'VALID', qualified: true, creator_id: creatorB });
    expect(await s('muted')).toMatchObject({ status: 'VALID', impression: true, qualified: false });
    expect((await s('overlap')).reasons).toContain('OVERLAPPING_PLAYBACK');
    expect((await s('impossible')).reasons).toContain('IMPOSSIBLE_DURATION');
    expect(await s('click1')).toMatchObject({ status: 'VALID' });
    expect((await s('click2')).reasons).toEqual(['DUPLICATE_CLICK']);
    expect(await s('contentA')).toMatchObject({ status: 'VALID', qualified: true, watch_seconds: 60 });
    expect(await s('seg1')).toMatchObject({ status: 'VALID', eligible_active_seconds: 480 });
    expect(await s('pendingVideoAd')).toMatchObject({ status: 'VALID', qualified: true, creator_id: null });
    expect(await s('offline')).toMatchObject({ status: 'HELD_REVIEW', reasons: ['OFFLINE_DELAYED'], driver_id: d2 });
    expect((await s('idle')).reasons).toEqual(['IDLE_SEGMENT']);
    expect((await s('draft')).reasons).toEqual(['CAMPAIGN_NOT_APPROVED']);
    expect((await s('suspended')).reasons).toEqual(['DEVICE_NOT_ACTIVE']);
    await expect(ctx.db.query(`UPDATE validated_events SET qualified = true WHERE raw_event_id IN (SELECT id FROM raw_events WHERE event_id = $1)`, [ev.muted.eventId])).rejects.toThrow(/only held events/);
  });

  it('held (offline) events block allocation until a human reviews them', async () => {
    const blocked = await postWin(windowBody());
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/held event/);
    const held = (await ctx.app.inject({ method: 'GET', url: '/v1/events/held', headers: reviewer.h })).json().items;
    const offlineRow = held.find((h: any) => h.campaign_id === c1);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/events/review', headers: fin.h, payload: { eventIds: [offlineRow.id], decision: 'APPROVE', note: 'tablet was in a tunnel' } })).statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: 'POST', url: '/v1/events/review', headers: reviewer.h, payload: { eventIds: [offlineRow.id], decision: 'APPROVE', note: 'Connectivity log confirms tunnel outage' } });
    expect(ok.json().updated).toBe(1);
  });

  it('posts creator-content and standalone batches whose numbers come only from valid events', async () => {
    const body = windowBody();
    const preview = (await ctx.app.inject({ method: 'POST', url: `/v1/finance/campaigns/${c1}/allocation-windows/preview`, headers: fin.h, payload: body })).json();
    expect(preview.earned).toEqual({ creatorContent: '100', standalone: '150' }); // 2 vs 3 qualified views x $0.50

    const r = await postWin(body);
    expect(r.statusCode).toBe(201);
    const out = r.json();
    const cc = out.batches.find((b: any) => b.sourceRef.endsWith('CREATOR_CONTENT')).calculation;
    const sa = out.batches.find((b: any) => b.sourceRef.endsWith('STANDALONE')).calculation;
    expect(cc.category).toBe('CREATOR_CONTENT_AD');
    expect([cc.partySplit.driver, cc.partySplit.creator, cc.partySplit.platform]).toEqual(['5', '60', '35']);
    // A: .5*(50/100) + .3*(60/100) + .2*(1/2) = .53 -> 31.8 ; B: .47 -> 28.2 ; largest remainder gives A the extra cent
    expect(Object.fromEntries(cc.creatorPool.shares.map((s: any) => [s.key, s.amount]))).toEqual({ [creatorA]: '32', [creatorB]: '28' });
    expect(cc.driverPool.shares).toEqual([{ key: d1, amount: '5' }]);
    expect(sa.category).toBe('STANDALONE_AD');
    expect([sa.partySplit.driver, sa.partySplit.platform, sa.partySplit.roundingResidual]).toEqual(['7', '142', '1']);
    expect(sa.driverPool.shares.map((s: any) => s.key).sort()).toEqual([d1, d2].sort());
    expect(sa.driverPool.shares.reduce((a: number, s: any) => a + Number(s.amount), 0)).toBe(7);

    const replay = await postWin(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().windowId).toBe(out.windowId);
    const overlap = await postWin({ ...windowBody(), periodStart: iso(new Date(windowStart).getTime() + 10 * M) });
    expect(overlap.statusCode).toBe(409);
    const tb = (await ctx.app.inject({ method: 'GET', url: '/v1/finance/trial-balance', headers: fin.h })).json();
    expect(tb.balanced).toBe(true);
  });

  it('late events for an allocated window are held and cannot be approved into it', async () => {
    ev.late = ad(c1, c1Video, new Date(windowEnd).getTime() - 20_000, 15_000);
    await send(t1, [ev.late]);
    await validate();
    const s = await statusOf(ev.late.eventId);
    expect(s).toMatchObject({ status: 'HELD_REVIEW', reasons: ['LATE_AFTER_ALLOCATION'] });
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/events/review', headers: reviewer.h, payload: { eventIds: [s.id], decision: 'APPROVE', note: 'try to sneak it in' } });
    expect(r.statusCode).toBe(409);
  });

  it('campaign metrics report valid delivery plus integrity counts', async () => {
    const m = (await ctx.app.inject({ method: 'GET', url: `/v1/finance/campaigns/${c1}/metrics?from=${encodeURIComponent(windowStart)}&to=${encodeURIComponent(windowEnd)}`, headers: fin.h })).json();
    expect(m).toMatchObject({ qualifiedViews: '5', clicks: '1', impressions: '6' });
    expect(m.invalidEvents).toBe('4'); // overlap, impossible duration, duplicate click, suspended tablet
  });
});

describe('anti-farming and clock drift', () => {
  it('holds qualified ad views beyond 40 per tablet-hour (across all campaigns)', async () => {
    const prior = (await ctx.db.query(`SELECT count(*)::int n FROM validated_events WHERE device_id = $1 AND type = 'AD_PLAYBACK' AND qualified AND status IN ('VALID','HELD_REVIEW')`, [t2.deviceId])).rows[0].n;
    expect(prior).toBe(3);
    const T = now() - 5 * M;
    const banners = Array.from({ length: 42 }, (_, i) => ad(cRate, cRateBanner, T + i * 2_000, 1_500));
    await send(t2, banners);
    await validate();
    const r = await ctx.db.query(`SELECT status, count(*)::int n FROM validated_events WHERE campaign_id = $1 GROUP BY status`, [cRate]);
    expect(Object.fromEntries(r.rows.map((x) => [x.status, x.n]))).toEqual({ VALID: 40 - prior, HELD_REVIEW: 2 + prior });
  });

  it('corrects event times by the signed request clock offset', async () => {
    const deviceNow = now() - 200_000; // tablet clock 200 s behind
    const e = content(vA, deviceNow - 30_000, 10_000);
    await send(t1, [e], { ts: Math.floor(deviceNow / 1000) });
    const r = (await ctx.db.query('SELECT device_occurred_at, occurred_at, clock_offset_ms FROM raw_events WHERE event_id = $1', [e.eventId])).rows[0];
    expect(r.clock_offset_ms).toBeGreaterThanOrEqual(199_000);
    expect(Math.abs(r.occurred_at.getTime() - (now() - 30_000))).toBeLessThan(5_000);
  });
});
