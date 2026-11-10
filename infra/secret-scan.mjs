#!/usr/bin/env node
/**
 * Secret scan for this repository (it is public). Fails if a tracked file contains something shaped like a real
 * secret, especially the kinds GitHub's free scanning can't recognise: this app's own random keys and database URLs
 * with a password. Runs in CI and with `npm run check:secrets`. No dependencies; scans `git ls-files`.
 *   node infra/secret-scan.mjs              scan the repository
 *   node infra/secret-scan.mjs FILE…        scan specific files (used by the self-test)
 *   node infra/secret-scan.mjs --self-test  prove each rule fires on a fake secret and stays quiet on placeholders
 * A line that really must contain such a value (it never should) can end with: secret-scan: allow
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const RULES = [
  { name: 'committed .env file', file: /(^|\/)\.env(\.[^/]*)?$/, allowFile: /(^|\/)\.env\.example$/ },
  { name: 'private key', re: /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'AWS secret key', re: /(aws_secret_access_key|SECRET_ACCESS_KEY)["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}\b/i },
  { name: 'Stripe live key', re: /\b(sk|rk)_live_[0-9A-Za-z]{16,}/ },
  { name: 'Stripe webhook secret', re: /\bwhsec_[0-9A-Za-z]{24,}/ },
  { name: 'Resend API key', re: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub token', re: /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{30,}/ },
  // This app's own keys: 32 random bytes in base64 (44 chars) or long hex, assigned to one of its variables.
  { name: 'app key literal', re: /\b(APP_ENCRYPTION_KEY(_PREVIOUS)?|MEDIA_SIGNING_KEY|METRICS_TOKEN|RESEND_API_KEY|STRIPE_SECRET_KEY|BACKUP\d_S3_SECRET_ACCESS_KEY|MEDIA_S3_SECRET_ACCESS_KEY)["']?\s*[:=]\s*["']?(?![$<{]|REPLACE|CHANGE_ME)([A-Za-z0-9+/]{43}=|[0-9a-f]{32,}|[A-Za-z0-9+/_-]{32,})/ },
  // Connection strings with a real-looking password (12+ chars); test/dev placeholders like u:p@ or rmn:rmn@ pass.
  { name: 'database URL with password', re: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^:\s/'"@]+:(?!CHANGE_ME)[^@\s'"]{12,}@/ },
];

const ALLOW_LINE = /secret-scan: allow\s*$/;

function scan(files) {
  const hits = [];
  for (const f of files) {
    for (const r of RULES.filter((r) => r.file)) if (r.file.test(f) && !(r.allowFile?.test(f))) hits.push({ f, line: 0, rule: r.name });
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue; // binary
    text.split('\n').forEach((line, i) => {
      if (ALLOW_LINE.test(line)) return;
      for (const r of RULES) if (r.re && r.re.test(line)) hits.push({ f, line: i + 1, rule: r.name });
    });
  }
  return hits;
}

if (process.argv.includes('--self-test')) {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/secret-scan-`);
  const rnd = (n, set = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => Array.from(randomBytes(n), (b) => set[b % set.length]).join('');
  // Fake secrets, generated now (never real), one per rule.
  const bad = {
    'AWS access key id': `key = "AKIA${rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}"`,
    'AWS secret key': `AWS_SECRET_ACCESS_KEY=${rnd(40)}`,
    'Stripe live key': `STRIPE_KEY="sk_live_${rnd(24)}"`,
    'Stripe webhook secret': `whsec_${rnd(32)}`,
    'Resend API key': `token: 're_${rnd(8)}_${rnd(24)}'`,
    'GitHub token': `ghp_${rnd(36)}`,
    'private key': ['-----BEGIN EC', 'PRIVATE KEY-----'].join(' '), // assembled at run time so this file doesn't flag itself
    'app key literal': `APP_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
    'database URL with password': `DATABASE_URL=postgresql://postgres:${rnd(24)}@postgres.railway.internal:5432/railway`,
  };
  const good = ['DATABASE_URL=postgres://rmn:rmn@localhost:5432/rmn_test', "postgresql://u:p@db.example.com:5432/x", 'APP_ENCRYPTION_KEY=REPLACE_WITH_32_BYTE_BASE64_KEY',
    'MEDIA_SIGNING_KEY=${{api.MEDIA_SIGNING_KEY}}', "RESEND_API_KEY: z.string().regex(/^re_/)", "STRIPE_WEBHOOK_SECRET: 'whsec_testsecret123'", 'APP_ENCRYPTION_KEY=$(openssl rand -base64 32)',
    'DATABASE_URL=postgres://rmn:CHANGE_ME@localhost:5432/rmn_dev', `APP_ENCRYPTION_KEY=${randomBytes(32).toString('base64')} # secret-scan: allow`];
  let ok = true;
  for (const [rule, line] of Object.entries(bad)) {
    const p = `${dir}/bad-${rule.replace(/\W+/g, '-')}.txt`; writeFileSync(p, `${line}\n`);
    const h = scan([p]);
    if (!h.some((x) => x.rule === rule)) { console.error(`self-test: rule "${rule}" missed ${line.slice(0, 20)}…`); ok = false; }
  }
  const gp = `${dir}/good.txt`; writeFileSync(gp, good.join('\n'));
  const gh = scan([gp]);
  if (gh.length) { console.error('self-test: false positives:', gh); ok = false; }
  if (!scan([`${dir}/x/.env`]).length && !RULES[0].file.test('apps/api/.env')) ok = false;
  if (RULES[0].file.test('.env.example') && RULES[0].allowFile.test('.env.example') !== true) ok = false;
  console.log(ok ? `self-test passed: ${Object.keys(bad).length} rules fire on fake secrets, ${good.length} placeholders stay quiet` : 'self-test FAILED');
  process.exit(ok ? 0 : 1);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = args.length ? args : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter((f) => f && f !== 'package-lock.json');
const hits = scan(files);
if (hits.length) {
  console.error(`Possible secrets found (${hits.length}). Remove them, move real values to Railway variables, and rotate anything that was real:`);
  for (const h of hits) console.error(`  ${h.f}${h.line ? `:${h.line}` : ''}  ${h.rule}`);
  process.exit(1);
}
console.log(`secret scan: ${files.length} files clean`);
