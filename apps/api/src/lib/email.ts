import type { Config } from '../config.js';
import type { Db, Queryable } from '../db/pool.js';

/**
 * Transactional email via an outbox: application code only enqueues (inside its own transaction), and the worker
 * delivers. Senders: LogEmailSender (development; in production it never prints bodies, which hold single-use
 * links) and ResendEmailSender (EMAIL_PROVIDER=resend). Provider choice: D-044.
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

/** The configured sender for this process. */
export function emailSender(config: Config): EmailSender {
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
