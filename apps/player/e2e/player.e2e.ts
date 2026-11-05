/**
 * End-to-end: real Chromium runs the built web player against the real API + PostgreSQL, with real ffmpeg media.
 * Run: npm run e2e -w @rmn/player   (uses database rmn_e2e; DROPS AND RECREATES its public schema)
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createRequire } from 'node:module';
// Use the environment's preinstalled Playwright (CommonJS resolution honours NODE_PATH); CI installs it explicitly.
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
import { buildApp } from '../../api/src/app.js';
import { loadConfig } from '../../api/src/config.js';
import { createPool, withTx } from '../../api/src/db/pool.js';
import { migrate } from '../../api/src/db/migrate.js';
import { hashPassword } from '../../api/src/lib/crypto.js';
import { postEntry } from '../../api/src/modules/ledger/service.js';
import { runValidation } from '../../api/src/modules/events/validator.js';
import { setProximityRandomForTests } from '../../api/src/modules/riders/proximity.js';

const PORT = 18080, BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_URL = process.env.E2E_ADMIN_DB ?? 'postgres://rmn:rmn@localhost:5432/rmn_test';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://rmn:rmn@localhost:5432/rmn_e2e';
const SHOTS = process.env.E2E_SCREENSHOTS ?? tmpdir();
const HERE = { latitude: 39.7817, longitude: -89.6501 };
const step = (s: string) => console.log(`  • ${s}`);
/** Poll an async condition from the test side (page.waitForFunction does not await async predicates). */
async function until(cond: () => Promise<boolean>, what: string, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`timed out waiting: ${what}`);
}

async function resetDb() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  if (!(await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'rmn_e2e'`)).rows[0]) await admin.query('CREATE DATABASE rmn_e2e');
  await admin.end();
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(DB_URL, () => {});
}

const mediaRoot = mkdtempSync(path.join(tmpdir(), 'rmn-e2e-media-'));
function makeVideo(seconds: number, color: string): string {
  const id = randomUUID();
  const dir = path.join(mediaRoot, 'assets', id);
  mkdirSync(dir, { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=${seconds}:r=24`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(dir, '720p.mp4')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180`, '-frames:v', '1', path.join(dir, 'thumb.jpg')]);
  return id;
}

/**
 * Stand-in for the Android shell's WebMessage bridge (apps/android BridgeProtocol): same JSON protocol, same payload
 * allow-list, ECDSA P-256 with DER signatures like the Keystore. The key is non-extractable inside the fake "native" side.
 */
const FAKE_ANDROID_BRIDGE = `(() => {
  const keyP = crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
  const PATTERN = /^(GET|POST)\\n\\/v1\\/devices\\/[A-Za-z0-9\\/_-]{1,200}\\n\\d{9,12}\\n[A-Za-z0-9_-]{16,64}\\n[0-9a-f]{64}$/;
  const der = (raw) => { // WebCrypto gives r||s; Android Keystore gives ASN.1 DER
    const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); return b[0] & 0x80 ? [0, ...b] : [...b]; };
    const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
    return new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s]);
  };
  window.__bridgeSignCalls = 0;
  const bridge = { onmessage: null, postMessage: async (msg) => {
    const m = JSON.parse(msg); let reply;
    try {
      const kp = await keyP;
      if (m.op === 'info') reply = { id: m.id, ok: true, result: { algorithm: 'ECDSA_P256', serial: 'AND-e2e0000001', hardwareBacked: false, shellVersion: '0.1.0',
        publicKey: b64(await crypto.subtle.exportKey('spki', kp.publicKey)) } };
      else if (m.op === 'sign') {
        const data = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
        if (data.length > 512 || !PATTERN.test(new TextDecoder().decode(data))) throw new Error('refused');
        window.__bridgeSignCalls++;
        reply = { id: m.id, ok: true, result: { signature: b64(der(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data)))) } };
      } else throw new Error('unknown op');
    } catch (e) { reply = { id: m.id, ok: false, error: String(e.message) }; }
    setTimeout(() => bridge.onmessage && bridge.onmessage({ data: JSON.stringify(reply) }), 0);
  } };
  window.RMNDevice = bridge;
})();`;

async function main() {
  console.log('player e2e');
  await resetDb();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'),
    MEDIA_BASE_URL: `${BASE}/media`, MEDIA_ROOT: mediaRoot, STRIPE_WEBHOOK_SECRET: 'whsec_e2e', LOG_LEVEL: 'silent', ALLOCATION_SETTLE_MINUTES: '0' });
  const db = createPool(DB_URL);
  const app = await buildApp({ config, db, logger: false });
  const serverErrors: string[] = [];
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 400 && !req.url.startsWith('/media')) serverErrors.push(`${req.method} ${req.url.split('?')[0]} ${reply.statusCode} ${String(payload).slice(0, 200)}`);
    return payload;
  });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(BASE + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const q = (sql: string, p: unknown[] = []) => db.query(sql, p).then((r) => r.rows);
  setProximityRandomForTests(() => 0);

  // ---------- fixtures (SYNTHETIC) ----------
  await q(`INSERT INTO accounting_periods (period_start, period_end) VALUES (date_trunc('year', now())::date, (date_trunc('year', now()) + interval '1 year - 1 day')::date)`);
  const pw = await hashPassword('e2e-password-123');
  const org = async (kind: string, name: string) => (await q('INSERT INTO organizations (kind, name, is_synthetic) VALUES ($1,$2,true) RETURNING id', [kind, name]))[0].id as string;
  const user = async (orgId: string, role: string) => {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
    const id = (await q('INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id', [email, pw, role]))[0].id;
    await q('INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,$3)', [id, orgId, role]);
    return { id, h: { authorization: `Bearer ${(await api('POST', '/v1/auth/login', { email, password: 'e2e-password-123' })).token}` } };
  };
  await org('PLATFORM', 'Platform');
  const fleetOrg = await org('FLEET_OPERATOR', 'Springfield Rides');
  const fleetAdmin = await user(fleetOrg, 'fleet_admin');
  const fleet = (await q(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'Main','Springfield','UTC') RETURNING id`, [fleetOrg]))[0].id;
  const vehicle = (await q(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,'UNIT-1') RETURNING id`, [fleetOrg, fleet]))[0].id;
  const adv = await org('ADVERTISER', 'Main Street Coffee');
  const advAdmin = await user(adv, 'advertiser_admin');
  await withTx(db, (tx) => postEntry(tx, { idempotencyKey: `fund-${adv}`, entryDate: new Date().toISOString().slice(0, 10), description: 'prepayment', sourceType: 'PAYMENT',
    lines: [{ accountCode: '1010', currency: 'USD', debit: 100_000n, processor: 'stripe-test' }, { accountCode: '2000', currency: 'USD', credit: 100_000n, partyType: 'ADVERTISER', partyId: adv }] }));
  const asset = async (orgId: string, seconds: number, color: string) => {
    const id = makeVideo(seconds, color);
    const up = (await q(`INSERT INTO media_uploads (org_id, purpose, filename, declared_type, size_bytes, sha256, received_bytes, status, detected_type, created_by, completed_at, processed_at)
                         VALUES ($1,$2,'f','video/mp4',1,$3,1,'READY','video/mp4',$4,now(),now()) RETURNING id`, [orgId, orgId === adv ? 'AD_CREATIVE' : 'CREATOR_VIDEO', '0'.repeat(64), advAdmin.id]))[0].id;
    await q(`INSERT INTO media_assets (id, upload_id, org_id, kind, duration_ms, rendition_key, thumbnail_key, probe) VALUES ($1,$2,$3,'VIDEO',$4,$5,$6,'{}')`, [id, up, orgId, seconds * 1000, `assets/${id}/720p.mp4`, `assets/${id}/thumb.jpg`]);
    return id;
  };
  const studio = await org('CREATOR_STUDIO', 'City Walks');
  const creator = (await q(`INSERT INTO creator_profiles (org_id, display_name, monetization_status) VALUES ($1,'City Walks','ELIGIBLE') RETURNING id`, [studio]))[0].id;
  const contentAsset = await asset(studio, 6, 'teal');
  const videoId = (await q(`INSERT INTO videos (creator_id, title, status, duration_ms, media_key, asset_id) VALUES ($1,'Downtown murals','APPROVED',6000,$2,$3) RETURNING id`, [creator, `assets/${contentAsset}/720p.mp4`, contentAsset]))[0].id;
  const adAsset = await asset(adv, 5, 'orange');
  const campaign = (await q(`INSERT INTO campaigns (advertiser_org_id, name, status, starts_at, ends_at, pricing_model, rate_minor, markets, destination_url, skip_delay_seconds)
                             VALUES ($1,'Morning latte','APPROVED', now() - interval '1 hour', now() + interval '1 day','CPQV',50,'{Springfield}','https://example.com/offer',2) RETURNING id`, [adv]))[0].id;
  await q(`INSERT INTO creatives (campaign_id, kind, status, duration_ms, media_key, asset_id, headline) VALUES ($1,'VIDEO','APPROVED',5000,$2,$3,'Fresh coffee')`, [campaign, `assets/${adAsset}/720p.mp4`, adAsset]);
  await q(`INSERT INTO creatives (campaign_id, kind, status, headline) VALUES ($1,'BANNER','APPROVED','2-for-1 lattes today')`, [campaign]);
  await api('POST', `/v1/orgs/${adv}/campaigns/${campaign}/commission-offers`, { name: '10%', kind: 'PERCENT_OF_SALE', rateBps: 1000, couponDescription: 'Free cookie',
    validFrom: new Date(Date.now() - 60_000).toISOString(), validTo: new Date(Date.now() + 86_400_000).toISOString() }, advAdmin.h);
  await api('POST', `/v1/orgs/${adv}/campaigns/${campaign}/geofences`, { name: 'Main St Cafe', message: 'Fresh coffee two blocks away', ...HERE, radiusM: 300 }, advAdmin.h);
  await api('POST', `/v1/orgs/${adv}/reward-programs`, { name: 'Trivia', rewardDescription: 'Free small coffee', faceValueMinor: 300, totalQuantity: 5, minScore: 2, gameSlug: 'city-trivia',
    startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() }, advAdmin.h);
  const riderEmail = `rider-${randomUUID().slice(0, 8)}@example.test`;
  await api('POST', '/v1/riders/register', { email: riderEmail, password: 'a long rider passphrase', displayName: 'Sam', birthYear: 1990, confirmAdult: true, termsVersion: 'RIDER_TERMS_V1' });
  const verify = /verify=([^\s&]+)/.exec((await q(`SELECT body_text FROM email_outbox WHERE to_email = $1`, [riderEmail]))[0].body_text)![1]!;
  await api('POST', '/v1/riders/verify-email', { token: decodeURIComponent(verify) });
  const riderH = { authorization: `Bearer ${(await api('POST', '/v1/riders/login', { email: riderEmail, password: 'a long rider passphrase' })).token}` };
  const { code } = await api('POST', `/v1/orgs/${fleetOrg}/devices/enrollment-codes`, {}, fleetAdmin.h);

  // ---------- browser ----------
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['geolocation'], geolocation: { latitude: 39.9, longitude: -89.65 } });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_NAME_NOT_RESOLVED|example\.com|net::ERR/.test(m.text())) problems.push(`console: ${m.text()}`); });
  try {
    await page.goto(`${BASE}/player/?fast=1`);
    step('enroll the tablet with a one-time code (Ed25519 key generated in the browser, non-extractable)');
    await page.fill('#code', code);
    await page.click('#setup-form button');
    await page.waitForSelector('#idle:has-text("Waiting for vehicle assignment")', { timeout: 15_000 });
    const deviceId = (await q(`SELECT id FROM devices WHERE serial LIKE 'WEB-%'`))[0].id;
    const extractable = await page.evaluate(() => new Promise<boolean>((res) => { const r = indexedDB.open('rmn-player'); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('keys'); g.onsuccess = () => res(g.result.privateKey.extractable); }; }));
    assert.equal(extractable, false, 'private key must be non-extractable');

    step('assign to a vehicle; content plays with a sponsored banner, then the video ad with a skip countdown');
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${deviceId}/assignments`, { vehicleId: vehicle }, fleetAdmin.h);
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${deviceId}/commands`, { command: 'REFRESH_PLAYBACK' }, fleetAdmin.h);
    await page.waitForSelector('#now:has-text("Downtown murals")', { timeout: 20_000 });
    await page.waitForSelector('#banner:not([hidden]):has-text("2-for-1 lattes today")', { timeout: 10_000 });
    await page.screenshot({ path: path.join(SHOTS, 'player-content.png') });
    await page.waitForSelector('#adui:not([hidden]) .skip', { timeout: 15_000 });
    assert.match((await page.textContent('#adui .skip'))!, /Skip in \d/);
    assert.equal(await page.textContent('#now'), 'Advertisement');
    await page.screenshot({ path: path.join(SHOTS, 'player-ad.png') });

    step('tap "Learn more": QR for the passenger phone, back to ride');
    await page.click('#adui button:has-text("Learn more")');
    await page.waitForSelector('#overlay:not([hidden]) svg.qr');
    await page.click('#overlay button:has-text("Back to ride")');

    step('rider signs in by QR from their phone');
    await page.click('#rider button');
    await page.waitForSelector('#pair-code');
    await api('POST', '/v1/riders/pair', { code: (await page.textContent('#pair-code'))! }, riderH);
    await page.waitForSelector('#rider-name:has-text("Hi Sam")', { timeout: 10_000 });

    step('claim a coupon from the banner/ad: saved to the rider wallet');
    await page.waitForSelector('#banner:not([hidden]) button, #adui:not([hidden]) button.primary', { timeout: 30_000 });
    await page.click('#banner:not([hidden]) button, #adui:not([hidden]) button.primary');
    await page.waitForSelector('#coupon-code');
    const coupon = (await page.textContent('#coupon-code'))!;
    await page.click('#overlay button:has-text("Back to ride")');
    const wallet = await api('GET', '/v1/riders/me/wallet', undefined, riderH);
    assert.ok(wallet.coupons.some((c: any) => c.code === coupon), 'coupon in wallet');

    step('play City Trivia (server-scored) and win the sponsor reward');
    await page.click('#games');
    await page.click('#overlay button:has-text("City Trivia")');
    await page.waitForSelector('#trivia');
    await page.waitForTimeout(5_500); // server rejects faster-than-human completion
    for (const [qi, ai] of [[0, 1], [1, 0], [2, 2]]) await page.check(`#trivia input[name=q${qi}][value="${ai}"]`);
    await page.click('#trivia button[type=submit]');
    await page.waitForSelector('#game-result:has-text("Score: 3")');
    assert.match((await page.textContent('#game-reward'))!, /Free small coffee/);
    await page.screenshot({ path: path.join(SHOTS, 'player-reward.png') });
    await page.click('#overlay button:has-text("Back to ride")');

    step('drive past the sponsor: a silent, passenger-only alert appears');
    await ctx.setGeolocation(HERE);
    await page.waitForSelector('#proximity-alert:has-text("Near your route")', { timeout: 20_000 });
    await page.screenshot({ path: path.join(SHOTS, 'player-proximity.png') });
    await page.click('#toast button:has-text("Dismiss")');

    step('the tablet keeps a local copy of its media and keeps playing with no connection (R-029)');
    await until(async () => (await page.evaluate(async () => (await (await caches.open('rmn-media-v1')).keys()).length)) >= 2, 'tablet cached its media');
    await ctx.setOffline(true);
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !!v && v.src.startsWith('blob:') && !v.paused && v.currentTime > 0.5; }, undefined, { timeout: 30_000 });
    await ctx.setOffline(false);

    step('fleet suspends the tablet, then resumes; purge clears the rider');
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${deviceId}/commands`, { command: 'SUSPEND' }, fleetAdmin.h);
    await page.waitForSelector('#idle:has-text("paused by the fleet operator")', { timeout: 10_000 });
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${deviceId}/commands`, { command: 'RESUME' }, fleetAdmin.h);
    await page.waitForSelector('#now:not(:empty)', { timeout: 15_000 });
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${deviceId}/commands`, { command: 'PURGE_RIDER_DATA' }, fleetAdmin.h);
    await page.waitForSelector('#rider button:has-text("Sign in for rewards")', { timeout: 10_000 });

    step('events uploaded from the browser queue validate server-side');
    await page.waitForTimeout(4_000);
    await runValidation(db);
    const ev = await q(`SELECT v.type, v.status, v.qualified, v.reasons, c.kind FROM validated_events v LEFT JOIN creatives c ON c.id = v.creative_id WHERE v.device_id = $1`, [deviceId]);
    const has = (pred: (e: any) => boolean, what: string) => assert.ok(ev.some(pred), `${what}: ${JSON.stringify(ev)}`);
    has((e) => e.type === 'CONTENT_PLAYBACK' && e.status === 'VALID' && e.qualified, 'qualified content view');
    has((e) => e.type === 'AD_PLAYBACK' && e.kind === 'VIDEO' && e.status === 'VALID' && e.qualified, 'qualified video ad view');
    has((e) => e.type === 'AD_PLAYBACK' && e.kind === 'BANNER' && e.status === 'VALID', 'banner impression');
    has((e) => e.type === 'CLICK' && e.status === 'VALID', 'valid click');
    // Expected rejections: a second click on the same campaign within 10 min, idle active segments, and a play that began
    // between the server-side suspension and the tablet learning of it at its next heartbeat (correctly not billable).
    const expectedInvalid = (e: any) => (e.type === 'CLICK' && e.reasons.includes('DUPLICATE_CLICK')) || e.type === 'ACTIVE_SEGMENT'
      || (e.reasons.length === 1 && e.reasons[0] === 'DEVICE_NOT_ACTIVE');
    const bad = ev.filter((e) => e.status !== 'VALID' && !expectedInvalid(e));
    assert.deepEqual(bad, [], 'no unexpected invalid events');
    step('when a campaign ends, the tablet deletes its cached copy of the ad (expiry enforcement)');
    const adKey = `assets/${adAsset}/720p.mp4`;
    const cachedKeys = () => page.evaluate(async () => (await (await caches.open('rmn-media-v1')).keys()).map((r) => decodeURIComponent(new URL(r.url).pathname.replace('/__media-cache/', ''))));
    assert.ok((await cachedKeys()).includes(adKey), 'ad cached while the campaign runs');
    await q(`UPDATE campaigns SET status = 'ENDED', ends_at = now() WHERE id = $1`, [campaign]);
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${deviceId}/commands`, { command: 'REFRESH_PLAYBACK' }, fleetAdmin.h);
    await until(async () => !(await cachedKeys()).includes(adKey), 'ended campaign media pruned');
    assert.ok(!(await cachedKeys()).includes(adKey), 'ended campaign media removed from the tablet');

    assert.deepEqual(problems, [], 'no page errors or CSP violations');

    step('Android shell: a tablet whose key lives in the native bridge (simulated Keystore ECDSA P-256) enrolls and plays');
    const { code: code2 } = await api('POST', `/v1/orgs/${fleetOrg}/devices/enrollment-codes`, {}, fleetAdmin.h);
    const vehicle2 = (await q(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,'UNIT-2') RETURNING id`, [fleetOrg, fleet]))[0].id;
    const shellCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await shellCtx.addInitScript(FAKE_ANDROID_BRIDGE);
    const shell = await shellCtx.newPage();
    shell.on('pageerror', (e) => problems.push(`shell pageerror: ${e.message}`));
    await shell.goto(`${BASE}/player/?fast=1`);
    await shell.fill('#code', code2);
    await shell.click('#setup-form button');
    await shell.waitForSelector('#idle:has-text("Waiting for vehicle assignment")', { timeout: 15_000 });
    const [andDev] = await q(`SELECT id, app_version, public_key_der, attestation_status FROM devices WHERE serial LIKE 'AND-%'`);
    assert.equal(andDev.attestation_status, 'NONE', 'a shell without the attest op (older version) still enrolls, unattested');
    assert.match(andDev.app_version, /\+android-/);
    assert.ok((await import('node:crypto')).createPublicKey({ key: andDev.public_key_der, format: 'der', type: 'spki' }).asymmetricKeyType === 'ec', 'device key is ECDSA');
    const signCalls = await shell.evaluate(() => (window as any).__bridgeSignCalls as number);
    assert.ok(signCalls > 0, 'requests signed through the native bridge');
    assert.equal(await shell.evaluate(() => new Promise((res) => { const r = indexedDB.open('rmn-player'); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('keys'); g.onsuccess = () => res(g.result); }; })), 'native', 'no key material in the web page');
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${andDev.id}/assignments`, { vehicleId: vehicle2 }, fleetAdmin.h);
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${andDev.id}/commands`, { command: 'REFRESH_PLAYBACK' }, fleetAdmin.h);
    await shell.waitForSelector('#now:not(:empty)', { timeout: 20_000 });
    assert.deepEqual(problems, [], 'no page errors in the shell page');
    await shellCtx.close();
    console.log(`  ✓ player e2e passed (${ev.length} events validated; screenshots in ${SHOTS})`);
  } finally {
    await page.screenshot({ path: path.join(SHOTS, 'player-final.png') }).catch(() => {});
    if (serverErrors.length) console.log('  server error responses:\n   ', [...new Set(serverErrors)].slice(0, 15).join('\n    '));
    await browser.close();
    await app.close();
    await db.end();
  }
}

main().catch((e) => { console.error('  ✗', e); process.exit(1); });
