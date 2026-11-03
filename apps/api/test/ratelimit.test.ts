import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTablet, org, setupApp, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => {
  process.env.RATE_LIMIT_IN_TESTS = 'true'; // the rest of the suite disables rate limiting
  ctx = await setupApp();
});
afterAll(async () => { delete process.env.RATE_LIMIT_IN_TESTS; await ctx.app.close(); await ctx.db.end(); });

describe('rate limiting', () => {
  it('tablets sharing one carrier IP are limited per device, not per IP; other traffic is limited per IP', async () => {
    const orgId = await org(ctx.db, 'FLEET_OPERATOR');
    const admin = await userWithRole(ctx, orgId, 'fleet_admin');
    const tablets: FakeTablet[] = [];
    for (let i = 0; i < 2; i++) {
      const code = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/devices/enrollment-codes`, headers: admin.h, payload: {} })).json().code;
      const t = new FakeTablet(ctx.app);
      t.deviceId = (await ctx.app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { code, serial: t.serial, publicKey: t.publicKeyB64, appVersion: '1' } })).json().deviceId;
      tablets.push(t);
    }
    // 2 × 200 signed requests from the same IP: 400 > 300/min, which a per-IP limit would have throttled.
    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) for (const t of tablets) statuses.push((await t.call('POST', '/v1/devices/heartbeat', { appVersion: '1' })).statusCode);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
    // One tablet beyond its own budget is throttled.
    const extra: number[] = [];
    for (let i = 0; i < 120; i++) extra.push((await tablets[0]!.call('POST', '/v1/devices/heartbeat', { appVersion: '1' })).statusCode);
    expect(extra).toContain(429);
    // Unsigned traffic from one IP still shares the per-IP budget.
    const anon: number[] = [];
    for (let i = 0; i < 310; i++) anon.push((await ctx.app.inject({ method: 'GET', url: '/healthz' })).statusCode);
    expect(anon).toContain(429);
  });
});
