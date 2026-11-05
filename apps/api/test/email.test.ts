import { createServer, type IncomingMessage } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { deliverPendingEmail, emailSender, enqueueEmail, LogEmailSender, ResendEmailSender } from '../src/lib/email.js';
import { setupApp, uid, type Ctx } from './helpers.js';

let ctx: Ctx;
const calls: Array<{ headers: IncomingMessage['headers']; body: any }> = [];
let failNext = 0, rejectNext = false;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    calls.push({ headers: req.headers, body: JSON.parse(raw || '{}') });
    if (failNext > 0) { failNext--; res.writeHead(500).end('upstream error'); return; }
    if (rejectNext) { rejectNext = false; res.writeHead(422, { 'content-type': 'application/json' }).end('{"message":"invalid from address"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"email_123"}');
  });
});
let url = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ctx = await setupApp();
});
afterAll(async () => { server.close(); await ctx.app.close(); await ctx.db.end(); });

const mine = (to: string) => ctx.db.query(`SELECT status, attempts, last_error, body_text FROM email_outbox WHERE to_email = $1`, [to]).then((r) => r.rows[0]);

describe('email delivery (D-044)', () => {
  it('sends through Resend with the outbox id as idempotency key, and clears the body after sending', async () => {
    const to = `r-${uid()}@example.test`;
    await enqueueEmail(ctx.db, to, 'invitation', 'You are invited', 'Accept: https://rides.example.com/portal/?invite=abc');
    const sender = new ResendEmailSender('re_test_key', 'Rideshare Media <no-reply@rides.example.com>', url);
    await deliverPendingEmail(ctx.db, sender, 1000);
    const c = calls.find((x) => x.body.to?.[0] === to)!;
    expect(c.headers.authorization).toBe('Bearer re_test_key');
    expect(c.headers['idempotency-key']).toMatch(/^rmn-email-\d+$/);
    expect(c.body).toEqual({ from: 'Rideshare Media <no-reply@rides.example.com>', to: [to], subject: 'You are invited', text: 'Accept: https://rides.example.com/portal/?invite=abc' });
    expect(await mine(to)).toMatchObject({ status: 'SENT', attempts: 1, body_text: null });
  });

  it('retries provider failures with the same idempotency key, then gives up after 5 attempts', async () => {
    const to = `retry-${uid()}@example.test`;
    await enqueueEmail(ctx.db, to, 'password_reset', 'Reset', 'link');
    const sender = new ResendEmailSender('re_test_key', 'no-reply@rides.example.com', url);
    failNext = 1;
    await deliverPendingEmail(ctx.db, sender, 1000);
    expect(await mine(to)).toMatchObject({ status: 'PENDING', attempts: 1 });
    await deliverPendingEmail(ctx.db, sender, 1000);
    expect(await mine(to)).toMatchObject({ status: 'SENT', attempts: 2 });
    const keys = calls.filter((x) => x.body.to?.[0] === to).map((x) => x.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1); // same key on retry: the provider never sends twice

    const bad = `bad-${uid()}@example.test`;
    await enqueueEmail(ctx.db, bad, 'invitation', 'x', 'y');
    for (let i = 0; i < 5; i++) { failNext = 1000; await deliverPendingEmail(ctx.db, sender, 1000); }
    failNext = 0;
    expect(await mine(bad)).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect((await mine(bad)).last_error).toMatch(/resend 500/);
  });

  it('records the provider’s reason when it rejects a message', async () => {
    const to = `rej-${uid()}@example.test`;
    await enqueueEmail(ctx.db, to, 'invitation', 'x', 'y');
    rejectNext = true;
    await deliverPendingEmail(ctx.db, new ResendEmailSender('re_test_key', 'bad', url), 1000);
    expect((await mine(to)).last_error).toMatch(/resend 422: .*invalid from address/);
  });

  it('in production the log fallback never prints email bodies (they contain single-use links)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      await new LogEmailSender().send('a@example.test', 'Reset your password', 'https://x/portal/?reset=SECRET-TOKEN');
      expect(log.mock.calls.flat().join(' ')).not.toContain('SECRET-TOKEN');
      expect(log.mock.calls.flat().join(' ')).toContain('not-sent');
    } finally { process.env.NODE_ENV = env; log.mockRestore(); }
  });

  it('selects the sender from configuration and requires a key and sender address for Resend', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', APP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), MEDIA_SIGNING_KEY: Buffer.alloc(32).toString('base64'), PAYMENTS_PROVIDER: 'disabled' };
    expect(emailSender(loadConfig(base)).name).toBe('log');
    expect(emailSender(loadConfig({ ...base, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_abc', EMAIL_FROM: 'no-reply@rides.example.com' })).name).toBe('resend');
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY/);
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'sk_wrong', EMAIL_FROM: 'a@b.c' })).toThrow(/re_/);
  });
});
