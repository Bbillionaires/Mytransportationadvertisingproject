import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, runWithDbScope } from '../src/db/pool.js';
import { org, platformOrg, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
let a: string, b: string;
const der = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
const device = (orgId: string) => ctx.db.query(`INSERT INTO devices (org_id, serial, public_key_der) VALUES ($1,$2,$3) RETURNING id`, [orgId, `RLS-${uid()}`, der()]).then((r) => r.rows[0].id as string);

beforeAll(async () => {
  ctx = await setupApp();
  // A deliberately buggy route that forgets the tenant filter: the database must still contain the damage.
  ctx.app.get('/v1/test/forgotten-filter', async () => ({ orgs: [...new Set((await ctx.db.query('SELECT org_id FROM devices')).rows.map((r) => r.org_id))] }));
  ctx.app.post('/v1/test/forgotten-check', async (req) => {
    const { orgId } = req.body as { orgId: string };
    await ctx.db.query(`INSERT INTO vehicles (org_id, fleet_id, label) SELECT $1, id, 'stolen' FROM fleets WHERE org_id = $1 LIMIT 1`, [orgId]);
    return { ok: true };
  });
  a = await org(ctx.db, 'FLEET_OPERATOR');
  b = await org(ctx.db, 'FLEET_OPERATOR');
  await device(a); await device(b);
  await ctx.db.query(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'F','M','UTC')`, [b]);
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('database row-level security (R-003)', () => {
  it('the API connects as the restricted runtime role, not as a superuser or table owner', async () => {
    const r = (await ctx.db.query(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`)).rows[0];
    expect(r).toEqual({ u: 'rmn_app', su: false, bypass: false });
    // So it cannot switch off ledger protections (R-002).
    await expect(ctx.db.query('ALTER TABLE journal_entries DISABLE TRIGGER ALL')).rejects.toThrow(/must be owner/);
  });

  it('fails closed: if the restricted role cannot be assumed, queries error (nothing runs as the login role) and the process survives', async () => {
    const bad = createPool(ctx.config.DATABASE_URL, { runtimeRole: 'rmn_role_that_does_not_exist' });
    await expect(bad.query('SELECT current_user')).rejects.toThrow(/does not exist/);
    await expect(bad.query('SELECT current_user')).rejects.toThrow(/does not exist/); // every new connection, not just the first
    await bad.end();
  });

  it('a route that forgets its tenant filter still only sees the caller’s organization', async () => {
    const userA = await userWithRole(ctx, a, 'fleet_admin');
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/test/forgotten-filter', headers: userA.h })).json().orgs).toEqual([a]);
    const staff = await userWithRole(ctx, await platformOrg(ctx.db), 'support_agent');
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/test/forgotten-filter', headers: staff.h })).json().orgs).toEqual(expect.arrayContaining([a, b])); // other test files share the DB
  });

  it('a route that forgets its permission check cannot write into another organization', async () => {
    const userA = await userWithRole(ctx, a, 'fleet_admin');
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/test/forgotten-check', headers: userA.h, payload: { orgId: b } });
    expect(r.statusCode).toBe(200); // the SELECT of org B's fleet sees nothing, so nothing is inserted
    expect((await ctx.db.query(`SELECT count(*)::int n FROM vehicles WHERE org_id = $1`, [b])).rows[0].n).toBe(0);
    await expect(runWithDbScope(`tenant:${a}`, () => ctx.db.query(`INSERT INTO devices (org_id, serial, public_key_der) VALUES ($1,$2,$3)`, [b, `X-${uid()}`, der()])))
      .rejects.toThrow(/row-level security/);
  });

  it('scopes apply to transactions and pooled connections, and unknown scopes fail closed', async () => {
    const seen = (scope: string) => runWithDbScope(scope, async () => (await ctx.db.query(`SELECT count(DISTINCT org_id)::int n FROM devices WHERE org_id = ANY($1)`, [[a, b]])).rows[0].n);
    expect(await seen(`tenant:${b}`)).toBe(1);
    expect(await seen('platform')).toBe(2);
    expect(await seen('')).toBe(2);              // system jobs, tablets, riders
    expect(await seen('garbage')).toBe(0);       // fail closed
    expect(await seen('tenant:')).toBe(0);       // a user with no organizations sees nothing
    // The scope does not leak to the next checkout of the same pooled connection.
    expect(await seen(`tenant:${a}`)).toBe(1);
    expect(await seen('')).toBe(2);
  });

  it('campaign rows are readable for analytics but only the owning advertiser can change them', async () => {
    const adv1 = await org(ctx.db, 'ADVERTISER'), adv2 = await org(ctx.db, 'ADVERTISER');
    const c = (await ctx.db.query(`INSERT INTO campaigns (advertiser_org_id, name, starts_at, ends_at, pricing_model, rate_minor) VALUES ($1,'C', now(), now() + interval '1 day','CPM',100) RETURNING id`, [adv1])).rows[0].id;
    const upd = await runWithDbScope(`tenant:${adv2}`, () => ctx.db.query(`UPDATE campaigns SET name = 'hijacked' WHERE id = $1`, [c]));
    expect(upd.rowCount).toBe(0);
    expect((await runWithDbScope(`tenant:${adv2}`, () => ctx.db.query(`SELECT 1 FROM campaigns WHERE id = $1`, [c]))).rowCount).toBe(1);
  });
});
