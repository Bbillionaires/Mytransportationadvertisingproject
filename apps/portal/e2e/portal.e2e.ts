/**
 * End-to-end: a fleet manager runs their fleet from the business portal in real Chromium, against the real API and
 * PostgreSQL, while a real web-player tablet reacts. Run: npm run e2e -w @rmn/portal (DROPS AND RECREATES rmn_e2e).
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
import { buildApp } from '../../api/src/app.js';
import { loadConfig } from '../../api/src/config.js';
import { createPool } from '../../api/src/db/pool.js';
import { migrate } from '../../api/src/db/migrate.js';
import { hashPassword, totpAt } from '../../api/src/lib/crypto.js';

const PORT = 18082, BASE = `http://127.0.0.1:${PORT}`;
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
  console.log('portal e2e');
  await resetDb();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'),
    MEDIA_BASE_URL: `${BASE}/media`, MEDIA_ROOT: mkdtempSync(path.join(tmpdir(), 'rmn-portal-media-')), STRIPE_WEBHOOK_SECRET: 'whsec_e2e', LOG_LEVEL: 'silent', APP_PUBLIC_URL: BASE });
  const db = createPool(DB_URL);
  const app = await buildApp({ config, db, logger: false });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const q = (sql: string, p: unknown[] = []) => db.query(sql, p).then((r) => r.rows);
  const emailLink = async (to: string, template: string) => (await q(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY id DESC LIMIT 1`, [to, template]))[0].body_text.match(/https?:\/\/\S+/)[0] as string;

  // ---------- fixtures (SYNTHETIC) ----------
  await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('PLATFORM','Platform',true)`);
  const fleetOrg = (await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('FLEET_OPERATOR','Springfield Rides',true) RETURNING id`))[0].id;
  const adminEmail = `fleet-${randomUUID().slice(0, 8)}@example.test`;
  const adminId = (await q('INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1,$2,$3, now()) RETURNING id', [adminEmail, await hashPassword('fleet-admin-password'), 'Dana Fleet']))[0].id;
  await q(`INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,'fleet_admin')`, [adminId, fleetOrg]);

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const problems: string[] = [];
  const watch = (p: import('playwright').Page, name: string) => {
    p.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/the server responded with a status of (401|403|404|409)/.test(m.text())) problems.push(`${name} console: ${m.text()}`); });
  };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage(); watch(page, 'portal');
  const tabletCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tablet = await tabletCtx.newPage(); watch(tablet, 'tablet');
  const signIn = async (p: import('playwright').Page, email: string, password: string) => {
    await p.goto(`${BASE}/portal/`);
    await p.fill('#signin input[name=email]', email);
    await p.fill('#signin input[name=password]', password);
    await p.click('#signin button[type=submit]');
  };
  const nav = (p: import('playwright').Page, title: string) => p.click(`#nav a:has-text("${title}")`);

  try {
    step('fleet admin signs in: empty overview invites them to add a tablet');
    await signIn(page, adminEmail, 'fleet-admin-password');
    await page.waitForSelector('#attention:has-text("No tablets yet")');
    assert.equal(await page.textContent('#org-switch'), 'Springfield Rides');

    step('add a fleet and a vehicle');
    await nav(page, 'Vehicles & fleets');
    await page.fill('#fleet-form input[name=name]', 'Downtown');
    await page.fill('#fleet-form input[name=market]', 'Springfield');
    await page.fill('#fleet-form input[name=timezone]', 'America/Chicago');
    await page.click('#fleet-form button');
    await page.waitForSelector('#vehicle-form');
    await page.fill('#vehicle-form input[name=label]', 'CAB-104');
    await page.fill('#vehicle-form input[name=makeModel]', 'Toyota Sienna');
    await page.click('#vehicle-form button');
    await page.waitForSelector('#vehicles td:has-text("CAB-104")');

    step('create a one-time enrollment code and enroll a real web-player tablet with it');
    await nav(page, 'Add a tablet');
    await page.fill('#code-form input[name=label]', 'Back seat');
    await page.click('#code-form button');
    const code = (await page.textContent('#new-code'))!.trim();
    await page.click('#dlg button:has-text("Done")');
    await page.waitForSelector('#codes:has-text("Unused")');
    await tablet.goto(`${BASE}/player/?fast=1`);
    await tablet.fill('#code', code);
    await tablet.click('#setup-form button');
    await tablet.waitForSelector('#idle:has-text("Waiting for vehicle assignment")', { timeout: 15_000 });
    await nav(page, 'Overview'); await nav(page, 'Add a tablet');
    await page.waitForSelector('#codes:has-text("Used by WEB-")');

    step('the tablet shows online and unassigned; assign it to the vehicle from the portal');
    await nav(page, 'Tablets');
    await page.waitForSelector('#tablets tr:has-text("Back seat") .chip.ok:has-text("Online")', { timeout: 15_000 });
    await page.click('#tablets tr:has-text("Back seat") button:has-text("Assign")');
    await page.selectOption('#dlg select[name=vehicleId]', { label: 'CAB-104 (Toyota Sienna)' });
    await page.click('#dlg button:has-text("Assign")');
    await page.waitForSelector('#tablets tr:has-text("Back seat") td:has-text("CAB-104")');
    await tablet.waitForSelector('#idle:has-text("Enjoy your ride")', { timeout: 20_000 });
    await page.screenshot({ path: path.join(SHOTS, 'portal-tablets.png') });

    step('suspend from the portal (with confirmation): the tablet pauses; resume restarts it');
    await page.click('#tablets tr:has-text("Back seat") button:has-text("Suspend")');
    await page.click('#dlg button.danger:has-text("Suspend")');
    await page.waitForSelector('#tablets tr:has-text("Back seat") .chip.warn:has-text("Suspended")');
    await tablet.waitForSelector('#idle:has-text("paused by the fleet operator")', { timeout: 15_000 });
    await page.click('#tablets tr:has-text("Back seat") button:has-text("Resume")');
    await tablet.waitForSelector('#idle:has-text("Enjoy your ride")', { timeout: 20_000 });

    step('rename the tablet and see its command history');
    await page.click('#tablets tr:has-text("Back seat") button:has-text("Details")');
    await page.waitForSelector('#dlg td:has-text("suspend")');
    await page.fill('#label-form input[name=label]', 'CAB-104 rear');
    await page.click('#label-form button');
    await page.waitForSelector('#tablets tr:has-text("CAB-104 rear")');

    step('hardware attestation result is visible (set directly here; the web player itself cannot attest)');
    await q(`UPDATE devices SET attestation_status = 'VERIFIED', attestation_security_level = 'STRONGBOX' WHERE label = 'CAB-104 rear'`);
    await nav(page, 'Overview'); await nav(page, 'Tablets');
    await page.waitForSelector('#tablets tr:has-text("CAB-104 rear") .chip.ok:has-text("Hardware verified (StrongBox)")');
    await page.click('#tablets tr:has-text("CAB-104 rear") button:has-text("Details")');
    await page.waitForSelector('#dlg p:has-text("can’t be copied")');
    await page.keyboard.press('Escape');
    await q(`UPDATE devices SET attestation_status = 'UNTRUSTED_BOOT' WHERE label = 'CAB-104 rear'`);
    await nav(page, 'Overview'); await nav(page, 'Tablets');
    await page.waitForSelector('#tablets tr:has-text("CAB-104 rear") .chip.warn:has-text("Unlocked or modified")');

    step('turn on "verified tablets only": the admin is warned about the existing unverified tablet; then turn it off again');
    await nav(page, 'Add a tablet');
    await page.waitForSelector('#policy:has-text("1 current tablet(s) are not hardware verified")');
    await page.check('#verified-only');
    await page.click('#dlg button:has-text("Turn on")');
    await page.waitForSelector('text=Only verified tablets can now be added.');
    assert.equal((await q(`SELECT require_hardware_attestation FROM organizations WHERE id = $1`, [fleetOrg]))[0].require_hardware_attestation, true);
    await page.uncheck('#verified-only');
    await page.waitForSelector('text=Any tablet can now be added.');

    step('overview shows the healthy fleet');
    await nav(page, 'Overview');
    await page.waitForSelector('#stat-online .n:has-text("1")');
    await page.waitForSelector('#attention:has-text("All tablets are healthy")');
    await page.screenshot({ path: path.join(SHOTS, 'portal-overview.png') });

    step('invite a read-only colleague; they accept from the email link and see no management actions');
    const viewerEmail = `viewer-${randomUUID().slice(0, 8)}@example.test`;
    await nav(page, 'Team');
    await page.fill('#invite-form input[name=displayName]', 'Val Viewer');
    await page.fill('#invite-form input[name=email]', viewerEmail);
    await page.selectOption('#invite-form select[name=role]', 'fleet_viewer');
    await page.click('#invite-form button');
    await page.waitForSelector('#invitations tr:has-text("Val Viewer") .chip:has-text("Pending")');
    const viewerCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const viewer = await viewerCtx.newPage(); watch(viewer, 'viewer');
    await viewer.goto(await emailLink(viewerEmail, 'invitation'));
    await viewer.fill('#invite-form input[name=pw]', 'viewer-password-123');
    await viewer.click('#invite-form button');
    await viewer.waitForSelector('#signin:has-text("Invitation accepted")');
    await signIn(viewer, viewerEmail, 'viewer-password-123');
    await viewer.waitForSelector('#nav a:has-text("Tablets")');
    assert.equal(await viewer.locator('#nav a:has-text("Add a tablet"), #nav a:has-text("Team")').count(), 0, 'viewer has no management sections');
    await nav(viewer, 'Tablets');
    await viewer.waitForSelector('#tablets tr:has-text("CAB-104 rear")');
    assert.equal(await viewer.locator('#tablets button:has-text("Suspend"), #tablets button:has-text("Assign")').count(), 0, 'viewer sees no management buttons');
    await viewer.screenshot({ path: path.join(SHOTS, 'portal-viewer-phone.png') });
    await viewerCtx.close();

    step('turn on two-step verification; the next sign-in asks for a code');
    await nav(page, 'Security');
    await page.click('#mfa-card button');
    const secret = (await page.textContent('#dlg .code'))!.trim();
    await page.fill('#dlg input[name=code]', totpAt(secret, Math.floor(Date.now() / 30_000)));
    await page.click('#dlg button:has-text("Turn on")');
    await page.waitForSelector('#mfa-card:has-text("On.")');
    await page.click('#who button:has-text("Sign out")');
    await signIn(page, adminEmail, 'fleet-admin-password');
    await page.waitForSelector('#mfa');
    await page.fill('#mfa input[name=code]', totpAt(secret, Math.floor(Date.now() / 30_000) + 1)); // codes are single-use; next step is accepted
    await page.click('#mfa button[type=submit]');
    await page.waitForSelector('#attention');

    step('retire the tablet: its key stops working and it disappears from the list');
    await nav(page, 'Tablets');
    await page.click('#tablets tr:has-text("CAB-104 rear") button:has-text("Details")');
    await page.click('#dlg button:has-text("Retire tablet")');
    await page.fill('#dlg textarea[name=reason]', 'Replaced with the Android shell');
    await page.click('#dlg button.danger:has-text("Retire tablet")');
    await page.waitForSelector('#main:has-text("No tablets yet")');
    const [dev] = await q(`SELECT status FROM devices WHERE org_id = $1`, [fleetOrg]);
    assert.equal(dev.status, 'RETIRED');
    const audit = (await q(`SELECT action FROM audit_log WHERE org_id = $1 ORDER BY id`, [fleetOrg])).map((r) => r.action);
    for (const a of ['vehicle.created', 'device.enrollment_code_created', 'device.assigned', 'device.command_issued', 'device.relabeled', 'invitation.created', 'device.retired']) assert.ok(audit.includes(a), `audited: ${a}`);

    step('forgot password: reset from the email link');
    await page.click('#who button:has-text("Sign out")');
    await page.click('#signin button:has-text("Forgot password?")');
    await page.fill('#forgot input[name=email]', adminEmail);
    await page.click('#forgot button[type=submit]');
    await page.waitForSelector('#signin:has-text("reset link is on its way")');
    await page.goto(await emailLink(adminEmail, 'password_reset'));
    await page.fill('#reset-form input[name=pw]', 'a brand new fleet password');
    await page.click('#reset-form button');
    await page.waitForSelector('#signin:has-text("Password changed")');

    assert.deepEqual(problems, [], 'no page errors or CSP violations');
    console.log(`  ✓ portal e2e passed (screenshots in ${SHOTS})`);
  } finally {
    await page.screenshot({ path: path.join(SHOTS, 'portal-final.png') }).catch(() => {});
    await browser.close();
    await app.close();
    await db.end();
  }
}

main().catch((e) => { console.error('  ✗', e); process.exit(1); });
