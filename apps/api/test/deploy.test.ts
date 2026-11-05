/** Production-readiness pieces for the Railway deployment: first-admin bootstrap, disabled payments, DB TLS rule. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { bootstrapAdmin } from '../src/modules/platform/bootstrap.js';
import { org, setupApp, userWithRole, type Ctx } from './helpers.js';

const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://rmn:rmn@localhost:5432/rmn_test';
const DB_NAME = 'rmn_bootstrap_test';
const DB_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);
const keys = { APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64') };

describe('first super admin bootstrap (empty production database)', () => {
  let db: Db;
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
    await migrate(DB_URL, () => {});
    db = createPool(DB_URL);
  }, 60_000);
  afterAll(async () => { await db?.end(); });

  it('creates the platform org and first super admin; the printed link sets the password; it refuses a second run', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ...keys, PAYMENTS_PROVIDER: 'disabled', APP_PUBLIC_URL: 'https://rides.example.com', LOG_LEVEL: 'silent' });
    const link = await bootstrapAdmin(db, config, 'owner@example.test', 'Owner');
    expect(link).toMatch(/^https:\/\/rides\.example\.com\/portal\/\?reset=/);
    const app = await buildApp({ config, db, logger: false });
    const token = decodeURIComponent(link.split('reset=')[1]!);
    const rc = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token, newPassword: 'correct battery horse staple 42' } });
    expect(rc.statusCode, rc.body).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'owner@example.test', password: 'correct battery horse staple 42' } });
    expect(login.statusCode).toBe(200);
    const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${login.json().token}` } })).json();
    expect(me.memberships).toEqual([expect.objectContaining({ orgKind: 'PLATFORM', role: 'super_admin' })]);
    await expect(bootstrapAdmin(db, config, 'second@example.test', 'Second')).rejects.toThrow(/already exists/);
    expect((await db.query(`SELECT action FROM audit_log WHERE action = 'platform.bootstrap_admin'`)).rowCount).toBe(1);
    await app.close();
  });
});

describe('payments disabled until Stripe is connected', () => {
  let ctx: Ctx;
  beforeAll(async () => { ctx = await setupApp({ env: { PAYMENTS_PROVIDER: 'disabled' } }); });
  afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

  it('checkout and webhooks refuse clearly; nothing reaches a processor', async () => {
    const adv = await org(ctx.db, 'ADVERTISER');
    const admin = await userWithRole(ctx, adv, 'advertiser_admin');
    const r = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${adv}/prepayments`, headers: admin.h, payload: { amountMinor: '25000' } });
    expect(r.statusCode, r.body).toBe(503);
    expect(r.json().error).toMatchObject({ code: 'PAYMENTS_NOT_ENABLED' });
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/webhooks/stripe', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(503);
  });
});

describe('production configuration rules', () => {
  const prod = (over: Record<string, string>) => loadConfig({ NODE_ENV: 'production', ...keys, PAYMENTS_PROVIDER: 'disabled', ...over });
  it('accepts Railway private networking without sslmode, still requires TLS for other remote databases', () => {
    expect(() => prod({ DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/railway' })).not.toThrow();
    expect(() => prod({ DATABASE_URL: 'postgresql://u:p@db.example.com:5432/x' })).toThrow(/TLS/);
    expect(() => prod({ DATABASE_URL: 'postgresql://u:p@db.example.com:5432/x?sslmode=require' })).not.toThrow();
    expect(() => prod({ DATABASE_URL: 'postgresql://u:p@evil.railway.internal.example.com:5432/x' })).toThrow(/TLS/);
  });
  it('never allows the fake payment provider, and requires a webhook secret whenever payments are on', () => {
    expect(() => prod({ DATABASE_URL: 'postgresql://u:p@postgres.railway.internal/x', PAYMENTS_PROVIDER: 'fake' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', ...keys, PAYMENTS_PROVIDER: 'fake' })).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });
});
