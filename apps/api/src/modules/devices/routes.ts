import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { randomBytes } from 'node:crypto';
import { deviceKeyType, deviceSigningPayload, parseDevicePublicKey, randomToken, sha256hex, verifyDeviceSignature } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';
import { loadOrg } from '../orgs/routes.js';
import { endTabletSessions } from '../riders/routes.js';
import { AttestationError, googleAttestationTrust, verifyAttestation, type AttestationTrust } from './attestation.js';

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

export async function deviceRoutes(app: FastifyInstance, { db, config, attestationTrust }: { db: Db; config: Config; attestationTrust?: AttestationTrust }) {
  const trust = attestationTrust ?? googleAttestationTrust();
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

  app.get('/v1/orgs/:orgId/devices/enrollment-codes', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await fleetOrg(orgId);
    await authorize(db, req, 'device.manage', orgId);
    const r = await db.query(
      `SELECT c.id, c.label, c.created_at, c.expires_at, c.used_at, c.device_id, d.serial AS device_serial,
              CASE WHEN c.used_at IS NOT NULL THEN 'USED' WHEN c.expires_at <= now() THEN 'EXPIRED' ELSE 'ACTIVE' END AS state
         FROM device_enrollment_codes c LEFT JOIN devices d ON d.id = c.device_id
        WHERE c.org_id = $1 AND c.created_at > now() - interval '7 days' ORDER BY c.created_at DESC LIMIT 50`,
      [orgId],
    );
    return { items: r.rows };
  });

  app.post('/v1/orgs/:orgId/devices/enrollment-codes/:codeId/revoke', async (req) => {
    const { orgId, codeId } = parse(z.object({ orgId: uuid, codeId: uuid }), req.params);
    await fleetOrg(orgId);
    await authorize(db, req, 'device.manage', orgId);
    const r = await db.query(`UPDATE device_enrollment_codes SET expires_at = now() WHERE id = $1 AND org_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING id`, [codeId, orgId]);
    if (!r.rows[0]) throw notFound('active enrollment code not found');
    await audit(db, actorOf(req), 'device.enrollment_code_revoked', { type: 'enrollment_code', id: codeId, orgId });
    return { revoked: true };
  });

  app.get('/v1/orgs/:orgId/devices', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await fleetOrg(orgId);
    await authorize(db, req, 'device.read', orgId);
    const r = await db.query(
      `SELECT d.id, d.serial, d.label, d.status, d.app_version, d.os_version, d.storage_free_bytes, d.connectivity, d.last_heartbeat_at, d.last_sync_at, d.enrolled_at,
              d.attestation_status, d.attestation_security_level, d.attestation_boot_state, d.attested_at,
              d.public_key_der, a.vehicle_id, v.label AS vehicle_label, a.driver_id, (d.last_heartbeat_at > now() - interval '10 minutes') AS online,
              (SELECT count(*)::int FROM device_commands c WHERE c.device_id = d.id AND c.status IN ('PENDING','DELIVERED')) AS pending_commands
         FROM devices d LEFT JOIN device_assignments a ON a.device_id = d.id AND a.ends_at IS NULL LEFT JOIN vehicles v ON v.id = a.vehicle_id
        WHERE d.org_id = $1 ORDER BY d.serial`,
      [orgId],
    );
    // keyType tells operators whether the tablet runs the Android shell (Keystore key) or the plain web player (R-028).
    return { items: r.rows.map(({ public_key_der, ...d }) => ({ ...d, keyType: deviceKeyType(public_key_der) })) };
  });

  app.patch('/v1/orgs/:orgId/devices/:deviceId', async (req) => {
    const { orgId, deviceId } = parse(z.object({ orgId: uuid, deviceId: uuid }), req.params);
    await fleetOrg(orgId);
    await authorize(db, req, 'device.manage', orgId);
    const b = parse(z.object({ label: z.string().trim().max(100) }), req.body);
    const r = await db.query('UPDATE devices SET label = $3 WHERE id = $1 AND org_id = $2 RETURNING id, label', [deviceId, orgId, b.label || null]);
    if (!r.rows[0]) throw notFound('device not found');
    await audit(db, actorOf(req), 'device.relabeled', { type: 'device', id: deviceId, orgId }, b);
    return r.rows[0];
  });

  app.get('/v1/orgs/:orgId/devices/:deviceId/commands', async (req) => {
    const { orgId, deviceId } = parse(z.object({ orgId: uuid, deviceId: uuid }), req.params);
    await fleetOrg(orgId);
    await authorize(db, req, 'device.read', orgId);
    const r = await db.query(
      `SELECT c.id, c.command, c.status, c.created_at, c.delivered_at, c.acked_at, u.display_name AS issued_by
         FROM device_commands c JOIN users u ON u.id = c.created_by WHERE c.device_id = $1 AND c.org_id = $2 ORDER BY c.created_at DESC LIMIT 20`,
      [deviceId, orgId],
    );
    return { items: r.rows };
  });

  /** Unassign: the tablet stops getting a playlist (no vehicle) until reassigned. */
  app.post('/v1/orgs/:orgId/devices/:deviceId/unassign', async (req) => {
    const { orgId, deviceId } = parse(z.object({ orgId: uuid, deviceId: uuid }), req.params);
    await fleetOrg(orgId);
    await authorize(db, req, 'device.manage', orgId);
    return withTx(db, async (tx) => {
      const r = await tx.query('UPDATE device_assignments SET ends_at = now() WHERE device_id = $1 AND org_id = $2 AND ends_at IS NULL RETURNING id', [deviceId, orgId]);
      if (!r.rows[0]) throw notFound('device has no current assignment');
      await endTabletSessions(tx, deviceId);
      await audit(tx, actorOf(req), 'device.unassigned', { type: 'device', id: deviceId, orgId });
      return { unassigned: true };
    });
  });

  /** Retire a lost, replaced or broken tablet: its key stops working immediately and the serial can be re-enrolled. */
  app.post('/v1/orgs/:orgId/devices/:deviceId/retire', async (req) => {
    const { orgId, deviceId } = parse(z.object({ orgId: uuid, deviceId: uuid }), req.params);
    await fleetOrg(orgId);
    await authorize(db, req, 'device.manage', orgId);
    const b = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    return withTx(db, async (tx) => {
      const r = await tx.query(`UPDATE devices SET status = 'RETIRED', serial = serial || '#retired-' || substr(id::text, 1, 8) WHERE id = $1 AND org_id = $2 AND status <> 'RETIRED' RETURNING id`, [deviceId, orgId]);
      if (!r.rows[0]) throw notFound('active device not found');
      await tx.query('UPDATE device_assignments SET ends_at = now() WHERE device_id = $1 AND ends_at IS NULL', [deviceId]);
      await tx.query(`UPDATE device_commands SET status = 'EXPIRED' WHERE device_id = $1 AND status IN ('PENDING','DELIVERED')`, [deviceId]);
      await endTabletSessions(tx, deviceId);
      await audit(tx, actorOf(req), 'device.retired', { type: 'device', id: deviceId, orgId }, b);
      return { retired: true };
    });
  });

  app.post('/v1/orgs/:orgId/devices/:deviceId/assignments', async (req, reply) => {
    const { orgId, deviceId } = parse(z.object({ orgId: uuid, deviceId: uuid }), req.params);
    await fleetOrg(orgId);
    const auth = await authorize(db, req, 'device.manage', orgId);
    const b = parse(z.object({ vehicleId: uuid, driverId: uuid.optional() }), req.body);
    const r = await withTx(db, async (tx) => {
      const dev = await tx.query(`SELECT id FROM devices WHERE id = $1 AND org_id = $2 AND status <> 'RETIRED' FOR UPDATE`, [deviceId, orgId]);
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

  /** Fleet security policy: verified tablets only (D-059). Turning it on affects new enrollments; existing tablets are listed, not cut off. */
  app.get('/v1/orgs/:orgId/devices/policy', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await fleetOrg(orgId);
    await authorize(db, req, 'device.read', orgId);
    const r = await db.query(
      `SELECT o.require_hardware_attestation,
              (SELECT count(*)::int FROM devices d WHERE d.org_id = o.id AND d.status <> 'RETIRED' AND d.attestation_status <> 'VERIFIED') AS unverified_tablets
         FROM organizations o WHERE o.id = $1`, [orgId]);
    return { requireHardwareAttestation: r.rows[0].require_hardware_attestation, networkMode: config.DEVICE_ATTESTATION, unverifiedTablets: r.rows[0].unverified_tablets };
  });

  app.put('/v1/orgs/:orgId/devices/policy', async (req) => {
    const { orgId } = parse(z.object({ orgId: uuid }), req.params);
    await fleetOrg(orgId);
    await authorize(db, req, 'device.manage', orgId);
    const b = parse(z.object({ requireHardwareAttestation: z.boolean() }), req.body);
    await withTx(db, async (tx) => {
      await tx.query('UPDATE organizations SET require_hardware_attestation = $2 WHERE id = $1', [orgId, b.requireHardwareAttestation]);
      await audit(tx, actorOf(req), 'device.policy_changed', { type: 'organization', id: orgId, orgId }, b);
    });
    return { requireHardwareAttestation: b.requireHardwareAttestation };
  });

  // ----- tablet side -----
  /** Step 1 for tablets that can prove a hardware key (Android shell): a fresh, single-use challenge bound to the code. */
  app.post('/v1/devices/enroll/challenge', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ code: z.string().min(10).max(100) }), req.body);
    const challenge = randomBytes(32);
    const r = await db.query(
      `UPDATE device_enrollment_codes SET attestation_challenge = $2, challenge_expires_at = now() + interval '10 minutes'
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING challenge_expires_at`,
      [sha256hex(b.code), challenge],
    );
    if (!r.rows[0]) throw unauthorized('invalid or expired enrollment code');
    return { challenge: challenge.toString('base64'), expiresAt: r.rows[0].challenge_expires_at };
  });

  app.post('/v1/devices/enroll', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = parse(z.object({
      code: z.string().min(10).max(100), serial: z.string().min(3).max(100), publicKey: z.string().min(40).max(200),
      appVersion: z.string().max(50), osVersion: z.string().max(100).optional(),
      attestation: z.object({ chain: z.array(z.string().min(100).max(16_000)).min(2).max(10) }).optional(),
    }), req.body);
    let der: Buffer;
    try { der = parseDevicePublicKey(b.publicKey); } catch { throw badRequest('publicKey must be a base64 DER SPKI Ed25519 or ECDSA P-256 key'); }
    const mode = config.DEVICE_ATTESTATION;
    if (b.attestation && mode !== 'off') await trust.revokedSerials(); // warm the revocation-list cache outside the transaction
    const out = await withTx(db, async (tx) => {
      const c = await tx.query(
        `SELECT id, org_id, label, attestation_challenge, challenge_expires_at > now() AS challenge_live
           FROM device_enrollment_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256hex(b.code)]);
      const code = c.rows[0];
      if (!code) throw unauthorized('invalid or expired enrollment code');
      const exists = await tx.query('SELECT 1 FROM devices WHERE serial = $1', [b.serial]);
      if (exists.rows[0]) throw conflict('a device with this serial is already enrolled; retire it first');
      // Verified tablets only: network-wide (DEVICE_ATTESTATION=required) or chosen by this fleet (D-059).
      const fleetRequires = (await tx.query('SELECT require_hardware_attestation FROM organizations WHERE id = $1', [code.org_id])).rows[0]?.require_hardware_attestation === true;
      const required = mode === 'required' || (fleetRequires && mode !== 'off');
      const who = mode === 'required' ? 'This network' : 'This fleet';
      if (required && !b.attestation) throw forbidden(`${who} only accepts tablets that prove a hardware key. Install the Ride Screen Android app on this tablet.`, 'HARDWARE_ATTESTATION_REQUIRED');

      // Hardware attestation (R-028). The challenge is consumed with the code, so a chain can never be replayed.
      let att: { status: string; level: string | null; boot: string | null; failure: string | null } = { status: 'NONE', level: null, boot: null, failure: null };
      if (b.attestation && mode !== 'off') {
        try {
          if (!code.attestation_challenge || !code.challenge_live) throw new AttestationError('no live challenge; request one from /v1/devices/enroll/challenge first');
          const r = await verifyAttestation({ chainB64: b.attestation.chain, publicKeyDer: der, challenge: code.attestation_challenge, trust });
          const trustedBoot = r.bootState === 'VERIFIED' && r.deviceLocked;
          att = { status: trustedBoot ? 'VERIFIED' : 'UNTRUSTED_BOOT', level: r.securityLevel, boot: `${r.bootState}${r.deviceLocked ? '' : ', unlocked'}`, failure: null };
        } catch (e) {
          if (!(e instanceof AttestationError)) throw e;
          att = { status: 'FAILED', level: null, boot: null, failure: e.reason.slice(0, 300) };
        }
        if (required && att.status !== 'VERIFIED') {
          throw forbidden(att.status === 'FAILED' ? `Hardware check failed: ${att.failure}` : `This tablet's bootloader is unlocked or its software is not verified. ${who} only accepts verified tablets.`, 'HARDWARE_ATTESTATION_REQUIRED');
        }
      }
      const d = await tx.query(
        `INSERT INTO devices (org_id, serial, label, public_key_der, app_version, os_version, enrolled_via,
                              attestation_status, attestation_security_level, attestation_boot_state, attestation_failure, attested_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $8 = 'NONE' THEN NULL ELSE now() END) RETURNING id, org_id`,
        [code.org_id, b.serial, code.label, der, b.appVersion, b.osVersion ?? null, code.id, att.status, att.level, att.boot, att.failure],
      );
      await tx.query('UPDATE device_enrollment_codes SET used_at = now(), device_id = $2, attestation_challenge = NULL WHERE id = $1', [code.id, d.rows[0].id]);
      await audit(tx, { deviceId: d.rows[0].id, requestId: req.id }, 'device.enrolled', { type: 'device', id: d.rows[0].id, orgId: d.rows[0].org_id },
        { serial: b.serial, appVersion: b.appVersion, attestation: att.status, securityLevel: att.level, bootState: att.boot, attestationFailure: att.failure });
      return { ...d.rows[0], attestation: att.status };
    });
    reply.code(201);
    return { deviceId: out.id, attestation: out.attestation };
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
