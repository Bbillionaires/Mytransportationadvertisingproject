import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { randomToken, sha256hex } from '../../lib/crypto.js';
import { enqueueEmail } from '../../lib/email.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';

/**
 * Time-boxed support impersonation. The resulting session acts as the target user but records the support user as
 * impersonator on every audit entry, cannot use any MFA-gated (financial/platform) permission, cannot target platform
 * staff, and the target is notified by email.
 */
export async function impersonationRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.post('/v1/support/impersonations', async (req, reply) => {
    const auth = await authorize(db, req, 'support.impersonate');
    const b = parse(z.object({ targetUserId: uuid, reason: z.string().min(10).max(1000), ticketRef: z.string().min(2).max(100), minutes: z.number().int().min(1).max(30).default(15) }), req.body);
    if (b.targetUserId === auth.userId) throw forbidden('cannot impersonate yourself');
    const out = await withTx(db, async (tx) => {
      const t = (await tx.query(`SELECT id, email, status FROM users WHERE id = $1`, [b.targetUserId])).rows[0];
      if (!t || t.status !== 'ACTIVE') throw notFound('active user not found');
      const staff = await tx.query(`SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = $1 AND o.kind = 'PLATFORM' AND m.status = 'ACTIVE'`, [t.id]);
      if (staff.rows[0]) throw forbidden('platform staff accounts cannot be impersonated');
      const token = randomToken();
      const s = await tx.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent, impersonator_user_id, impersonation_reason)
         VALUES ($1,$2, now() + make_interval(mins => $3), $4, $5, $6, $7) RETURNING id, expires_at`,
        [t.id, sha256hex(token), b.minutes, req.ip, 'support-impersonation', auth.userId, `${b.ticketRef}: ${b.reason}`]);
      const imp = await tx.query(
        `INSERT INTO support_impersonations (support_user_id, target_user_id, reason, ticket_ref, session_id, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [auth.userId, t.id, b.reason, b.ticketRef, s.rows[0].id, s.rows[0].expires_at]);
      await enqueueEmail(tx, t.email, 'support_access', 'Support accessed your account',
        `A support agent is accessing your account until ${new Date(s.rows[0].expires_at).toISOString()} for ticket ${b.ticketRef}. Financial and administrative actions are blocked during support access.`);
      await audit(tx, actorOf(req), 'support.impersonation_started', { type: 'user', id: t.id }, { impersonationId: imp.rows[0].id, ticketRef: b.ticketRef, reason: b.reason, minutes: b.minutes });
      return { impersonationId: imp.rows[0].id, token, expiresAt: s.rows[0].expires_at };
    });
    reply.code(201);
    return out;
  });

  app.post('/v1/support/impersonations/:id/end', async (req) => {
    const auth = await authorize(db, req, 'support.impersonate');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTx(db, async (tx) => {
      const i = (await tx.query('SELECT * FROM support_impersonations WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!i) throw notFound('impersonation not found');
      await tx.query('UPDATE sessions SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1', [i.session_id]);
      await tx.query('UPDATE support_impersonations SET ended_at = coalesce(ended_at, now()), ended_by = coalesce(ended_by, $2) WHERE id = $1', [id, auth.userId]);
      await audit(tx, actorOf(req), 'support.impersonation_ended', { type: 'user', id: i.target_user_id }, { impersonationId: id });
      return { ended: true };
    });
  });

  app.get('/v1/support/impersonations', async (req) => {
    await authorize(db, req, 'platform.audit.read');
    return { items: (await db.query(`SELECT i.*, s.revoked_at AS session_revoked_at FROM support_impersonations i JOIN sessions s ON s.id = i.session_id ORDER BY started_at DESC LIMIT 200`)).rows };
  });
}
