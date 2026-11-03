/**
 * End-to-end: an advertiser runs a campaign from the business portal in real Chromium, against the real API, PostgreSQL
 * and ffmpeg: funds the account through the simulated checkout, creates a campaign, uploads a real video, adds a banner,
 * offer, location alert and game reward, submits for review; after staff approval a real web-player tablet plays the ad
 * and the validated results and spend appear in the portal. Run: npm run e2e -w @rmn/portal (DROPS AND RECREATES rmn_e2e).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
import { runValidation } from '../../api/src/modules/events/validator.js';
import { processPendingUploads } from '../../api/src/modules/media/process.js';

const PORT = 18083, BASE = `http://127.0.0.1:${PORT}`;
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

const work = mkdtempSync(path.join(tmpdir(), 'rmn-adv-e2e-'));
const mediaRoot = path.join(work, 'media');
const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
function videoFile(seconds: number, color: string, out: string) {
  ffmpeg('-f', 'lavfi', '-i', `color=c=${color}:s=1280x720:d=${seconds}:r=24`, '-f', 'lavfi', '-i', `sine=frequency=500:duration=${seconds}`, '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', out);
  return out;
}

async function main() {
  console.log('advertiser portal e2e');
  await resetDb();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'),
    MEDIA_BASE_URL: `${BASE}/media`, MEDIA_ROOT: mediaRoot, STRIPE_WEBHOOK_SECRET: 'whsec_e2e', LOG_LEVEL: 'silent', APP_PUBLIC_URL: BASE, ALLOCATION_SETTLE_MINUTES: '0' });
  const db = createPool(DB_URL);
  const app = await buildApp({ config, db, logger: false });
  const serverErrors: string[] = [];
  app.addHook('onError', async (req, _reply, err) => { serverErrors.push(`${req.method} ${req.url.split('?')[0]}: ${err.message}`); });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const q = (sql: string, p: unknown[] = []) => db.query(sql, p).then((r) => r.rows);
  const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(BASE + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  // The media worker runs on a schedule in production; here it runs alongside the test.
  const worker = setInterval(() => { void processPendingUploads(db, config).catch(() => {}); }, 1000);

  // ---------- fixtures (SYNTHETIC) ----------
  await q(`INSERT INTO accounting_periods (period_start, period_end) VALUES (date_trunc('year', now())::date, (date_trunc('year', now()) + interval '1 year - 1 day')::date)`);
  const platform = (await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('PLATFORM','Platform',true) RETURNING id`))[0].id;
  const pw = await hashPassword('e2e-password-123');
  const user = async (orgId: string, role: string, name: string, mfa = false) => {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
    const id = (await q('INSERT INTO users (email, password_hash, display_name, email_verified_at, mfa_enabled, mfa_secret_enc) VALUES ($1,$2,$3, now(), $4, $5) RETURNING id',
      [email, pw, name, mfa, mfa ? 'placeholder' : null]))[0].id;
    await q('INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,$3)', [id, orgId, role]);
    return { id, email };
  };
  const reviewer = await user(platform, 'moderator', 'Rita Reviewer', true);
  const reviewerToken = (await api('POST', '/v1/auth/login', { email: reviewer.email, password: 'e2e-password-123' })).token;
  await q(`UPDATE sessions SET mfa_verified_at = now() WHERE user_id = $1`, [reviewer.id]); // MFA flow itself is covered in portal.e2e and auth tests
  const staff = { authorization: `Bearer ${reviewerToken}` };
  const adv = (await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('ADVERTISER','Main Street Coffee',true) RETURNING id`))[0].id;
  const advAdmin = await user(adv, 'advertiser_admin', 'Alex Advertiser');
  const advMember = await user(adv, 'advertiser_member', 'Morgan Member');
  // A fleet with one tablet in Springfield, and some creator content to play between ads.
  const fleetOrg = (await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('FLEET_OPERATOR','Springfield Rides',true) RETURNING id`))[0].id;
  const fleetAdmin = await user(fleetOrg, 'fleet_admin', 'Dana Fleet');
  const fleetH = { authorization: `Bearer ${(await api('POST', '/v1/auth/login', { email: fleetAdmin.email, password: 'e2e-password-123' })).token}` };
  const fleet = (await q(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'Main','Springfield','UTC') RETURNING id`, [fleetOrg]))[0].id;
  const vehicle = (await q(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,'CAB-1') RETURNING id`, [fleetOrg, fleet]))[0].id;
  const studio = (await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('CREATOR_STUDIO','City Walks',true) RETURNING id`))[0].id;
  const creator = (await q(`INSERT INTO creator_profiles (org_id, display_name, monetization_status) VALUES ($1,'City Walks','ELIGIBLE') RETURNING id`, [studio]))[0].id;
  const contentId = randomUUID();
  mkdirSync(path.join(mediaRoot, 'assets', contentId), { recursive: true });
  videoFile(6, 'teal', path.join(mediaRoot, 'assets', contentId, '720p.mp4'));
  ffmpeg('-f', 'lavfi', '-i', 'color=c=teal:s=320x180', '-frames:v', '1', path.join(mediaRoot, 'assets', contentId, 'thumb.jpg'));
  const up = (await q(`INSERT INTO media_uploads (org_id, purpose, filename, declared_type, size_bytes, sha256, received_bytes, status, detected_type, created_by, completed_at, processed_at)
                       VALUES ($1,'CREATOR_VIDEO','c.mp4','video/mp4',1,$2,1,'READY','video/mp4',$3,now(),now()) RETURNING id`, [studio, '0'.repeat(64), advAdmin.id]))[0].id;
  await q(`INSERT INTO media_assets (id, upload_id, org_id, kind, duration_ms, rendition_key, thumbnail_key, probe) VALUES ($1,$2,$3,'VIDEO',6000,$4,$5,'{}')`,
    [contentId, up, studio, `assets/${contentId}/720p.mp4`, `assets/${contentId}/thumb.jpg`]);
  await q(`INSERT INTO videos (creator_id, title, status, duration_ms, media_key, asset_id) VALUES ($1,'Downtown murals','APPROVED',6000,$2,$3)`, [creator, `assets/${contentId}/720p.mp4`, contentId]);
  const adVideo = videoFile(8, 'orange', path.join(work, 'latte-ad.mp4'));

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const problems: string[] = [];
  const watch = (p: import('playwright').Page, name: string) => {
    p.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/status of (4\d\d)|ERR_NAME_NOT_RESOLVED|net::ERR/.test(m.text())) problems.push(`${name} console: ${m.text()}`); });
  };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); watch(page, 'portal');
  const signIn = async (p: import('playwright').Page, email: string) => {
    await p.goto(`${BASE}/portal/`);
    await p.fill('#signin input[name=email]', email);
    await p.fill('#signin input[name=password]', 'e2e-password-123');
    await p.click('#signin button[type=submit]');
  };
  const nav = (p: import('playwright').Page, title: string) => p.click(`#nav a:has-text("${title}")`);
  const dlgFill = async (name: string, value: string) => page.fill(`#dlg [name=${name}]`, value);

  try {
    step('advertiser signs in: overview asks them to add funds');
    await signIn(page, advAdmin.email);
    await page.waitForSelector('#todo:has-text("prepaid balance is empty")');

    step('add $250 through the simulated checkout: the balance and receipt come from the real webhook + ledger path');
    await nav(page, 'Billing');
    await page.fill('#fund-form input[name=amount]', '250');
    await page.click('#fund-form button');
    await page.waitForSelector('#amount:has-text("$250.00")');
    await page.screenshot({ path: path.join(SHOTS, 'advertiser-checkout.png') });
    await page.click('#pay');
    await page.waitForSelector('#toast:has-text("Payment received")');
    await page.waitForSelector('#stat-available .n:has-text("$250.00")');
    await page.waitForSelector('#invoices:has-text("Prepayment receipt")');

    step('create a draft campaign (pay per qualified view, $0.50, $100 budget, Springfield)');
    await nav(page, 'Campaigns');
    await page.click('#new-campaign');
    await dlgFill('name', 'Morning latte');
    await page.selectOption('#dlg select[name=category]', 'FOOD_DRINK');
    await dlgFill('rate', '0.50');
    await dlgFill('total', '100');
    await dlgFill('daily', '25');
    await dlgFill('markets', 'Springfield');
    await dlgFill('destinationUrl', 'https://example.com/latte');
    await page.click('#dlg button:has-text("Create draft")');
    await page.waitForSelector('#campaign-name:has-text("Morning latte")');
    await page.waitForSelector('#delivery:has-text("add ads and submit")');
    const campaignId = (await q(`SELECT id FROM campaigns WHERE advertiser_org_id = $1`, [adv]))[0].id;

    step('submitting without ads is refused with a clear message');
    await page.click('#campaign-actions button:has-text("Submit for review")');
    await page.waitForSelector('#toast.err:has-text("add at least one creative")');

    step('upload a real 8 s video (chunked, SHA-256 verified, probed and transcoded by ffmpeg)');
    await page.click('#add-video');
    await page.setInputFiles('#dlg input[type=file]', adVideo);
    await dlgFill('headline', 'Fresh coffee');
    await page.click('#dlg button:has-text("Upload")');
    await page.waitForSelector('#toast:has-text("Video added (8 s)")', { timeout: 90_000 });
    await page.waitForSelector('#creatives tr:has-text("Video · 8 s") .chip:has-text("In review")');

    step('add a text banner, a coupon offer and a location alert');
    await page.click('#add-banner');
    await dlgFill('headline', '2-for-1 lattes today');
    await page.click('#dlg button:has-text("Add banner")');
    await page.waitForSelector('#creatives:has-text("2-for-1 lattes today")');
    await page.click('#add-offer');
    await dlgFill('name', 'Free cookie');
    await dlgFill('couponDescription', 'Free cookie with any coffee');
    await dlgFill('amount', '10');
    await page.click('#dlg button:has-text("Create offer")');
    await page.waitForSelector('#offers tr:has-text("10% of sale")');
    await page.click('#add-geofence');
    await dlgFill('name', 'Main St Cafe');
    await dlgFill('message', 'Fresh coffee two blocks away');
    await dlgFill('lat', '39.7817');
    await dlgFill('lng', '-89.6501');
    await page.click('#dlg button:has-text("Add alert")');
    await page.waitForSelector('#geofences tr:has-text("Main St Cafe") .chip:has-text("Active")');

    step('submit for review; a reviewer rejects with a note; the advertiser sees it, edits and resubmits');
    await page.click('#campaign-actions button:has-text("Submit for review")');
    await page.waitForSelector('.row-head .chip:has-text("In review")');
    await api('POST', `/v1/review/campaigns/${campaignId}/decision`, { decision: 'REJECT', note: 'Please add the store address to the landing page.' }, staff);
    await page.reload();
    await page.waitForSelector('#review-note:has-text("store address")');
    await page.click('#campaign-actions button:has-text("Edit")');
    await dlgFill('destinationUrl', 'https://example.com/latte?store=main-st');
    await page.click('#dlg button:has-text("Save changes")');
    await page.waitForSelector('#toast:has-text("Changes saved")');
    await page.click('#campaign-actions button:has-text("Submit for review")');
    await page.waitForSelector('.row-head .chip:has-text("In review")');
    const pending = (await api('GET', '/v1/review/campaigns', undefined, staff)).campaigns.find((c: any) => c.id === campaignId);
    await api('POST', `/v1/review/campaigns/${campaignId}/decision`, { decision: 'APPROVE', note: 'Looks good, family friendly.',
      creatives: pending.creatives.filter((k: any) => k.status === 'PENDING_REVIEW').map((k: any) => ({ creativeId: k.id, decision: 'APPROVE' })) }, staff);
    await page.reload();
    await page.waitForSelector('.row-head .chip:has-text("Running")');
    await page.waitForSelector('#delivery:has-text("Delivering to tablets")');

    step('a real tablet in Springfield plays the approved ad');
    const { code } = await api('POST', `/v1/orgs/${fleetOrg}/devices/enrollment-codes`, {}, fleetH);
    const tabletCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const tablet = await tabletCtx.newPage(); watch(tablet, 'tablet');
    await tablet.goto(`${BASE}/player/?fast=1`);
    await tablet.fill('#code', code);
    await tablet.click('#setup-form button');
    await tablet.waitForSelector('#idle:has-text("Waiting for vehicle assignment")', { timeout: 15_000 });
    const deviceId = (await q(`SELECT id FROM devices WHERE org_id = $1`, [fleetOrg]))[0].id;
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${deviceId}/assignments`, { vehicleId: vehicle }, fleetH);
    await api('POST', `/v1/orgs/${fleetOrg}/devices/${deviceId}/commands`, { command: 'REFRESH_PLAYBACK' }, fleetH);
    await tablet.waitForSelector('#now:has-text("Advertisement")', { timeout: 45_000 });
    await tablet.screenshot({ path: path.join(SHOTS, 'advertiser-ad-on-tablet.png') });
    await tablet.waitForSelector('#now:not(:has-text("Advertisement"))', { timeout: 30_000 }); // ad finished
    await tablet.waitForTimeout(4_000); // event queue upload
    await runValidation(db);

    step('validated results and spend appear in the portal');
    await page.reload();
    await page.waitForFunction(() => Number(document.querySelector('#results tbody tr:nth-child(2) td:nth-child(3)')?.textContent ?? '0') >= 1, undefined, { timeout: 20_000 });
    const spent = (await page.textContent('#stat-spent .n'))!;
    assert.notEqual(spent, '$0.00', 'spend recorded');
    await page.screenshot({ path: path.join(SHOTS, 'advertiser-campaign.png'), fullPage: true });

    step('pause and resume the campaign');
    await page.click('#campaign-actions button:has-text("Pause")');
    await page.waitForSelector('.row-head .chip:has-text("Paused")');
    await page.click('#campaign-actions button:has-text("Resume")');
    await page.waitForSelector('.row-head .chip:has-text("Running")');

    step('download the daily report: a spreadsheet-ready CSV whose spend matches the portal');
    const [report] = await Promise.all([page.waitForEvent('download'), page.click('#download-report')]);
    const csv = readFileSync((await report.path())!, 'utf8').trim().split('\r\n');
    assert.equal(csv[0], 'date,impressions,qualifiedViews,completions,clicks,billablePlays,spend,currency,spendMilliMinor,rejectedEvents');
    assert.equal(`$${csv[1]!.split(',')[6]}`, spent, 'CSV spend equals the spend shown in the portal'); // events are validated only by runValidation above, so spend is stable

    step('sales tracking: create an integration key, report a sale with it from a server, then revoke it');
    await nav(page, 'Sales tracking');
    await page.click('#new-key-btn');
    await dlgFill('name', 'Online store');
    await page.click('#dlg button:has-text("Create key")');
    const key = (await page.textContent('#new-key'))!.trim();
    assert.match(key, /^rmnk_[0-9a-f]{12}_/);
    await page.click('#dlg button:has-text("Done")');
    await page.waitForSelector('#keys tr[data-key="Online store"]:has-text("never used")');
    const report2 = (orderId: string, amount: string) => fetch(`${BASE}/v1/conversions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId, occurredAt: new Date().toISOString(), saleAmountMinor: amount, currency: 'USD' }) });
    assert.equal((await report2('A-1001', '2450')).status, 201);
    await page.reload();
    await page.waitForSelector('#conversions tr:has-text("A-1001"):has-text("not credited")'); // no coupon and no tap: recorded, not credited
    await page.waitForSelector('#keys tr[data-key="Online store"]:has-text("last used")');
    const [convCsv] = await Promise.all([page.waitForEvent('download'), page.click('#conversions-csv')]);
    assert.match(readFileSync((await convCsv.path())!, 'utf8'), /A-1001/);
    await page.click('#keys tr[data-key="Online store"] button:has-text("Revoke")');
    await page.click('#dlg button.danger:has-text("Revoke key")');
    await page.waitForSelector('#keys tr[data-key="Online store"] .chip:has-text("Revoked")');
    assert.equal((await report2('A-1002', '900')).status, 401, 'revoked keys stop working immediately');

    step('sponsor a trivia reward');
    await nav(page, 'Game rewards');
    await page.click('#new-reward');
    await dlgFill('name', 'Trivia champions');
    await dlgFill('rewardDescription', 'Free small coffee');
    await dlgFill('value', '3');
    await dlgFill('qty', '50');
    await page.selectOption('#dlg select[name=gameSlug]', 'city-trivia');
    await page.click('#dlg button:has-text("Create program")');
    await page.waitForSelector('#rewards tr:has-text("Trivia champions"):has-text("0 of 50")');

    step('overview reflects the running campaign');
    await nav(page, 'Overview');
    await page.waitForSelector('#stat-running .n:has-text("1")');
    await page.screenshot({ path: path.join(SHOTS, 'advertiser-overview.png') });

    step('a read-only team member sees results but cannot change anything');
    const memberCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const member = await memberCtx.newPage(); watch(member, 'member');
    await signIn(member, advMember.email);
    await nav(member, 'Campaigns');
    await member.waitForSelector('#campaigns a:has-text("Morning latte")');
    assert.equal(await member.locator('#new-campaign').count(), 0);
    await member.click('#campaigns a:has-text("Morning latte")');
    await member.waitForSelector('#results');
    assert.equal(await member.locator('#campaign-actions button, #add-video, #add-offer, #add-geofence').count(), 0, 'no management actions for members');
    await nav(member, 'Billing');
    await member.waitForSelector('#stat-available');
    assert.equal(await member.locator('#fund-form').count(), 0, 'members cannot add funds');
    await nav(member, 'Sales tracking');
    await member.waitForSelector('#conversions td:has-text("A-1001")');
    assert.equal(await member.locator('#new-key-btn').count(), 0, 'members cannot create integration keys');
    await member.screenshot({ path: path.join(SHOTS, 'advertiser-member-phone.png') });
    await memberCtx.close();
    await tabletCtx.close();

    const audit = (await q(`SELECT action FROM audit_log WHERE org_id = $1`, [adv])).map((r) => r.action);
    for (const a of ['integration.key_created', 'integration.key_revoked', 'conversion.reported', 'campaign.created', 'media.uploaded', 'creative.created', 'commission.offer_created', 'geofence.created', 'campaign.submit', 'campaign.updated', 'campaign.pause', 'reward_program.created'])
      assert.ok(audit.includes(a), `audited: ${a}`);
    assert.deepEqual(problems, [], 'no page errors or CSP violations');
    console.log(`  ✓ advertiser portal e2e passed (screenshots in ${SHOTS})`);
  } finally {
    clearInterval(worker);
    if (serverErrors.length) console.log('  server errors:\n   ', [...new Set(serverErrors)].slice(0, 10).join('\n    '));
    await page.screenshot({ path: path.join(SHOTS, 'advertiser-final.png') }).catch(() => {});
    await browser.close();
    await app.close();
    await db.end();
  }
}

main().catch((e) => { console.error('  ✗', e); process.exit(1); });
