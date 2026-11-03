/**
 * End-to-end: a creator signs up in the business portal, confirms their email, uploads real videos with the rights
 * statement, follows human review (rejection with reasons → appeal; approval → live), answers a copyright notice
 * with a counter-notice, and downloads a ledger statement. Real Chromium, API, PostgreSQL and ffmpeg.
 * Run: npm run e2e -w @rmn/portal (DROPS AND RECREATES rmn_e2e).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { processPendingUploads } from '../../api/src/modules/media/process.js';

const PORT = 18084, BASE = `http://127.0.0.1:${PORT}`;
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

const work = mkdtempSync(path.join(tmpdir(), 'rmn-creator-e2e-'));
function videoFile(seconds: number, color: string, name: string) {
  const out = path.join(work, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=1280x720:d=${seconds}:r=24`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', out]);
  return out;
}

async function main() {
  console.log('creator portal e2e');
  await resetDb();
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'),
    MEDIA_BASE_URL: `${BASE}/media`, MEDIA_ROOT: path.join(work, 'media'), STRIPE_WEBHOOK_SECRET: 'whsec_e2e', LOG_LEVEL: 'silent', APP_PUBLIC_URL: BASE });
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
  const emailLink = async (to: string, template: string) => (await q(`SELECT body_text FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY id DESC LIMIT 1`, [to, template]))[0].body_text.match(/https?:\/\/\S+/)[0] as string;
  const worker = setInterval(() => { void processPendingUploads(db, config).catch(() => {}); }, 1000);

  // Staff reviewer (SYNTHETIC). The staff review screens are not in the portal yet, so the reviewer acts through the API.
  const platform = (await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('PLATFORM','Platform',true) RETURNING id`))[0].id;
  const revEmail = `mod-${randomUUID().slice(0, 8)}@example.test`;
  const revId = (await q(`INSERT INTO users (email, password_hash, display_name, email_verified_at, mfa_enabled, mfa_secret_enc) VALUES ($1,$2,'Rita Reviewer', now(), true, 'placeholder') RETURNING id`,
    [revEmail, await hashPassword('e2e-password-123')]))[0].id;
  await q(`INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,'moderator')`, [revId, platform]);
  const staff = { authorization: `Bearer ${(await api('POST', '/v1/auth/login', { email: revEmail, password: 'e2e-password-123' })).token}` };
  await q(`UPDATE sessions SET mfa_verified_at = now() WHERE user_id = $1`, [revId]); // MFA flow is covered in portal.e2e and auth tests
  const openCase = async (title: string) => {
    for (let i = 0; i < 60; i++) {
      const c = (await api('GET', '/v1/moderation/queue', undefined, staff)).items.find((x: any) => x.title === title);
      if (c) return c.id as string;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`no moderation case for ${title}`);
  };

  const browser = await chromium.launch();
  const problems: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(`console: ${m.text()}`); });
  const nav = (title: string) => page.click(`#nav a:has-text("${title}")`);
  const email = `creator-${randomUUID().slice(0, 8)}@example.test`;

  try {
    step('sign up as a creator in the portal and confirm the email from the link');
    await page.goto(`${BASE}/portal/`);
    await page.click('#to-register');
    await page.check('#register input[value=creator]');
    await page.fill('#register input[name=org]', 'City Walks');
    await page.fill('#register input[name=displayName]', 'Casey Creator');
    await page.fill('#register input[name=email]', email);
    await page.fill('#register input[name=password]', 'short');
    await page.click('#register button[type=submit]');
    assert.equal(await page.locator('#register').count(), 1, 'browser blocks a short password'); // minlength
    await page.fill('#register input[name=password]', 'a long creator passphrase');
    await page.click('#register button[type=submit]');
    await page.waitForSelector('#signin:has-text("confirmation link")');
    await page.goto(await emailLink(email, 'verify_email'));
    await page.waitForSelector('#signin:has-text("Email confirmed")');
    await page.fill('#signin input[name=email]', email);
    await page.fill('#signin input[name=password]', 'a long creator passphrase');
    await page.click('#signin button[type=submit]');
    await page.waitForSelector('#channel:has-text("Not yet earning")');
    await page.waitForSelector('#todo:has-text("Upload your first video")');

    step('upload a video: the rights statement must be accepted; the video is processed by ffmpeg then queued for review');
    await nav('Videos');
    await page.click('#upload-video');
    await page.setInputFiles('#dlg input[type=file]', videoFile(10, 'purple', 'murals.mp4'));
    await page.fill('#dlg input[name=title]', 'Downtown murals');
    await page.click('#dlg button:has-text("Upload and submit")');
    assert.ok(await page.locator('#dlg[open] fieldset.attestation').isVisible(), 'cannot submit without the rights statement');
    for (let i = 0; i < 4; i++) await page.check(`#dlg input[name=a${i}]`);
    await page.click('#dlg button:has-text("Upload and submit")');
    await page.waitForSelector('#toast:has-text("Uploaded")', { timeout: 60_000 });
    await page.waitForSelector('#videos tr[data-title="Downtown murals"] .chip:has-text("In review")', { timeout: 30_000 });
    const [att] = await q(`SELECT ra.statement_version FROM rights_attestations ra JOIN videos v ON v.id = ra.video_id WHERE v.title = 'Downtown murals'`);
    assert.equal(att.statement_version, 'RIGHTS_ATTESTATION_V1', 'attestation stored');

    step('a reviewer rejects it with a reason; the creator sees why and appeals');
    await api('POST', `/v1/moderation/cases/${await openCase('Downtown murals')}/decision`, { decision: 'REJECT', reasons: ['LOW_QUALITY'], note: 'The video is a single color frame.' }, staff);
    await page.reload();
    await page.waitForSelector('#videos tr[data-title="Downtown murals"]:has-text("low quality")');
    await page.click('#videos tr[data-title="Downtown murals"] button:has-text("Appeal")');
    await page.fill('#dlg textarea[name=statement]', 'This is an intentional art piece about the mural palette.');
    await page.click('#dlg button:has-text("Send appeal")');
    await page.waitForSelector('#videos tr[data-title="Downtown murals"]:has-text("Appeal under review")');
    assert.equal(await page.locator('#videos tr[data-title="Downtown murals"] button:has-text("Appeal")').count(), 0, 'one appeal per decision');

    step('a second video is approved and goes live');
    await page.click('#upload-video');
    await page.setInputFiles('#dlg input[type=file]', videoFile(12, 'navy', 'river.mp4'));
    await page.fill('#dlg input[name=title]', 'River walk');
    await page.fill('#dlg textarea[name=description]', 'A calm walk along the river.');
    for (let i = 0; i < 4; i++) await page.check(`#dlg input[name=a${i}]`);
    await page.click('#dlg button:has-text("Upload and submit")');
    await page.waitForSelector('#toast:has-text("Uploaded")', { timeout: 60_000 });
    await api('POST', `/v1/moderation/cases/${await openCase('River walk')}/decision`, { decision: 'APPROVE', note: 'Family friendly and original.' }, staff);
    await page.reload();
    await page.waitForSelector('#videos tr[data-title="River walk"] .chip:has-text("Live")');
    await page.waitForSelector('#videos tr[data-title="River walk"] img.thumb');
    await page.screenshot({ path: path.join(SHOTS, 'creator-videos.png') });

    step('a copyright notice removes the live video; the creator sends a sworn counter-notice');
    const videoId = (await q(`SELECT id FROM videos WHERE title = 'River walk'`))[0].id;
    await api('POST', '/v1/takedowns', { videoId, complainantName: 'Pat Claimant', complainantEmail: 'pat@example.test', complainantAddress: '1 Main St, Springfield',
      copyrightedWork: 'River documentary (2024)', goodFaithStatement: true, accuracyUnderPenaltyOfPerjury: true, signature: 'Pat Claimant' });
    await page.reload();
    await page.waitForSelector('#videos tr[data-title="River walk"] .chip:has-text("Removed")');
    await nav('Overview');
    await page.waitForSelector('#todo:has-text("copyright notice")');
    await nav('Videos');
    await page.click('#videos tr[data-title="River walk"] button:has-text("Counter-notice")');
    await page.fill('#dlg textarea[name=statement]', 'I filmed this walk myself on my own phone in May.');
    await page.check('#dlg input[name=goodFaith]');
    await page.check('#dlg input[name=jurisdiction]');
    await page.fill('#dlg input[name=signature]', 'Casey Creator');
    await page.click('#dlg button:has-text("Send counter-notice")');
    await page.waitForSelector('#videos tr[data-title="River walk"]:has-text("Counter-notice sent")');

    step('performance and earnings pages; statements download from the ledger');
    await nav('Performance');
    await page.waitForSelector('#performance td:has-text("River walk")');
    await page.click('#range a:has-text("90 days")');
    await page.waitForSelector('#range a.primary:has-text("90 days")');
    await nav('Earnings');
    await page.waitForSelector('#disclosure:has-text("Earnings are not guaranteed")');
    const [pdf] = await Promise.all([page.waitForEvent('download'), page.click('#statement-form button:has-text("Download PDF")')]);
    const bytes = readFileSync((await pdf.path())!);
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-', 'statement is a PDF');
    await page.screenshot({ path: path.join(SHOTS, 'creator-earnings.png') });

    step('once staff confirm monetization eligibility, the channel shows as earning');
    await q(`UPDATE creator_profiles SET monetization_status = 'ELIGIBLE' WHERE display_name = 'City Walks'`); // staff screen comes with the staff section
    await nav('Overview');
    await page.waitForSelector('#channel:has-text("Earning")');
    await page.screenshot({ path: path.join(SHOTS, 'creator-overview.png') });

    const org = (await q(`SELECT id FROM organizations WHERE name = 'City Walks'`))[0].id;
    const audit = (await q(`SELECT action FROM audit_log WHERE org_id = $1`, [org])).map((r) => r.action);
    for (const a of ['creator.self_registered', 'media.uploaded', 'video.submitted', 'video.appealed', 'takedown.counter_noticed']) assert.ok(audit.includes(a), `audited: ${a}`);
    assert.deepEqual(problems, [], 'no page errors or CSP violations');
    console.log(`  ✓ creator portal e2e passed (screenshots in ${SHOTS})`);
  } finally {
    clearInterval(worker);
    await page.screenshot({ path: path.join(SHOTS, 'creator-final.png') }).catch(() => {});
    await browser.close();
    await app.close();
    await db.end();
  }
}

main().catch((e) => { console.error('  ✗', e); process.exit(1); });
