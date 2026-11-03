import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { parse } from '../../lib/validation.js';
import { authenticateDevice } from '../devices/routes.js';

const ts = z.string().datetime({ offset: true });
const ms = z.number().int().min(0).max(24 * 3600_000);
const exposure = { startedAt: ts, endedAt: ts, visibleMs: ms, mutedMs: ms };

export const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('AD_PLAYBACK'), eventId: z.string().uuid(), playbackSessionId: z.string().uuid().optional(), campaignId: z.string().uuid(), creativeId: z.string().uuid(),
    contentVideoId: z.string().uuid().optional(), completed: z.boolean().default(false), skipped: z.boolean().default(false), ...exposure }),
  z.object({ type: z.literal('CONTENT_PLAYBACK'), eventId: z.string().uuid(), playbackSessionId: z.string().uuid().optional(), videoId: z.string().uuid(),
    completed: z.boolean().default(false), ...exposure }),
  z.object({ type: z.literal('CLICK'), eventId: z.string().uuid(), campaignId: z.string().uuid(), creativeId: z.string().uuid(), contentVideoId: z.string().uuid().optional(),
    target: z.enum(['LANDING_PAGE', 'COUPON']), occurredAt: ts }),
  z.object({ type: z.literal('ACTIVE_SEGMENT'), eventId: z.string().uuid(), startedAt: ts, endedAt: ts, screenOn: z.boolean(), interactions: z.number().int().min(0).max(100_000) }),
]);
export type DeviceEvent = z.infer<typeof eventSchema>;

const occurredOf = (e: DeviceEvent) => (e.type === 'CLICK' ? e.occurredAt : e.startedAt);

/**
 * Signed batch upload from a tablet (live or replayed from its offline queue). Events are stored raw and
 * deduplicated by (device, eventId); nothing here is billable until the validator has run.
 * Clock drift: the signed request timestamp measures the device clock offset, which is applied to every
 * event time in the batch (the offset itself is bounded by the signature skew window).
 */
export async function eventIngestRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  app.post('/v1/devices/events', async (req) => {
    const dev = await authenticateDevice(db, config, req);
    const body = parse(z.object({ batchId: z.string().uuid(), events: z.array(z.unknown()).min(1).max(500) }), req.body);
    const offsetMs = Date.now() - dev.deviceTime.getTime();
    const rejected: Array<{ index: number; eventId?: unknown; reason: string }> = [];
    const good: DeviceEvent[] = [];
    body.events.forEach((raw, index) => {
      const r = eventSchema.safeParse(raw);
      if (!r.success) rejected.push({ index, eventId: (raw as any)?.eventId, reason: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      else good.push(r.data);
    });
    let accepted = 0;
    await withTx(db, async (tx) => {
      for (const e of good) {
        const deviceAt = new Date(occurredOf(e));
        const ins = await tx.query(
          `INSERT INTO raw_events (device_id, event_id, batch_id, type, device_occurred_at, occurred_at, clock_offset_ms, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (device_id, event_id) DO NOTHING`,
          [dev.deviceId, e.eventId, body.batchId, e.type, deviceAt.toISOString(), new Date(deviceAt.getTime() + offsetMs).toISOString(), offsetMs, JSON.stringify(e)],
        );
        accepted += ins.rowCount ?? 0;
      }
      await tx.query('UPDATE devices SET last_sync_at = now() WHERE id = $1', [dev.deviceId]);
    });
    return { batchId: body.batchId, received: body.events.length, accepted, duplicates: good.length - accepted, rejected };
  });
}
