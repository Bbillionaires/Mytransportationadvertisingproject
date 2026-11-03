/**
 * Tablet fleet load test (R-015). Starts the real API server as a separate process against a dedicated database,
 * enrolls N simulated tablets (real Ed25519 keys, real signed requests), and drives the tablet protocol on a compressed
 * schedule: heartbeat every HEARTBEAT_S, playlist every PLAYLIST_S, an event batch every EVENTS_S. Then times the
 * validation job over everything uploaded. Prints latency percentiles per endpoint and error counts.
 *
 *   TABLETS=300 DURATION_S=60 npx tsx load/tablet-load.ts
 *   (uses LOAD_DATABASE_URL, default postgres://rmn:rmn@localhost:5432/rmn_load — DROPS AND RECREATES its schema)
 *
 * SYNTHETIC data only. Run on an idle machine; numbers from a shared CI box are indicative.
 */
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import pg from 'pg';
import { createPool, withTx } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { postEntry } from '../src/modules/ledger/service.js';
import { runValidation } from '../src/modules/events/validator.js';

const TABLETS = Number(process.env.TABLETS ?? 300);
const DURATION_S = Number(process.env.DURATION_S ?? 60);
const HEARTBEAT_S = Number(process.env.HEARTBEAT_S ?? 10), PLAYLIST_S = Number(process.env.PLAYLIST_S ?? 30), EVENTS_S = Number(process.env.EVENTS_S ?? 20);
const PORT = Number(process.env.LOAD_PORT ?? 18090), BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_URL = process.env.LOAD_ADMIN_DB ?? 'postgres://rmn:rmn@localhost:5432/rmn_test';
const DB_URL = process.env.LOAD_DATABASE_URL ?? 'postgres://rmn:rmn@localhost:5432/rmn_load';

async function resetDb() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  if (!(await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'rmn_load'`)).rows[0]) await admin.query('CREATE DATABASE rmn_load');
  await admin.end();
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(DB_URL, () => {});
}

interface Tablet { id: string; key: KeyObject; campaign?: { campaignId: string; creativeId: string } }
const lat: Record<string, number[]> = {};
const errors: Record<string, number> = {};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function call(t: Tablet, method: 'GET' | 'POST', path: string, payload?: unknown) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(18).toString('base64url');
  const sig = sign(null, Buffer.from([method, path, ts, nonce, sha(body)].join('\n')), t.key).toString('base64');
  const name = `${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}`;
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { method, body: body || undefined, headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-device-id': t.id, 'x-device-timestamp': ts, 'x-device-nonce': nonce, 'x-device-signature': sig } });
    const j = await r.json().catch(() => ({}));
    (lat[name] ??= []).push(performance.now() - t0);
    if (!r.ok) errors[`${name} ${r.status}`] = (errors[`${name} ${r.status}`] ?? 0) + 1;
    return j as any;
  } catch (e) {
    errors[`${name} network`] = (errors[`${name} network`] ?? 0) + 1;
    return {};
  }
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

async function main() {
  console.log(`tablet load test: ${TABLETS} tablets for ${DURATION_S}s (heartbeat ${HEARTBEAT_S}s, playlist ${PLAYLIST_S}s, events ${EVENTS_S}s)`);
  await resetDb();
  const db = createPool(DB_URL);
  const q = (sql: string, p: unknown[] = []) => db.query(sql, p).then((r) => r.rows);

  // ---------- fixtures (SYNTHETIC) ----------
  await q(`INSERT INTO accounting_periods (period_start, period_end) VALUES (date_trunc('year', now())::date, (date_trunc('year', now()) + interval '1 year - 1 day')::date)`);
  const sys = (await q(`SELECT id FROM users LIMIT 1`))[0].id;
  const fleetOrg = (await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('FLEET_OPERATOR','Load Fleet',true) RETURNING id`))[0].id;
  const fleet = (await q(`INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,'Load','Springfield','UTC') RETURNING id`, [fleetOrg]))[0].id;
  const adv = (await q(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('ADVERTISER','Load Advertiser',true) RETURNING id`))[0].id;
  await withTx(db, (tx) => postEntry(tx, { idempotencyKey: `load-fund-${adv}`, entryDate: new Date().toISOString().slice(0, 10), description: 'prepayment', sourceType: 'PAYMENT',
    lines: [{ accountCode: '1010', currency: 'USD', debit: 100_000_000n, processor: 'stripe-test' }, { accountCode: '2000', currency: 'USD', credit: 100_000_000n, partyType: 'ADVERTISER', partyId: adv }] }));
  for (let i = 0; i < 5; i++) {
    const c = (await q(`INSERT INTO campaigns (advertiser_org_id, name, status, starts_at, ends_at, pricing_model, rate_minor, markets, created_by) VALUES ($1,$2,'APPROVED', now() - interval '1 hour', now() + interval '1 day','CPQV',50,'{Springfield}',$3) RETURNING id`, [adv, `Load ${i}`, sys]))[0].id;
    await q(`INSERT INTO creatives (campaign_id, kind, status, duration_ms, media_key) VALUES ($1,'VIDEO','APPROVED',15000,'assets/00000000-0000-0000-0000-000000000000/720p.mp4')`, [c]);
  }
  const tablets: Tablet[] = [];
  for (let i = 0; i < TABLETS; i++) {
    const kp = generateKeyPairSync('ed25519');
    const v = (await q(`INSERT INTO vehicles (org_id, fleet_id, label) VALUES ($1,$2,$3) RETURNING id`, [fleetOrg, fleet, `LOAD-${i}`]))[0].id;
    const d = (await q(`INSERT INTO devices (org_id, serial, public_key_der) VALUES ($1,$2,$3) RETURNING id`, [fleetOrg, `LOAD-${i}-${randomUUID().slice(0, 6)}`, kp.publicKey.export({ type: 'spki', format: 'der' })]))[0].id;
    await q(`INSERT INTO device_assignments (org_id, device_id, vehicle_id, created_by, starts_at) VALUES ($1,$2,$3,$4, now() - interval '1 hour')`, [fleetOrg, d, v, sys]);
    tablets.push({ id: d, key: kp.privateKey });
  }
  console.log(`  fixtures ready: ${TABLETS} tablets enrolled and assigned, 5 running campaigns`);

  // ---------- server as a separate process ----------
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: DB_URL, LOG_LEVEL: 'warn', DEV_IN_PROCESS_JOBS: 'false',
      APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'), STRIPE_WEBHOOK_SECRET: 'whsec_load', MEDIA_BASE_URL: `${BASE}/media` },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/readyz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 300)); }

  // ---------- drive the fleet ----------
  const until = Date.now() + DURATION_S * 1000;
  let uploaded = 0;
  const loop = async (t: Tablet) => {
    await new Promise((r) => setTimeout(r, Math.random() * HEARTBEAT_S * 1000)); // spread start times
    let nextHb = 0, nextPl = 0, nextEv = Date.now() + EVENTS_S * 1000 * (0.5 + Math.random() / 2), lastEnd = 0, firstHeartbeat = 0;
    while (Date.now() < until) {
      const now = Date.now();
      if (now >= nextHb) { firstHeartbeat ||= now; await call(t, 'POST', '/v1/devices/heartbeat', { appVersion: 'load', connectivity: 'CELLULAR', playback: { state: 'PLAYING' } }); nextHb = now + HEARTBEAT_S * 1000; }
      if (now >= nextPl) {
        const p = await call(t, 'GET', '/v1/devices/playlist');
        const ad = p.ads?.[Math.floor(Math.random() * (p.ads?.length ?? 1))];
        if (ad) t.campaign = { campaignId: ad.campaignId, creativeId: ad.creativeId };
        nextPl = now + PLAYLIST_S * 1000;
      }
      if (now >= nextEv && t.campaign && now - firstHeartbeat > 3 * 16_000 + 2000) {
        // Plays that just finished, back to back, never overlapping the previous batch (as a real tablet reports them).
        let clock = Math.max(lastEnd + 1000, firstHeartbeat + 1000, now - 3 * 16_000 - 1000);
        const events = Array.from({ length: 3 }, () => { const s = clock; clock += 16_000; lastEnd = s + 15_000; return { type: 'AD_PLAYBACK', eventId: randomUUID(), ...t.campaign, startedAt: new Date(s).toISOString(), endedAt: new Date(s + 15_000).toISOString(), visibleMs: 15_000, mutedMs: 0, completed: true }; });
        const r = await call(t, 'POST', '/v1/devices/events', { batchId: randomUUID(), events });
        uploaded += r.accepted ?? 0;
        nextEv = now + EVENTS_S * 1000;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  const t0 = Date.now();
  await Promise.all(tablets.map(loop));
  const seconds = (Date.now() - t0) / 1000;

  // ---------- validation job over everything uploaded ----------
  const v0 = performance.now();
  let validated = 0;
  for (;;) { const r = await runValidation(db, 5000); validated += r.processed; if (!r.processed) break; }
  const validationMs = performance.now() - v0;
  const outcome = await q(`SELECT status, count(*)::int n FROM validated_events GROUP BY status ORDER BY status`);

  server.kill('SIGTERM');
  await db.end();

  // ---------- report ----------
  const total = Object.values(lat).reduce((a, x) => a + x.length, 0);
  console.log(`\n  ${total} requests in ${seconds.toFixed(0)} s = ${(total / seconds).toFixed(1)} req/s from ${TABLETS} tablets`);
  console.log('  endpoint                         count     p50     p95     p99     max  (ms)');
  for (const [k, xs] of Object.entries(lat).sort()) console.log(`  ${k.padEnd(32)} ${String(xs.length).padStart(5)} ${pct(xs, 50).toFixed(0).padStart(7)} ${pct(xs, 95).toFixed(0).padStart(7)} ${pct(xs, 99).toFixed(0).padStart(7)} ${Math.max(...xs).toFixed(0).padStart(7)}`);
  console.log(`  errors: ${Object.keys(errors).length ? JSON.stringify(errors) : 'none'}`);
  console.log(`  events uploaded: ${uploaded}; validation job: ${validated} events in ${(validationMs / 1000).toFixed(1)} s (${(validated / (validationMs / 1000)).toFixed(0)} events/s); outcome ${outcome.map((o) => `${o.status}=${o.n}`).join(' ')}`);
  if (Object.keys(errors).length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
