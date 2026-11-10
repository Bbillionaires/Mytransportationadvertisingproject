/** System health page: job tracking, staleness, failures, launch checklist, and who may see it. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { trackJob } from '../src/lib/jobStatus.js';
import { systemHealth } from '../src/modules/ops/health.js';
import { org, userWithRole } from './helpers.js';

const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://rmn:rmn@localhost:5432/rmn_test';
const DB_NAME = 'rmn_health_test';
const DB_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'),
  PAYMENTS_PROVIDER: 'disabled', LOG_LEVEL: 'silent' });
let db: Db;
const check = async (id: string) => (await systemHealth(db, config)).checks.find((c) => c.id === id)!;

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

describe('system health', () => {
  it('a fresh deployment: jobs not run yet are "to do", the checklist lists what is left, nothing is red', async () => {
    await trackJob(db, 'process-media', async () => ({ processed: 0 }));
    const h = await systemHealth(db, config);
    expect(h.overall).toBe('ok');
    expect(h.checks.find((c) => c.id === 'job:process-media')).toMatchObject({ status: 'ok' });
    expect(h.checks.find((c) => c.id === 'job:allocate-windows')).toMatchObject({ status: 'todo', detail: expect.stringMatching(/hasn't run yet/i) });
    expect(h.checks.find((c) => c.id === 'job:process-webhooks')).toBeUndefined(); // payments are off
    expect(h.checks.find((c) => c.id === 'revenue-rules')).toMatchObject({ status: 'todo', detail: expect.stringMatching(/4 of 4/) });
    expect(h.checks.find((c) => c.id === 'email')).toMatchObject({ status: 'todo' });
    expect(h.checks.find((c) => c.id === 'ledger-balanced')).toMatchObject({ status: 'ok' });
    expect(h.checks.find((c) => c.id === 'tablets')).toMatchObject({ status: 'todo' });
  });

  it('a failing job turns red with its error and count; the next success clears it', async () => {
    await expect(trackJob(db, 'allocate-windows', async () => { throw new Error('database timeout'); })).rejects.toThrow('database timeout');
    await trackJob(db, 'allocate-windows', async () => ({ skipped: 2, allocated: 0 }), { isFailure: (r) => (r.skipped ? `${r.skipped} window(s) could not be allocated` : null) });
    expect(await check('job:allocate-windows')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/2 times in a row.*could not be allocated/) });
    expect((await systemHealth(db, config)).overall).toBe('fail');
    await trackJob(db, 'allocate-windows', async () => ({ skipped: 0, allocated: 3 }));
    expect(await check('job:allocate-windows')).toMatchObject({ status: 'ok' });
    const row = (await db.query(`SELECT last_summary FROM job_status WHERE job = 'allocate-windows'`)).rows[0];
    expect(row.last_summary).toEqual({ skipped: 0, allocated: 3 });
  });

  it('a job that stops running (worker crashed, cron removed) turns red after its expected interval', async () => {
    await db.query(`UPDATE job_status SET last_ok_at = now() - interval '20 minutes' WHERE job = 'process-media'`);
    expect(await check('job:process-media')).toMatchObject({ status: 'fail', action: expect.stringMatching(/restart/) });
    await db.query(`UPDATE job_status SET last_ok_at = now() - interval '90 minutes' WHERE job = 'allocate-windows'`);
    expect((await check('job:allocate-windows')).status).toBe('ok'); // hourly job: 90 minutes is still fine
    await db.query(`UPDATE job_status SET last_ok_at = now() - interval '3 hours' WHERE job = 'allocate-windows'`);
    expect((await check('job:allocate-windows')).status).toBe('fail');
    // A daily job that never ran, long after the first job started, is a problem too.
    await db.query(`UPDATE job_status SET last_started_at = now() - interval '3 days' WHERE job = 'process-media'`);
    expect((await check('job:verify-spend-counters')).status).toBe('fail');
  });

  it('knows the backup bucket is connected from the worker’s backup runs (the API itself holds no backup keys)', async () => {
    expect((await check('backup-configured')).status).toBe('todo');
    await trackJob(db, 'backup-media', async () => ({ targets: 0, copied: 0, failed: 0 }));
    expect(await check('backups')).toMatchObject({ status: 'todo', detail: expect.stringMatching(/no backup bucket is connected/) });
    await trackJob(db, 'backup-media', async () => ({ targets: 1, copied: 0, failed: 0 }));
    expect(await check('backup-configured')).toMatchObject({ status: 'ok', detail: 'Connected (1 backup bucket).' });
    expect((await check('backups')).status).toBe('ok');
  });

  it('only finance and super admins can open it', async () => {
    const app = await buildApp({ config, db, logger: false });
    const platform = (await db.query(`INSERT INTO organizations (kind, name) VALUES ('PLATFORM','Platform') RETURNING id`)).rows[0].id;
    const ctx = { app, db, config };
    const sa = await userWithRole(ctx, platform, 'super_admin');
    const fin = await userWithRole(ctx, platform, 'finance_approver');
    const support = await userWithRole(ctx, platform, 'support_agent');
    const fleet = await userWithRole(ctx, await org(db, 'FLEET_OPERATOR'), 'fleet_admin');
    const r = await app.inject({ method: 'GET', url: '/v1/platform/health', headers: sa.h });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().checks.length).toBeGreaterThan(10);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/health', headers: fin.h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/health', headers: support.h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/health', headers: fleet.h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/health' })).statusCode).toBe(401);
    // Staff without two-step verification show up on the checklist.
    expect((await check('staff-mfa'))).toMatchObject({ status: 'warn', detail: expect.stringMatching(/3 staff member/) });
    await app.close();
  });
});
