import type { Db, Queryable } from '../db/pool.js';

/**
 * Transactional email via an outbox: application code only enqueues (inside its own transaction), and
 * jobs:send-email delivers. The sender is pluggable; LogEmailSender is for development only. A production
 * provider (SES, Postmark, SendGrid…) is DECISION REQUIRED (D-044).
 */
export interface EmailSender { name: string; send(to: string, subject: string, body: string): Promise<void> }

export class LogEmailSender implements EmailSender {
  readonly name = 'log';
  sent: Array<{ to: string; subject: string; body: string }> = [];
  async send(to: string, subject: string, body: string) {
    this.sent.push({ to, subject, body });
    if (process.env.NODE_ENV !== 'test') console.log(`[email:dev] to=${to} subject=${subject}\n${body}\n`);
  }
}

export async function enqueueEmail(q: Queryable, to: string, template: string, subject: string, body: string) {
  await q.query('INSERT INTO email_outbox (to_email, template, subject, body_text) VALUES ($1,$2,$3,$4)', [to, template, subject, body]);
}

export async function deliverPendingEmail(db: Db, sender: EmailSender, limit = 100) {
  const rows = (await db.query(`SELECT id, to_email, subject, body_text FROM email_outbox WHERE status = 'PENDING' AND attempts < 5 ORDER BY id LIMIT $1`, [limit])).rows;
  let sent = 0, failed = 0;
  for (const r of rows) {
    try {
      await sender.send(r.to_email, r.subject, r.body_text ?? '');
      await db.query(`UPDATE email_outbox SET status = 'SENT', sent_at = now(), attempts = attempts + 1, body_text = NULL WHERE id = $1`, [r.id]);
      sent += 1;
    } catch (e) {
      await db.query(`UPDATE email_outbox SET attempts = attempts + 1, last_error = $2, status = CASE WHEN attempts + 1 >= 5 THEN 'FAILED' ELSE 'PENDING' END WHERE id = $1`, [r.id, (e as Error).message.slice(0, 300)]);
      failed += 1;
    }
  }
  return { sent, failed };
}
