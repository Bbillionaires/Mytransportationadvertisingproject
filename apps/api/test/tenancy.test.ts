import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { org, platformOrg, setupApp, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('RBAC and tenant isolation', () => {
  it('a fleet admin manages only their own fleet operator', async () => {
    const a = await org(ctx.db, 'FLEET_OPERATOR');
    const b = await org(ctx.db, 'FLEET_OPERATOR');
    const adminA = await userWithRole(ctx, a, 'fleet_admin');
    const adminB = await userWithRole(ctx, b, 'fleet_admin');

    const fa = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${a}/fleets`, headers: adminA.h, payload: { name: 'A main', market: 'Springfield', timezone: 'America/Chicago' } });
    expect(fa.statusCode).toBe(201);
    const fb = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${b}/fleets`, headers: adminB.h, payload: { name: 'B main', market: 'Springfield', timezone: 'America/Chicago' } });

    // Cross-tenant reads and writes are refused.
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/orgs/${b}/fleets`, headers: adminA.h })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/orgs/${b}/devices`, headers: adminA.h })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${b}/vehicles`, headers: adminA.h, payload: { fleetId: fb.json().id, label: 'X' } })).statusCode).toBe(403);
    // Referencing another tenant's fleet from your own org is a 404, not a leak.
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${a}/vehicles`, headers: adminA.h, payload: { fleetId: fb.json().id, label: 'X' } })).statusCode).toBe(404);

    const list = await ctx.app.inject({ method: 'GET', url: `/v1/orgs/${a}/fleets`, headers: adminA.h });
    expect(list.json().items.map((f: any) => f.org_id)).toEqual([a]);
    const orgs = await ctx.app.inject({ method: 'GET', url: '/v1/orgs', headers: adminA.h });
    expect(orgs.json().items.map((o: any) => o.id)).toEqual([a]);
  });

  it('the database itself rejects cross-tenant references', async () => {
    const a = await org(ctx.db, 'FLEET_OPERATOR');
    const b = await org(ctx.db, 'FLEET_OPERATOR');
    const fleetB = (await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'f','m','UTC') RETURNING id`, [b])).rows[0].id;
    await expect(ctx.db.query(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,'x')`, [a, fleetB])).rejects.toThrow(/foreign key/);
  });

  it('non-finance roles cannot reach finance, and roles cannot be granted in the wrong org kind', async () => {
    const a = await org(ctx.db, 'FLEET_OPERATOR');
    const admin = await userWithRole(ctx, a, 'fleet_admin');
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/finance/trial-balance', headers: admin.h })).statusCode).toBe(403);
    const grant = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${a}/members`, headers: admin.h, payload: { email: 'x@example.test', displayName: 'x', role: 'super_admin', initialPassword: 'a-long-password-123' } });
    expect(grant.statusCode).toBe(403);
    const p = await platformOrg(ctx.db);
    const u = (await ctx.db.query(`INSERT INTO users (email, password_hash, display_name) VALUES ('kind-${a}@example.test','x','x') RETURNING id`)).rows[0].id;
    await expect(ctx.db.query(`INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,'fleet_admin')`, [u, p])).rejects.toThrow(/cannot be granted/);
  });

  it('a tenant admin can add new members to their org but cannot attach existing users from elsewhere', async () => {
    const a = await org(ctx.db, 'FLEET_OPERATOR');
    const b = await org(ctx.db, 'FLEET_OPERATOR');
    const admin = await userWithRole(ctx, a, 'fleet_admin');
    const other = await userWithRole(ctx, b, 'driver');
    const ok = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${a}/members`, headers: admin.h, payload: { email: `new-${a}@example.test`, displayName: 'New Driver', role: 'driver', initialPassword: 'a-long-password-123' } });
    expect(ok.statusCode).toBe(201);
    const steal = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${a}/members`, headers: admin.h, payload: { email: other.email, displayName: 'x', role: 'driver' } });
    expect(steal.statusCode).toBe(403);
  });

  it('platform staff with MFA can operate across tenants; every mutation is in the hash-chained audit log', async () => {
    const p = await platformOrg(ctx.db);
    const sa = await userWithRole(ctx, p, 'super_admin', { mfa: true });
    const created = await ctx.app.inject({ method: 'POST', url: '/v1/orgs', headers: sa.h, payload: { kind: 'ADVERTISER', name: 'Acme Ads' } });
    expect(created.statusCode).toBe(201);
    const log = await ctx.app.inject({ method: 'GET', url: '/v1/audit?limit=500', headers: sa.h });
    expect(log.json().items.some((x: any) => x.action === 'org.created' && x.target_id === created.json().id)).toBe(true);
    const chain = await ctx.db.query('SELECT id, prev_hash, hash FROM audit_log ORDER BY id');
    for (let i = 1; i < chain.rows.length; i++) expect(chain.rows[i].prev_hash).toBe(chain.rows[i - 1].hash);
    await expect(ctx.db.query('UPDATE audit_log SET action = $1 WHERE id = $2', ['tampered', chain.rows[0].id])).rejects.toThrow(/immutable/);
    await expect(ctx.db.query('DELETE FROM audit_log')).rejects.toThrow(/immutable/);
  });
});
