import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { org, platformOrg, setupApp, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
let platform: string;
beforeAll(async () => { ctx = await setupApp(); platform = await platformOrg(ctx.db); });
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });
const inj = (method: 'GET' | 'POST', url: string, h: Record<string, string>, payload?: unknown) => ctx.app.inject({ method, url, headers: h, payload: payload as any });

describe('platform earnings eligibility', () => {
  it('super admins with MFA confirm creator monetization with a reason; it is audited', async () => {
    const admin = await userWithRole(ctx, platform, 'super_admin', { mfa: true });
    const studio = await org(ctx.db, 'CREATOR_STUDIO');
    const ch = (await ctx.db.query(`INSERT INTO creator_profiles (org_id, display_name) VALUES ($1,'Walks') RETURNING id`, [studio])).rows[0].id;
    const list = (await inj('GET', '/v1/platform/creators?status=PENDING', admin.h)).json().items;
    expect(list.find((x: any) => x.id === ch)).toMatchObject({ monetization_status: 'PENDING', videos_total: 0 });
    expect((await inj('POST', `/v1/platform/creators/${ch}/monetization`, admin.h, { status: 'ELIGIBLE', reason: 'x' })).statusCode).toBe(400);
    const r = await inj('POST', `/v1/platform/creators/${ch}/monetization`, admin.h, { status: 'ELIGIBLE', reason: 'W-9 and payout account verified' });
    expect(r.json()).toEqual({ id: ch, monetizationStatus: 'ELIGIBLE' });
    const a = (await ctx.db.query(`SELECT details FROM audit_log WHERE action = 'creator.monetization_changed' AND target_id = $1`, [ch])).rows[0];
    expect(a.details).toMatchObject({ from: 'PENDING', to: 'ELIGIBLE', reason: 'W-9 and payout account verified' });
  });

  it('driver eligibility is listed with subscription status and decided by staff', async () => {
    const admin = await userWithRole(ctx, platform, 'super_admin', { mfa: true });
    const fleetOrg = await org(ctx.db, 'FLEET_OPERATOR');
    const u = await userWithRole(ctx, fleetOrg, 'driver');
    const fleet = (await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'F','M','UTC') RETURNING id`, [fleetOrg])).rows[0].id;
    const d = (await ctx.db.query(`INSERT INTO drivers (org_id, fleet_id, user_id) VALUES ($1,$2,$3) RETURNING id`, [fleetOrg, fleet, u.userId])).rows[0].id;
    expect((await inj('GET', '/v1/platform/drivers', admin.h)).json().items.find((x: any) => x.id === d)).toMatchObject({ eligibility_status: 'PENDING', subscription_status: null });
    expect((await inj('POST', `/v1/platform/drivers/${d}/eligibility`, admin.h, { status: 'ELIGIBLE', reason: 'subscription and terms confirmed' })).json().eligibilityStatus).toBe('ELIGIBLE');
  });

  it('requires MFA and the platform permission, and staff cannot decide for their own organization', async () => {
    const noMfa = await userWithRole(ctx, platform, 'super_admin');
    expect((await inj('GET', '/v1/platform/creators', noMfa.h)).json().error.code).toBe('MFA_REQUIRED');
    const moderator = await userWithRole(ctx, platform, 'moderator', { mfa: true });
    expect((await inj('GET', '/v1/platform/creators', moderator.h)).statusCode).toBe(403);
    const studio = await org(ctx.db, 'CREATOR_STUDIO');
    const own = await userWithRole(ctx, platform, 'super_admin', { mfa: true });
    await ctx.db.query(`INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,'creator_owner')`, [own.userId, studio]);
    const ch = (await ctx.db.query(`INSERT INTO creator_profiles (org_id, display_name) VALUES ($1,'Mine') RETURNING id`, [studio])).rows[0].id;
    expect((await inj('POST', `/v1/platform/creators/${ch}/monetization`, own.h, { status: 'ELIGIBLE', reason: 'my own channel' })).statusCode).toBe(409);
  });

  it('the ad review queue includes signed previews of each creative', async () => {
    const mod = await userWithRole(ctx, platform, 'moderator', { mfa: true });
    const adv = await org(ctx.db, 'ADVERTISER');
    const c = (await ctx.db.query(`INSERT INTO campaigns (advertiser_org_id, name, status, starts_at, ends_at, pricing_model, rate_minor, submitted_at)
                                   VALUES ($1,'Q','PENDING_REVIEW', now(), now() + interval '1 day','CPQV',50, now()) RETURNING id`, [adv])).rows[0].id;
    await ctx.db.query(`INSERT INTO creatives (campaign_id, kind, status, duration_ms, media_key) VALUES ($1,'VIDEO','PENDING_REVIEW',5000,'assets/00000000-0000-0000-0000-000000000000/720p.mp4')`, [c]);
    const q = (await inj('GET', '/v1/review/campaigns', mod.h)).json().campaigns.find((x: any) => x.id === c);
    expect(q.creatives[0].previewUrl).toMatch(/^https:\/\/cdn\.example\.test\/assets\/.+720p\.mp4\?.*sig=/);
  });
});
