/**
 * One-time setup and health check for media storage (run after configuring buckets, and on every deploy):
 *   - main bucket: reachable; CORS lets the tablet player (APP_PUBLIC_URL) download media for its offline cache;
 *   - backup buckets: reachable; versioning ON and Object Lock ON with a default retention (refuses to pass otherwise).
 * Never deletes anything. Exit code 1 = something must be fixed before going live.
 *   npm run jobs:check-media-storage -w @rmn/api
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GetBucketVersioningCommand, GetObjectLockConfigurationCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig, type Config } from '../config.js';
import { ensureMediaCors, mediaStores, ObjectExistsError } from '../lib/objectStore.js';

const config = loadConfig();
const results: Array<{ check: string; ok: boolean | 'warn'; detail?: string }> = [];
const ok = (check: string, detail?: string) => results.push({ check, ok: true, detail });
const fail = (check: string, detail: string) => results.push({ check, ok: false, detail });
const warn = (check: string, detail: string) => results.push({ check, ok: 'warn', detail });
let lockedBackups = 0;

const client = (p: 'MEDIA_S3' | 'BACKUP1_S3' | 'BACKUP2_S3') => {
  const c = config as Config & Record<string, string | undefined>;
  return new S3Client({ region: c[`${p}_REGION`] && c[`${p}_REGION`] !== 'auto' ? c[`${p}_REGION`]! : 'us-east-1', ...(c[`${p}_ENDPOINT`] ? { endpoint: c[`${p}_ENDPOINT`] } : {}),
    forcePathStyle: c[`${p}_FORCE_PATH_STYLE`] === 'true', credentials: { accessKeyId: c[`${p}_ACCESS_KEY_ID`]!, secretAccessKey: c[`${p}_SECRET_ACCESS_KEY`]! } });
};

const { primary, backups } = mediaStores(config);
const probe = path.join(await mkdtemp(path.join(tmpdir(), 'rmn-chk-')), 'probe');
await writeFile(probe, `storage check ${new Date().toISOString()}`);

// Main bucket: write-once probe object under a fixed health key, then read it back.
try {
  if (!(await primary.head('health/probe'))) await primary.putFile('health/probe', probe, { ifNotExists: true }).catch((e) => { if (!(e instanceof ObjectExistsError)) throw e; });
  (await primary.head('health/probe')) ? ok(`${primary.name}: reachable, write + read`) : fail(`${primary.name}: reachable`, 'probe object not readable');
} catch (e) { fail(`${primary.name}: reachable`, (e as Error).message); }

if (config.MEDIA_STORE === 's3') {
  try {
    const c = await ensureMediaCors(config);
    ok(`${primary.name}: CORS allows ${c.origins.join(', ')} (tablet media cache)`);
  } catch (e) { fail(`${primary.name}: CORS`, `${(e as Error).message} — tablets will still stream, but cannot keep offline copies`); }
} else ok(`${primary.name}: local disk (development)`);

if (!backups.length) fail('backups', 'no backup bucket configured (BACKUP1_S3_BUCKET …)');
for (const [i, b] of backups.entries()) {
  const prefix = (`BACKUP${i + 1}_S3`) as 'BACKUP1_S3' | 'BACKUP2_S3';
  const bucket = (config as Record<string, unknown>)[`${prefix}_BUCKET`] as string;
  try {
    const v = await client(prefix).send(new GetBucketVersioningCommand({ Bucket: bucket }));
    v.Status === 'Enabled' ? ok(`${b.name}: versioning enabled`) : warn(`${b.name}: versioning`, `status is ${v.Status ?? 'off'} (fine for a secondary copy; the locked archive needs it)`);
  } catch (e) { warn(`${b.name}: versioning`, `${(e as Error).message} (provider may not support it)`); }
  try {
    const l = await client(prefix).send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
    const r = l.ObjectLockConfiguration?.Rule?.DefaultRetention;
    if (l.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled' && r) { lockedBackups++; ok(`${b.name}: Object Lock ${r.Mode} ${r.Days ? `${r.Days} days` : `${r.Years} years`}`); }
    else warn(`${b.name}: Object Lock`, 'enabled without a default retention rule; set one (Governance recommended)');
  } catch (e) { warn(`${b.name}: Object Lock`, `not available (${(e as Error).message.slice(0, 80)}) — this copy can be erased with its keys`); }
  try { if (!(await b.head('health/probe'))) await b.putFile('health/probe', probe, { ifNotExists: true }).catch((e) => { if (!(e instanceof ObjectExistsError)) throw e; }); ok(`${b.name}: can add files`); }
  catch (e) { fail(`${b.name}: can add files`, (e as Error).message); }
}

if (backups.length && !lockedBackups) fail('locked backup', 'no backup bucket has Object Lock; at least one copy must be undeletable (the AWS archive)');
for (const r of results) console.log(`${r.ok === 'warn' ? 'WARN' : r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail ? ` — ${r.detail}` : ''}`);
if (results.some((r) => r.ok === false)) process.exitCode = 1;
