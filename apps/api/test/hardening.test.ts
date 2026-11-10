/** Fixes from the live security probe (R-015 preparation, session 29). */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { org, setupApp, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('live probe findings', () => {
  it('API responses are never cached (personal and financial data)', async () => {
    const u = await userWithRole(ctx, await org(ctx.db, 'FLEET_OPERATOR'), 'fleet_admin');
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: u.h });
    expect(me.statusCode).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    const denied = await ctx.app.inject({ method: 'GET', url: '/v1/me' });
    expect(denied.headers['cache-control']).toBe('no-store');
  });

  it('unknown addresses get the app’s own error shape, not the framework’s', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'not found' } });
    expect(r.body).not.toMatch(/Route GET/);
  });

  it('database errors don’t reveal table, column or constraint names', async () => {
    const fleet = await org(ctx.db, 'FLEET_OPERATOR');
    const admin = await userWithRole(ctx, fleet, 'fleet_admin');
    const f = { name: 'North', market: 'Springfield', timezone: 'America/Chicago' };
    const first = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${fleet}/fleets`, headers: admin.h, payload: f });
    expect(first.statusCode, first.body).toBe(201);
    const fleetId = first.json().id;
    const v = { fleetId, label: 'CAB-1' };
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${fleet}/vehicles`, headers: admin.h, payload: v })).statusCode).toBe(201);
    const dup = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${fleet}/vehicles`, headers: admin.h, payload: v });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatchObject({ code: 'CONFLICT', message: 'this already exists' });
    expect(dup.body).not.toMatch(/constraint|vehicles_|duplicate key/);
  });

  it('production doesn’t publish source maps; development still does', async () => {
    const keys = { APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'), PAYMENTS_PROVIDER: 'disabled' };
    const prod = await buildApp({ config: loadConfig({ NODE_ENV: 'production', DATABASE_URL: ctx.config.DATABASE_URL, ...keys }), db: ctx.db, logger: false });
    for (const p of ['/portal/portal.js.map', '/player/player.js.map', '/rider/rider.js.map']) expect((await prod.inject({ method: 'GET', url: p })).statusCode, p).toBe(404);
    await prod.close();
    const dev = await ctx.app.inject({ method: 'GET', url: '/portal/portal.js.map' });
    expect([200, 404]).toContain(dev.statusCode); // 404 only when the portal hasn't been built in this checkout
  });
});
