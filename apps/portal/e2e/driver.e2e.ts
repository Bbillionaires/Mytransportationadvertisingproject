/**
 * End-to-end: a fleet admin invites a driver and adds them to a fleet in the portal; the driver accepts, sees the
 * earnings disclosure and eligibility, sees the tablet in their vehicle, subscribes ($30/month) through the simulated
 * checkout (real signed-webhook path), gets a receipt, cancels transparently, and downloads a statement.
 * The retired /admin/ console redirects to the portal. Run: npm run e2e -w @rmn/portal (DROPS AND RECREATES rmn_e2e).
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
import { buildApp } from '../../api/src/app.js';
import { loadConfig } from '../../api/src/config.js';
import { createPool } from '../../api/src/db/pool.js';
import { migrate } from '../../api/src/db/migrate.js';
import { hashPassword } from '../../api/src/lib/crypto.js';

const PORT = 18086, BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_URL = process.env.E2E_ADMIN_DB ?? 'postgres://rmn:rmn@localhost:5432/rmn_test';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://rmn:rmn@localhost:5432/rmn_e2e';
const SHOTS = process.env.E2E_SCREENSHOTS ?? tmpdir();
const step = (s: string) => console.log(`  • ${s}`);

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

async function main() {
  console.log('driver portal e2e');
  await resetDb();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'),
    MEDIA_BASE_URL: `${BASE}/media`, MEDIA_ROOT: mkdtempSync(path.join(tmpdir(), 'rmn-driver-e2e-')), STRIPE_WEBHOOK_SECRET: 'whsec_e2e', LOG_LEVEL: 'silent', APP_PUBLIC_URL: BASE });
  const db = createPool(DB_URL);
  const app = await buildApp({ config, db, logger: false });
  const serverErrors: string[] = [];
  app.addHook('onError', async (req, _reply, err) => { serverErrors.push(`${req.method} ${req.url.split('?')[0]}: ${err.message}`); });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const q = (sql: string, p: unknown[] = []) => db.query(sql, p).then((r) => r.rows);
  const emailLink = async (to: string, template: string) => (await q(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY id DESC LIMIT 1`, [to, template]))[0].body_text.match(/https?:\/\/\S+/)[0] as string;

  // ---------- fixtures (SYNTHETIC) ----------
  await q(`INSERT INTO accounting_periods (period_start, period_end) VALUES (date_trunc('year', now())::date, (date_trunc('year', now()) + interval '1 year - 1 day')::date)`);
  await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('PLATFORM','Platform',true)`);
  const fleetOrg = (await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('FLEET_OPERATOR','Springfield Rides',true) RETURNING id`))[0].id;
  const adminEmail = `fleet-${randomUUID().slice(0, 8)}@example.test`;
  const adminId = (await q(`INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1,$2,'Dana Fleet', now()) RETURNING id`, [adminEmail, await hashPassword('fleet-admin-password')]))[0].id;
  await q(`INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,'fleet_admin')`, [adminId, fleetOrg]);
  await q(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'Downtown','Springfield','UTC')`, [fleetOrg]);
  const fleetId = (await q(`SELECT id FROM fleets WHERE org_id = $1`, [fleetOrg]))[0].id;
  const vehicle = (await q(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,'CAB-7') RETURNING id`, [fleetOrg, fleetId]))[0].id;
  const der = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  const device = (await q(`INSERT INTO devices (org_id, serial, label, public_key_der, app_version, last_heartbeat_at) VALUES ($1,'AND-e2e000000007','CAB-7 rear',$2,'0.1.0', now()) RETURNING id`, [fleetOrg, der]))[0].id;

  const browser = await chromium.launch();
  const problems: string[] = [];
  const open = async (name: string, mobile = false) => {
    const ctx = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, acceptDownloads: true } : { viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(`${name} console: ${m.text()}`); });
    return p;
  };
  const signIn = async (p: import('playwright').Page, email: string, pw: string) => {
    await p.goto(`${BASE}/portal/`);
    await p.fill('#signin input[name=email]', email);
    await p.fill('#signin input[name=password]', pw);
    await p.click('#signin button[type=submit]');
  };
  const nav = (p: import('playwright').Page, t: string) => p.click(`#nav a:has-text("${t}")`);
  const driverEmail = `driver-${randomUUID().slice(0, 8)}@example.test`;

  try {
    step('the old /admin/ console address now opens the portal');
    const r = await fetch(`${BASE}/admin/`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/portal/');

    step('fleet admin invites a driver; the driver accepts from the email link');
    const admin = await open('fleet-admin');
    await signIn(admin, adminEmail, 'fleet-admin-password');
    await nav(admin, 'Team');
    await admin.fill('#invite-form input[name=displayName]', 'Drew Driver');
    await admin.fill('#invite-form input[name=email]', driverEmail);
    await admin.selectOption('#invite-form select[name=role]', 'driver');
    await admin.click('#invite-form button');
    await admin.waitForSelector('#invitations tr:has-text("Drew Driver")');
    const driver = await open('driver', true);
    await driver.goto(await emailLink(driverEmail, 'invitation'));
    await driver.fill('#invite-form input[name=pw]', 'a long driver passphrase');
    await driver.click('#invite-form button');
    await driver.waitForSelector('#signin:has-text("Invitation accepted")');

    step('before being added to a fleet, the driver is told why nothing is available yet');
    await signIn(driver, driverEmail, 'a long driver passphrase');
    await driver.waitForSelector('#no-driver');
    assert.equal(await driver.locator('#nav a:has-text("Tablets"), #nav a:has-text("Team")').count(), 0, 'drivers see no fleet management');

    step('fleet admin adds the driver to a fleet and assigns the tablet with the driver');
    await nav(admin, 'Drivers');
    await admin.click(`#waiting-drivers tr[data-email="${driverEmail}"] button:has-text("Add to fleet")`);
    await admin.click('#dlg button:has-text("Add driver")');
    await admin.waitForSelector('#drivers td:has-text("Drew Driver")');
    const driverId = (await q(`SELECT d.id FROM drivers d JOIN users u ON u.id = d.user_id WHERE u.email = $1`, [driverEmail]))[0].id;
    const token = await admin.evaluate(() => sessionStorage.getItem('rmn_portal_token'));
    const a = await fetch(`${BASE}/v1/orgs/${fleetOrg}/devices/${device}/assignments`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ vehicleId: vehicle, driverId }) });
    assert.equal(a.status, 201);

    step('the driver sees the disclosure, eligibility, and the tablet in their vehicle');
    await driver.reload();
    await driver.waitForSelector('#disclosure:has-text("Earnings are not guaranteed")');
    await driver.waitForSelector('#eligibility:has-text("Not yet eligible")');
    await driver.waitForSelector('#tablet:has-text("AND-e2e000000007")');
    await driver.screenshot({ path: path.join(SHOTS, 'driver-earnings-phone.png'), fullPage: true });

    step('subscribe for $30/month: the disclosure must be accepted; the simulated checkout runs the real webhook path');
    await nav(driver, 'Subscription');
    await driver.waitForSelector('#subscription-card .chip:has-text("Not subscribed")');
    await driver.click('#subscribe');
    await driver.click('#dlg button:has-text("Continue to payment")');
    assert.ok(await driver.locator('#dlg[open]').isVisible(), 'cannot continue without accepting the disclosure');
    await driver.check('#dlg input[name=accept]');
    await driver.click('#dlg button:has-text("Continue to payment")');
    await driver.waitForSelector('#amount:has-text("$30.00 / month")');
    await driver.click('#pay');
    await driver.waitForSelector('#toast:has-text("Subscription started")');
    await driver.waitForSelector('#subscription-card .chip:has-text("Active")');
    await driver.waitForSelector('#invoices td:has-text("$30.00")');
    const [sub] = await q(`SELECT status FROM driver_subscriptions WHERE driver_id = $1`, [driverId]);
    assert.equal(sub.status, 'ACTIVE');
    const [fee] = await q(`SELECT balance::text FROM ledger_balances WHERE account_code = '4200'`);
    assert.equal(fee?.balance, '3000', 'subscription revenue booked separately (account 4200), never in the pools');

    step('cancel transparently: no further charges, access to period end');
    await driver.click('#cancel-subscription');
    await driver.click('#dlg button.danger:has-text("Cancel subscription")');
    await driver.waitForSelector('#toast:has-text("No further charges")');
    await driver.waitForSelector('#subscription-card .chip:has-text("Ends at period end")');
    await driver.screenshot({ path: path.join(SHOTS, 'driver-subscription-phone.png') });

    step('download a monthly statement (PDF from the ledger)');
    await nav(driver, 'My earnings');
    const [pdf] = await Promise.all([driver.waitForEvent('download'), driver.click('#statement-form button:has-text("Download PDF")')]);
    assert.equal(readFileSync((await pdf.path())!).subarray(0, 5).toString(), '%PDF-');

    const audit = (await q(`SELECT action FROM audit_log WHERE org_id = $1`, [fleetOrg])).map((x) => x.action);
    for (const x of ['invitation.created', 'invitation.accepted', 'driver.registered', 'device.assigned', 'driver.subscription_checkout_started', 'driver.subscription_cancel_requested']) assert.ok(audit.includes(x), `audited: ${x}`);
    assert.deepEqual(problems, [], 'no page errors or CSP violations');
    console.log(`  ✓ driver portal e2e passed (screenshots in ${SHOTS})`);
  } finally {
    if (serverErrors.length) console.log('  server errors:\n   ', [...new Set(serverErrors)].slice(0, 10).join('\n    '));
    await browser.close();
    await app.close();
    await db.end();
  }
}

main().catch((e) => { console.error('  ✗', e); process.exit(1); });
