/**
 * End-to-end: the rider phone web app in mobile Chromium against the real API + PostgreSQL, with a simulated
 * tablet signing its requests (Ed25519) exactly like a real one. Run: npm run e2e -w @rmn/rider (uses rmn_e2e).
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { buildApp } from '../../api/src/app.js';
import { loadConfig } from '../../api/src/config.js';
import { createPool } from '../../api/src/db/pool.js';
import { migrate } from '../../api/src/db/migrate.js';
import { hashPassword } from '../../api/src/lib/crypto.js';

const { chromium, devices } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const PORT = 18081, BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_URL = process.env.E2E_ADMIN_DB ?? 'postgres://rmn:rmn@localhost:5432/rmn_test';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://rmn:rmn@localhost:5432/rmn_e2e';
const SHOTS = process.env.E2E_SCREENSHOTS ?? tmpdir();
const step = (s: string) => console.log(`  • ${s}`);

class Tablet {
  id = '';
  private key: KeyObject;
  publicKey: string;
  constructor() { const kp = generateKeyPairSync('ed25519'); this.key = kp.privateKey; this.publicKey = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'); }
  async call(method: string, p: string, body?: unknown, extra: Record<string, string> = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(18).toString('base64url');
    const sig = sign(null, Buffer.from([method, p, ts, nonce, createHash('sha256').update(raw).digest('hex')].join('\n')), this.key).toString('base64');
    const r = await fetch(BASE + p, { method, body: raw || undefined, headers: { ...(raw ? { 'content-type': 'application/json' } : {}), 'x-device-id': this.id, 'x-device-timestamp': ts, 'x-device-nonce': nonce, 'x-device-signature': sig, ...extra } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
    return j;
  }
}

async function main() {
  console.log('rider web app e2e');
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  if (!(await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'rmn_e2e'`)).rows[0]) await admin.query('CREATE DATABASE rmn_e2e');
  await admin.end();
  const c = new pg.Client({ connectionString: DB_URL }); await c.connect(); await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
  await migrate(DB_URL, () => {});
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'),
    MEDIA_BASE_URL: `${BASE}/media`, STRIPE_WEBHOOK_SECRET: 'whsec_e2e', LOG_LEVEL: 'silent', APP_PUBLIC_URL: BASE });
  const db = createPool(DB_URL);
  const app = await buildApp({ config, db, logger: false });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const q = (sql: string, p: unknown[] = []) => db.query(sql, p).then((r) => r.rows);
  const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(BASE + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  /** The full one-time link from the newest email of a template, exactly as the rider would tap it. */
  const link = async (email: string, template: string, param: string) =>
    new RegExp(`https?://\\S+[?&]${param}=\\S+`).exec((await q(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY id DESC LIMIT 1`, [email, template]))[0].body_text)![0];

  // ---------- fixtures (SYNTHETIC): fleet, tablet, campaign with a coupon offer ----------
  await q(`INSERT INTO accounting_periods (period_start, period_end) VALUES (date_trunc('year', now())::date, (date_trunc('year', now()) + interval '1 year - 1 day')::date)`);
  const org = async (kind: string) => (await q('INSERT INTO organizations (kind, name, is_synthetic) VALUES ($1,$2,true) RETURNING id', [kind, `${kind} e2e`]))[0].id as string;
  const user = async (orgId: string, role: string) => {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
    const id = (await q('INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id', [email, await hashPassword('e2e-password-123'), role]))[0].id;
    await q('INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,$3)', [id, orgId, role]);
    return { id, h: { authorization: `Bearer ${(await api('POST', '/v1/auth/login', { email, password: 'e2e-password-123' })).token}` } };
  };
  await org('PLATFORM');
  const fleetOrg = await org('FLEET_OPERATOR');
  const fleetAdmin = await user(fleetOrg, 'fleet_admin');
  const fleet = (await q(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'Main','Springfield','UTC') RETURNING id`, [fleetOrg]))[0].id;
  const vehicle = (await q(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,'UNIT-1') RETURNING id`, [fleetOrg, fleet]))[0].id;
  const tablet = new Tablet();
  const { code } = await api('POST', `/v1/orgs/${fleetOrg}/devices/enrollment-codes`, {}, fleetAdmin.h);
  tablet.id = (await api('POST', '/v1/devices/enroll', { code, serial: `SIM-${randomUUID().slice(0, 8)}`, publicKey: tablet.publicKey, appVersion: 'sim' })).deviceId;
  await api('POST', `/v1/orgs/${fleetOrg}/devices/${tablet.id}/assignments`, { vehicleId: vehicle }, fleetAdmin.h);
  const adv = await org('ADVERTISER');
  const advAdmin = await user(adv, 'advertiser_admin');
  const campaign = (await q(`INSERT INTO campaigns (advertiser_org_id, name, status, starts_at, ends_at, pricing_model, rate_minor) VALUES ($1,'Main Street Coffee','APPROVED', now() - interval '1 hour', now() + interval '1 day','CPQV',50) RETURNING id`, [adv]))[0].id;
  const creative = (await q(`INSERT INTO creatives (campaign_id, kind, status, headline) VALUES ($1,'BANNER','APPROVED','Coffee') RETURNING id`, [campaign]))[0].id;
  await api('POST', `/v1/orgs/${adv}/campaigns/${campaign}/commission-offers`, { name: '10%', kind: 'PERCENT_OF_SALE', rateBps: 1000, couponDescription: 'Free cookie with any coffee',
    validFrom: new Date(Date.now() - 60_000).toISOString(), validTo: new Date(Date.now() + 86_400_000).toISOString() }, advAdmin.h);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) problems.push(`console: ${m.text()}`); });
  const email = `sam-${randomUUID().slice(0, 8)}@example.test`;
  try {
    step('create an account on the phone (adult attestation, terms)');
    await page.goto(`${BASE}/rider/`);
    await page.click('button[role=tab]:has-text("Create account")');
    await page.fill('#register [name=displayName]', 'Sam');
    await page.fill('#register [name=email]', email);
    await page.fill('#register [name=password]', 'a long rider passphrase');
    // Show/Hide on password boxes, so riders can check what they typed on a phone keyboard.
    await page.click('#register button.pw-toggle');
    assert.equal(await page.getAttribute('#register [name=password]', 'type'), 'text');
    assert.equal(await page.inputValue('#register [name=password]'), 'a long rider passphrase');
    await page.click('#register button.pw-toggle');
    assert.equal(await page.getAttribute('#register [name=password]', 'type'), 'password');
    await page.fill('#register [name=birthYear]', '1990');
    await page.check('#register [name=adult]'); await page.check('#register [name=terms]');
    await page.click('#register button[type=submit]');
    await page.waitForSelector('#msg:has-text("Check your email")');

    step('confirm the email from the link, sign in');
    await page.goto(await link(email, 'rider_verify_email', 'verify'));
    await page.waitForSelector('#msg:has-text("Email confirmed")');
    assert.equal(new URL(page.url()).search, '', 'one-time token removed from the address bar');
    await page.fill('#signin [name=email]', email);
    await page.fill('#signin [name=password]', 'a long rider passphrase');
    await page.click('#signin button[type=submit]');
    await page.waitForSelector('#who:has-text("Hi Sam")');

    step("scan the tablet's QR with the phone camera (the QR is a plain link into this app)");
    const p1 = await tablet.call('POST', '/v1/devices/rider-pairings', {});
    assert.match(p1.qrPayload, new RegExp(`^${BASE}/rider/\\?pair=[A-Z2-9]{8}$`));
    await page.goto(p1.qrPayload);
    await page.waitForSelector('#msg:has-text("Connected to the screen")');
    const s1 = await tablet.call('GET', `/v1/devices/rider-pairings/${p1.pairingId}`);
    assert.equal(s1.status, 'PAIRED');

    step('or type the code shown on the tablet');
    const p2 = await tablet.call('POST', '/v1/devices/rider-pairings', {});
    await page.fill('#pair-input', p2.code.toLowerCase());
    await page.click('#pair-form button');
    await page.waitForSelector('#msg:has-text("Connected to the screen")');
    const s2 = await tablet.call('GET', `/v1/devices/rider-pairings/${p2.pairingId}`);
    await page.screenshot({ path: path.join(SHOTS, 'rider-connected.png') });

    step('a coupon claimed on the tablet appears in the phone wallet with a scannable QR');
    const coupon = await tablet.call('POST', '/v1/devices/coupons', { campaignId: campaign, creativeId: creative }, { 'x-rider-session': s2.riderSession });
    assert.equal(coupon.savedToWallet, true);
    await page.click('#wallet button:has-text("Refresh")');
    await page.waitForSelector('#wallet .item:has-text("Free cookie with any coffee")');
    await page.click('#wallet .item');
    await page.waitForSelector(`#wallet .code:has-text("${coupon.code}")`);
    assert.ok(await page.isVisible('#wallet svg.qr'));
    await page.screenshot({ path: path.join(SHOTS, 'rider-wallet.png'), fullPage: true });

    step('works offline at the checkout counter (service worker + saved wallet)');
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload(); // now controlled by the service worker
    await page.waitForSelector('#wallet');
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('#offline-note');
    await page.click('#wallet .item');
    await page.waitForSelector(`#wallet .code:has-text("${coupon.code}")`);
    await ctx.setOffline(false);

    step('signed out, scanning a tablet QR asks to sign in, then connects automatically');
    await page.reload();
    await page.click('#account button:has-text("Sign out")');
    await page.waitForSelector('#signin');
    const p3 = await tablet.call('POST', '/v1/devices/rider-pairings', {});
    await page.goto(p3.qrPayload);
    await page.waitForSelector('#msg:has-text("Sign in (or create a free account) to connect")');
    await page.fill('#signin [name=email]', email);
    await page.fill('#signin [name=password]', 'a long rider passphrase');
    await page.click('#signin button[type=submit]');
    await page.waitForSelector('#msg:has-text("Connected to the screen")');

    step('forgot password: reset by email link, sign in with the new password');
    await page.click('#account button:has-text("Sign out")');
    await page.click('#signin button:has-text("Forgot password?")');
    await page.fill('#forgot [name=email]', email);
    await page.click('#forgot button[type=submit]');
    await page.waitForSelector('#msg:has-text("If an account exists")');
    await page.goto(await link(email, 'rider_password_reset', 'reset'));
    await page.fill('#reset [name=password]', 'my brand new passphrase');
    await page.click('#reset button[type=submit]');
    await page.waitForSelector('#msg:has-text("Password changed")');
    await page.fill('#signin [name=email]', email);
    await page.fill('#signin [name=password]', 'my brand new passphrase');
    await page.click('#signin button[type=submit]');
    await page.waitForSelector('#who:has-text("Hi Sam")');

    step('delete the account: personal data erased, signed out');
    await page.click('#account button:has-text("Delete my account")');
    await page.fill('#delete [name=password]', 'my brand new passphrase');
    await page.click('#delete button[type=submit]');
    await page.waitForSelector('#msg:has-text("Your account was deleted")');
    assert.equal(await page.evaluate(() => localStorage.getItem('rmn_rider_wallet')), null, 'cached wallet cleared');
    const login = await fetch(`${BASE}/v1/riders/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'my brand new passphrase' }) });
    assert.equal(login.status, 401);
    assert.deepEqual(problems, [], 'no page errors or CSP violations');
    console.log(`  ✓ rider web app e2e passed (screenshots in ${SHOTS})`);
  } finally {
    await page.screenshot({ path: path.join(SHOTS, 'rider-final.png') }).catch(() => {});
    await browser.close(); await app.close(); await db.end();
  }
}
main().catch((e) => { console.error('  ✗', e); process.exit(1); });
