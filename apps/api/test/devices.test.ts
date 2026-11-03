import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTablet, org, setupApp, userWithRole, type Ctx } from './helpers.js';

let ctx: Ctx;
let orgId: string;
let admin: Awaited<ReturnType<typeof userWithRole>>;
beforeAll(async () => {
  ctx = await setupApp();
  orgId = await org(ctx.db, 'FLEET_OPERATOR');
  admin = await userWithRole(ctx, orgId, 'fleet_admin');
});
afterAll(async () => { await ctx.app.close(); await ctx.db.end(); });

async function enroll(): Promise<FakeTablet> {
  const code = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/devices/enrollment-codes`, headers: admin.h, payload: { label: 'tablet' } })).json().code;
  const t = new FakeTablet(ctx.app);
  const r = await ctx.app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { code, serial: t.serial, publicKey: t.publicKeyB64, appVersion: '0.1.0' } });
  expect(r.statusCode).toBe(201);
  t.deviceId = r.json().deviceId;
  return t;
}

describe('device enrollment and signed requests', () => {
  it('enrollment codes are single-use', async () => {
    const code = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/devices/enrollment-codes`, headers: admin.h, payload: {} })).json().code;
    const t1 = new FakeTablet(ctx.app), t2 = new FakeTablet(ctx.app);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { code, serial: t1.serial, publicKey: t1.publicKeyB64, appVersion: '1' } })).statusCode).toBe(201);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { code, serial: t2.serial, publicKey: t2.publicKeyB64, appVersion: '1' } })).statusCode).toBe(401);
  });

  it('accepts a valid signed heartbeat and records health', async () => {
    const t = await enroll();
    const r = await t.call('POST', '/v1/devices/heartbeat', { appVersion: '0.1.1', storageFreeBytes: 1_000_000, connectivity: 'CELLULAR' });
    expect(r.statusCode).toBe(200);
    expect(r.json().playbackAllowed).toBe(true);
    const list = await ctx.app.inject({ method: 'GET', url: `/v1/orgs/${orgId}/devices`, headers: admin.h });
    const d = list.json().items.find((x: any) => x.id === t.deviceId);
    expect(d.app_version).toBe('0.1.1');
    expect(d.online).toBe(true);
  });

  it('rejects replayed nonces, tampered bodies, foreign keys and clock skew', async () => {
    const t = await enroll();
    const ok = await t.call('POST', '/v1/devices/heartbeat', { appVersion: '1' }, { nonce: 'fixed-nonce-0000001' });
    expect(ok.statusCode).toBe(200);
    expect((await t.call('POST', '/v1/devices/heartbeat', { appVersion: '1' }, { nonce: 'fixed-nonce-0000001' })).json().error.message).toMatch(/replay/);

    const body = JSON.stringify({ appVersion: '1' });
    const headers = t.signedHeaders('POST', '/v1/devices/heartbeat', body);
    const tampered = await ctx.app.inject({ method: 'POST', url: '/v1/devices/heartbeat', headers, payload: JSON.stringify({ appVersion: '2' }) });
    expect(tampered.json().error.message).toMatch(/signature/);

    const impostor = new FakeTablet(ctx.app); impostor.deviceId = t.deviceId;
    expect((await impostor.call('POST', '/v1/devices/heartbeat', { appVersion: '1' })).statusCode).toBe(401);

    expect((await t.call('POST', '/v1/devices/heartbeat', { appVersion: '1' }, { ts: Math.floor(Date.now() / 1000) - 3600 })).json().error.message).toMatch(/skew/);
  });

  it('accepts hardware-backed ECDSA P-256 tablet keys (Android Keystore) and refuses other key types', async () => {
    const code = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/devices/enrollment-codes`, headers: admin.h, payload: {} })).json().code;
    const t = new FakeTablet(ctx.app, undefined, 'p256');
    const r = await ctx.app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { code, serial: t.serial, publicKey: t.publicKeyB64, appVersion: 'android-shell' } });
    expect(r.statusCode).toBe(201);
    t.deviceId = r.json().deviceId;
    expect((await t.call('POST', '/v1/devices/heartbeat', { appVersion: 'android-shell' })).statusCode).toBe(200);
    const impostor = new FakeTablet(ctx.app, undefined, 'p256'); impostor.deviceId = t.deviceId;
    expect((await impostor.call('POST', '/v1/devices/heartbeat', { appVersion: 'x' })).statusCode).toBe(401);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const code2 = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/devices/enrollment-codes`, headers: admin.h, payload: {} })).json().code;
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { code: code2, serial: `SN-RSA-${t.serial}`, publicKey: rsa, appVersion: 'x' } })).statusCode).toBe(400);
  });

  it('remote suspend stops playback and commands are delivered then acknowledged', async () => {
    const t = await enroll();
    const cmd = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/devices/${t.deviceId}/commands`, headers: admin.h, payload: { command: 'SUSPEND' } });
    expect(cmd.statusCode).toBe(201);
    const hb = (await t.call('POST', '/v1/devices/heartbeat', { appVersion: '1' })).json();
    expect(hb.playbackAllowed).toBe(false);
    expect(hb.commands.map((c: any) => c.command)).toEqual(['SUSPEND']);
    const ack = await t.call('POST', `/v1/devices/commands/${cmd.json().id}/ack`, { ok: true });
    expect(ack.json().status).toBe('ACKED');
    expect((await t.call('POST', '/v1/devices/heartbeat', { appVersion: '1' })).json().commands).toEqual([]);
  });

  it('a device holds one active vehicle assignment at a time', async () => {
    const t = await enroll();
    const fleet = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/fleets`, headers: admin.h, payload: { name: `F-${t.serial}`, market: 'M', timezone: 'UTC' } })).json();
    const v1 = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/vehicles`, headers: admin.h, payload: { fleetId: fleet.id, label: 'V1' } })).json();
    const v2 = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/vehicles`, headers: admin.h, payload: { fleetId: fleet.id, label: 'V2' } })).json();
    const a1 = await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/devices/${t.deviceId}/assignments`, headers: admin.h, payload: { vehicleId: v1.id } });
    expect(a1.statusCode, a1.body).toBe(201);
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/devices/${t.deviceId}/assignments`, headers: admin.h, payload: { vehicleId: v2.id } })).statusCode).toBe(201);
    const active = await ctx.db.query('SELECT vehicle_id FROM device_assignments WHERE device_id = $1 AND ends_at IS NULL', [t.deviceId]);
    expect(active.rows).toEqual([{ vehicle_id: v2.id }]);
    // DB exclusion constraint backs this up even if application code is bypassed.
    await expect(ctx.db.query(`INSERT INTO device_assignments (org_id, device_id, vehicle_id, created_by) VALUES ($1,$2,$3,$4)`, [orgId, t.deviceId, v1.id, admin.userId])).rejects.toThrow(/conflicting key|exclusion/);
  });
});

describe('fleet portal device management', () => {
  const inj = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, h = admin.h) => ctx.app.inject({ method, url, headers: h, payload: payload as any });

  it('lists enrollment codes without revealing them, and revokes unused codes', async () => {
    const c = (await inj('POST', `/v1/orgs/${orgId}/devices/enrollment-codes`, { label: 'van 7' })).json();
    const list = (await inj('GET', `/v1/orgs/${orgId}/devices/enrollment-codes`)).json().items;
    const row = list.find((x: any) => x.id === c.id);
    expect(row).toMatchObject({ label: 'van 7', state: 'ACTIVE' });
    expect(JSON.stringify(list)).not.toContain(c.code);
    expect((await inj('POST', `/v1/orgs/${orgId}/devices/enrollment-codes/${c.id}/revoke`)).statusCode).toBe(200);
    const t = new FakeTablet(ctx.app);
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { code: c.code, serial: t.serial, publicKey: t.publicKeyB64, appVersion: '1' } })).statusCode).toBe(401);
    expect((await inj('POST', `/v1/orgs/${orgId}/devices/enrollment-codes/${c.id}/revoke`)).statusCode).toBe(404);
  });

  it('shows key type, vehicle, pending commands and command history; relabels and unassigns', async () => {
    const t = await enroll();
    const fleet = (await inj('POST', `/v1/orgs/${orgId}/fleets`, { name: 'F', market: 'M', timezone: 'UTC' })).json().id;
    const vehicle = (await inj('POST', `/v1/orgs/${orgId}/vehicles`, { fleetId: fleet, label: 'CAB-9' })).json().id;
    await inj('POST', `/v1/orgs/${orgId}/devices/${t.deviceId}/assignments`, { vehicleId: vehicle });
    await inj('POST', `/v1/orgs/${orgId}/devices/${t.deviceId}/commands`, { command: 'REFRESH_PLAYBACK' });
    expect((await inj('PATCH', `/v1/orgs/${orgId}/devices/${t.deviceId}`, { label: 'Back seat left' })).statusCode).toBe(200);
    const d = (await inj('GET', `/v1/orgs/${orgId}/devices`)).json().items.find((x: any) => x.id === t.deviceId);
    expect(d).toMatchObject({ label: 'Back seat left', vehicle_label: 'CAB-9', pending_commands: 1, keyType: 'ED25519' });
    expect(d.public_key_der).toBeUndefined();
    const hist = (await inj('GET', `/v1/orgs/${orgId}/devices/${t.deviceId}/commands`)).json().items;
    expect(hist[0]).toMatchObject({ command: 'REFRESH_PLAYBACK', status: 'PENDING' });
    expect((await inj('POST', `/v1/orgs/${orgId}/devices/${t.deviceId}/unassign`)).statusCode).toBe(200);
    expect((await inj('GET', `/v1/orgs/${orgId}/devices`)).json().items.find((x: any) => x.id === t.deviceId).vehicle_id).toBeNull();
  });

  it('retiring a tablet stops its key immediately and frees the serial for re-enrollment', async () => {
    const t = await enroll();
    expect((await inj('POST', `/v1/orgs/${orgId}/devices/${t.deviceId}/retire`, { reason: 'x' })).statusCode).toBe(400);
    expect((await inj('POST', `/v1/orgs/${orgId}/devices/${t.deviceId}/retire`, { reason: 'stolen from vehicle' })).statusCode).toBe(200);
    expect((await t.call('POST', '/v1/devices/heartbeat', { appVersion: '1' })).statusCode).toBe(401);
    expect((await inj('POST', `/v1/orgs/${orgId}/devices/${t.deviceId}/commands`, { command: 'RESUME' })).statusCode).toBe(409);
    const code = (await inj('POST', `/v1/orgs/${orgId}/devices/enrollment-codes`, {})).json().code;
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/devices/enroll', payload: { code, serial: t.serial, publicKey: t.publicKeyB64, appVersion: '1' } })).statusCode).toBe(201);
  });

  it('viewers can see devices but cannot manage them; other fleets cannot see them', async () => {
    const viewer = await userWithRole(ctx, orgId, 'fleet_viewer');
    expect((await inj('GET', `/v1/orgs/${orgId}/devices`, undefined, viewer.h)).statusCode).toBe(200);
    expect((await inj('GET', `/v1/orgs/${orgId}/devices/enrollment-codes`, undefined, viewer.h)).statusCode).toBe(403);
    expect((await inj('POST', `/v1/orgs/${orgId}/devices/enrollment-codes`, {}, viewer.h)).statusCode).toBe(403);
    const other = await org(ctx.db, 'FLEET_OPERATOR');
    const otherAdmin = await userWithRole(ctx, other, 'fleet_admin');
    expect((await inj('GET', `/v1/orgs/${orgId}/devices`, undefined, otherAdmin.h)).statusCode).toBe(403);
  });
});
