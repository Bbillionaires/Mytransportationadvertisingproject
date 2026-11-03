import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';
import { loadOrg } from '../orgs/routes.js';

const orgParams = z.object({ orgId: uuid });

async function fleetOrg(db: Db, orgId: string) {
  const org = await loadOrg(db, orgId);
  if (org.kind !== 'FLEET_OPERATOR') throw notFound('fleet operator not found');
  return org;
}

export async function fleetRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/v1/orgs/:orgId/fleets', async (req) => {
    const { orgId } = parse(orgParams, req.params);
    await fleetOrg(db, orgId);
    await authorize(db, req, 'fleet.read', orgId);
    return { items: (await db.query('SELECT * FROM fleets WHERE org_id = $1 ORDER BY name', [orgId])).rows };
  });

  app.post('/v1/orgs/:orgId/fleets', async (req, reply) => {
    const { orgId } = parse(orgParams, req.params);
    await fleetOrg(db, orgId);
    await authorize(db, req, 'fleet.manage', orgId);
    const b = parse(z.object({ name: z.string().min(1).max(200), market: z.string().min(1).max(100), timezone: z.string().min(1).max(64) }), req.body);
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch { throw badRequest('unknown IANA timezone'); }
    const r = await withTx(db, async (tx) => {
      const f = await tx.query('INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,$2,$3,$4) RETURNING *', [orgId, b.name, b.market, b.timezone]);
      await audit(tx, actorOf(req), 'fleet.created', { type: 'fleet', id: f.rows[0].id, orgId }, b);
      return f.rows[0];
    });
    reply.code(201);
    return r;
  });

  app.get('/v1/orgs/:orgId/vehicles', async (req) => {
    const { orgId } = parse(orgParams, req.params);
    await fleetOrg(db, orgId);
    await authorize(db, req, 'fleet.read', orgId);
    return { items: (await db.query('SELECT * FROM vehicles WHERE org_id = $1 ORDER BY label', [orgId])).rows };
  });

  app.post('/v1/orgs/:orgId/vehicles', async (req, reply) => {
    const { orgId } = parse(orgParams, req.params);
    await fleetOrg(db, orgId);
    await authorize(db, req, 'fleet.manage', orgId);
    const b = parse(z.object({ fleetId: uuid, label: z.string().min(1).max(100), makeModel: z.string().max(200).optional() }), req.body);
    const fleet = await db.query('SELECT id FROM fleets WHERE id = $1 AND org_id = $2', [b.fleetId, orgId]);
    if (!fleet.rows[0]) throw notFound('fleet not found');
    const r = await withTx(db, async (tx) => {
      const v = await tx.query('INSERT INTO vehicles (org_id, fleet_id, label, make_model) VALUES ($1,$2,$3,$4) RETURNING *', [orgId, b.fleetId, b.label, b.makeModel ?? null]);
      await audit(tx, actorOf(req), 'vehicle.created', { type: 'vehicle', id: v.rows[0].id, orgId }, b);
      return v.rows[0];
    });
    reply.code(201);
    return r;
  });

  app.get('/v1/orgs/:orgId/drivers', async (req) => {
    const { orgId } = parse(orgParams, req.params);
    await fleetOrg(db, orgId);
    await authorize(db, req, 'fleet.read', orgId);
    const r = await db.query(
      `SELECT d.id, d.fleet_id, d.eligibility_status, d.created_at, u.display_name FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.org_id = $1 ORDER BY u.display_name`,
      [orgId],
    );
    return { items: r.rows };
  });

  /** Register an existing member (holding the driver role in this org) as a driver in a fleet. */
  app.post('/v1/orgs/:orgId/drivers', async (req, reply) => {
    const { orgId } = parse(orgParams, req.params);
    await fleetOrg(db, orgId);
    await authorize(db, req, 'fleet.manage', orgId);
    const b = parse(z.object({ userId: uuid, fleetId: uuid }), req.body);
    const ok = await db.query(
      `SELECT 1 FROM memberships m JOIN fleets f ON f.org_id = m.org_id AND f.id = $3 WHERE m.user_id = $1 AND m.org_id = $2 AND m.role_code = 'driver' AND m.status = 'ACTIVE'`,
      [b.userId, orgId, b.fleetId],
    );
    if (!ok.rows[0]) throw notFound('user is not a driver member of this organization, or fleet not found');
    const r = await withTx(db, async (tx) => {
      const d = await tx.query('INSERT INTO drivers (org_id, fleet_id, user_id) VALUES ($1,$2,$3) RETURNING *', [orgId, b.fleetId, b.userId]);
      await audit(tx, actorOf(req), 'driver.registered', { type: 'driver', id: d.rows[0].id, orgId }, b);
      return d.rows[0];
    });
    reply.code(201);
    return r;
  });

  /**
   * Eligibility gates pool earnings. Only platform staff may mark a driver ELIGIBLE, because it depends on
   * subscription status, signed participation terms and payout onboarding (DECISIONS.md D-012).
   */
  app.post('/v1/orgs/:orgId/drivers/:driverId/eligibility', async (req) => {
    const { orgId, driverId } = parse(z.object({ orgId: uuid, driverId: uuid }), req.params);
    await fleetOrg(db, orgId);
    const auth = await authorize(db, req, 'fleet.manage', orgId);
    const b = parse(z.object({ status: z.enum(['PENDING', 'ELIGIBLE', 'SUSPENDED', 'TERMINATED']), reason: z.string().min(5).max(500) }), req.body);
    if (b.status === 'ELIGIBLE' && !auth.memberships.some((m) => m.orgKind === 'PLATFORM')) throw forbidden('only platform staff can mark a driver eligible');
    return withTx(db, async (tx) => {
      const d = await tx.query('UPDATE drivers SET eligibility_status = $3 WHERE id = $1 AND org_id = $2 RETURNING id, eligibility_status', [driverId, orgId, b.status]);
      if (!d.rows[0]) throw notFound('driver not found');
      await audit(tx, actorOf(req), 'driver.eligibility_changed', { type: 'driver', id: driverId, orgId }, b);
      return d.rows[0];
    });
  });
}
