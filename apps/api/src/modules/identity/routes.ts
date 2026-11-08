import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { encryptionKeys, type Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { decrypt, DUMMY_PASSWORD_HASH, encrypt, newTotpSecret, randomToken, sha256hex, verifyPassword, verifyTotp } from '../../lib/crypto.js';
import { badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import { parse } from '../../lib/validation.js';
import { actorOf, actorOf as ctxActor, requireAuth } from '../../auth/context.js';

const MAX_FAILED_LOGINS = 10;

export async function identityRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  app.post('/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(1024) }), req.body);
    const r = await db.query('SELECT id, password_hash, status, failed_logins, mfa_enabled FROM users WHERE email = $1', [body.email]);
    const u = r.rows[0];
    const ok = await verifyPassword(body.password, u?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!u || !ok || u.status !== 'ACTIVE') {
      if (u) {
        await db.query(`UPDATE users SET failed_logins = failed_logins + 1, status = CASE WHEN failed_logins + 1 >= $2 THEN 'LOCKED' ELSE status END WHERE id = $1`, [u.id, MAX_FAILED_LOGINS]);
        await audit(db, { userId: u.id, requestId: req.id }, 'auth.login_failed', { type: 'user', id: u.id });
      }
      throw unauthorized('invalid credentials');
    }
    const token = randomToken();
    const s = await db.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2, now() + make_interval(mins => $3), $4, $5) RETURNING id, expires_at`,
      [u.id, sha256hex(token), config.SESSION_TTL_MINUTES, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
    );
    await db.query('UPDATE users SET failed_logins = 0 WHERE id = $1', [u.id]);
    await audit(db, { userId: u.id, requestId: req.id }, 'auth.login', { type: 'session', id: s.rows[0].id });
    reply.header('cache-control', 'no-store');
    return { token, expiresAt: s.rows[0].expires_at, mfaRequired: u.mfa_enabled, mfaEnrolled: u.mfa_enabled };
  });

  app.post('/v1/auth/logout', async (req) => {
    const auth = requireAuth(req);
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [auth.sessionId]);
    await audit(db, ctxActor(req), 'auth.logout', { type: 'session', id: auth.sessionId });
    return { ok: true };
  });

  app.get('/v1/me', async (req) => {
    const auth = requireAuth(req);
    const u = await db.query('SELECT id, email, display_name, mfa_enabled FROM users WHERE id = $1', [auth.userId]);
    return {
      user: { id: u.rows[0].id, email: u.rows[0].email, displayName: u.rows[0].display_name, mfaEnabled: u.rows[0].mfa_enabled },
      session: { id: auth.sessionId, mfaVerified: auth.mfaVerified, impersonatedBy: auth.impersonatorUserId },
      memberships: auth.memberships.map((m) => ({ orgId: m.orgId, orgKind: m.orgKind, role: m.role, permissions: [...m.permissions].sort() })),
    };
  });

  /** Begin TOTP enrollment. The secret is stored encrypted and only activated after a valid code. */
  app.post('/v1/auth/mfa/enroll', async (req) => {
    const auth = requireAuth(req);
    if (auth.impersonatorUserId) throw forbidden('cannot change MFA while impersonating');
    const u = await db.query('SELECT email, mfa_enabled FROM users WHERE id = $1', [auth.userId]);
    if (u.rows[0].mfa_enabled) throw badRequest('MFA is already enabled');
    const secret = newTotpSecret();
    await db.query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [auth.userId, encrypt(secret, config.APP_ENCRYPTION_KEY)]);
    await audit(db, ctxActor(req), 'auth.mfa_enroll_started', { type: 'user', id: auth.userId });
    const label = encodeURIComponent(`RideshareMediaNetwork:${u.rows[0].email}`);
    return { secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=RideshareMediaNetwork&algorithm=SHA1&digits=6&period=30` };
  });

  const checkCode = async (userId: string, code: string): Promise<boolean> => {
    const u = await db.query('SELECT mfa_secret_enc, mfa_last_step FROM users WHERE id = $1', [userId]);
    if (!u.rows[0]?.mfa_secret_enc) return false;
    const step = verifyTotp(decrypt(u.rows[0].mfa_secret_enc, encryptionKeys(config)), code);
    if (step === null) return false;
    // Atomic replay protection: a code's time-step can be used only once.
    const upd = await db.query('UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2) RETURNING id', [userId, step]);
    return upd.rowCount === 1;
  };

  app.post('/v1/auth/mfa/activate', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requireAuth(req);
    const { code } = parse(z.object({ code: z.string() }), req.body);
    if (!(await checkCode(auth.userId, code))) throw unauthorized('invalid code');
    await db.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [auth.userId]);
    await db.query('UPDATE sessions SET mfa_verified_at = now() WHERE id = $1', [auth.sessionId]);
    await audit(db, ctxActor(req), 'auth.mfa_enabled', { type: 'user', id: auth.userId });
    return { ok: true };
  });

  app.post('/v1/auth/mfa/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const auth = requireAuth(req);
    const { code } = parse(z.object({ code: z.string() }), req.body);
    if (!auth.mfaEnabled) throw badRequest('MFA is not enabled for this user');
    if (!(await checkCode(auth.userId, code))) {
      await audit(db, ctxActor(req), 'auth.mfa_failed', { type: 'user', id: auth.userId });
      throw unauthorized('invalid code');
    }
    await db.query('UPDATE sessions SET mfa_verified_at = now() WHERE id = $1', [auth.sessionId]);
    await audit(db, actorOf(req), 'auth.mfa_verified', { type: 'session', id: auth.sessionId });
    return { ok: true };
  });
}
