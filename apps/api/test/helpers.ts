import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { deviceSigningPayload, hashPassword, randomToken } from '../src/lib/crypto.js';
import { TEST_DB } from './globalSetup.js';

export const PASSWORD = 'correct horse battery staple';

export interface Ctx { app: FastifyInstance; db: Db; config: Config }

let pwHash: string | undefined;

export async function setupApp(opts: { paymentProvider?: import('../src/modules/payments/provider.js').PaymentProvider; env?: Record<string, string> } = {}): Promise<Ctx> {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DB, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), LOG_LEVEL: 'silent', ALLOCATION_SETTLE_MINUTES: '0', ALLOCATION_WINDOW_MINUTES: '1', MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'), MEDIA_BASE_URL: 'https://cdn.example.test', MEDIA_ROOT: `${tmpdir()}/rmn-test-media`, STRIPE_WEBHOOK_SECRET: 'whsec_testsecret123', ...opts.env });
  const db = createPool(config.DATABASE_URL);
  const app = await buildApp({ config, db, logger: false, paymentProvider: opts.paymentProvider });
  return { app, db, config };
}

export const uid = () => randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');

export async function platformOrg(db: Db): Promise<string> {
  const r = await db.query(`SELECT id FROM organizations WHERE kind = 'PLATFORM'`);
  if (r.rows[0]) return r.rows[0].id;
  return (await db.query(`INSERT INTO organizations (kind, name) VALUES ('PLATFORM','Platform') RETURNING id`)).rows[0].id;
}

export async function org(db: Db, kind: string, name = `${kind}-${uid()}`): Promise<string> {
  return (await db.query('INSERT INTO organizations (kind, name) VALUES ($1,$2) RETURNING id', [kind, name])).rows[0].id;
}

/** Create a user with a role and return an authenticated bearer token (optionally MFA-verified). */
export async function userWithRole(ctx: Ctx, orgId: string, role: string, opts: { mfa?: boolean } = {}) {
  pwHash ??= await hashPassword(PASSWORD);
  const email = `${role}-${uid()}@example.test`;
  const u = await ctx.db.query(
    `INSERT INTO users (email, password_hash, display_name, mfa_enabled, mfa_secret_enc) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [email, pwHash, role, !!opts.mfa, opts.mfa ? 'test-placeholder' : null],
  );
  await ctx.db.query('INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,$3)', [u.rows[0].id, orgId, role]);
  const res = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error('login failed ' + res.body);
  const token = res.json().token as string;
  // Test shortcut: the full TOTP flow is exercised in auth.test.ts.
  if (opts.mfa) await ctx.db.query(`UPDATE sessions SET mfa_verified_at = now() WHERE user_id = $1`, [u.rows[0].id]);
  return { userId: u.rows[0].id as string, email, token, h: { authorization: `Bearer ${token}` } };
}

export async function ensureOpenPeriod(db: Db, start = '2026-01-01', end = '2026-12-31') {
  await db.query(`INSERT INTO accounting_periods (period_start, period_end) SELECT $1::date, $2::date WHERE NOT EXISTS (SELECT 1 FROM accounting_periods WHERE daterange(period_start, period_end, '[]') && daterange($1::date, $2::date, '[]'))`, [start, end]);
}

/** Read the newest one-time link of a template from the email outbox, as the recipient would. */
export async function linkToken(db: Db, email: string, template: string, param: string): Promise<string> {
  const r = await db.query(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY id DESC LIMIT 1`, [email, template]);
  const m = new RegExp(`[?&]${param}=([^\\s&]+)`).exec(r.rows[0]?.body_text ?? '');
  if (!m) throw new Error(`no ${template} email for ${email}`);
  return decodeURIComponent(m[1]!);
}

/** Self-registration path: register (202), verify via the emailed link, sign in. Returns the new tenant and auth header. */
export async function registerVerified(ctx: Ctx, path: '/v1/advertisers/register' | '/v1/creators/register', body: Record<string, string>) {
  const r = await ctx.app.inject({ method: 'POST', url: path, payload: body });
  if (r.statusCode !== 202) throw new Error(`registration failed ${r.statusCode} ${r.body}`);
  const token = await linkToken(ctx.db, body.email!, 'verify_email', 'verify');
  const v = await ctx.app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token } });
  if (v.statusCode !== 200) throw new Error('verification failed ' + v.body);
  const login = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: body.email, password: body.password } });
  const h = { authorization: `Bearer ${login.json().token}` };
  const me = (await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: h })).json();
  return { h, userId: me.user.id as string, orgId: me.memberships[0].orgId as string };
}

/** Test fixture: a fully processed media asset (bypasses ffmpeg; the real pipeline is covered in media.test.ts). */
export async function readyAsset(db: Db, orgId: string, userId: string, kind: 'VIDEO' | 'IMAGE' = 'VIDEO', durationMs = 30_000): Promise<string> {
  const purpose = (await db.query('SELECT kind FROM organizations WHERE id = $1', [orgId])).rows[0].kind === 'ADVERTISER' ? 'AD_CREATIVE' : 'CREATOR_VIDEO';
  const up = (await db.query(
    `INSERT INTO media_uploads (org_id, purpose, filename, declared_type, size_bytes, sha256, received_bytes, status, detected_type, created_by, completed_at, processed_at)
     VALUES ($1,$2,'fixture',$3,1,$4,1,'READY',$3,$5,now(),now()) RETURNING id`,
    [orgId, purpose, kind === 'VIDEO' ? 'video/mp4' : 'image/png', '0'.repeat(64), userId])).rows[0].id;
  const assetId = randomUUID();
  await db.query(
    `INSERT INTO media_assets (id, upload_id, org_id, kind, duration_ms, rendition_key, thumbnail_key, probe) VALUES ($1,$2,$3,$4,$5,$6,$7,'{}')`,
    [assetId, up, orgId, kind, kind === 'VIDEO' ? durationMs : null, `assets/${assetId}/${kind === 'VIDEO' ? '720p.mp4' : 'display.jpg'}`, `assets/${assetId}/thumb.jpg`]);
  return up;
}

export class FakeTablet {
  readonly privateKey: KeyObject;
  readonly publicKeyB64: string;
  deviceId?: string;
  constructor(readonly app: FastifyInstance, readonly serial = `SN-${uid()}`) {
    const kp = generateKeyPairSync('ed25519');
    this.privateKey = kp.privateKey;
    this.publicKeyB64 = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }
  signedHeaders(method: string, path: string, body: string, over: { ts?: number; nonce?: string } = {}) {
    const ts = String(over.ts ?? Math.floor(Date.now() / 1000));
    const nonce = over.nonce ?? randomToken(16);
    const sig = sign(null, deviceSigningPayload(method, path, ts, nonce, body), this.privateKey).toString('base64');
    return { 'content-type': 'application/json', 'x-device-id': this.deviceId!, 'x-device-timestamp': ts, 'x-device-nonce': nonce, 'x-device-signature': sig };
  }
  async call(method: 'POST' | 'GET', path: string, payload?: object, over: { ts?: number; nonce?: string } = {}) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers: Record<string, string> = this.signedHeaders(method, path, body, over);
    if (!body) delete headers['content-type'];
    return this.app.inject({ method, url: path, ...(body ? { payload: body } : {}), headers });
  }
}
