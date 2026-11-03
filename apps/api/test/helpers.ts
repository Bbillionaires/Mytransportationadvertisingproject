import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { deviceSigningPayload, hashPassword, randomToken } from '../src/lib/crypto.js';
import { TEST_DB } from './globalSetup.js';

export const PASSWORD = 'correct horse battery staple';

export interface Ctx { app: FastifyInstance; db: Db; config: Config }

let pwHash: string | undefined;

export async function setupApp(): Promise<Ctx> {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DB, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), LOG_LEVEL: 'silent', ALLOCATION_SETTLE_MINUTES: '0' });
  const db = createPool(config.DATABASE_URL);
  const app = await buildApp({ config, db, logger: false });
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
  async call(method: 'POST', path: string, payload: object, over: { ts?: number; nonce?: string } = {}) {
    const body = JSON.stringify(payload);
    return this.app.inject({ method, url: path, payload: body, headers: this.signedHeaders(method, path, body, over) });
  }
}
