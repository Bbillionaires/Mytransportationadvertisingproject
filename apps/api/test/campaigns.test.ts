import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { verifyMediaSignature } from '../src/lib/media.js';
import { postEntry } from '../src/modules/ledger/service.js';
import { ensureOpenPeriod, FakeTablet, org, platformOrg, readyAsset, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
let moderator: Awaited<ReturnType<typeof userWithRole>>;
let fleetAdmin: Awaited<ReturnType<typeof userWithRole>>;
let fleetOrg: string;
let tablet: FakeTablet;
const adv: Record<'a' | 'b', { orgId: string; userId: string; h: Record<string, string>; email: string }> = {} as any;
const M = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const api = (method: 'GET' | 'POST' | 'PATCH', url: string, h: object, payload?: object) => ctx.app.inject({ method, url, headers: h as any, payload });
const baseCampaign = (over: Record<string, unknown> = {}) => ({
  name: `Campaign ${uid()}`, category: 'FOOD_DRINK', pricingModel: 'CPQV', rateMinor: '50', startsAt: iso(Date.now() - 60 * M), endsAt: iso(Date.now() + 24 * 60 * M),
  destinationUrl: 'https://coffee.example.test/offer', markets: ['Springfield'], ...over,
});
const videoCreative = async (key: 'a' | 'b') => ({ name: '30s spot', kind: 'VIDEO', uploadId: await readyAsset(ctx.db, adv[key].orgId, adv[key].userId), headline: 'Fresh coffee' });

async function register(key: 'a' | 'b') {
  const email = `adv-${key}-${uid()}@example.test`;
  const r = await api('POST', '/v1/advertisers/register', {}, { organizationName: `Advertiser ${key.toUpperCase()}`, email, displayName: 'Owner', password: 'a-long-password-123' });
  expect(r.statusCode).toBe(201);
  const login = await api('POST', '/v1/auth/login', {}, { email, password: 'a-long-password-123' });
  adv[key] = { orgId: r.json().organizationId, userId: r.json().userId, h: { authorization: `Bearer ${login.json().token}` }, email };
}

/** Full happy path through the API: draft -> creative -> submit -> moderator approval. */
async function approvedCampaign(key: 'a' | 'b', over: Record<string, unknown> = {}) {
  const c = await api('POST', `/v1/orgs/${adv[key].orgId}/campaigns`, adv[key].h, baseCampaign(over));
  expect(c.statusCode, c.body).toBe(201);
  const cr = await api('POST', `/v1/orgs/${adv[key].orgId}/campaigns/${c.json().id}/creatives`, adv[key].h, await videoCreative(key));
  expect(cr.statusCode, cr.body).toBe(201);
  expect((await api('POST', `/v1/orgs/${adv[key].orgId}/campaigns/${c.json().id}/submit`, adv[key].h, {})).statusCode).toBe(200);
  const d = await api('POST', `/v1/review/campaigns/${c.json().id}/decision`, moderator.h, { decision: 'APPROVE', note: 'meets ad policy', creatives: [{ creativeId: cr.json().id, decision: 'APPROVE' }] });
  expect(d.statusCode, d.body).toBe(200);
  return { campaignId: c.json().id as string, creativeId: cr.json().id as string };
}

const playlist = async () => (await tablet.call('GET', '/v1/devices/playlist')).json();

beforeAll(async () => {
  ctx = await setupApp();
  await ensureOpenPeriod(ctx.db);
  moderator = await userWithRole(ctx, await platformOrg(ctx.db), 'moderator', { mfa: true });
  await register('a');
  await register('b');
  await withTx(ctx.db, (tx) => postEntry(tx, { idempotencyKey: `fund-${adv.a.orgId}`, entryDate: new Date().toISOString().slice(0, 10), description: 'prepayment', sourceType: 'PAYMENT',
    lines: [{ accountCode: '1010', currency: 'USD', debit: 50_000n, processor: 'stripe-test' }, { accountCode: '2000', currency: 'USD', credit: 50_000n, partyType: 'ADVERTISER', partyId: adv.a.orgId }] }));

  fleetOrg = await org(ctx.db, 'FLEET_OPERATOR');
  fleetAdmin = await userWithRole(ctx, fleetOrg, 'fleet_admin');
  const fleet = (await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'Main','Springfield','America/Chicago') RETURNING id`, [fleetOrg])).rows[0].id;
  const vehicle = (await ctx.db.query(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,'V1') RETURNING id`, [fleetOrg, fleet])).rows[0].id;
  const code = (await api('POST', `/v1/orgs/${fleetOrg}/devices/enrollment-codes`, fleetAdmin.h, {})).json().code;
  tablet = new FakeTablet(ctx.app);
  tablet.deviceId = (await api('POST', '/v1/devices/enroll', {}, { code, serial: tablet.serial, publicKey: tablet.publicKeyB64, appVersion: '0.3.0' })).json().deviceId;
  await ctx.db.query(`INSERT INTO device_status_history (device_id, status, changed_at) VALUES ($1,'ACTIVE', now() - interval '2 hours')`, [tablet.deviceId]);
  await ctx.db.query(`INSERT INTO device_assignments (org_id, device_id, vehicle_id, created_by, starts_at) VALUES ($1,$2,$3,$4, now() - interval '2 hours')`, [fleetOrg, tablet.deviceId, vehicle, fleetAdmin.userId]);
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('advertiser self-service', () => {
  it('registration creates an isolated advertiser tenant', async () => {
    const dup = await api('POST', '/v1/advertisers/register', {}, { organizationName: 'Dup', email: adv.a.email, displayName: 'x', password: 'a-long-password-123' });
    expect(dup.statusCode).toBe(409);
    expect((await api('GET', `/v1/orgs/${adv.a.orgId}/campaigns`, adv.a.h)).statusCode).toBe(200);
    expect((await api('GET', `/v1/orgs/${adv.b.orgId}/campaigns`, adv.a.h)).statusCode).toBe(403);
    expect((await api('GET', '/v1/review/campaigns', adv.a.h)).statusCode).toBe(403);
  });

  it('refuses restricted categories, non-https destinations and unknown time zones', async () => {
    const bad = async (over: Record<string, unknown>) => (await api('POST', `/v1/orgs/${adv.a.orgId}/campaigns`, adv.a.h, baseCampaign(over))).json();
    expect(JSON.stringify((await bad({ category: 'GAMBLING' })).error.details)).toMatch(/restricted/);
    expect(JSON.stringify((await bad({ destinationUrl: 'http://insecure.example.test' })).error.details)).toMatch(/https/);
    expect(JSON.stringify((await bad({ timezone: 'Mars/Olympus' })).error.details)).toMatch(/time zone/);
  });

  it('drafts are editable; submitted billing terms are frozen; moderation decides every creative', async () => {
    const c = (await api('POST', `/v1/orgs/${adv.a.orgId}/campaigns`, adv.a.h, baseCampaign())).json();
    const url = `/v1/orgs/${adv.a.orgId}/campaigns/${c.id}`;
    expect((await api('POST', `${url}/submit`, adv.a.h, {})).statusCode).toBe(422); // no creatives yet
    expect((await api('POST', `${url}/creatives`, adv.a.h, { name: 'x', kind: 'VIDEO', durationMs: 30_000 })).statusCode).toBe(400); // missing media
    const video = (await api('POST', `${url}/creatives`, adv.a.h, await videoCreative('a'))).json();
    expect(video.durationMs).toBe(30_000); // from the probed asset, not the advertiser
    const bannerRes = await api('POST', `${url}/creatives`, adv.a.h, { name: 'banner', kind: 'BANNER', headline: '2-for-1 lattes today' });
    expect(bannerRes.statusCode, bannerRes.body).toBe(201);
    const banner = bannerRes.json();
    expect((await api('PATCH', url, adv.a.h, { rateMinor: '60' })).json().rateMinor).toBe('60');
    expect((await api('POST', `${url}/submit`, adv.a.h, {})).json().status).toBe('PENDING_REVIEW');

    const frozen = await api('PATCH', url, adv.a.h, { rateMinor: '10' });
    expect(frozen.statusCode).toBe(403);
    expect((await api('PATCH', url, adv.a.h, { endsAt: iso(Date.now() + 48 * 60 * M) })).statusCode).toBe(403); // cannot extend
    expect((await api('PATCH', url, adv.a.h, { name: 'Renamed' })).statusCode).toBe(200);

    const queue = (await api('GET', '/v1/review/campaigns', moderator.h)).json().campaigns;
    expect(queue.find((q: any) => q.id === c.id).creatives, JSON.stringify([video, banner])).toHaveLength(2);
    const partial = await api('POST', `/v1/review/campaigns/${c.id}/decision`, moderator.h, { decision: 'APPROVE', note: 'looks fine', creatives: [{ creativeId: video.id, decision: 'APPROVE' }] });
    expect(partial.statusCode).toBe(422);
    const ok = await api('POST', `/v1/review/campaigns/${c.id}/decision`, moderator.h, { decision: 'APPROVE', note: 'video meets policy',
      creatives: [{ creativeId: video.id, decision: 'APPROVE' }, { creativeId: banner.id, decision: 'REJECT', note: 'unsubstantiated claim' }] });
    expect(ok.json().status).toBe('APPROVED');
    expect((await api('POST', `${url}/submit`, adv.a.h, {})).statusCode).toBe(422); // APPROVED -> PENDING_REVIEW is not a valid transition
    expect((await api('POST', `${url}/pause`, adv.a.h, {})).json().status).toBe('PAUSED');
    expect((await api('POST', `${url}/resume`, adv.a.h, {})).json().status).toBe('APPROVED');
    await expect(ctx.db.query(`UPDATE creatives SET media_key = 'swapped.mp4' WHERE id = $1`, [video.id])).rejects.toThrow(/immutable/);
    const detail = (await api('GET', url, adv.a.h)).json();
    expect(detail.creatives.map((x: any) => x.status).sort()).toEqual(['APPROVED', 'REJECTED']);
  });

  it('balance comes from the ledger and is scoped to the advertiser', async () => {
    expect((await api('GET', `/v1/orgs/${adv.a.orgId}/balance`, adv.a.h)).json().balances.USD.prepaidBalance).toBe('50000');
    expect((await api('GET', `/v1/orgs/${adv.a.orgId}/balance`, adv.b.h)).statusCode).toBe(403);
  });
});

describe('tablet playlist', () => {
  let live: { campaignId: string; creativeId: string };
  let otherMarket: string, unfunded: string, offSchedule: string;

  beforeAll(async () => {
    live = await approvedCampaign('a', { priority: 9 });
    otherMarket = (await approvedCampaign('a', { markets: ['Shelbyville'] })).campaignId;
    unfunded = (await approvedCampaign('b')).campaignId; // advertiser B has no prepaid balance
    offSchedule = (await approvedCampaign('a', { timezone: 'UTC', daysOfWeek: [(new Date().getUTCDay() + 3) % 7] })).campaignId;
  });

  it('serves only approved, funded, in-market, in-schedule ads with signed expiring media', async () => {
    const p = await playlist();
    expect(p.playbackAllowed).toBe(true);
    expect(p.market).toBe('Springfield');
    const ids = p.ads.map((a: any) => a.campaignId);
    expect(ids).toContain(live.campaignId);
    for (const excluded of [otherMarket, unfunded, offSchedule]) expect(ids).not.toContain(excluded);
    const ad = p.ads.find((a: any) => a.campaignId === live.campaignId);
    expect(ad).toMatchObject({ kind: 'VIDEO', priority: 9, destinationUrl: 'https://coffee.example.test/offer' });
    const u = new URL(ad.media.url);
    expect(u.origin).toBe('https://cdn.example.test');
    const key = decodeURIComponent(u.pathname.slice(1));
    expect(verifyMediaSignature(key, Number(u.searchParams.get('exp')), u.searchParams.get('sig')!, ctx.config.MEDIA_SIGNING_KEY)).toBe(true);
    expect(new Date(ad.expiresAt).getTime()).toBeLessThanOrEqual(new Date(p.validUntil).getTime());
  });

  it('paused campaigns disappear, and suspended tablets get nothing', async () => {
    await api('POST', `/v1/orgs/${adv.a.orgId}/campaigns/${live.campaignId}/pause`, adv.a.h, {});
    expect((await playlist()).ads.map((a: any) => a.campaignId)).not.toContain(live.campaignId);
    await api('POST', `/v1/orgs/${adv.a.orgId}/campaigns/${live.campaignId}/resume`, adv.a.h, {});
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${tablet.deviceId}/commands`, fleetAdmin.h, { command: 'SUSPEND' });
    const p = await playlist();
    expect(p).toMatchObject({ playbackAllowed: false, ads: [], content: [] });
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${tablet.deviceId}/commands`, fleetAdmin.h, { command: 'RESUME' });
  });

  it('the validator independently rejects out-of-market and off-schedule plays and enforces frequency caps', async () => {
    const capped = await approvedCampaign('a', { frequencyCapPerHour: 2 });
    const T = Date.now() - 8 * M;
    const ad = (campaignId: string, creativeId: string, start: number) => ({ type: 'AD_PLAYBACK', eventId: randomUUID(), campaignId, creativeId,
      startedAt: iso(start), endedAt: iso(start + 30_000), visibleMs: 30_000, mutedMs: 0, completed: true });
    const creativeOf = async (cid: string) => (await ctx.db.query('SELECT id FROM creatives WHERE campaign_id = $1', [cid])).rows[0].id;
    const events = [
      ad(otherMarket, await creativeOf(otherMarket), T),
      ad(offSchedule, await creativeOf(offSchedule), T + M),
      ad(capped.campaignId, capped.creativeId, T + 2 * M),
      ad(capped.campaignId, capped.creativeId, T + 3 * M),
      ad(capped.campaignId, capped.creativeId, T + 4 * M),
    ];
    expect((await tablet.call('POST', '/v1/devices/events', { batchId: randomUUID(), events })).json().accepted).toBe(5);
    const fin = await userWithRole(ctx, await platformOrg(ctx.db), 'finance_admin', { mfa: true });
    await api('POST', '/v1/events/validate', fin.h, {});
    const reasons = async (eventId: string) => (await ctx.db.query(`SELECT v.status, v.reasons FROM validated_events v JOIN raw_events r ON r.id = v.raw_event_id WHERE r.event_id = $1`, [eventId])).rows[0];
    expect(await reasons(events[0]!.eventId)).toEqual({ status: 'INVALID', reasons: ['MARKET_NOT_TARGETED'] });
    expect(await reasons(events[1]!.eventId)).toEqual({ status: 'INVALID', reasons: ['OUTSIDE_SCHEDULE'] });
    expect((await reasons(events[3]!.eventId)).status).toBe('VALID');
    expect(await reasons(events[4]!.eventId)).toEqual({ status: 'INVALID', reasons: ['FREQUENCY_CAP_EXCEEDED'] });
    const m = (await api('GET', `/v1/orgs/${adv.a.orgId}/campaigns/${capped.campaignId}/metrics?from=${encodeURIComponent(iso(T - M))}&to=${encodeURIComponent(iso(Date.now()))}`, adv.a.h)).json();
    expect(m).toMatchObject({ qualifiedViews: '2', invalidEvents: '1' });
    expect((await api('GET', `/v1/orgs/${adv.a.orgId}/campaigns/${capped.campaignId}/metrics?from=${encodeURIComponent(iso(T))}&to=${encodeURIComponent(iso(Date.now()))}`, adv.b.h)).statusCode).toBe(403);
  });
});
