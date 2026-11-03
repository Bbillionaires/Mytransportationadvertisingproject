import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { currency, idemKey, isoDate, minor, parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';
import { postEntry, reverseEntry, trialBalance, validateEntry, type EntryInput } from './service.js';

const lineSchema = z.object({
  accountCode: z.string().regex(/^\d{4}$/),
  currency,
  debit: minor.optional(),
  credit: minor.optional(),
  partyType: z.enum(['ADVERTISER', 'CREATOR', 'DRIVER', 'RECIPIENT', 'PLATFORM']).optional(),
  partyId: uuid.optional(),
  memo: z.string().max(500).optional(),
});

const manualSchema = z.object({
  idempotencyKey: idemKey,
  entryDate: isoDate,
  description: z.string().min(3).max(500),
  reason: z.string().min(10).max(2000),
  sourceType: z.enum(['MANUAL', 'ADJUSTMENT']).default('MANUAL'),
  lines: z.array(lineSchema).min(2).max(200),
});

const serializeLines = (lines: EntryInput['lines']) => lines.map((l) => ({ ...l, debit: l.debit?.toString(), credit: l.credit?.toString() }));
const deserializeLines = (lines: any[]): EntryInput['lines'] => lines.map((l) => ({ ...l, debit: l.debit ? BigInt(l.debit) : undefined, credit: l.credit ? BigInt(l.credit) : undefined }));

export async function ledgerRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/v1/finance/accounts', async (req) => {
    await authorize(db, req, 'finance.read');
    return { items: (await db.query('SELECT * FROM ledger_accounts ORDER BY code')).rows };
  });

  app.get('/v1/finance/trial-balance', async (req) => {
    await authorize(db, req, 'finance.read');
    const q = parse(z.object({ asOf: isoDate.optional() }), req.query);
    const tb = await trialBalance(db, q.asOf);
    const balanced = Object.values(tb.totals).every((t) => t.debit === t.credit);
    return { ...tb, balanced };
  });

  app.get('/v1/finance/journal-entries', async (req) => {
    await authorize(db, req, 'finance.read');
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), sourceType: z.string().optional() }), req.query);
    const r = await db.query(
      `SELECT id, entry_number, entry_date, description, source_type, source_id, reverses_entry_id, posted_at, posted_by, approved_by
         FROM journal_entries WHERE ($1::text IS NULL OR source_type = $1) ORDER BY entry_number DESC LIMIT $2`,
      [q.sourceType ?? null, q.limit],
    );
    return { items: r.rows };
  });

  app.get('/v1/finance/journal-entries/:id', async (req) => {
    await authorize(db, req, 'finance.read');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const e = await db.query('SELECT * FROM journal_entries WHERE id = $1', [id]);
    if (!e.rows[0]) throw notFound();
    const l = await db.query('SELECT line_no, account_code, currency, debit, credit, party_type, party_id, processor, memo FROM journal_lines WHERE entry_id = $1 ORDER BY line_no', [id]);
    const rev = await db.query('SELECT id FROM journal_entries WHERE reverses_entry_id = $1', [id]);
    return { ...e.rows[0], lines: l.rows, reversedBy: rev.rows[0]?.id ?? null };
  });

  app.get('/v1/finance/periods', async (req) => {
    await authorize(db, req, 'finance.read');
    return { items: (await db.query('SELECT * FROM accounting_periods ORDER BY period_start')).rows };
  });

  app.post('/v1/finance/periods', async (req, reply) => {
    await authorize(db, req, 'finance.period.manage');
    const b = parse(z.object({ periodStart: isoDate, periodEnd: isoDate }), req.body);
    const r = await withTx(db, async (tx) => {
      const p = await tx.query('INSERT INTO accounting_periods (period_start, period_end) VALUES ($1,$2) RETURNING *', [b.periodStart, b.periodEnd]);
      await audit(tx, actorOf(req), 'finance.period_opened', { type: 'accounting_period', id: p.rows[0].id }, b);
      return p.rows[0];
    });
    reply.code(201);
    return r;
  });

  app.post('/v1/finance/periods/:id/close', async (req) => {
    const auth = await authorize(db, req, 'finance.period.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTx(db, async (tx) => {
      const pending = await tx.query(
        `SELECT count(*)::int n FROM journal_requests r, accounting_periods p WHERE p.id = $1 AND r.status = 'PENDING' AND (r.payload->>'entryDate')::date BETWEEN p.period_start AND p.period_end`,
        [id],
      );
      if (pending.rows[0].n > 0) throw conflict(`${pending.rows[0].n} pending journal request(s) are dated in this period; decide them before closing`);
      const p = await tx.query(`UPDATE accounting_periods SET status = 'CLOSED', closed_by = $2, closed_at = now() WHERE id = $1 RETURNING *`, [id, auth.userId]);
      if (!p.rows[0]) throw notFound('period not found');
      const tb = await trialBalance(tx, p.rows[0].period_end.toISOString().slice(0, 10));
      await audit(tx, actorOf(req), 'finance.period_closed', { type: 'accounting_period', id }, { trialBalanceTotals: tb.totals });
      return p.rows[0];
    });
  });

  /** Request a manual journal entry. It is validated now but posted only after a different user approves. */
  app.post('/v1/finance/journal-requests', async (req, reply) => {
    const auth = await authorize(db, req, 'finance.journal.request');
    const b = parse(manualSchema, req.body);
    const entry: EntryInput = { idempotencyKey: `manual:${b.idempotencyKey}`, entryDate: b.entryDate, description: b.description, sourceType: b.sourceType, lines: b.lines };
    validateEntry(entry);
    const r = await withTx(db, async (tx) => {
      const prior = await tx.query('SELECT * FROM journal_requests WHERE idempotency_key = $1', [b.idempotencyKey]);
      if (prior.rows[0]) return prior.rows[0];
      const jr = await tx.query(
        `INSERT INTO journal_requests (idempotency_key, requested_by, reason, payload) VALUES ($1,$2,$3,$4) RETURNING *`,
        [b.idempotencyKey, auth.userId, b.reason, JSON.stringify({ kind: 'ENTRY', entryDate: b.entryDate, description: b.description, sourceType: b.sourceType, lines: serializeLines(b.lines) })],
      );
      await audit(tx, actorOf(req), 'finance.journal_requested', { type: 'journal_request', id: jr.rows[0].id }, { reason: b.reason });
      return jr.rows[0];
    });
    reply.code(201);
    return r;
  });

  /** Request reversal of a posted entry (also dual-approved). */
  app.post('/v1/finance/journal-entries/:id/reversal-requests', async (req, reply) => {
    const auth = await authorize(db, req, 'finance.journal.request');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ idempotencyKey: idemKey, entryDate: isoDate, reason: z.string().min(10).max(2000) }), req.body);
    const e = await db.query('SELECT id FROM journal_entries WHERE id = $1', [id]);
    if (!e.rows[0]) throw notFound('entry not found');
    const jr = await db.query(
      `INSERT INTO journal_requests (idempotency_key, requested_by, reason, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [b.idempotencyKey, auth.userId, b.reason, JSON.stringify({ kind: 'REVERSAL', entryId: id, entryDate: b.entryDate })],
    );
    if (!jr.rows[0]) return (await db.query('SELECT * FROM journal_requests WHERE idempotency_key = $1', [b.idempotencyKey])).rows[0];
    await audit(db, actorOf(req), 'finance.reversal_requested', { type: 'journal_entry', id }, { reason: b.reason, requestId: jr.rows[0].id });
    reply.code(201);
    return jr.rows[0];
  });

  app.get('/v1/finance/journal-requests', async (req) => {
    await authorize(db, req, 'finance.read');
    const q = parse(z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }), req.query);
    return { items: (await db.query('SELECT * FROM journal_requests WHERE ($1::text IS NULL OR status = $1) ORDER BY requested_at DESC LIMIT 200', [q.status ?? null])).rows };
  });

  app.post('/v1/finance/journal-requests/:id/decision', async (req) => {
    const auth = await authorize(db, req, 'finance.journal.approve');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().max(2000).optional() }), req.body);
    return withTx(db, async (tx) => {
      const r = await tx.query('SELECT * FROM journal_requests WHERE id = $1 FOR UPDATE', [id]);
      const jr = r.rows[0];
      if (!jr) throw notFound('request not found');
      if (jr.status !== 'PENDING') throw conflict(`request already ${jr.status}`);
      if (jr.requested_by === auth.userId) throw forbidden('the requester cannot approve their own journal request', 'SEPARATION_OF_DUTIES');
      if (b.decision === 'REJECT') {
        const u = await tx.query(`UPDATE journal_requests SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1 RETURNING *`, [id, auth.userId, b.note ?? null]);
        await audit(tx, actorOf(req), 'finance.journal_rejected', { type: 'journal_request', id }, { note: b.note });
        return u.rows[0];
      }
      const p = jr.payload;
      let posted;
      if (p.kind === 'REVERSAL') {
        posted = await reverseEntry(tx, p.entryId, { idempotencyKey: `reversal:${jr.idempotency_key}`, entryDate: p.entryDate, reason: jr.reason, postedBy: jr.requested_by, approvedBy: auth.userId });
      } else if (p.kind === 'ENTRY') {
        posted = await postEntry(tx, {
          idempotencyKey: `manual:${jr.idempotency_key}`, entryDate: p.entryDate, description: p.description, sourceType: p.sourceType,
          postedBy: jr.requested_by, approvedBy: auth.userId, lines: deserializeLines(p.lines), metadata: { journalRequestId: id, reason: jr.reason },
        });
      } else throw unprocessable('unknown request kind');
      const u = await tx.query(
        `UPDATE journal_requests SET status = 'APPROVED', decided_by = $2, decided_at = now(), decision_note = $3, journal_entry_id = $4 WHERE id = $1 RETURNING *`,
        [id, auth.userId, b.note ?? null, posted.id],
      );
      await audit(tx, actorOf(req), 'finance.journal_approved', { type: 'journal_entry', id: posted.id }, { requestId: id, kind: p.kind });
      return u.rows[0];
    });
  });
}
