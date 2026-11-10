import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize, requireAuth } from '../../auth/context.js';

export async function loadOrg(db: Db, orgId: string) {
  const r = await db.query('SELECT id, kind, name, status FROM organizations WHERE id = $1', [orgId]);
  if (!r.rows[0]) throw notFound('organization not found');
  return r.rows[0] as { id: string; kind: string; name: string; status: string };
}

export async function orgRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.post('/v1/orgs', async (req, reply) => {
    await authorize(db, req, 'platform.orgs.manage');
    const body = parse(z.object({ kind: z.enum(['FLEET_OPERATOR', 'ADVERTISER', 'CREATOR_STUDIO']), name: z.string().min(1).max(200) }), req.body);
    const r = await withTx(db, async (tx) => {
      const o = await tx.query('INSERT INTO organizations (kind, name) VALUES ($1,$2) RETURNING id, kind, name, status, created_at', [body.kind, body.name]);
      await audit(tx, actorOf(req), 'org.created', { type: 'organization', id: o.rows[0].id, orgId: o.rows[0].id }, body);
      return o.rows[0];
    });
    reply.code(201);
    return r;
  });

  /** Lists only organizations the caller belongs to, unless the caller holds a platform membership. */
  app.get('/v1/orgs', async (req) => {
    const auth = requireAuth(req);
    const isPlatform = auth.memberships.some((m) => m.orgKind === 'PLATFORM');
    const r = isPlatform
      ? await db.query('SELECT id, kind, name, status, created_at FROM organizations ORDER BY created_at')
      : await db.query('SELECT id, kind, name, status, created_at FROM organizations WHERE id = ANY($1::uuid[]) ORDER BY created_at', [auth.memberships.map((m) => m.orgId)]);
    return { items: r.rows };
  });

  /** Create (or reuse) a user and grant a role in the organization. */
  app.post('/v1/orgs/:orgId/members', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    const org = await loadOrg(db, orgId);
    const body = parse(z.object({
      email: z.string().email(), displayName: z.string().min(1).max(200), role: z.string(),
      initialPassword: z.string().min(12).max(200).optional(),
    }), req.body);
    // Granting platform roles, or acting outside one's own org, needs platform.users.manage (MFA).
    const auth = org.kind === 'PLATFORM' ? await authorize(db, req, 'platform.users.manage') : await authorize(db, req, 'org.members.manage', orgId);
    const isPlatformActor = auth.memberships.some((m) => m.orgKind === 'PLATFORM' && m.permissions.has('platform.users.manage'));
    const role = await db.query('SELECT code, org_kind FROM roles WHERE code = $1', [body.role]);
    if (!role.rows[0] || role.rows[0].org_kind !== org.kind) throw forbidden(`role ${body.role} cannot be granted in a ${org.kind} organization`);
    const out = await withTx(db, async (tx) => {
      let u = (await tx.query('SELECT id FROM users WHERE email = $1', [body.email])).rows[0];
      if (!u) {
        if (!body.initialPassword) throw forbidden('initialPassword is required for a new user');
        u = (await tx.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id', [body.email, await hashPassword(body.initialPassword), body.displayName])).rows[0];
        await audit(tx, actorOf(req), 'user.created', { type: 'user', id: u.id, orgId }, { email: body.email });
      } else if (!isPlatformActor) {
        // Tenant admins cannot attach (and thereby discover) users that already exist elsewhere.
        throw forbidden('existing users can only be added by platform administrators');
      }
      const m = await tx.query(
        `INSERT INTO memberships (user_id, org_id, role_code, created_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, org_id, role_code) DO UPDATE SET status = 'ACTIVE' RETURNING id`,
        [u.id, orgId, body.role, auth.userId],
      );
      await audit(tx, actorOf(req), 'membership.granted', { type: 'membership', id: m.rows[0].id, orgId }, { userId: u.id, role: body.role });
      return { userId: u.id, membershipId: m.rows[0].id };
    });
    reply.code(201);
    return out;
  });

  app.get('/v1/orgs/:orgId/members', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await loadOrg(db, orgId);
    await authorize(db, req, 'org.members.manage', orgId);
    const r = await db.query(
      `SELECT m.id, m.role_code AS role, m.status, u.id AS user_id, u.email, u.display_name, u.mfa_enabled FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND m.status = 'ACTIVE' ORDER BY u.display_name, u.email`,
      [orgId],
    );
    return { items: r.rows };
  });

  /** The role that keeps an organization manageable; the last active one can't be removed or demoted. */
  const ADMIN_ROLE: Record<string, string> = { PLATFORM: 'super_admin', FLEET_OPERATOR: 'fleet_admin', ADVERTISER: 'advertiser_admin', CREATOR_STUDIO: 'creator_owner' };

  /** Change a member's role or remove them. Never your own membership; never the last administrator. Audited. */
  const changeMembership = async (req: FastifyRequest, change: { role?: string; remove?: true }) => {
    const { orgId, membershipId } = parse(z.object({ orgId: uuid, membershipId: uuid }), req.params);
    const org = await loadOrg(db, orgId);
    const auth = org.kind === 'PLATFORM' ? await authorize(db, req, 'platform.users.manage') : await authorize(db, req, 'org.members.manage', orgId);
    if (change.role) {
      const role = (await db.query('SELECT org_kind FROM roles WHERE code = $1', [change.role])).rows[0];
      if (!role || role.org_kind !== org.kind) throw forbidden(`role ${change.role} cannot be granted in a ${org.kind} organization`);
    }
    return withTx(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['members:' + orgId]);
      const m = (await tx.query(`SELECT id, user_id, role_code FROM memberships WHERE id = $1 AND org_id = $2 AND status = 'ACTIVE' FOR UPDATE`, [membershipId, orgId])).rows[0];
      if (!m) throw notFound('active member not found');
      if (m.user_id === auth.userId) throw forbidden('you can’t change or remove your own role; ask another administrator', 'SELF_CHANGE');
      if (change.role === m.role_code) return { membershipId: m.id, role: m.role_code, unchanged: true };
      const admin = ADMIN_ROLE[org.kind];
      if (admin && m.role_code === admin) {
        const others = (await tx.query(`SELECT count(*)::int AS n FROM memberships mm JOIN users u ON u.id = mm.user_id
                                          WHERE mm.org_id = $1 AND mm.role_code = $2 AND mm.status = 'ACTIVE' AND u.status = 'ACTIVE' AND mm.id <> $3`, [orgId, admin, m.id])).rows[0].n;
        if (others === 0) throw conflict(`this is the last ${admin.replace(/_/g, ' ')}; add another one before changing or removing this person`);
      }
      await tx.query(`UPDATE memberships SET status = 'REVOKED' WHERE id = $1`, [m.id]);
      let newId: string | null = null;
      if (change.role) {
        newId = (await tx.query(
          `INSERT INTO memberships (user_id, org_id, role_code, created_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, org_id, role_code) DO UPDATE SET status = 'ACTIVE' RETURNING id`, [m.user_id, orgId, change.role, auth.userId])).rows[0].id;
      }
      await audit(tx, actorOf(req), change.role ? 'membership.role_changed' : 'membership.removed', { type: 'membership', id: m.id, orgId },
        { userId: m.user_id, from: m.role_code, to: change.role ?? null });
      return change.role ? { membershipId: newId, role: change.role } : { removed: true };
    });
  };

  app.patch('/v1/orgs/:orgId/members/:membershipId', async (req) => changeMembership(req, { role: parse(z.object({ role: z.string().min(1).max(50) }), req.body).role }));
  app.post('/v1/orgs/:orgId/members/:membershipId/remove', async (req) => changeMembership(req, { remove: true }));

  app.get('/v1/audit', async (req) => {
    await authorize(db, req, 'platform.audit.read');
    const q = parse(z.object({ orgId: uuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    const r = await db.query(
      `SELECT id, occurred_at, actor_user_id, actor_device_id, impersonator_user_id, org_id, action, target_type, target_id, details, hash
         FROM audit_log WHERE ($1::uuid IS NULL OR org_id = $1) ORDER BY id DESC LIMIT $2`,
      [q.orgId ?? null, q.limit],
    );
    return { items: r.rows };
  });
}
