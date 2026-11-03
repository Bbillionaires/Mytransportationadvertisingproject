/**
 * Helper for infra/media-worker/verify.sh: migrates the database, creates a SYNTHETIC advertiser and uploads a real
 * video through the API's resumable upload endpoints (so the file lands in MEDIA_ROOT exactly as in production).
 * Prints the upload id. Run from apps/api: npx tsx ../../infra/media-worker/upload-fixture.mts <video.mp4>
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { createPool } from '../../apps/api/src/db/pool.js';
import { migrate } from '../../apps/api/src/db/migrate.js';
import { hashPassword } from '../../apps/api/src/lib/crypto.js';

const file = readFileSync(process.argv[2]!);
const config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), MEDIA_SIGNING_KEY: randomBytes(32).toString('base64'), STRIPE_WEBHOOK_SECRET: 'whsec_verify' });
await migrate(config.DATABASE_URL, () => {});
const db = createPool(config.DATABASE_URL);
const app = await buildApp({ config, db, logger: false });
const org = (await db.query(`INSERT INTO organizations (kind, name, is_synthetic) VALUES ('ADVERTISER','Worker check',true) RETURNING id`)).rows[0].id;
const email = `worker-${randomBytes(4).toString('hex')}@example.test`;
const u = (await db.query(`INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1,$2,'Worker check', now()) RETURNING id`, [email, await hashPassword('worker-check-password')])).rows[0].id;
await db.query(`INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,'advertiser_admin')`, [u, org]);
const token = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'worker-check-password' } })).json().token;
const h = { authorization: `Bearer ${token}` };
const up = (await app.inject({ method: 'POST', url: `/v1/orgs/${org}/uploads`, headers: h, payload: { filename: 'ad.mp4', contentType: 'video/mp4', sizeBytes: file.length, sha256: createHash('sha256').update(file).digest('hex') } })).json();
await app.inject({ method: 'PUT', url: `/v1/uploads/${up.uploadId}/content`, headers: { ...h, 'content-type': 'application/octet-stream', 'content-range': `bytes 0-${file.length - 1}/${file.length}` }, payload: file });
const done = (await app.inject({ method: 'POST', url: `/v1/uploads/${up.uploadId}/complete`, headers: h })).json();
if (done.status !== 'UPLOADED') throw new Error(JSON.stringify(done));
console.log(up.uploadId);
await app.close(); await db.end();
