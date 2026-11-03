import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { deviceSigningPayload, parseDevicePublicKey, randomToken, sha256hex, verifyDeviceSignature } from '../../lib/crypto.js';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';
import { loadOrg } from '../orgs/routes.js';
import { endTabletSessions } from '../riders/routes.js';

/**
 * Verifies an Ed25519-signed device request:
 *   X-Device-Id, X-Device-Timestamp (unix seconds), X-Device-Nonce, X-Device-Signature (base64)
 * over METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body). Rejects clock skew and nonce replay.
 */
export async function authenticateDevice(db: Db, config: Config, req: FastifyRequest) {
  const id = req.headers['x-device-id'];
  const ts = req.headers['x-device-timestamp'];
  const nonce = req.headers['x-device-nonce'];
  const sig = req.headers['x-device-signature'];
  if (typeof id !== 'string' || typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') throw unauthorized('missing device signature headers');
  if (!z.string().uuid().safeParse(id).success || !/^\d{1,12}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw unauthorized('malformed device headers');
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (skew > config.DEVICE_CLOCK_SKEW_SECONDS) throw unauthorized('device clock skew too large; resync time');
  const d = await db.query('SELECT id, org_id, public_key_der, status FROM devices WHERE id = $1', [id]);
  const dev = d.rows[0];
  if (!dev || dev.status === 'RETIRED') throw unauthorized('unknown device');
  const path = req.url.split('?')[0]!;
  if (!verifyDeviceSignature(dev.public_key_der, deviceSigningPayload(req.method, path, ts, nonce, req.rawBody ?? ''), sig)) throw unauthorized('bad device signature');
  const n = await db.query('INSERT INTO device_nonces (device_id, nonce) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, nonce]);
  if (n.rowCount !== 1) throw unauthorized('replayed request');
  return { deviceId: dev.id as string, orgId: dev.org_id as string, status: dev.status as 'ACTIVE' | 'SUSPENDED', deviceTime: new Date(Number(ts) * 1000) };
}

export async function deviceRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  const fleetOrg = async (orgId: string) => {
    const org = await loadOrg(db, orgId);
    if (org.kind !== 'FLEET_OPERATOR') throw notFound('fleet operator not found');
  };

  // ----- operator / admin side -----
  app.post('/v1/orgs/:orgId/devices/enrollment-codes', async (req, reply) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await fleetOrg(orgId);
    const auth = await authorize(db, req, 'device.manage', orgId);
    const b = parse(z.object({ label: z.string().max(100).optional(), ttlMinutes: z.number().int().min(5).max(1440).default(30) }), req.body ?? {});
    const code = randomToken(18);
    const r = await withTx(db, async (tx) => {
      const c = await tx.query(
        `INSERT INTO device_enrollment_codes (org_id, code_hash, label, created_by, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5)) RETURNING id, expires_at`,
        [orgId, sha256hex(code), b.label ?? null, auth.userId, b.ttlMinutes],
      );
      await audit(tx, actorOf(req), 'device.enrollment_code_created', { type: 'enrollment_code', id: c.rows[0].id, orgId }, { label: b.label });
      return c.rows[0];
    });
    reply.code(201);
    return { id: r.id, code, expiresAt: r.expires_at, note: 'Shown once. Enter on the tablet during kiosk provisioning.' };
  });

  app.get('/v1/orgs/:orgId/devices', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await fleetOrg(orgId);
    await authorize(db, req, 'device.read', orgId);
    const r = await db.query(
      `SELECT d.id, d.serial, d.label, d.status, d.app_version, d.os_version, d.storage_free_bytes, d.connectivity, d.last_heartbeat_at, d.last_sync_at, d.enrolled_at,
              a.vehicle_id, a.driver_id, (d.last_heartbeat_at > now() - interval '10 minutes') AS online
         FROM devices d LEFT JOIN device_assignments a ON a.device_id = d.id AND a.ends_at IS NULL
        WHERE d.org_id = $1 ORDER BY d.serial`,
      [orgId],
    );
    return { items: r.rows };
  });

  app.post('/v1/orgs/:orgId/devices/:deviceId/assignments', async (req, reply) => {
    const { orgId, deviceId } = parse(z.object({ orgId: uuid, deviceId: uuid }), req.params);
    await fleetOrg(orgId);
    const auth = await authorize(db, req, 'device.manage', orgId);
    const b = parse(z.object({ vehicleId: uuid, driverId: uuid.optional() }), req.body);
    const r = await withTx(db, async (tx) => {
      const dev = await tx.query('SELECT id FROM devices WHERE id = $1 AND org_id = $2 FOR UPDATE', [deviceId, orgId]);
      if (!dev.rows[0]) throw notFound('device not found');
      const v = await tx.query('SELECT id FROM vehicles WHERE id = $1 AND org_id = $2', [b.vehicleId, orgId]);
      if (!v.rows[0]) throw notFound('vehicle not found');
      if (b.driverId) {
        const dr = await tx.query('SELECT id FROM drivers WHERE id = $1 AND org_id = $2', [b.driverId, orgId]);
        if (!dr.rows[0]) throw notFound('driver not found');
      }
      await tx.query('UPDATE device_assignments SET ends_at = now() WHERE device_id = $1 AND ends_at IS NULL', [deviceId]);
      await tx.query('UPDATE device_assignments SET ends_at = now() WHERE vehicle_id = $1 AND ends_at IS NULL', [b.vehicleId]);
      const a = await tx.query(
        'INSERT INTO device_assignments (org_id, device_id, vehicle_id, driver_id, created_by, starts_at) VALUES ($1,$2,$3,$4,$5, clock_timestamp()) RETURNING *',
        [orgId, deviceId, b.vehicleId, b.driverId ?? null, auth.userId],
      );
      await audit(tx, actorOf(req), 'device.assigned', { type: 'device', id: deviceId, orgId }, b);
      return a.rows[0];
    });
    reply.code(201);
    return r;
  });

  app.post('/v1/orgs/:orgId/devices/:deviceId/commands', async (req, reply) => {
    const { orgId, deviceId } = parse(z.object({ orgId: uuid, deviceId: uuid }), req.params);
    await fleetOrg(orgId);
    const auth = await authorize(db, req, 'device.command', orgId);
    const b = parse(z.object({ command: z.enum(['REFRESH_PLAYBACK', 'SUSPEND', 'RESUME', 'UPDATE_CONFIG', 'PURGE_RIDER_DATA']), payload: z.record(z.string(), z.unknown()).default({}) }), req.body);
    const r = await withTx(db, async (tx) => {
      const dev = await tx.query(`SELECT id, status FROM devices WHERE id = $1 AND org_id = $2 FOR UPDATE`, [deviceId, orgId]);
      if (!dev.rows[0]) throw notFound('device not found');
      if (dev.rows[0].status === 'RETIRED') throw conflict('device is retired');
      // Suspension takes effect server-side immediately; the command tells the tablet to stop playback.
      if (b.command === 'SUSPEND') await tx.query(`UPDATE devices SET status = 'SUSPENDED' WHERE id = $1`, [deviceId]);
      if (b.command === 'RESUME') await tx.query(`UPDATE devices SET status = 'ACTIVE' WHERE id = $1`, [deviceId]);
      if (b.command === 'PURGE_RIDER_DATA' || b.command === 'SUSPEND') await endTabletSessions(tx, deviceId);
      const c = await tx.query('INSERT INTO device_commands (org_id, device_id, command, payload, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [orgId, deviceId, b.command, JSON.stringify(b.payload), auth.userId]);
      await audit(tx, actorOf(req), 'device.command_issued', { type: 'device', id: deviceId, orgId }, { command: b.command, commandId: c.rows[0].id });
      return c.rows[0];
    });
    reply.code(201);
    return r;
  });

  // ----- tablet side -----
  app.post('/v1/devices/enroll', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(z.object({
      code: z.string().min(10).max(100), serial: z.string().min(3).max(100), publicKey: z.string().min(40).max(200),
      appVersion: z.string().max(50), osVersion: z.string().max(100).optional(),
    }), req.body);
    let der: Buffer;
    try { der = parseDevicePublicKey(b.publicKey); } catch { throw badRequest('publicKey must be a base64 DER SPKI Ed25519 or ECDSA P-256 key'); }
    const out = await withTx(db, async (tx) => {
      const c = await tx.query(`SELECT id, org_id, label FROM device_enrollment_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256hex(b.code)]);
      if (!c.rows[0]) throw unauthorized('invalid or expired enrollment code');
      const exists = await tx.query('SELECT 1 FROM devices WHERE serial = $1', [b.serial]);
      if (exists.rows[0]) throw conflict('a device with this serial is already enrolled; retire it first');
      const d = await tx.query(
        `INSERT INTO devices (org_id, serial, label, public_key_der, app_version, os_version, enrolled_via) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, org_id`,
        [c.rows[0].org_id, b.serial, c.rows[0].label, der, b.appVersion, b.osVersion ?? null, c.rows[0].id],
      );
      await tx.query('UPDATE device_enrollment_codes SET used_at = now(), device_id = $2 WHERE id = $1', [c.rows[0].id, d.rows[0].id]);
      await audit(tx, { deviceId: d.rows[0].id, requestId: req.id }, 'device.enrolled', { type: 'device', id: d.rows[0].id, orgId: d.rows[0].org_id }, { serial: b.serial, appVersion: b.appVersion });
      return d.rows[0];
    });
    reply.code(201);
    return { deviceId: out.id };
  });

  app.post('/v1/devices/heartbeat', async (req) => {
    const dev = await authenticateDevice(db, config, req);
    const b = parse(z.object({
      appVersion: z.string().max(50), osVersion: z.string().max(100).optional(), storageFreeBytes: z.number().int().nonnegative().optional(),
      connectivity: z.enum(['WIFI', 'CELLULAR', 'OFFLINE_RECOVERED', 'UNKNOWN']).default('UNKNOWN'), lastSyncAt: z.string().datetime().optional(),
      playback: z.object({ state: z.enum(['PLAYING', 'IDLE', 'SUSPENDED', 'ERROR']), itemId: z.string().max(100).optional() }).optional(),
    }), req.body);
    return withTx(db, async (tx) => {
      await tx.query(
        `UPDATE devices SET app_version = $2, os_version = coalesce($3, os_version), storage_free_bytes = $4, connectivity = $5, last_heartbeat_at = now(), last_sync_at = coalesce($6, last_sync_at) WHERE id = $1`,
        [dev.deviceId, b.appVersion, b.osVersion ?? null, b.storageFreeBytes ?? null, b.connectivity, b.lastSyncAt ?? null],
      );
      await tx.query('INSERT INTO device_heartbeats (device_id, device_time, payload) VALUES ($1,$2,$3)', [dev.deviceId, dev.deviceTime.toISOString(), JSON.stringify(b)]);
      const cmds = await tx.query(
        `UPDATE device_commands SET status = 'DELIVERED', delivered_at = coalesce(delivered_at, now()) WHERE device_id = $1 AND status IN ('PENDING','DELIVERED') RETURNING id, command, payload, created_at`,
        [dev.deviceId],
      );
      const status = (await tx.query('SELECT status FROM devices WHERE id = $1', [dev.deviceId])).rows[0].status;
      return { serverTime: new Date().toISOString(), deviceStatus: status, playbackAllowed: status === 'ACTIVE', commands: cmds.rows.sort((a, c) => +a.created_at - +c.created_at) };
    });
  });

  app.post('/v1/devices/commands/:commandId/ack', async (req) => {
    const dev = await authenticateDevice(db, config, req);
    const { commandId } = parse(z.object({ commandId: uuid }), req.params);
    const b = parse(z.object({ ok: z.boolean(), detail: z.string().max(500).optional() }), req.body);
    const r = await db.query(
      `UPDATE device_commands SET status = $3, acked_at = now(), result = $4 WHERE id = $1 AND device_id = $2 AND status IN ('PENDING','DELIVERED') RETURNING id, status`,
      [commandId, dev.deviceId, b.ok ? 'ACKED' : 'FAILED', JSON.stringify(b)],
    );
    if (!r.rows[0]) throw notFound('command not found');
    await audit(db, { deviceId: dev.deviceId, requestId: req.id }, 'device.command_acked', { type: 'device_command', id: commandId, orgId: dev.orgId }, b);
    return r.rows[0];
  });

}
