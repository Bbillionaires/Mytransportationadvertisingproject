import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { conflict } from '../../lib/errors.js';
import { idemKey, isoDate, minor, parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';
import { runValidation } from './validator.js';
import { runScheduledAllocations } from './scheduler.js';
import { campaignMetrics, postWindow, previewWindow, type WindowInput } from './aggregate.js';

const windowSchema = z.object({
  idempotencyKey: idemKey,
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  entryDate: isoDate,
  deductions: z.array(z.object({ type: z.string(), amount: minor, description: z.string().min(1).max(200), contractRef: z.string().min(1).max(200) })).default([]),
}).refine((v) => new Date(v.periodEnd) > new Date(v.periodStart), 'periodEnd must be after periodStart');

export async function eventRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  app.post('/v1/events/validate', async (req) => {
    await authorize(db, req, 'events.validate');
    const b = parse(z.object({ limit: z.number().int().min(1).max(50_000).default(5000) }), req.body ?? {});
    const r = await runValidation(db, b.limit);
    await audit(db, actorOf(req), 'events.validation_run', { type: 'validator' }, r);
    return r;
  });

  app.get('/v1/events/held', async (req) => {
    await authorize(db, req, 'events.review');
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }), req.query);
    const r = await db.query(
      `SELECT v.id::text, v.device_id, v.type, v.occurred_at, v.campaign_id, v.creator_id, v.driver_id, v.reasons, r.received_at
         FROM validated_events v JOIN raw_events r ON r.id = v.raw_event_id WHERE v.status = 'HELD_REVIEW' ORDER BY v.occurred_at LIMIT $1`, [q.limit]);
    return { items: r.rows };
  });

  /**
   * Human decision on held events. Approval is refused for events inside an already-allocated window:
   * those can only be paid through a future, separately approved adjustment batch.
   */
  app.post('/v1/events/review', async (req) => {
    const auth = await authorize(db, req, 'events.review');
    const b = parse(z.object({ eventIds: z.array(z.string().regex(/^\d{1,18}$/)).min(1).max(1000), decision: z.enum(['APPROVE', 'REJECT']), note: z.string().min(5).max(1000) }), req.body);
    return withTx(db, async (tx) => {
      if (b.decision === 'APPROVE') {
        const late = await tx.query(
          `SELECT v.id::text FROM validated_events v JOIN allocation_windows w ON w.campaign_id = v.campaign_id AND tstzrange(w.period_start, w.period_end) @> v.occurred_at
            WHERE v.id = ANY($1::bigint[])`, [b.eventIds]);
        if (late.rows.length) throw conflict(`events ${late.rows.map((r) => r.id).join(', ')} fall in an allocated window and can only be rejected`);
      }
      const u = await tx.query(
        `UPDATE validated_events SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = ANY($1::bigint[]) AND status = 'HELD_REVIEW' RETURNING id::text`,
        [b.eventIds, b.decision === 'APPROVE' ? 'VALID' : 'INVALID', auth.userId, b.note]);
      await audit(tx, actorOf(req), 'events.reviewed', { type: 'validated_events' }, { decision: b.decision, ids: u.rows.map((r) => r.id), note: b.note });
      return { updated: u.rows.length, ids: u.rows.map((r) => r.id) };
    });
  });

  app.get('/v1/finance/campaigns/:campaignId/metrics', async (req) => {
    await authorize(db, req, 'finance.read');
    const { campaignId } = parse(z.object({ campaignId: uuid }), req.params);
    const q = parse(z.object({ from: z.string().datetime(), to: z.string().datetime() }), req.query);
    return campaignMetrics(db, campaignId, q.from, q.to);
  });

  app.post('/v1/finance/campaigns/:campaignId/allocation-windows/preview', async (req) => {
    await authorize(db, req, 'finance.read');
    const { campaignId } = parse(z.object({ campaignId: uuid }), req.params);
    const b = parse(windowSchema, req.body);
    return previewWindow(db, { ...b, campaignId } as WindowInput);
  });

  /** Trigger the scheduled allocation run now (normally hourly by the job runner). Recorded as the calling user. */
  app.post('/v1/finance/allocation-windows/run', async (req) => {
    const auth = await authorize(db, req, 'finance.allocation.post');
    const r = await runScheduledAllocations(db, config, { actorUserId: auth.userId });
    await audit(db, actorOf(req), 'finance.scheduled_allocation_run', { type: 'scheduler' }, { allocated: r.allocated, skipped: r.skipped, cutoff: r.cutoff });
    return r;
  });

  /** Allocate a campaign window from validated events only. Windows can never overlap (DB exclusion). */
  app.post('/v1/finance/campaigns/:campaignId/allocation-windows', async (req, reply) => {
    const auth = await authorize(db, req, 'finance.allocation.post');
    const { campaignId } = parse(z.object({ campaignId: uuid }), req.params);
    const b = parse(windowSchema, req.body);
    const r = await withTx(db, async (tx) => {
      const out = await postWindow(tx, { ...b, campaignId } as WindowInput, auth.userId, config.ALLOCATION_SETTLE_MINUTES);
      if (!out.idempotent) await audit(tx, actorOf(req), 'finance.window_allocated', { type: 'allocation_window', id: out.windowId }, { campaignId, periodStart: b.periodStart, periodEnd: b.periodEnd });
      return out;
    });
    reply.code(r.idempotent ? 200 : 201);
    return r;
  });
}
