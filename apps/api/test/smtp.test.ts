/**
 * SMTP email (Google Workspace style): implicit TLS on a local test server with a password, exactly like
 * smtp.gmail.com:465. Proves delivery, the stable Message-ID per outbox row, wrong-password handling, and that a
 * server without encryption is refused.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { deliverPendingEmail, emailSender, enqueueEmail, SmtpEmailSender } from '../src/lib/email.js';
import { setupApp, uid, type Ctx } from './helpers.js';

const USER = 'no-reply@azothadz.example', PASS = 'abcd efgh ijkl mnop'; // App Password format (synthetic)
const received: Array<{ from: string; to: string[]; raw: string }> = [];
let tls: { key: string; cert: string };
let server: SMTPServer, plainServer: SMTPServer, port: number, plainPort: number;
let ctx: Ctx;

const listen = (s: SMTPServer) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.server.address() as AddressInfo).port)));

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smtp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`], { stdio: 'ignore' });
  tls = { key: readFileSync(`${dir}/key.pem`, 'utf8'), cert: readFileSync(`${dir}/cert.pem`, 'utf8') };
  const common: SMTPServerOptions = {
    authMethods: ['PLAIN', 'LOGIN'], disabledCommands: [],
    onAuth(auth, _s, cb) {
      return auth.username === USER && auth.password === PASS ? cb(null, { user: USER }) : cb(new Error('Invalid credentials'));
    },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c: Buffer) => { raw += c.toString(); });
      stream.on('end', () => { received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw }); cb(); });
    },
  };
  server = new SMTPServer({ ...common, secure: true, key: tls.key, cert: tls.cert });
  plainServer = new SMTPServer({ ...common, secure: false, disabledCommands: ['STARTTLS'], allowInsecureAuth: true });
  port = await listen(server); plainPort = await listen(plainServer);
  ctx = await setupApp();
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r())); await new Promise<void>((r) => plainServer.close(() => r()));
  await ctx.app.close(); await ctx.db.end();
});

const sender = (over: Partial<ConstructorParameters<typeof SmtpEmailSender>[0]> = {}) => new SmtpEmailSender({
  host: '127.0.0.1', port, secure: true, user: USER, password: PASS, from: `Azoth Ads <${USER}>`, replyTo: 'support@azothadz.example', tlsCa: tls.cert, ...over });

describe('SMTP email (Google Workspace)', () => {
  it('delivers outbox email over TLS with the right sender, reply-to, and a stable Message-ID per row', async () => {
    const to = `driver-${uid()}@example.test`;
    await enqueueEmail(ctx.db, to, 'invitation', 'You are invited', 'Accept within 7 days: https://app.azothadz.example/portal/?invite=SYNTHETIC');
    const id = (await ctx.db.query(`SELECT id FROM email_outbox WHERE to_email = $1`, [to])).rows[0].id;
    const s = sender();
    // Only this test's row: other tests share the outbox table.
    const before = received.length;
    await s.send(to, 'You are invited', 'Accept within 7 days', { idempotencyKey: `rmn-email-${id}` });
    s.close();
    const m = received[before]!;
    expect(m.from).toBe(USER);
    expect(m.to).toEqual([to]);
    expect(m.raw).toMatch(/^From: Azoth Ads <no-reply@azothadz\.example>/m);
    expect(m.raw).toMatch(/^Reply-To: support@azothadz\.example/m);
    expect(m.raw).toMatch(new RegExp(`^Message-ID: <rmn-email-${id}@azothadz\\.example>`, 'mi'));
    expect(m.raw).toMatch(/Subject: You are invited/);
  });

  it('the outbox job marks rows sent, and records a wrong password as a retryable failure (no crash, body kept)', async () => {
    const bad = sender({ password: 'wrong-password' });
    const to = `bad-${uid()}@example.test`;
    await enqueueEmail(ctx.db, to, 'invitation', 'Hello', 'body');
    await deliverPendingEmail(ctx.db, bad, 500);
    bad.close();
    const row = (await ctx.db.query(`SELECT status, attempts, last_error, body_text FROM email_outbox WHERE to_email = $1`, [to])).rows[0];
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, body_text: 'body' });
    expect(row.last_error).toMatch(/auth|credentials|535/i);
    const good = sender();
    await deliverPendingEmail(ctx.db, good, 500);
    good.close();
    const after = (await ctx.db.query(`SELECT status, body_text FROM email_outbox WHERE to_email = $1`, [to])).rows[0];
    expect(after).toEqual({ status: 'SENT', body_text: null }); // body (may hold a one-time link) purged once sent
    expect(received.some((m) => m.to.includes(to))).toBe(true);
  });

  it('refuses a server that offers no encryption, so the password is never sent in the clear', async () => {
    const s = sender({ port: plainPort, secure: false });
    await expect(s.send('x@example.test', 's', 'b')).rejects.toThrow(/STARTTLS|TLS|secure/i);
    s.close();
  });

  it('config: smtp needs an account, an app password and a From address; Google Workspace defaults', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', APP_ENCRYPTION_KEY: 'A'.repeat(43) + '=', MEDIA_SIGNING_KEY: 'B'.repeat(43) + '=', PAYMENTS_PROVIDER: 'disabled' };
    expect(() => loadConfig({ ...base, EMAIL_PROVIDER: 'smtp' })).toThrow(/SMTP_USER, SMTP_PASSWORD and EMAIL_FROM/);
    const c = loadConfig({ ...base, EMAIL_PROVIDER: 'smtp', SMTP_USER: USER, SMTP_PASSWORD: PASS, EMAIL_FROM: `Azoth Ads <${USER}>` });
    expect(c).toMatchObject({ SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: 465, SMTP_SECURE: 'true' });
    expect(emailSender(c).name).toBe('smtp');
    // Resend stays available as the backup provider.
    expect(emailSender(loadConfig({ ...base, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test_123', EMAIL_FROM: 'x <a@b.co>' })).name).toBe('resend');
  });
});
