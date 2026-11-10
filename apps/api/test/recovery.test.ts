/** Account recovery by platform staff while email isn't connected: lookup, reset link, lost authenticator. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { org, PASSWORD, platformOrg, setupApp, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });
const call = (method: 'GET' | 'POST', url: string, h: Record<string, string>, payload?: object) => ctx.app.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });

describe('account recovery by platform staff', () => {
  it('staff find a person by exact email and see their status and memberships; others can’t look anyone up', async () => {
    const staff = await userWithRole(ctx, await platformOrg(ctx.db), 'super_admin', { mfa: true });
    const fleet = await org(ctx.db, 'FLEET_OPERATOR');
    const driver = await userWithRole(ctx, fleet, 'fleet_viewer');
    const r = await call('GET', `/v1/users?email=${encodeURIComponent(driver.email)}`, staff.h);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items).toEqual([expect.objectContaining({ id: driver.userId, status: 'ACTIVE', mfa_enabled: false, memberships: [expect.objectContaining({ org_kind: 'FLEET_OPERATOR', role: 'fleet_viewer' })] })]);
    expect(r.json().items[0].password_hash).toBeUndefined();
    expect((await call('GET', `/v1/users?email=nobody-${Date.now()}@example.test`, staff.h)).json().items).toEqual([]);
    expect((await call('GET', '/v1/users?email=x', staff.h)).statusCode).toBe(400); // exact email only, no browsing
    const fleetAdmin = await userWithRole(ctx, fleet, 'fleet_admin');
    expect((await call('GET', `/v1/users?email=${encodeURIComponent(driver.email)}`, fleetAdmin.h)).statusCode).toBe(403);
  });

  it('a reset link from staff works once, unlocks a locked account and signs the person out everywhere; audited with the reason', async () => {
    const staff = await userWithRole(ctx, await platformOrg(ctx.db), 'super_admin', { mfa: true });
    const person = await userWithRole(ctx, await org(ctx.db, 'ADVERTISER'), 'advertiser_admin');
    await ctx.db.query(`UPDATE users SET status = 'LOCKED', failed_logins = 10 WHERE id = $1`, [person.userId]);
    expect((await call('POST', `/v1/users/${person.userId}/password-reset-link`, staff.h, { reason: 'short' })).statusCode).toBe(400); // a real reason is required
    const r = await call('POST', `/v1/users/${person.userId}/password-reset-link`, staff.h, { reason: 'Called support, identity confirmed by phone' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ link: expect.stringMatching(/\/portal\/\?reset=/), expiresInMinutes: 30, emailNotConnected: true });
    const token = decodeURIComponent(r.json().link.split('reset=')[1]);
    expect((await call('POST', '/v1/auth/password-reset/confirm', {}, { token, newPassword: 'a fresh recovered passphrase' })).statusCode).toBe(200);
    expect((await call('POST', '/v1/auth/password-reset/confirm', {}, { token, newPassword: 'another passphrase here' })).statusCode).toBe(400);
    expect((await call('GET', '/v1/me', person.h)).statusCode).toBe(401); // old session ended
    const login = await call('POST', '/v1/auth/login', {}, { email: person.email, password: 'a fresh recovered passphrase' });
    expect(login.statusCode).toBe(200);
    const a = (await ctx.db.query(`SELECT details FROM audit_log WHERE action = 'user.password_reset_link_created' AND target_id = $1`, [person.userId])).rows[0];
    expect(a.details).toMatchObject({ reason: 'Called support, identity confirmed by phone', linkShownToStaff: true });
  });

  it('lost authenticator: staff turn two-step off; the person signs in with their password and sets it up again', async () => {
    const staff = await userWithRole(ctx, await platformOrg(ctx.db), 'super_admin', { mfa: true });
    const person = await userWithRole(ctx, await platformOrg(ctx.db), 'finance_approver', { mfa: true });
    const r = await call('POST', `/v1/users/${person.userId}/mfa-reset`, staff.h, { reason: 'Lost phone, identity confirmed on a video call' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ mfaEnabled: false });
    const login = await call('POST', '/v1/auth/login', {}, { email: person.email, password: PASSWORD });
    expect(login.json().mfaRequired).toBeFalsy();
  });

  it('nobody recovers their own account this way, and once email works the link is only emailed', async () => {
    const staff = await userWithRole(ctx, await platformOrg(ctx.db), 'super_admin', { mfa: true });
    expect((await call('POST', `/v1/users/${staff.userId}/password-reset-link`, staff.h, { reason: 'trying my own account' })).statusCode).toBe(403);
    const withEmail = await setupApp({ env: { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_123', EMAIL_FROM: 'Rides <no-reply@example.test>' } });
    const s2 = await userWithRole(withEmail, await platformOrg(withEmail.db), 'super_admin', { mfa: true });
    const p2 = await userWithRole(withEmail, await org(withEmail.db, 'FLEET_OPERATOR'), 'fleet_admin');
    const r = await withEmail.app.inject({ method: 'POST', url: `/v1/users/${p2.userId}/password-reset-link`, headers: s2.h, payload: { reason: 'Customer asked for a reset' } });
    expect(r.json()).toEqual({ emailed: true });
    await withEmail.app.close(); await withEmail.db.end();
  });
});
