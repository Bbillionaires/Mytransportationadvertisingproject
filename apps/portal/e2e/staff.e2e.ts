/**
 * End-to-end: platform staff work their queues in the business portal (real Chromium, API, PostgreSQL, ffmpeg) with
 * real TOTP two-step verification: a moderator without MFA is blocked until they set it up; ads are reviewed with
 * previews; videos are moderated and an appeal is decided by a second reviewer; a copyright notice is upheld; a super
 * admin confirms creator and driver eligibility; a finance approver posts a journal entry requested by someone else
 * (and the requester cannot approve it). Run: npm run e2e -w @rmn/portal (DROPS AND RECREATES rmn_e2e).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
import { buildApp } from '../../api/src/app.js';
import { loadConfig } from '../../api/src/config.js';
import { createPool } from '../../api/src/db/pool.js';
import { migrate } from '../../api/src/db/migrate.js';
import { base32Encode, encrypt, hashPassword, totpAt } from '../../api/src/lib/crypto.js';

const PORT = 18085, BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_URL = process.env.E2E_ADMIN_DB ?? 'postgres://rmn:rmn@localhost:5432/rmn_test';
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://rmn:rmn@localhost:5432/rmn_e2e';
const SHOTS = process.env.E2E_SCREENSHOTS ?? tmpdir();
const PW = 'e2e-password-123';
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

const mediaRoot = mkdtempSync(path.join(tmpdir(), 'rmn-staff-e2e-'));
const ffmpeg = (...a: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
function asset(color: string, seconds: number) {
  const id = randomUUID(), dir = path.join(mediaRoot, 'assets', id);
  mkdirSync(dir, { recursive: true });
  ffmpeg('-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=${seconds}:r=24`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(dir, '720p.mp4'));
  ffmpeg('-f', 'lavfi', '-i', `color=c=${color}:s=320x180`, '-frames:v', '1', path.join(dir, 'thumb.jpg'));
  return id;
}

async function main() {
  console.log('staff portal e2e');
  await resetDb();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'),
    MEDIA_BASE_URL: `${BASE}/media`, MEDIA_ROOT: mediaRoot, STRIPE_WEBHOOK_SECRET: 'whsec_e2e', LOG_LEVEL: 'silent', APP_PUBLIC_URL: BASE });
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

  // ---------- fixtures (SYNTHETIC) ----------
  await q(`INSERT INTO accounting_periods (period_start, period_end) VALUES (date_trunc('year', now())::date, (date_trunc('year', now()) + interval '1 year - 1 day')::date)`);
  const pwHash = await hashPassword(PW);
  const org = async (kind: string, name: string) => (await q('INSERT INTO organizations (kind, name, is_synthetic) VALUES ($1,$2,true) RETURNING id', [kind, name]))[0].id as string;
  const platform = await org('PLATFORM', 'Platform');
  /** Staff user; with `mfa`, a real TOTP secret (encrypted like the app does) for sign-in through the portal. */
  const person = async (orgId: string, role: string, name: string, mfa: boolean) => {
    const email = `${role}-${randomUUID().slice(0, 6)}@example.test`;
    const secret = base32Encode(randomBytes(20));
    const id = (await q(`INSERT INTO users (email, password_hash, display_name, email_verified_at, mfa_enabled, mfa_secret_enc) VALUES ($1,$2,$3, now(), $4, $5) RETURNING id`,
      [email, pwHash, name, mfa, mfa ? encrypt(secret, config.APP_ENCRYPTION_KEY) : null]))[0].id as string;
    await q('INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,$3)', [id, orgId, role]);
    return { id, email, secret };
  };
  const moderator = await person(platform, 'moderator', 'Mo Moderator', false);
  const superAdmin = await person(platform, 'super_admin', 'Sam Superadmin', true);
  const finAdmin = await person(platform, 'finance_admin', 'Fran Finance', true);
  const finApprover = await person(platform, 'finance_approver', 'Avery Approver', true);
  const tokenFor = async (p: { id: string; email: string }) => {
    const t = (await api('POST', '/v1/auth/login', { email: p.email, password: PW })).token;
    await q(`UPDATE sessions SET mfa_verified_at = now() WHERE user_id = $1`, [p.id]); // API-side setup only; the browser signs in with real codes
    return { authorization: `Bearer ${t}` };
  };

  // Advertiser campaign awaiting review: a real video ad + a text banner.
  const adv = await org('ADVERTISER', 'Main Street Coffee');
  const advUser = await person(adv, 'advertiser_admin', 'Alex Advertiser', false);
  const adAsset = asset('orange', 6);
  const campaign = (await q(`INSERT INTO campaigns (advertiser_org_id, name, category, status, starts_at, ends_at, pricing_model, rate_minor, markets, destination_url, submitted_at, created_by)
     VALUES ($1,'Morning latte','FOOD_DRINK','PENDING_REVIEW', now(), now() + interval '30 days','CPQV',50,'{Springfield}','https://example.com/latte', now(), $2) RETURNING id`, [adv, advUser.id]))[0].id;
  await q(`INSERT INTO creatives (campaign_id, name, kind, status, duration_ms, media_key) VALUES ($1,'Latte video','VIDEO','PENDING_REVIEW',6000,$2)`, [campaign, `assets/${adAsset}/720p.mp4`]);
  await q(`INSERT INTO creatives (campaign_id, name, kind, status, headline) VALUES ($1,'Banner','BANNER','PENDING_REVIEW','2-for-1 lattes today')`, [campaign]);

  // Creator with two videos awaiting moderation.
  const studio = await org('CREATOR_STUDIO', 'City Walks');
  const creatorUser = await person(studio, 'creator_owner', 'Casey Creator', false);
  const channel = (await q(`INSERT INTO creator_profiles (org_id, display_name) VALUES ($1,'City Walks') RETURNING id`, [studio]))[0].id;
  const video = async (title: string, color: string, rec: string) => {
    const a = asset(color, 8);
    const up = (await q(`INSERT INTO media_uploads (org_id, purpose, filename, declared_type, size_bytes, sha256, received_bytes, status, detected_type, created_by, completed_at, processed_at)
                         VALUES ($1,'CREATOR_VIDEO','v.mp4','video/mp4',1,$2,1,'READY','video/mp4',$3,now(),now()) RETURNING id`, [studio, '0'.repeat(64), creatorUser.id]))[0].id;
    await q(`INSERT INTO media_assets (id, upload_id, org_id, kind, duration_ms, rendition_key, thumbnail_key, probe) VALUES ($1,$2,$3,'VIDEO',8000,$4,$5,'{}')`,
      [a, up, studio, `assets/${a}/720p.mp4`, `assets/${a}/thumb.jpg`]);
    const v = (await q(`INSERT INTO videos (creator_id, title, status, duration_ms, media_key, asset_id, upload_id) VALUES ($1,$2,'PENDING_REVIEW',8000,$3,$4,$5) RETURNING id`,
      [channel, title, `assets/${a}/720p.mp4`, a, up]))[0].id;
    await q(`INSERT INTO moderation_cases (asset_id, subject_type, subject_id, policy_version, ai_recommendation, priority, scores, findings) VALUES ($1,'VIDEO',$2,'MODERATION_POLICY_V1',$3,'NORMAL','{}','{"notes":["synthetic"]}')`, [a, v, rec]);
    return v as string;
  };
  const riverVideo = await video('River walk', 'navy', 'LIKELY_OK');
  await video('Night market', 'maroon', 'NEEDS_REVIEW');
  // A third video already rejected by the super admin and appealed by the creator: a different reviewer must decide the appeal.
  const appealed = await video('Bridge timelapse', 'teal', 'NEEDS_REVIEW');
  const saH = await tokenFor(superAdmin);
  const caseId = (await q(`SELECT id FROM moderation_cases WHERE subject_id = $1`, [appealed]))[0].id;
  await api('POST', `/v1/moderation/cases/${caseId}/decision`, { decision: 'REJECT', reasons: ['LOW_QUALITY'], note: 'Too dark to see anything.' }, saH);
  const creatorH = { authorization: `Bearer ${(await api('POST', '/v1/auth/login', { email: creatorUser.email, password: PW })).token}` };
  await api('POST', `/v1/orgs/${studio}/videos/${appealed}/appeal`, { statement: 'It is a night timelapse; the darkness is intentional and shows the city lights.' }, creatorH);

  // A fleet driver awaiting eligibility.
  const fleetOrg = await org('FLEET_OPERATOR', 'Springfield Rides');
  const fleet = (await q(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'Main','Springfield','UTC') RETURNING id`, [fleetOrg]))[0].id;
  const driverUser = await person(fleetOrg, 'driver', 'Drew Driver', false);
  await q(`INSERT INTO drivers (org_id, fleet_id, user_id) VALUES ($1,$2,$3)`, [fleetOrg, fleet, driverUser.id]);

  // A manual journal entry requested by finance admin, awaiting a different approver.
  const finH = await tokenFor(finAdmin);
  await api('POST', '/v1/finance/journal-requests', { idempotencyKey: `e2e-${randomUUID()}`, entryDate: new Date().toISOString().slice(0, 10), description: 'Wire received from advertiser',
    reason: 'Advertiser paid by bank wire instead of card (SYNTHETIC)', lines: [{ accountCode: '1010', currency: 'USD', debit: '50000', processor: 'bank-wire' },
      { accountCode: '2000', currency: 'USD', credit: '50000', partyType: 'ADVERTISER', partyId: adv }] }, finH);

  const browser = await chromium.launch();
  const problems: string[] = [];
  const open = async (name: string) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(`${name} console: ${m.text()}`); });
    return p;
  };
  const signIn = async (p: import('playwright').Page, who: { email: string; secret: string }, mfa: boolean) => {
    await p.goto(`${BASE}/portal/`);
    await p.fill('#signin input[name=email]', who.email);
    await p.fill('#signin input[name=password]', PW);
    await p.click('#signin button[type=submit]');
    if (mfa) {
      await p.waitForSelector('#mfa');
      await p.fill('#mfa input[name=code]', totpAt(who.secret, Math.floor(Date.now() / 30_000)));
      await p.click('#mfa button[type=submit]');
    }
  };
  const nav = (p: import('playwright').Page, title: string) => p.click(`#nav a:has-text("${title}")`);

  try {
    step('a moderator without two-step verification is told to set it up; after setup the queues appear');
    const mod = await open('moderator');
    await signIn(mod, moderator, false);
    await mod.waitForSelector('#mfa-required');
    await nav(mod, 'Security');
    await mod.click('#mfa-card button');
    const modSecret = (await mod.textContent('#dlg .code'))!.trim();
    await mod.fill('#dlg input[name=code]', totpAt(modSecret, Math.floor(Date.now() / 30_000)));
    await mod.click('#dlg button:has-text("Turn on")');
    await mod.waitForSelector('#mfa-card:has-text("On.")');
    assert.equal(await mod.locator('#keygen').count(), 0, 'only the super admin sees the key generator');
    await nav(mod, 'Overview');
    await mod.waitForSelector('#stat-ads .n:has-text("1")');
    await mod.waitForSelector('#stat-videos .n:has-text("2")');
    await mod.waitForSelector('#stat-appeals .n:has-text("1")');
    await mod.screenshot({ path: path.join(SHOTS, 'staff-overview.png') });

    step('ad review: watch the video ad, approve it, reject the banner, approve the campaign');
    await nav(mod, 'Ad review');
    const card = mod.locator(`form[data-campaign="${campaign}"]`);
    await card.locator('video.preview').waitFor();
    const playable = await card.locator('video.preview').evaluate((v: HTMLVideoElement) => new Promise<boolean>((res) => {
      if (v.readyState >= 1) return res(v.duration > 5);
      v.addEventListener('loadedmetadata', () => res(v.duration > 5), { once: true }); v.addEventListener('error', () => res(false), { once: true });
    }));
    assert.ok(playable, 'reviewer can load the signed ad preview');
    await card.locator('.banner-preview:has-text("2-for-1 lattes today")').waitFor();
    const bannerId = (await q(`SELECT id FROM creatives WHERE campaign_id = $1 AND kind = 'BANNER'`, [campaign]))[0].id;
    await card.locator(`input[name="d-${bannerId}"][value=REJECT]`).check();
    await card.locator(`input[name="n-${bannerId}"]`).fill('Claim needs the offer terms.');
    await card.locator('textarea[name=note]').fill('Video ad approved; banner needs terms.');
    await mod.screenshot({ path: path.join(SHOTS, 'staff-ad-review.png') });
    await card.locator('button:has-text("Approve campaign")').click();
    await mod.waitForSelector('#toast:has-text("Campaign approved")');
    const [c] = await q(`SELECT status FROM campaigns WHERE id = $1`, [campaign]);
    assert.equal(c.status, 'APPROVED');
    assert.deepEqual((await q(`SELECT kind, status, review_note FROM creatives WHERE campaign_id = $1 ORDER BY kind`, [campaign])).map((r) => [r.kind, r.status, r.review_note]),
      [['BANNER', 'REJECTED', 'Claim needs the offer terms.'], ['VIDEO', 'APPROVED', null]]);

    step('video moderation: approve one, reject one with a reason, decide the appeal as a second reviewer');
    await nav(mod, 'Video moderation');
    const river = mod.locator('form[data-case]:has-text("River walk")');
    await river.locator('textarea[name=note]').fill('Original and family friendly.');
    await river.locator('button:has-text("Approve video")').click();
    await mod.waitForSelector('#toast:has-text("Video approved")');
    const night = mod.locator('form[data-case]:has-text("Night market")');
    await night.locator('textarea[name=note]').fill('Visible brand logos throughout.');
    await night.locator('button:has-text("Reject video")').click();
    await mod.waitForSelector('#toast.err:has-text("policy reason")');
    await night.locator('input[name=reason][value=COPYRIGHT]').check();
    await night.locator('button:has-text("Reject video")').click();
    await mod.waitForSelector('#toast:has-text("Video rejected")');
    await mod.click('[data-appeal] button:has-text("Overturn")');
    await mod.fill('#dlg textarea[name=note]', 'Agree: the darkness is the subject.');
    await mod.click('#dlg button:has-text("Save decision")');
    await mod.waitForSelector('#toast:has-text("Appeal decided")');
    assert.deepEqual((await q(`SELECT title, status FROM videos ORDER BY title`)).map((r) => `${r.title}:${r.status}`), ['Bridge timelapse:APPROVED', 'Night market:REJECTED', 'River walk:APPROVED']);

    step('copyright notice on the live video: the moderator upholds it');
    await api('POST', '/v1/takedowns', { videoId: riverVideo, complainantName: 'Pat Claimant', complainantEmail: 'pat@example.test', complainantAddress: '1 Main St, Springfield',
      copyrightedWork: 'River documentary (2024)', goodFaithStatement: true, accuracyUnderPenaltyOfPerjury: true, signature: 'Pat Claimant' });
    await nav(mod, 'Copyright notices');
    await mod.click('#takedowns tr:has-text("River walk") button:has-text("Uphold")');
    await mod.fill('#dlg textarea[name=note]', 'Claimant provided the original footage.');
    await mod.click('#dlg button:has-text("Save")');
    await mod.waitForSelector('#takedowns tr:has-text("River walk") .chip:has-text("upheld")');
    assert.equal(await mod.locator('#nav a:has-text("Finance"), #nav a:has-text("Earnings eligibility")').count(), 0, 'moderators see no finance or eligibility');

    step('super admin confirms creator monetization and driver eligibility with reasons');
    const sa = await open('super-admin');
    await signIn(sa, superAdmin, true);
    await sa.waitForSelector('#stat-creators .n:has-text("1")');
    // System health: plain-language checks; seeded revenue rules mean the checklist shows them as done.
    await q(`INSERT INTO job_status (job, last_started_at, last_ok_at) VALUES ('process-media', now(), now()) ON CONFLICT (job) DO UPDATE SET last_ok_at = now()`);
    await q(`INSERT INTO job_status (job, last_started_at, last_failed_at, last_error, consecutive_failures) VALUES ('allocate-windows', now(), now(), 'database timeout', 2)
             ON CONFLICT (job) DO UPDATE SET last_failed_at = now(), last_error = 'database timeout', consecutive_failures = 2`);
    await nav(sa, 'System health');
    await sa.waitForSelector('#health-overall:has-text("needs attention")');
    await sa.waitForSelector('tr[data-check="job:allocate-windows"]:has-text("Problem"):has-text("database timeout")');
    await sa.waitForSelector('tr[data-check="job:process-media"] .chip.ok');
    await sa.waitForSelector('#health-launch-checklist tr[data-check="email"]:has-text("To do")');
    await sa.screenshot({ path: path.join(SHOTS, 'staff-health.png'), fullPage: true });
    await q(`DELETE FROM job_status`);
    await sa.click('button:has-text("Refresh")');
    await sa.waitForSelector('#health-overall:not(:has-text("needs attention"))');

    // Key rotation helper: a fresh 32-byte key made in the browser, with no request to the server.
    await nav(sa, 'Security');
    const keyRequests: string[] = [];
    sa.on('request', (r) => { if (!r.url().includes('/portal/')) keyRequests.push(r.url()); });
    await sa.click('#keygen button:has-text("Generate a new key")');
    const key1 = (await sa.textContent('#new-key'))!.trim();
    await sa.click('#keygen button:has-text("Generate a new key")');
    const key2 = (await sa.textContent('#new-key'))!.trim();
    assert.equal(Buffer.from(key1, 'base64').length, 32);
    assert.notEqual(key1, key2);
    assert.deepEqual(keyRequests, [], 'generating a key sends nothing to the server');
    sa.removeAllListeners('request');
    await nav(sa, 'Earnings eligibility');
    await sa.click('#elig-creators tr[data-name="City Walks"] button:has-text("Change")');
    await sa.selectOption('#dlg select[name=status]', 'ELIGIBLE');
    await sa.fill('#dlg textarea[name=reason]', 'Identity, W-9 and payout onboarding verified (SYNTHETIC)');
    await sa.click('#dlg button:has-text("Save")');
    await sa.waitForSelector('#elig-creators tr[data-name="City Walks"] .chip:has-text("eligible")');
    await sa.click('#elig-tabs a:has-text("Drivers")');
    await sa.click('#elig-drivers tr[data-name="Drew Driver"] button:has-text("Change")');
    await sa.selectOption('#dlg select[name=status]', 'ELIGIBLE');
    await sa.fill('#dlg textarea[name=reason]', 'Subscription active and terms signed (SYNTHETIC)');
    await sa.click('#dlg button:has-text("Save")');
    await sa.waitForSelector('#elig-drivers tr[data-name="Drew Driver"] .chip:has-text("eligible")');
    await sa.screenshot({ path: path.join(SHOTS, 'staff-eligibility.png') });
    await nav(sa, 'Audit log');
    await sa.fill('#audit-filter', 'eligibility_changed');
    await sa.waitForSelector('#audit td:has-text("driver.eligibility_changed")');

    step('dual control: the requester cannot approve their own journal entry; a different approver posts it');
    const fin = await open('finance-admin');
    await signIn(fin, finAdmin, true);
    await nav(fin, 'Finance');
    await fin.waitForSelector('#journal-requests:has-text("bank wire")');
    assert.equal(await fin.locator('#journal-requests button:has-text("Approve")').count(), 0, 'requester has no approve button');
    const ap = await open('approver');
    await signIn(ap, finApprover, true);
    await nav(ap, 'Finance');
    await ap.waitForSelector('#trial-balance .chip:has-text("Balanced")');
    await ap.click('#journal-requests button:has-text("Approve")');
    await ap.click('#dlg button:has-text("Approve and post")');
    await ap.waitForSelector('#toast:has-text("Entry posted")');
    await ap.waitForSelector('#journal-requests:has-text("Nothing to approve")');
    await ap.waitForSelector('#trial-balance:has-text("$500.00")');
    const [bal] = await q(`SELECT balance::text FROM ledger_balances WHERE account_code = '2000' AND party_id = $1`, [adv]);
    assert.equal(bal.balance, '50000', 'advertiser credited by the approved entry');
    await ap.screenshot({ path: path.join(SHOTS, 'staff-finance.png') });

    step('revenue split rule: finance drafts it (pre-filled 5/60/35), one approver approves, a second different person gives final approval');
    await fin.reload(); await nav(fin, 'Finance');
    await fin.waitForSelector('#rules-current tr[data-category="CREATOR_CONTENT_AD"]:has-text("No approved rule")');
    await fin.click('#draft-rule');
    assert.equal(await fin.inputValue('#dlg input[name=driver]'), '5');
    assert.equal(await fin.inputValue('#dlg input[name=creator]'), '60');
    await fin.waitForSelector('#platform-share:has-text("Platform keeps 35%")');
    await fin.selectOption('#dlg select[name=category]', 'STANDALONE_AD');
    await fin.waitForSelector('#platform-share:has-text("Platform keeps 95%")');
    assert.equal(await fin.isDisabled('#dlg input[name=creator]'), true, 'no creator share for an ad without a creator');
    await fin.selectOption('#dlg select[name=category]', 'CREATOR_CONTENT_AD');
    await fin.fill('#dlg input[name=contract]', 'Driver & Creator Terms v1.0 (SYNTHETIC)');
    await fin.click('#dlg button:has-text("Save draft")');
    await fin.waitForSelector('#toast:has-text("Draft saved")');
    await fin.waitForSelector('#rules-drafts:has-text("0 of 2 approvals")');
    assert.equal(await fin.locator('#rules-drafts button').count(), 0, 'the drafter cannot approve');
    await ap.reload(); await nav(ap, 'Finance');
    await ap.click('#rules-drafts button:has-text("Approve")');
    await ap.click('#dlg button:has-text("Approve")');
    await ap.waitForSelector('#toast:has-text("First approval recorded")');
    await ap.waitForSelector('#rules-drafts:has-text("1 of 2 approvals"):has-text("waiting for a second")');
    await nav(sa, 'Finance');
    await sa.click('#rules-drafts button:has-text("Give final approval")');
    await sa.click('#dlg button:has-text("Give final approval")');
    await sa.waitForSelector('#toast:has-text("now in effect")');
    await sa.waitForSelector('#rules-current tr[data-category="CREATOR_CONTENT_AD"]:has-text("In effect v1"):has-text("platform 35%")');
    const [rule] = await q(`SELECT driver_bps, creator_bps, platform_bps, status, created_by <> approved_by_1 AND approved_by_1 <> approved_by_2 AND created_by <> approved_by_2 AS three_people
                              FROM revenue_rule_versions WHERE category = 'CREATOR_CONTENT_AD'`);
    assert.deepEqual(rule, { driver_bps: 500, creator_bps: 6000, platform_bps: 3500, status: 'APPROVED', three_people: true });
    await sa.screenshot({ path: path.join(SHOTS, 'staff-rules.png'), fullPage: true });

    step('Team: invite a second finance approver; email isn’t connected, so the link is shown to send yourself; they accept it');
    await nav(sa, 'Team');
    await sa.fill('#invite-form input[name=displayName]', 'Casey CTO');
    await sa.fill('#invite-form input[name=email]', 'cto@example.test');
    await sa.selectOption('#invite-form select[name=role]', 'finance_approver');
    await sa.click('#invite-form button:has-text("Send invitation")');
    const inviteLink = (await sa.textContent('#invite-link'))!.trim();
    assert.match(inviteLink, /\/portal\/\?invite=/);
    await sa.click('#dlg button:has-text("Done")');
    await sa.waitForSelector('#invitations tr:has-text("cto@example.test"):has-text("Pending")');
    const cto = await open('cto');
    await cto.goto(inviteLink);
    await cto.fill('#invite-form input[type=password]', 'a long cto passphrase 2026');
    await cto.click('#invite-form button[type=submit]');
    await cto.waitForSelector('text=Invitation accepted');
    assert.ok((await q(`SELECT accepted_at FROM invitations WHERE email = 'cto@example.test'`))[0].accepted_at, 'invitation accepted');

    assert.deepEqual(problems, [], 'no page errors or CSP violations');
    console.log(`  ✓ staff portal e2e passed (screenshots in ${SHOTS})`);
  } finally {
    await browser.close();
    await app.close();
    await db.end();
  }
}

main().catch((e) => { console.error('  ✗', e); process.exit(1); });
