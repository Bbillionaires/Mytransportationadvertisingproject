import nodemailer from 'nodemailer';
import type { Config } from '../config.js';
import type { Db, Queryable } from '../db/pool.js';

/**
 * Transactional email via an outbox: application code only enqueues (inside its own transaction), and the worker
 * delivers. Senders: LogEmailSender (development; in production it never prints bodies, which hold single-use
 * links), SmtpEmailSender (EMAIL_PROVIDER=smtp, e.g. Google Workspace) and ResendEmailSender (EMAIL_PROVIDER=resend,
 * kept as the backup). Provider choice: D-044.
 */
export interface EmailSender { name: string; send(to: string, subject: string, body: string, opts?: { idempotencyKey?: string }): Promise<void> }

export class LogEmailSender implements EmailSender {
  readonly name = 'log';
  sent: Array<{ to: string; subject: string; body: string }> = [];
  constructor(private readonly redactBodies = process.env.NODE_ENV === 'production') {}
  async send(to: string, subject: string, body: string) {
    this.sent.push({ to, subject, body });
    if (process.env.NODE_ENV === 'test') return;
    console.log(this.redactBodies
      ? `[email:not-sent] to=${to} subject=${subject} (no email provider configured; body withheld because it may contain sign-in links)`
      : `[email:dev] to=${to} subject=${subject}\n${body}\n`);
  }
}

/** Resend (https://resend.com) HTTP API. The outbox row id is sent as the idempotency key, so retries never duplicate. */
export class ResendEmailSender implements EmailSender {
  readonly name = 'resend';
  constructor(private readonly apiKey: string, private readonly from: string, private readonly apiUrl = 'https://api.resend.com') {}
  async send(to: string, subject: string, body: string, opts: { idempotencyKey?: string } = {}) {
    const res = await fetch(`${this.apiUrl.replace(/\/$/, '')}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}) },
      body: JSON.stringify({ from: this.from, to: [to], subject, text: body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`resend ${res.status}: ${detail}`);
    }
  }
}

/**
 * SMTP sender, e.g. Google Workspace (smtp.gmail.com:465 with an App Password on the sending account). SMTP has no
 * idempotency key, so each outbox row gets a stable Message-ID: if a retry follows a send whose reply was lost,
 * mail systems (Gmail included) recognise the duplicate. TLS is always required and certificates are verified.
 */
export class SmtpEmailSender implements EmailSender {
  readonly name = 'smtp';
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;
  constructor(private readonly opts: { host: string; port: number; secure: boolean; user: string; password: string; from: string; replyTo?: string;
    /** Tests only: trust a self-signed certificate. */ tlsCa?: string }) {
    this.transport = nodemailer.createTransport({
      host: opts.host, port: opts.port, secure: opts.secure, requireTLS: true,
      auth: { user: opts.user, pass: opts.password },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(opts.tlsCa ? { ca: opts.tlsCa } : {}) },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      disableFileAccess: true, disableUrlAccess: true,
    });
  }
  async send(to: string, subject: string, body: string, o: { idempotencyKey?: string } = {}) {
    const domain = this.opts.from.match(/@([^>\s]+)/)?.[1] ?? 'localhost';
    await this.transport.sendMail({
      from: this.opts.from, to, subject, text: body, ...(this.opts.replyTo ? { replyTo: this.opts.replyTo } : {}),
      ...(o.idempotencyKey ? { messageId: `<${o.idempotencyKey}@${domain}>` } : {}),
    });
  }
  close() { this.transport.close(); }
}

/** The configured sender for this process. */
export function emailSender(config: Config): EmailSender {
  if (config.EMAIL_PROVIDER === 'smtp') {
    return new SmtpEmailSender({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE === 'true', user: config.SMTP_USER!,
      password: config.SMTP_PASSWORD!, from: config.EMAIL_FROM!, replyTo: config.EMAIL_REPLY_TO });
  }
  if (config.EMAIL_PROVIDER === 'resend') return new ResendEmailSender(config.RESEND_API_KEY!, config.EMAIL_FROM!, config.RESEND_API_URL);
  return new LogEmailSender();
}

export async function enqueueEmail(q: Queryable, to: string, template: string, subject: string, body: string) {
  await q.query('INSERT INTO email_outbox (to_email, template, subject, body_text) VALUES ($1,$2,$3,$4)', [to, template, subject, body]);
}

export async function deliverPendingEmail(db: Db, sender: EmailSender, limit = 100) {
  const rows = (await db.query(`SELECT id, to_email, subject, body_text FROM email_outbox WHERE status = 'PENDING' AND attempts < 5 ORDER BY id LIMIT $1`, [limit])).rows;
  let sent = 0, failed = 0;
  for (const r of rows) {
    try {
      await sender.send(r.to_email, r.subject, r.body_text ?? '', { idempotencyKey: `rmn-email-${r.id}` });
      await db.query(`UPDATE email_outbox SET status = 'SENT', sent_at = now(), attempts = attempts + 1, body_text = NULL WHERE id = $1`, [r.id]);
      sent += 1;
    } catch (e) {
      await db.query(`UPDATE email_outbox SET attempts = attempts + 1, last_error = $2, status = CASE WHEN attempts + 1 >= 5 THEN 'FAILED' ELSE 'PENDING' END WHERE id = $1`, [r.id, (e as Error).message.slice(0, 300)]);
      failed += 1;
    }
  }
  return { sent, failed };
}
