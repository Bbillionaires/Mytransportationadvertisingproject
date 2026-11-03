import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliverPendingEmail, LogEmailSender } from '../src/lib/email.js';
import { linkToken, org, PASSWORD, platformOrg, setupApp, uid, userWithRole, type Ctx } from './helpers.js';

type User = Awaited<ReturnType<typeof userWithRole>>;
let ctx: Ctx;
let admin: User, support: User;
const METRICS_TOKEN = 'metrics-token-0123456789abcdef';
const api = (method: 'GET' | 'POST', url: string, h: object = {}, payload?: object) => ctx.app.inject({ method, url, headers: h as any, payload });
const login = (email: string, password: string) => api('POST', '/v1/auth/login', {}, { email, password });

beforeAll(async () => {
  ctx = await setupApp({ env: { METRICS_TOKEN } });
  const p = await platformOrg(ctx.db);
  admin = await userWithRole(ctx, p, 'super_admin', { mfa: true });
  support = await userWithRole(ctx, p, 'support_agent', { mfa: true });
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

describe('email verification', () => {
  const email = `verify-${uid()}@example.test`;
  let h: Record<string, string>, orgId: string;

  it('unverified self-registered users can sign in and read, but not use paid or publishing features', async () => {
    expect((await api('POST', '/v1/advertisers/register', {}, { organizationName: 'Unverified Co', email, displayName: 'U', password: 'a-long-password-123' })).statusCode).toBe(202);
    h = { authorization: `Bearer ${(await login(email, 'a-long-password-123')).json().token}` };
    orgId = (await api('GET', '/v1/me', h)).json().memberships[0].orgId;
    expect((await api('GET', `/v1/orgs/${orgId}/campaigns`, h)).statusCode).toBe(200);
    const blocked = await api('POST', `/v1/orgs/${orgId}/campaigns`, h, { name: 'x', pricingModel: 'CPQV', rateMinor: '50', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(blocked.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await api('POST', `/v1/orgs/${orgId}/prepayments`, h, { amountMinor: '5000' })).json().error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('resend retires the old link; links are single-use and expire', async () => {
    const first = await linkToken(ctx.db, email, 'verify_email', 'verify');
    await api('POST', '/v1/auth/verify-email/resend', h, {});
    const second = await linkToken(ctx.db, email, 'verify_email', 'verify');
    expect(second).not.toBe(first);
    expect((await api('POST', '/v1/auth/verify-email', {}, { token: first })).statusCode).toBe(400);
    expect((await api('POST', '/v1/auth/verify-email', {}, { token: second })).statusCode).toBe(200);
    expect((await api('POST', '/v1/auth/verify-email', {}, { token: second })).statusCode).toBe(400);
    expect((await api('POST', `/v1/orgs/${orgId}/campaigns`, h, { name: 'x', pricingModel: 'CPQV', rateMinor: '50', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() })).statusCode).toBe(201);
  });

  it('weak passwords are refused at registration', async () => {
    const r = await api('POST', '/v1/creators/register', {}, { channelName: 'Weak', email: `weak-${uid()}@example.test`, displayName: 'W', password: 'password1234' });
    expect(r.statusCode).toBe(400);
  });
});

describe('password reset', () => {
  it('never reveals whether an account exists', async () => {
    const unknown = await api('POST', '/v1/auth/password-reset/request', {}, { email: `nobody-${uid()}@example.test` });
    const known = await api('POST', '/v1/auth/password-reset/request', {}, { email: support.email });
    expect([unknown.statusCode, known.statusCode]).toEqual([202, 202]);
    expect(unknown.json()).toEqual(known.json());
  });

  it('a reset unlocks a locked account and signs out every session; links are single-use', async () => {
    const u = await userWithRole(ctx, await org(ctx.db, 'FLEET_OPERATOR'), 'fleet_admin');
    for (let i = 0; i < 10; i++) await login(u.email, 'wrong');
    expect((await login(u.email, PASSWORD)).statusCode).toBe(401);
    await api('POST', '/v1/auth/password-reset/request', {}, { email: u.email });
    const token = await linkToken(ctx.db, u.email, 'password_reset', 'reset');
    expect((await api('POST', '/v1/auth/password-reset/confirm', {}, { token, newPassword: 'short' })).statusCode).toBe(400);
    expect((await api('POST', '/v1/auth/password-reset/confirm', {}, { token, newPassword: 'a new long passphrase 42' })).statusCode).toBe(200);
    expect((await api('GET', '/v1/me', u.h)).statusCode).toBe(401); // old session revoked
    expect((await login(u.email, 'a new long passphrase 42')).statusCode).toBe(200);
    expect((await api('POST', '/v1/auth/password-reset/confirm', {}, { token, newPassword: 'another long passphrase' })).statusCode).toBe(400);
    expect((await ctx.db.query(`SELECT 1 FROM email_outbox WHERE to_email = $1 AND template = 'password_changed'`, [u.email])).rows).toHaveLength(1);
  });
});

describe('invitations', () => {
  let fleetOrg: string, fleetAdmin: User;
  beforeAll(async () => { fleetOrg = await org(ctx.db, 'FLEET_OPERATOR'); fleetAdmin = await userWithRole(ctx, fleetOrg, 'fleet_admin'); });

  it('an admin invites a new driver who accepts by choosing a password; the link works once', async () => {
    const email = `invitee-${uid()}@example.test`;
    expect((await api('POST', `/v1/orgs/${fleetOrg}/invitations`, fleetAdmin.h, { email, displayName: 'New Driver', role: 'driver' })).statusCode).toBe(201);
    expect((await api('POST', `/v1/orgs/${fleetOrg}/invitations`, fleetAdmin.h, { email, displayName: 'New Driver', role: 'driver' })).statusCode).toBe(409);
    const token = await linkToken(ctx.db, email, 'invitation', 'invite');
    expect((await api('POST', '/v1/auth/accept-invitation', {}, { token })).statusCode).toBe(400); // password needed for a new account
    expect((await api('POST', '/v1/auth/accept-invitation', {}, { token, password: 'a long driver passphrase' })).json()).toMatchObject({ accepted: true, role: 'driver' });
    expect((await api('POST', '/v1/auth/accept-invitation', {}, { token, password: 'a long driver passphrase' })).statusCode).toBe(400);
    const me = (await api('GET', '/v1/me', { authorization: `Bearer ${(await login(email, 'a long driver passphrase')).json().token}` })).json();
    expect(me.memberships).toEqual([expect.objectContaining({ orgId: fleetOrg, role: 'driver' })]);
  });

  it('revoked and expired invitations do not work; roles must match the organization', async () => {
    const e1 = `revoked-${uid()}@example.test`, e2 = `expired-${uid()}@example.test`;
    const i1 = (await api('POST', `/v1/orgs/${fleetOrg}/invitations`, fleetAdmin.h, { email: e1, displayName: 'x', role: 'fleet_viewer' })).json().invitationId;
    await api('POST', `/v1/orgs/${fleetOrg}/invitations/${i1}/revoke`, fleetAdmin.h, {});
    expect((await api('POST', '/v1/auth/accept-invitation', {}, { token: await linkToken(ctx.db, e1, 'invitation', 'invite'), password: 'a long passphrase here' })).statusCode).toBe(400);
    const i2 = (await api('POST', `/v1/orgs/${fleetOrg}/invitations`, fleetAdmin.h, { email: e2, displayName: 'x', role: 'fleet_viewer' })).json().invitationId;
    await ctx.db.query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [i2]);
    expect((await api('POST', '/v1/auth/accept-invitation', {}, { token: await linkToken(ctx.db, e2, 'invitation', 'invite'), password: 'a long passphrase here' })).statusCode).toBe(400);
    expect((await api('POST', `/v1/orgs/${fleetOrg}/invitations`, fleetAdmin.h, { email: `x-${uid()}@example.test`, displayName: 'x', role: 'super_admin' })).statusCode).toBe(403);
    expect((await api('POST', `/v1/orgs/${await platformOrg(ctx.db)}/invitations`, fleetAdmin.h, { email: `x-${uid()}@example.test`, displayName: 'x', role: 'moderator' })).statusCode).toBe(403);
  });
});

describe('support actions and impersonation', () => {
  it('unlock, disable, enable and MFA reset need platform admin, a reason, and never apply to yourself', async () => {
    const u = await userWithRole(ctx, await org(ctx.db, 'ADVERTISER'), 'advertiser_admin', { mfa: true });
    for (let i = 0; i < 10; i++) await login(u.email, 'wrong');
    expect((await api('POST', `/v1/users/${u.userId}/unlock`, support.h, { reason: 'verified identity by phone' })).statusCode).toBe(403);
    expect((await api('POST', `/v1/users/${u.userId}/unlock`, admin.h, { reason: 'short' })).statusCode).toBe(400);
    expect((await api('POST', `/v1/users/${u.userId}/unlock`, admin.h, { reason: 'verified identity by phone' })).json().status).toBe('ACTIVE');
    const s = (await login(u.email, PASSWORD)).json().token;
    expect((await api('POST', `/v1/users/${u.userId}/disable`, admin.h, { reason: 'account compromise suspected' })).json().status).toBe('DISABLED');
    expect((await api('GET', '/v1/me', { authorization: `Bearer ${s}` })).statusCode).toBe(401);
    expect((await login(u.email, PASSWORD)).statusCode).toBe(401);
    await api('POST', `/v1/users/${u.userId}/enable`, admin.h, { reason: 'owner confirmed and secured' });
    expect((await api('POST', `/v1/users/${u.userId}/mfa-reset`, admin.h, { reason: 'lost phone, identity verified' })).json().mfaEnabled).toBe(false);
    expect((await api('POST', `/v1/users/${admin.userId}/disable`, admin.h, { reason: 'trying to lock myself out' })).statusCode).toBe(403);
    const audit = await ctx.db.query(`SELECT action FROM audit_log WHERE target_id = $1 AND action LIKE 'user.%' ORDER BY id`, [u.userId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['user.unlocked', 'user.disabled', 'user.enabled', 'user.mfa_reset']);
  });

  it('impersonation is time-boxed, reasoned, audited with both identities, notifies the user and cannot target staff', async () => {
    const advOrg = await org(ctx.db, 'ADVERTISER');
    const target = await userWithRole(ctx, advOrg, 'advertiser_admin');
    expect((await api('POST', '/v1/support/impersonations', support.h, { targetUserId: admin.userId, reason: 'checking admin view', ticketRef: 'T-1' })).statusCode).toBe(403);
    expect((await api('POST', '/v1/support/impersonations', support.h, { targetUserId: target.userId, reason: 'too long a session', ticketRef: 'T-2', minutes: 60 })).statusCode).toBe(400);
    const s = await api('POST', '/v1/support/impersonations', support.h, { targetUserId: target.userId, reason: 'Customer cannot see campaign list', ticketRef: 'T-3', minutes: 10 });
    expect(s.statusCode).toBe(201);
    const ih = { authorization: `Bearer ${s.json().token}` };
    expect((await api('GET', '/v1/me', ih)).json().session.impersonatedBy).toBe(support.userId);
    const created = await api('POST', `/v1/orgs/${advOrg}/campaigns`, ih, { name: 'Made by support', pricingModel: 'CPQV', rateMinor: '50', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(created.statusCode).toBe(201);
    const a = (await ctx.db.query(`SELECT actor_user_id, impersonator_user_id FROM audit_log WHERE action = 'campaign.created' AND target_id = $1`, [created.json().id])).rows[0];
    expect(a).toEqual({ actor_user_id: target.userId, impersonator_user_id: support.userId });
    expect((await ctx.db.query(`SELECT 1 FROM email_outbox WHERE to_email = $1 AND template = 'support_access'`, [target.email])).rows).toHaveLength(1);
    await api('POST', `/v1/support/impersonations/${s.json().impersonationId}/end`, support.h, {});
    expect((await api('GET', '/v1/me', ih)).statusCode).toBe(401);
    const list = (await api('GET', '/v1/support/impersonations', admin.h)).json().items;
    expect(list.find((i: any) => i.id === s.json().impersonationId)).toMatchObject({ ticket_ref: 'T-3', ended_by: support.userId });
  });
});

describe('operations', () => {
  it('metrics need the bearer token and expose HTTP and business health series', async () => {
    expect((await api('GET', '/metrics')).statusCode).toBe(401);
    const m = await api('GET', '/metrics', { authorization: `Bearer ${METRICS_TOKEN}` });
    expect(m.statusCode).toBe(200);
    expect(m.body).toMatch(/rmn_http_requests_total\{method="POST",route="\/v1\/auth\/login",status="200"\} \d+/);
    expect(m.body).toContain('rmn_http_request_duration_seconds_bucket');
    expect(m.body).toMatch(/\nrmn_ledger_unbalanced_currencies 0\n/);
  });

  it('the email job delivers queued mail once and purges bodies that contained one-time links', async () => {
    const sender = new LogEmailSender();
    const r = await deliverPendingEmail(ctx.db, sender, 1000);
    expect(r.sent).toBeGreaterThan(0);
    expect(sender.sent.some((s) => /verify=/.test(s.body))).toBe(true);
    const left = await ctx.db.query(`SELECT count(*)::int n FROM email_outbox WHERE status = 'SENT' AND body_text IS NOT NULL`);
    expect(left.rows[0].n).toBe(0);
    expect((await deliverPendingEmail(ctx.db, sender, 1000)).sent).toBe(0);
  });
});
