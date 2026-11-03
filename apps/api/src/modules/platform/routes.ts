import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';

/**
 * Platform staff: earnings eligibility. Eligibility decides whether a creator or driver receives pool earnings, so it is
 * an MFA-protected, reason-required, audited action (D-012). Staff cannot decide for an organization they belong to.
 */
export async function platformRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const ELIG = z.enum(['PENDING', 'ELIGIBLE', 'SUSPENDED', 'TERMINATED']);
  const decision = z.object({ status: ELIG, reason: z.string().trim().min(5).max(500) });
  const notOwnOrg = async (q: { query: Db['query'] }, userId: string, orgId: string) => {
    if ((await q.query(`SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2 AND status = 'ACTIVE'`, [userId, orgId])).rows[0]) {
      throw conflict('staff cannot decide eligibility for an organization they belong to');
    }
  };

  app.get('/v1/platform/creators', async (req) => {
    await authorize(db, req, 'platform.eligibility.manage');
    const q = parse(z.object({ status: ELIG.optional() }), req.query);
    const r = await db.query(
      `SELECT cp.id, cp.display_name, cp.monetization_status, cp.created_at, o.id AS org_id, o.name AS org_name, o.is_synthetic,
              count(v.id) FILTER (WHERE v.status = 'APPROVED')::int AS videos_live, count(v.id)::int AS videos_total,
              count(t.id) FILTER (WHERE t.status IN ('ACTIONED','COUNTER_NOTICED'))::int AS open_takedowns
         FROM creator_profiles cp JOIN organizations o ON o.id = cp.org_id
         LEFT JOIN videos v ON v.creator_id = cp.id LEFT JOIN takedown_notices t ON t.video_id = v.id
        WHERE ($1::text IS NULL OR cp.monetization_status = $1) GROUP BY cp.id, o.id ORDER BY cp.created_at DESC LIMIT 500`, [q.status ?? null]);
    return { items: r.rows };
  });

  app.post('/v1/platform/creators/:id/monetization', async (req) => {
    const auth = await authorize(db, req, 'platform.eligibility.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(decision, req.body);
    return withTx(db, async (tx) => {
      const c = (await tx.query('SELECT id, org_id, monetization_status FROM creator_profiles WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!c) throw notFound('channel not found');
      await notOwnOrg(tx, auth.userId, c.org_id);
      await tx.query('UPDATE creator_profiles SET monetization_status = $2 WHERE id = $1', [id, b.status]);
      await audit(tx, actorOf(req), 'creator.monetization_changed', { type: 'creator_profile', id, orgId: c.org_id }, { from: c.monetization_status, to: b.status, reason: b.reason });
      return { id, monetizationStatus: b.status };
    });
  });

  app.get('/v1/platform/drivers', async (req) => {
    await authorize(db, req, 'platform.eligibility.manage');
    const q = parse(z.object({ status: ELIG.optional() }), req.query);
    const r = await db.query(
      `SELECT d.id, d.eligibility_status, d.created_at, u.display_name, u.email, o.id AS org_id, o.name AS fleet_operator, f.name AS fleet_name,
              (SELECT s.status FROM driver_subscriptions s WHERE s.driver_id = d.id ORDER BY s.created_at DESC LIMIT 1) AS subscription_status
         FROM drivers d JOIN users u ON u.id = d.user_id JOIN organizations o ON o.id = d.org_id JOIN fleets f ON f.id = d.fleet_id
        WHERE ($1::text IS NULL OR d.eligibility_status = $1) ORDER BY d.created_at DESC LIMIT 500`, [q.status ?? null]);
    return { items: r.rows };
  });

  app.post('/v1/platform/drivers/:id/eligibility', async (req) => {
    const auth = await authorize(db, req, 'platform.eligibility.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(decision, req.body);
    return withTx(db, async (tx) => {
      const d = (await tx.query('SELECT id, org_id, eligibility_status FROM drivers WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!d) throw notFound('driver not found');
      await notOwnOrg(tx, auth.userId, d.org_id);
      await tx.query('UPDATE drivers SET eligibility_status = $2 WHERE id = $1', [id, b.status]);
      await audit(tx, actorOf(req), 'driver.eligibility_changed', { type: 'driver', id, orgId: d.org_id }, { from: d.eligibility_status, to: b.status, reason: b.reason });
      return { id, eligibilityStatus: b.status };
    });
  });
}
