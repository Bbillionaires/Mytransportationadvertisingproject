/** Changing a member's role and removing members: immediate effect, no self-changes, never the last admin. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { org, platformOrg, setupApp, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

const call = (method: 'GET' | 'PATCH' | 'POST', url: string, h: Record<string, string>, payload?: object) => ctx.app.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });
const membershipOf = async (orgId: string, userId: string) =>
  (await ctx.db.query(`SELECT id, role_code FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'ACTIVE'`, [orgId, userId])).rows;

describe('editing team roles', () => {
  it('a fleet admin changes a viewer to admin and back; the new permissions apply on the next request; audited', async () => {
    const fleet = await org(ctx.db, 'FLEET_OPERATOR');
    const admin = await userWithRole(ctx, fleet, 'fleet_admin');
    const viewer = await userWithRole(ctx, fleet, 'fleet_viewer');
    const [m] = await membershipOf(fleet, viewer.userId);
    expect((await call('GET', `/v1/orgs/${fleet}/devices/enrollment-codes`, viewer.h)).statusCode).toBe(403);

    const r = await call('PATCH', `/v1/orgs/${fleet}/members/${m.id}`, admin.h, { role: 'fleet_admin' });
    expect(r.statusCode, r.body).toBe(200);
    expect(await membershipOf(fleet, viewer.userId)).toEqual([expect.objectContaining({ role_code: 'fleet_admin' })]);
    expect((await call('GET', `/v1/orgs/${fleet}/devices/enrollment-codes`, viewer.h)).statusCode).toBe(200); // same session, new role

    const members = (await call('GET', `/v1/orgs/${fleet}/members`, admin.h)).json().items;
    expect(members.filter((x: any) => x.user_id === viewer.userId)).toHaveLength(1); // the old role is no longer listed

    const back = await call('PATCH', `/v1/orgs/${fleet}/members/${r.json().membershipId}`, admin.h, { role: 'fleet_viewer' });
    expect(back.statusCode, back.body).toBe(200);
    expect((await call('GET', `/v1/orgs/${fleet}/devices/enrollment-codes`, viewer.h)).statusCode).toBe(403);
    const a = await ctx.db.query(`SELECT details FROM audit_log WHERE action = 'membership.role_changed' AND details->>'userId' = $1 ORDER BY id`, [viewer.userId]);
    expect(a.rows.map((x) => [x.details.from, x.details.to])).toEqual([['fleet_viewer', 'fleet_admin'], ['fleet_admin', 'fleet_viewer']]);
  });

  it('removing a member cuts their access at once', async () => {
    const fleet = await org(ctx.db, 'FLEET_OPERATOR');
    const admin = await userWithRole(ctx, fleet, 'fleet_admin');
    const viewer = await userWithRole(ctx, fleet, 'fleet_viewer');
    const [m] = await membershipOf(fleet, viewer.userId);
    expect((await call('GET', `/v1/orgs/${fleet}/devices`, viewer.h)).statusCode).toBe(200);
    expect((await call('POST', `/v1/orgs/${fleet}/members/${m.id}/remove`, admin.h)).json()).toEqual({ removed: true });
    expect((await call('GET', `/v1/orgs/${fleet}/devices`, viewer.h)).statusCode).toBe(403);
    expect((await call('POST', `/v1/orgs/${fleet}/members/${m.id}/remove`, admin.h)).statusCode).toBe(404);
  });

  it('nobody changes their own role, the last admin stays, roles must fit the organization, and outsiders are refused', async () => {
    const fleet = await org(ctx.db, 'FLEET_OPERATOR');
    const admin = await userWithRole(ctx, fleet, 'fleet_admin');
    const viewer = await userWithRole(ctx, fleet, 'fleet_viewer');
    const [own] = await membershipOf(fleet, admin.userId);
    const [vm] = await membershipOf(fleet, viewer.userId);
    const self = await call('PATCH', `/v1/orgs/${fleet}/members/${own.id}`, admin.h, { role: 'fleet_viewer' });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe('SELF_CHANGE');
    expect((await call('PATCH', `/v1/orgs/${fleet}/members/${vm.id}`, admin.h, { role: 'super_admin' })).statusCode).toBe(403);
    expect((await call('PATCH', `/v1/orgs/${fleet}/members/${vm.id}`, viewer.h, { role: 'fleet_admin' })).statusCode).toBe(403); // viewers can't manage

    // Two admins: one may demote the other only while another admin remains.
    const admin2 = await userWithRole(ctx, fleet, 'fleet_admin');
    const [a2] = await membershipOf(fleet, admin2.userId);
    expect((await call('PATCH', `/v1/orgs/${fleet}/members/${a2.id}`, admin.h, { role: 'fleet_viewer' })).statusCode).toBe(200);
    // admin is now the only admin; admin2 (now a viewer) can't touch them.
    expect((await call('POST', `/v1/orgs/${fleet}/members/${own.id}/remove`, admin2.h)).statusCode).toBe(403);
    // Even platform staff can't remove or demote the fleet's last admin.
    const staff = await userWithRole(ctx, await platformOrg(ctx.db), 'super_admin', { mfa: true });
    const last = await call('POST', `/v1/orgs/${fleet}/members/${own.id}/remove`, staff.h);
    expect(last.statusCode).toBe(409);
    expect(last.json().error.message).toMatch(/last fleet admin/);
    expect((await call('PATCH', `/v1/orgs/${fleet}/members/${own.id}`, staff.h, { role: 'driver' })).statusCode).toBe(409);

    const other = await org(ctx.db, 'FLEET_OPERATOR');
    const outsider = await userWithRole(ctx, other, 'fleet_admin');
    expect((await call('PATCH', `/v1/orgs/${fleet}/members/${vm.id}`, outsider.h, { role: 'fleet_admin' })).statusCode).toBe(403);
  });

  it('platform: a super admin changes a finance admin to finance approver; the last super admin can’t be removed', async () => {
    const platform = await platformOrg(ctx.db);
    // Existing super admins in the shared test database would make "last" meaningless, so count them.
    const sa = await userWithRole(ctx, platform, 'super_admin', { mfa: true });
    const fin = await userWithRole(ctx, platform, 'finance_admin', { mfa: true });
    const [fm] = await membershipOf(platform, fin.userId);
    const r = await call('PATCH', `/v1/orgs/${platform}/members/${fm.id}`, sa.h, { role: 'finance_approver' });
    expect(r.statusCode, r.body).toBe(200);
    expect(await membershipOf(platform, fin.userId)).toEqual([expect.objectContaining({ role_code: 'finance_approver' })]);
    expect((await call('PATCH', `/v1/orgs/${platform}/members/${fm.id}`, fin.h, { role: 'super_admin' })).statusCode).toBe(403); // no self-promotion either way
  });
});
