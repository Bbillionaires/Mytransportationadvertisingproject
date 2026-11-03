import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt, totpStep } from '../src/lib/crypto.js';
import { PASSWORD, platformOrg, setupApp, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await setupApp(); });
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('authentication and MFA', () => {
  it('rejects bad credentials with a uniform error and never returns password data', async () => {
    const p = await platformOrg(ctx.db);
    const u = await userWithRole(ctx, p, 'support_agent');
    const bad = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: u.email, password: 'wrong' } });
    const unknown = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'nobody@example.test', password: 'wrong' } });
    expect(bad.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe(bad.json().error.message);
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: u.h });
    expect(me.statusCode).toBe(200);
    expect(me.body).not.toContain('password');
    expect(me.json().memberships[0].role).toBe('support_agent');
  });

  it('requires an authenticated session', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });

  it('logout revokes the session', async () => {
    const u = await userWithRole(ctx, await platformOrg(ctx.db), 'support_agent');
    await ctx.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: u.h, payload: {} });
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: u.h })).statusCode).toBe(401);
  });

  it('finance permissions require an MFA-verified session; full TOTP enroll/verify with replay protection', async () => {
    const u = await userWithRole(ctx, await platformOrg(ctx.db), 'finance_approver');
    const blocked = await ctx.app.inject({ method: 'GET', url: '/v1/finance/accounts', headers: u.h });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('MFA_REQUIRED');

    const enroll = await ctx.app.inject({ method: 'POST', url: '/v1/auth/mfa/enroll', headers: u.h, payload: {} });
    const { secret } = enroll.json();
    const stored = await ctx.db.query('SELECT mfa_secret_enc FROM users WHERE id = $1', [u.userId]);
    expect(stored.rows[0].mfa_secret_enc).not.toContain(secret); // encrypted at rest

    const step = totpStep();
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/auth/mfa/activate', headers: u.h, payload: { code: '000000' === totpAt(secret, step) ? '111111' : '000000' } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/auth/mfa/activate', headers: u.h, payload: { code: totpAt(secret, step) } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/finance/accounts', headers: u.h })).statusCode).toBe(200);

    // New session must verify again; the already-used code is rejected (replay), the next step's code works.
    const login = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: u.email, password: PASSWORD } });
    expect(login.json().mfaRequired).toBe(true);
    const h2 = { authorization: `Bearer ${login.json().token}` };
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/finance/accounts', headers: h2 })).json().error.code).toBe('MFA_REQUIRED');
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', headers: h2, payload: { code: totpAt(secret, step) } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', headers: h2, payload: { code: totpAt(secret, step + 1) } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/finance/accounts', headers: h2 })).statusCode).toBe(200);
  });

  it('locks an account after repeated failures', async () => {
    const u = await userWithRole(ctx, await platformOrg(ctx.db), 'support_agent');
    for (let i = 0; i < 10; i++) await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: u.email, password: 'wrong' } });
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: u.email, password: PASSWORD } })).statusCode).toBe(401);
  });
});
