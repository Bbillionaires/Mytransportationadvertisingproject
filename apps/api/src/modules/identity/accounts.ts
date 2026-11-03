import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db, Tx } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { hashPassword, randomToken, sha256hex } from '../../lib/crypto.js';
import { enqueueEmail } from '../../lib/email.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize, requireAuth } from '../../auth/context.js';
import { loadOrg } from '../orgs/routes.js';

const COMMON = new Set(['password1234', '123456789012', 'qwertyuiopas', 'letmein12345', 'passwordpassword', 'iloveyou1234', 'welcome12345', 'adminadmin12']);
export const passwordSchema = z.string().min(12, 'use at least 12 characters').max(200).refine((p) => !COMMON.has(p.toLowerCase()), 'this password is too common');

const link = (config: Config, param: string, token: string) => `${config.APP_PUBLIC_URL}/portal/?${param}=${encodeURIComponent(token)}`;

/** Issue a single-use token (stored hashed) and queue the email. Previous unused tokens of that purpose are retired. */
export async function issueUserToken(tx: Tx, config: Config, userId: string, email: string, purpose: 'EMAIL_VERIFY' | 'PASSWORD_RESET') {
  const token = randomToken(32);
  const minutes = purpose === 'EMAIL_VERIFY' ? 48 * 60 : 30;
  await tx.query(`UPDATE user_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await tx.query(`INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`, [userId, purpose, sha256hex(token), minutes]);
  if (purpose === 'EMAIL_VERIFY') {
    await enqueueEmail(tx, email, 'verify_email', 'Confirm your email for Rideshare Media Network',
      `Confirm your email address to finish setting up your account:\n${link(config, 'verify', token)}\n\nThis link expires in 48 hours. If you did not sign up, ignore this email.`);
  } else {
    await enqueueEmail(tx, email, 'password_reset', 'Reset your Rideshare Media Network password',
      `Use this link within 30 minutes to choose a new password:\n${link(config, 'reset', token)}\n\nIf you did not ask for this, ignore this email; your password is unchanged.`);
  }
}

/** Self-registration responds identically whether or not the email exists (no account enumeration). */
export const REGISTRATION_ACCEPTED = { status: 'PENDING_VERIFICATION', message: 'Check your email to confirm your address, then sign in.' };
export async function notifyExistingAccount(tx: Tx, config: Config, email: string) {
  await enqueueEmail(tx, email, 'registration_existing', 'Someone tried to register with your email',
    `An account already exists for this address. Sign in at ${config.APP_PUBLIC_URL}/portal/ or reset your password there. If this wasn't you, no action is needed.`);
}

async function consumeToken(tx: Tx, token: string, purpose: string) {
  const r = (await tx.query(`SELECT t.*, u.email FROM user_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.purpose = $2 FOR UPDATE OF t`, [sha256hex(token), purpose])).rows[0];
  if (!r || r.used_at || new Date(r.expires_at) < new Date()) throw badRequest('this link is invalid or has expired');
  await tx.query('UPDATE user_tokens SET used_at = now() WHERE id = $1', [r.id]);
  return r as { user_id: string; email: string };
}

export async function accountRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  // ---------- email verification ----------
  app.post('/v1/auth/verify-email', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
    return withTx(db, async (tx) => {
      const t = await consumeToken(tx, token, 'EMAIL_VERIFY');
      await tx.query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [t.user_id]);
      await audit(tx, { userId: t.user_id, requestId: req.id }, 'auth.email_verified', { type: 'user', id: t.user_id });
      return { verified: true };
    });
  });

  app.post('/v1/auth/verify-email/resend', { config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (req) => {
    const auth = requireAuth(req);
    const u = (await db.query('SELECT email, email_verified_at FROM users WHERE id = $1', [auth.userId])).rows[0];
    if (u.email_verified_at) return { verified: true };
    await withTx(db, (tx) => issueUserToken(tx, config, auth.userId, u.email, 'EMAIL_VERIFY'));
    return { sent: true };
  });

  // ---------- password reset ----------
  app.post('/v1/auth/password-reset/request', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { email } = parse(z.object({ email: z.string().email() }), req.body);
    await withTx(db, async (tx) => {
      const u = (await tx.query(`SELECT id, email FROM users WHERE email = $1 AND status IN ('ACTIVE','LOCKED')`, [email])).rows[0];
      if (u) {
        await issueUserToken(tx, config, u.id, u.email, 'PASSWORD_RESET');
        await audit(tx, { userId: u.id, requestId: req.id }, 'auth.password_reset_requested', { type: 'user', id: u.id });
      }
    });
    reply.code(202);
    return { message: 'If an account exists for that address, a reset link has been sent.' };
  });

  /** A completed reset proves control of the mailbox: it unlocks a locked account and signs out every session. MFA is unchanged. */
  app.post('/v1/auth/password-reset/confirm', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const b = parse(z.object({ token: z.string().min(20).max(200), newPassword: passwordSchema }), req.body);
    return withTx(db, async (tx) => {
      const t = await consumeToken(tx, b.token, 'PASSWORD_RESET');
      if (b.newPassword.toLowerCase().includes(t.email.split('@')[0]!.toLowerCase())) throw badRequest('the password must not contain your email name');
      await tx.query(`UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, status = CASE WHEN status = 'LOCKED' THEN 'ACTIVE' ELSE status END,
                        email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [t.user_id, await hashPassword(b.newPassword)]);
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [t.user_id]);
      await enqueueEmail(tx, t.email, 'password_changed', 'Your password was changed', 'Your Rideshare Media Network password was just changed and all sessions were signed out. If this was not you, contact support immediately.');
      await audit(tx, { userId: t.user_id, requestId: req.id }, 'auth.password_reset_completed', { type: 'user', id: t.user_id });
      return { reset: true };
    });
  });

  // ---------- invitations ----------
  app.post('/v1/orgs/:orgId/invitations', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    const org = await loadOrg(db, orgId);
    const b = parse(z.object({ email: z.string().email(), displayName: z.string().min(1).max(200), role: z.string() }), req.body);
    const auth = org.kind === 'PLATFORM' ? await authorize(db, req, 'platform.users.manage') : await authorize(db, req, 'org.members.manage', orgId);
    const role = (await db.query('SELECT org_kind FROM roles WHERE code = $1', [b.role])).rows[0];
    if (!role || role.org_kind !== org.kind) throw forbidden(`role ${b.role} cannot be granted in a ${org.kind} organization`);
    const token = randomToken(32);
    const inv = await withTx(db, async (tx) => {
      const pending = await tx.query(`SELECT 1 FROM invitations WHERE org_id = $1 AND email = $2 AND role_code = $3 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`, [orgId, b.email, b.role]);
      if (pending.rows[0]) throw conflict('an invitation is already pending for this address and role');
      const i = await tx.query(`INSERT INTO invitations (org_id, email, display_name, role_code, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days') RETURNING id, expires_at`,
        [orgId, b.email, b.displayName, b.role, sha256hex(token), auth.userId]);
      await enqueueEmail(tx, b.email, 'invitation', `You're invited to ${org.name} on Rideshare Media Network`,
        `You have been invited to join ${org.name} as ${b.role.replace(/_/g, ' ')}.\nAccept within 7 days: ${link(config, 'invite', token)}`);
      await audit(tx, actorOf(req), 'invitation.created', { type: 'invitation', id: i.rows[0].id, orgId }, { email: b.email, role: b.role });
      return i.rows[0];
    });
    reply.code(201);
    return { invitationId: inv.id, expiresAt: inv.expires_at };
  });

  app.get('/v1/orgs/:orgId/invitations', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    const org = await loadOrg(db, orgId);
    if (org.kind === 'PLATFORM') await authorize(db, req, 'platform.users.manage'); else await authorize(db, req, 'org.members.manage', orgId);
    return { items: (await db.query(`SELECT id, email, display_name, role_code, expires_at, accepted_at, revoked_at, created_at FROM invitations WHERE org_id = $1 ORDER BY created_at DESC`, [orgId])).rows };
  });

  app.post('/v1/orgs/:orgId/invitations/:id/revoke', async (req) => {
    const { orgId, id } = parse(z.object({ orgId: uuid, id: uuid }), req.params);
    const org = await loadOrg(db, orgId);
    if (org.kind === 'PLATFORM') await authorize(db, req, 'platform.users.manage'); else await authorize(db, req, 'org.members.manage', orgId);
    const r = await db.query(`UPDATE invitations SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`, [id, orgId]);
    if (!r.rows[0]) throw notFound('pending invitation not found');
    await audit(db, actorOf(req), 'invitation.revoked', { type: 'invitation', id, orgId });
    return { revoked: true };
  });

  /** Accept: creates the account (email verified by the link) or attaches the role to the existing account of the same address. */
  app.post('/v1/auth/accept-invitation', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const b = parse(z.object({ token: z.string().min(20).max(200), password: passwordSchema.optional() }), req.body);
    return withTx(db, async (tx) => {
      const i = (await tx.query(`SELECT * FROM invitations WHERE token_hash = $1 FOR UPDATE`, [sha256hex(b.token)])).rows[0];
      if (!i || i.accepted_at || i.revoked_at || new Date(i.expires_at) < new Date()) throw badRequest('this invitation is invalid or has expired');
      let u = (await tx.query('SELECT id FROM users WHERE email = $1', [i.email])).rows[0];
      if (!u) {
        if (!b.password) throw badRequest('choose a password to create your account');
        u = (await tx.query('INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1,$2,$3, now()) RETURNING id', [i.email, await hashPassword(b.password), i.display_name])).rows[0];
      } else {
        await tx.query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [u.id]);
      }
      await tx.query(`INSERT INTO memberships (user_id, org_id, role_code, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, org_id, role_code) DO UPDATE SET status = 'ACTIVE'`, [u.id, i.org_id, i.role_code, i.invited_by]);
      await tx.query('UPDATE invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1', [i.id, u.id]);
      await audit(tx, { userId: u.id, requestId: req.id }, 'invitation.accepted', { type: 'invitation', id: i.id, orgId: i.org_id }, { role: i.role_code });
      return { accepted: true, orgId: i.org_id, role: i.role_code };
    });
  });

  // ---------- support actions on accounts (platform staff, MFA, reason required, audited) ----------
  const supportAction = (path: string, action: string, run: (tx: Tx, userId: string) => Promise<void>) =>
    app.post(`/v1/users/:userId/${path}`, async (req) => {
      await authorize(db, req, 'platform.users.manage');
      const { userId } = parse(z.object({ userId: uuid }), req.params);
      const { reason } = parse(z.object({ reason: z.string().min(10).max(1000) }), req.body);
      return withTx(db, async (tx) => {
        const u = (await tx.query('SELECT id, email FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
        if (!u) throw notFound('user not found');
        if (userId === requireAuth(req).userId) throw forbidden('you cannot perform this action on your own account');
        await run(tx, userId);
        await audit(tx, actorOf(req), `user.${action}`, { type: 'user', id: userId }, { reason });
        const s = (await tx.query('SELECT status, mfa_enabled FROM users WHERE id = $1', [userId])).rows[0];
        return { userId, status: s.status, mfaEnabled: s.mfa_enabled };
      });
    });
  supportAction('unlock', 'unlocked', async (tx, id) => { await tx.query(`UPDATE users SET status = 'ACTIVE', failed_logins = 0 WHERE id = $1 AND status = 'LOCKED'`, [id]); });
  supportAction('disable', 'disabled', async (tx, id) => {
    await tx.query(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [id]);
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
  });
  supportAction('enable', 'enabled', async (tx, id) => { await tx.query(`UPDATE users SET status = 'ACTIVE', failed_logins = 0 WHERE id = $1 AND status = 'DISABLED'`, [id]); });
  /** Lost authenticator: clears MFA and signs the user out; they must enroll again before privileged actions. */
  supportAction('mfa-reset', 'mfa_reset', async (tx, id) => {
    await tx.query(`UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_last_step = NULL WHERE id = $1`, [id]);
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    const u = (await tx.query('SELECT email FROM users WHERE id = $1', [id])).rows[0];
    await enqueueEmail(tx, u.email, 'mfa_reset', 'Your two-factor authentication was reset', 'Support reset two-factor authentication on your account. Set it up again before using finance or administration features. If you did not request this, contact support immediately.');
  });
}
