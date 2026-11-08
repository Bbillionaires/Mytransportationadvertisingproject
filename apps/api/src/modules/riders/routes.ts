import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { encryptionKeys, type Config } from '../../config.js';
import type { Db, Queryable, Tx } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { decrypt, DUMMY_PASSWORD_HASH, encrypt, hashPassword, randomToken, sha256hex, verifyPassword } from '../../lib/crypto.js';
import { enqueueEmail } from '../../lib/email.js';
import { badRequest, forbidden, notFound, unauthorized, unprocessable } from '../../lib/errors.js';
import { parse, uuid } from '../../lib/validation.js';
import { authenticateDevice } from '../devices/routes.js';
import { passwordSchema } from '../identity/accounts.js';
import { couponCode } from '../commissions/attribution.js';

export const RIDER_TERMS_VERSION = 'RIDER_TERMS_V1';
const TABLET_SESSION_MINUTES = 30;
const PAIRING_SECONDS = 120;

/** Rider's own phone: `Authorization: Bearer rdr_<token>`. */
export async function phoneRider(db: Queryable, req: FastifyRequest) {
  const m = /^Bearer rdr_([A-Za-z0-9_-]{30,})$/.exec(String(req.headers.authorization ?? ''));
  if (!m) throw unauthorized('rider sign-in required');
  const r = (await db.query(
    `SELECT r.*, t.id AS token_id FROM rider_tokens t JOIN riders r ON r.id = t.rider_id
      WHERE t.token_hash = $1 AND t.kind = 'PHONE_SESSION' AND t.used_at IS NULL AND t.expires_at > now() AND r.status = 'ACTIVE'`, [sha256hex(m[1]!)])).rows[0];
  if (!r) throw unauthorized('rider session expired');
  return r;
}

/** A rider signed in on a tablet: `X-Rider-Session: rts_<token>`, valid only from the tablet it was issued to. */
export async function tabletRider(db: Queryable, req: FastifyRequest, deviceId: string) {
  const raw = req.headers['x-rider-session'];
  if (typeof raw !== 'string') return null;
  const m = /^rts_([A-Za-z0-9_-]{30,})$/.exec(raw);
  if (!m) throw unauthorized('malformed rider session');
  const r = (await db.query(
    `SELECT r.id, r.display_name, r.email_verified_at, t.id AS token_id, t.expires_at FROM rider_tokens t JOIN riders r ON r.id = t.rider_id
      WHERE t.token_hash = $1 AND t.kind = 'TABLET_SESSION' AND t.device_id = $2 AND t.used_at IS NULL AND t.expires_at > now() AND r.status = 'ACTIVE'`,
    [sha256hex(m[1]!), deviceId])).rows[0];
  if (!r) throw unauthorized('rider session ended; scan the code again');
  return r as { id: string; display_name: string; token_id: string; expires_at: Date };
}

/** Ends every rider session on a tablet (drop-off, PURGE_RIDER_DATA, re-pairing). */
export async function endTabletSessions(q: Queryable, deviceId: string) {
  await q.query(`UPDATE rider_tokens SET used_at = now() WHERE kind = 'TABLET_SESSION' AND device_id = $1 AND used_at IS NULL`, [deviceId]);
}

async function issueRiderVerify(tx: Tx, config: Config, riderId: string, email: string) {
  const token = randomToken(32);
  await tx.query(`UPDATE rider_tokens SET used_at = now() WHERE rider_id = $1 AND kind = 'EMAIL_VERIFY' AND used_at IS NULL`, [riderId]);
  await tx.query(`INSERT INTO rider_tokens (rider_id, kind, token_hash, expires_at) VALUES ($1,'EMAIL_VERIFY',$2, now() + interval '48 hours')`, [riderId, sha256hex(token)]);
  await enqueueEmail(tx, email, 'rider_verify_email', 'Confirm your rider account',
    `Confirm your email to save coupons and rewards from your rides:\n${config.APP_PUBLIC_URL}/rider/?verify=${encodeURIComponent(token)}\n\nThis link expires in 48 hours.`);
}

export async function riderRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  // ---------- rider account (personal phone) ----------
  app.post('/v1/riders/register', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = parse(z.object({
      email: z.string().email(), password: passwordSchema, displayName: z.string().min(1).max(50), birthYear: z.number().int().min(1900).max(2100),
      confirmAdult: z.literal(true), termsVersion: z.literal(RIDER_TERMS_VERSION), marketingOptIn: z.boolean().default(false),
    }), req.body);
    // Adults only until counsel completes the children's-privacy review (D-018). We store birth year only, not a full date of birth.
    if (new Date().getUTCFullYear() - b.birthYear < 18) throw unprocessable('rider accounts are available to adults (18+) only; guest viewing needs no account');
    await withTx(db, async (tx) => {
      if ((await tx.query('SELECT 1 FROM riders WHERE email = $1', [b.email])).rows[0]) {
        await enqueueEmail(tx, b.email, 'rider_registration_existing', 'Someone tried to create a rider account with your email', 'You already have a rider account. Sign in from the rider app, or reset your password there.');
        return;
      }
      const r = await tx.query(
        `INSERT INTO riders (email, password_hash, display_name, birth_year, adult_confirmed, terms_version, marketing_opt_in) VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING id`,
        [b.email, await hashPassword(b.password), b.displayName, b.birthYear, b.termsVersion, b.marketingOptIn]);
      await issueRiderVerify(tx, config, r.rows[0].id, b.email);
    });
    reply.code(202);
    return { status: 'PENDING_VERIFICATION', message: 'Check your email to confirm your address, then sign in.' };
  });

  app.post('/v1/riders/verify-email', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
    return withTx(db, async (tx) => {
      const t = (await tx.query(`SELECT * FROM rider_tokens WHERE token_hash = $1 AND kind = 'EMAIL_VERIFY' FOR UPDATE`, [sha256hex(token)])).rows[0];
      if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw badRequest('this link is invalid or has expired');
      await tx.query('UPDATE rider_tokens SET used_at = now() WHERE id = $1', [t.id]);
      await tx.query('UPDATE riders SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [t.rider_id]);
      return { verified: true };
    });
  });

  app.post('/v1/riders/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(1024) }), req.body);
    const r = (await db.query(`SELECT id, password_hash, status FROM riders WHERE email = $1`, [b.email])).rows[0];
    const ok = await verifyPassword(b.password, r?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!r || !ok || r.status !== 'ACTIVE') throw unauthorized('invalid credentials');
    const token = randomToken(32);
    await db.query(`INSERT INTO rider_tokens (rider_id, kind, token_hash, expires_at) VALUES ($1,'PHONE_SESSION',$2, now() + interval '30 days')`, [r.id, sha256hex(token)]);
    return { token: `rdr_${token}` };
  });

  app.post('/v1/riders/logout', async (req) => {
    const r = await phoneRider(db, req);
    await db.query('UPDATE rider_tokens SET used_at = now() WHERE id = $1', [r.token_id]);
    return { ok: true };
  });

  app.get('/v1/riders/me', async (req) => {
    const r = await phoneRider(db, req);
    return { id: r.id, displayName: r.display_name, emailVerified: !!r.email_verified_at, marketingOptIn: r.marketing_opt_in, termsVersion: r.terms_version };
  });

  /** Wallet: coupons saved from tablets and rewards won in games. */
  app.get('/v1/riders/me/wallet', async (req) => {
    const r = await phoneRider(db, req);
    const coupons = await db.query(
      `SELECT cc.code, cc.expires_at, cc.redeemed_at, o.coupon_description AS description, c.name AS campaign FROM coupon_codes cc
         JOIN commission_offers o ON o.id = cc.offer_id JOIN campaigns c ON c.id = cc.campaign_id WHERE cc.rider_id = $1 ORDER BY cc.issued_at DESC`, [r.id]);
    const rewards = await db.query(
      `SELECT g.code, g.expires_at, g.redeemed_at, p.reward_description AS description, o.name AS sponsor FROM reward_grants g
         JOIN reward_programs p ON p.id = g.program_id JOIN organizations o ON o.id = p.advertiser_org_id WHERE g.rider_id = $1 ORDER BY g.issued_at DESC`, [r.id]);
    return { coupons: coupons.rows, rewards: rewards.rows };
  });

  /** Account deletion: personal data is erased; codes stay valid for merchants but no longer identify anyone. */
  app.post('/v1/riders/me/delete', async (req) => {
    const r = await phoneRider(db, req);
    const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
    if (!(await verifyPassword(password, r.password_hash))) throw unauthorized('password incorrect');
    await withTx(db, async (tx) => {
      await tx.query(`UPDATE riders SET status = 'DELETED', email = NULL, password_hash = NULL, display_name = 'Deleted rider', birth_year = NULL, marketing_opt_in = false, deleted_at = now() WHERE id = $1`, [r.id]);
      await tx.query(`UPDATE rider_tokens SET used_at = now() WHERE rider_id = $1 AND used_at IS NULL`, [r.id]);
      await audit(tx, { requestId: req.id }, 'rider.deleted', { type: 'rider', id: r.id });
    });
    return { deleted: true };
  });

  app.patch('/v1/riders/me', async (req) => {
    const r = await phoneRider(db, req);
    const b = parse(z.object({ displayName: z.string().min(1).max(50).optional(), marketingOptIn: z.boolean().optional() }), req.body);
    const u = await db.query(`UPDATE riders SET display_name = coalesce($2, display_name), marketing_opt_in = coalesce($3, marketing_opt_in) WHERE id = $1 RETURNING display_name, marketing_opt_in`,
      [r.id, b.displayName ?? null, b.marketingOptIn ?? null]);
    return { displayName: u.rows[0].display_name, marketingOptIn: u.rows[0].marketing_opt_in };
  });

  app.post('/v1/riders/password-reset/request', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { email } = parse(z.object({ email: z.string().email() }), req.body);
    await withTx(db, async (tx) => {
      const r = (await tx.query(`SELECT id, email FROM riders WHERE email = $1 AND status = 'ACTIVE'`, [email])).rows[0];
      if (!r) return;
      const token = randomToken(32);
      await tx.query(`UPDATE rider_tokens SET used_at = now() WHERE rider_id = $1 AND kind = 'PASSWORD_RESET' AND used_at IS NULL`, [r.id]);
      await tx.query(`INSERT INTO rider_tokens (rider_id, kind, token_hash, expires_at) VALUES ($1,'PASSWORD_RESET',$2, now() + interval '30 minutes')`, [r.id, sha256hex(token)]);
      await enqueueEmail(tx, r.email, 'rider_password_reset', 'Reset your rider password',
        `Choose a new password within 30 minutes:\n${config.APP_PUBLIC_URL}/rider/?reset=${encodeURIComponent(token)}\n\nIf you didn't ask for this, ignore this email.`);
    });
    reply.code(202);
    return { message: 'If an account exists for that address, a reset link has been sent.' };
  });

  app.post('/v1/riders/password-reset/confirm', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const b = parse(z.object({ token: z.string().min(20).max(200), newPassword: passwordSchema }), req.body);
    return withTx(db, async (tx) => {
      const t = (await tx.query(`SELECT * FROM rider_tokens WHERE token_hash = $1 AND kind = 'PASSWORD_RESET' FOR UPDATE`, [sha256hex(b.token)])).rows[0];
      if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw badRequest('this link is invalid or has expired');
      await tx.query('UPDATE rider_tokens SET used_at = now() WHERE id = $1', [t.id]);
      await tx.query(`UPDATE riders SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [t.rider_id, await hashPassword(b.newPassword)]);
      await tx.query(`UPDATE rider_tokens SET used_at = now() WHERE rider_id = $1 AND kind IN ('PHONE_SESSION','TABLET_SESSION') AND used_at IS NULL`, [t.rider_id]);
      return { reset: true };
    });
  });

  // ---------- QR pairing: tablet shows a code, rider scans with phone ----------
  app.post('/v1/devices/rider-pairings', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const dev = await authenticateDevice(db, config, req);
    if (dev.status !== 'ACTIVE') throw forbidden('device is suspended');
    if (!(await db.query('SELECT 1 FROM device_assignments WHERE device_id = $1 AND ends_at IS NULL', [dev.deviceId])).rows[0]) throw forbidden('device is not assigned to a vehicle');
    const code = couponCode(randomBytes(10)).slice(0, 8);
    const p = await db.query(`INSERT INTO rider_pairings (device_id, code_hash, expires_at) VALUES ($1,$2, now() + make_interval(secs => $3)) RETURNING id, expires_at`,
      [dev.deviceId, sha256hex(code), PAIRING_SECONDS]);
    reply.code(201);
    // The QR is a plain https link: the phone's built-in camera opens the rider web app, which pairs immediately.
    return { pairingId: p.rows[0].id, code, qrPayload: `${config.APP_PUBLIC_URL}/rider/?pair=${code}`, expiresAt: p.rows[0].expires_at };
  });

  app.post('/v1/riders/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const r = await phoneRider(db, req);
    if (!r.email_verified_at) throw forbidden('confirm your email before signing in on a tablet', 'EMAIL_NOT_VERIFIED');
    const { code } = parse(z.object({ code: z.string().max(300) }), req.body);
    // Accept the bare code, the legacy RMNPAIR: payload, or the full deep link.
    const m = /(?:^|RMNPAIR:|[?&]pair=)([A-Za-z2-9]{8})(?:$|&)/.exec(code.trim());
    if (!m) throw badRequest('enter the 8-character code shown on the tablet');
    const clean = m[1]!.toUpperCase();
    return withTx(db, async (tx) => {
      const p = (await tx.query(`SELECT * FROM rider_pairings WHERE code_hash = $1 FOR UPDATE`, [sha256hex(clean)])).rows[0];
      if (!p || p.paired_at || new Date(p.expires_at) < new Date()) throw badRequest('this code has expired; ask the tablet for a new one');
      await endTabletSessions(tx, p.device_id); // one rider per tablet at a time
      const token = randomToken(32);
      const t = await tx.query(`INSERT INTO rider_tokens (rider_id, kind, token_hash, device_id, expires_at) VALUES ($1,'TABLET_SESSION',$2,$3, now() + make_interval(mins => $4)) RETURNING id, expires_at`,
        [r.id, sha256hex(token), p.device_id, TABLET_SESSION_MINUTES]);
      await tx.query(`UPDATE rider_pairings SET rider_id = $2, paired_at = now(), session_token_id = $3, session_token_enc = $4 WHERE id = $1`,
        [p.id, r.id, t.rows[0].id, encrypt(`rts_${token}`, config.APP_ENCRYPTION_KEY)]);
      return { paired: true, tabletSessionEndsAt: t.rows[0].expires_at };
    });
  });

  /** Tablet polls its pairing; the session token is handed over once, then erased from the server. */
  app.get('/v1/devices/rider-pairings/:id', async (req) => {
    const dev = await authenticateDevice(db, config, req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTx(db, async (tx) => {
      const p = (await tx.query(`SELECT p.*, r.display_name FROM rider_pairings p LEFT JOIN riders r ON r.id = p.rider_id WHERE p.id = $1 AND p.device_id = $2 FOR UPDATE OF p`, [id, dev.deviceId])).rows[0];
      if (!p) throw notFound('pairing not found');
      if (!p.paired_at) return { status: new Date(p.expires_at) < new Date() ? 'EXPIRED' : 'WAITING' };
      if (!p.session_token_enc) return { status: 'PAIRED', alreadyDelivered: true };
      await tx.query(`UPDATE rider_pairings SET session_token_enc = NULL, delivered_at = now() WHERE id = $1`, [id]);
      const exp = (await tx.query('SELECT expires_at FROM rider_tokens WHERE id = $1', [p.session_token_id])).rows[0].expires_at;
      return { status: 'PAIRED', riderDisplayName: p.display_name, riderSession: decrypt(p.session_token_enc, encryptionKeys(config)), expiresAt: exp };
    });
  });

  app.get('/v1/devices/rider-sessions/current', async (req) => {
    const dev = await authenticateDevice(db, config, req);
    const r = await tabletRider(db, req, dev.deviceId);
    if (!r) throw unauthorized('no rider session');
    return { riderDisplayName: r.display_name, expiresAt: r.expires_at };
  });

  /** Drop-off / sign-out on the tablet. The tablet must also purge any rider data it cached. */
  app.post('/v1/devices/rider-sessions/end', async (req) => {
    const dev = await authenticateDevice(db, config, req);
    await endTabletSessions(db, dev.deviceId);
    return { ended: true, purgeLocalRiderData: true };
  });

}
