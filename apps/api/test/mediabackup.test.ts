/**
 * Object storage + backups against a real S3 API (moto in dev/CI; same code talks to Railway Buckets and AWS S3).
 * Needs an S3-compatible endpoint at TEST_S3_ENDPOINT (default http://127.0.0.1:5055). CI starts moto and sets
 * REQUIRE_S3_TESTS=true so these never silently skip there.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CreateBucketCommand, GetBucketCorsCommand, DeleteObjectCommand, ListObjectVersionsCommand, PutObjectCommand, PutObjectLockConfigurationCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ensureMediaCors, mediaStores, ObjectExistsError } from '../src/lib/objectStore.js';
import { restoreMedia, runBackups, verifyMedia } from '../src/modules/media/backup.js';
import { processPendingUploads } from '../src/modules/media/process.js';
import { org, setupApp, userWithRole, type Ctx } from './helpers.js';

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:5055';
const reachable = await fetch(ENDPOINT).then(() => true, () => false);
if (!reachable && process.env.REQUIRE_S3_TESTS === 'true') throw new Error(`S3 test endpoint ${ENDPOINT} is not reachable`);
if (!reachable) console.warn(`[mediabackup] skipped: no S3-compatible endpoint at ${ENDPOINT} (start moto: moto_server -p 5055)`);

const raw = new S3Client({ endpoint: ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
const run = randomUUID().slice(0, 8);
const PRIMARY = `rmn-primary-${run}`, BACKUP1 = `rmn-backup-locked-${run}`, BACKUP2 = `rmn-backup-second-${run}`;
const s3env = (prefix: string, bucket: string) => ({ [`${prefix}_ENDPOINT`]: ENDPOINT, [`${prefix}_REGION`]: 'us-east-1', [`${prefix}_BUCKET`]: bucket,
  [`${prefix}_ACCESS_KEY_ID`]: 'test', [`${prefix}_SECRET_ACCESS_KEY`]: 'test', [`${prefix}_FORCE_PATH_STYLE`]: 'true' });

let ctx: Ctx;
let video: Buffer;
let uploadId: string;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!reachable)('media object storage and backups (R-021)', () => {
  beforeAll(async () => {
    await raw.send(new CreateBucketCommand({ Bucket: PRIMARY }));
    await raw.send(new CreateBucketCommand({ Bucket: BACKUP1, ObjectLockEnabledForBucket: true })); // like the production AWS bucket
    await raw.send(new PutObjectLockConfigurationCommand({ Bucket: BACKUP1, ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 365 } } } }));
    await raw.send(new CreateBucketCommand({ Bucket: BACKUP2 }));
    ctx = await setupApp({ env: { MEDIA_STORE: 's3', ...s3env('MEDIA_S3', PRIMARY), ...s3env('BACKUP1_S3', BACKUP1), BACKUP1_S3_STORAGE_CLASS: 'GLACIER_IR', ...s3env('BACKUP2_S3', BACKUP2) } });
    const dir = mkdtempSync(path.join(tmpdir(), 'rmn-s3-'));
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(dir, 'ad.mp4')]);
    video = readFileSync(path.join(dir, 'ad.mp4'));
  }, 60_000);
  afterAll(async () => { await ctx?.app.close(); await ctx?.db.end(); });

  it('a verified upload is stored as an immutable original in the bucket; processing writes renditions there; links are signed and direct', async () => {
    const adv = await org(ctx.db, 'ADVERTISER');
    const admin = await userWithRole(ctx, adv, 'advertiser_admin');
    await ctx.db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [admin.userId]);
    const u = (await ctx.app.inject({ method: 'POST', url: `/v1/orgs/${adv}/uploads`, headers: admin.h, payload: { filename: 'ad.mp4', contentType: 'video/mp4', sizeBytes: video.length, sha256: sha(video) } })).json();
    uploadId = u.uploadId;
    await ctx.app.inject({ method: 'PUT', url: `/v1/uploads/${uploadId}/content`, headers: { ...admin.h, 'content-type': 'application/octet-stream', 'content-range': `bytes 0-${video.length - 1}/${video.length}` }, payload: video });
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/uploads/${uploadId}/complete`, headers: admin.h })).json().status).toBe('UPLOADED');
    const { primary } = mediaStores(ctx.config);
    expect(await primary.head(`originals/${uploadId}`)).toEqual({ size: video.length, sha256: sha(video) });

    expect((await processPendingUploads(ctx.db, ctx.config)).ready).toBeGreaterThanOrEqual(1);
    const st = (await ctx.app.inject({ method: 'GET', url: `/v1/uploads/${uploadId}`, headers: admin.h })).json();
    expect(st.status).toBe('READY');
    expect(st.asset.thumbnailUrl).toMatch(new RegExp(`^${ENDPOINT}/${PRIMARY}/assets/.+/thumb\\.jpg\\?.*X-Amz-Signature=`));
    const img = await fetch(st.asset.thumbnailUrl);
    expect(img.status).toBe(200); // fetched straight from the bucket, not through the API
    expect(Buffer.from(await img.arrayBuffer()).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    expect(await primary.head(`originals/${uploadId}`)).toEqual({ size: video.length, sha256: sha(video) }); // untouched by processing
  });

  it('backs up originals to every backup bucket, once; backups cannot be overwritten, and locked versions cannot be deleted', async () => {
    // Other test files share this database (their originals live on local disk), so assert on this upload's records.
    const rows = async () => (await ctx.db.query(`SELECT target, copied_at FROM media_backups WHERE upload_id = $1 ORDER BY target`, [uploadId])).rows;
    await runBackups(ctx.db, ctx.config, 1000);
    const first = await rows();
    expect(first.map((r) => r.target)).toEqual(['backup1', 'backup2']);
    await runBackups(ctx.db, ctx.config, 1000);
    expect(await rows()).toEqual(first); // idempotent: copied once per target
    const [b1, b2] = mediaStores(ctx.config).backups;
    expect(await b1!.head(`originals/${uploadId}`)).toEqual({ size: video.length, sha256: sha(video) });
    expect(await b2!.head(`originals/${uploadId}`)).toEqual({ size: video.length, sha256: sha(video) });
    const scratch = path.join(mkdtempSync(path.join(tmpdir(), 'rmn-ow-')), 'x');
    await import('node:fs/promises').then((f) => f.writeFile(scratch, 'tampered'));
    await expect(b1!.putFile(`originals/${uploadId}`, scratch, { ifNotExists: true })).rejects.toBeInstanceOf(ObjectExistsError);
    const versions = await raw.send(new ListObjectVersionsCommand({ Bucket: BACKUP1, Prefix: `originals/${uploadId}` }));
    await expect(raw.send(new DeleteObjectCommand({ Bucket: BACKUP1, Key: `originals/${uploadId}`, VersionId: versions.Versions![0]!.VersionId }))).rejects.toThrow();
  });

  it('nightly audit is clean, then detects a lost original and lost renditions; restore brings everything back from the backup', async () => {
    const clean = await verifyMedia(ctx.db, ctx.config);
    expect(clean.problems.filter((p) => p.uploadId === uploadId)).toEqual([]);
    const asset = (await ctx.db.query('SELECT rendition_key, thumbnail_key FROM media_assets WHERE upload_id = $1', [uploadId])).rows[0];
    for (const key of [`originals/${uploadId}`, asset.rendition_key, asset.thumbnail_key]) await raw.send(new DeleteObjectCommand({ Bucket: PRIMARY, Key: key })); // disaster in the main bucket
    const broken = (await verifyMedia(ctx.db, ctx.config)).problems.filter((p) => p.uploadId === uploadId);
    expect(broken).toEqual(expect.arrayContaining([
      { uploadId, where: 'primary', problem: 'MISSING' },
      { uploadId, where: 'primary', problem: 'RENDITION_MISSING', detail: asset.rendition_key },
    ]));
    const r = await restoreMedia(ctx.db, ctx.config, { uploadIds: [uploadId] });
    expect(r).toMatchObject({ restoredOriginals: 1, rerendered: 1, failed: [] });
    expect((await verifyMedia(ctx.db, ctx.config)).problems.filter((p) => p.uploadId === uploadId)).toEqual([]);
    expect(await mediaStores(ctx.config).primary.head(asset.rendition_key)).not.toBeNull();
  }, 60_000);

  it('detects an original corrupted in place and restores the good copy; re-copies a missing backup automatically', async () => {
    await raw.send(new PutObjectCommand({ Bucket: PRIMARY, Key: `originals/${uploadId}`, Body: 'corrupted', Metadata: { sha256: sha(video) } }));
    expect((await verifyMedia(ctx.db, ctx.config)).problems).toEqual(expect.arrayContaining([{ uploadId, where: 'primary', problem: 'SIZE_MISMATCH' }]));
    expect((await restoreMedia(ctx.db, ctx.config, { uploadIds: [uploadId] })).restoredOriginals).toBe(1);
    expect((await verifyMedia(ctx.db, ctx.config, { deep: true })).problems.filter((p) => p.uploadId === uploadId)).toEqual([]); // deep: re-hashed content
    await raw.send(new DeleteObjectCommand({ Bucket: BACKUP2, Key: `originals/${uploadId}` })); // the unlocked backup loses its copy
    const v = await verifyMedia(ctx.db, ctx.config);
    expect(v.repaired).toBeGreaterThanOrEqual(1);
    expect(v.problems.filter((p) => p.uploadId === uploadId)).toEqual([]);
    expect(await mediaStores(ctx.config).backups[1]!.head(`originals/${uploadId}`)).toEqual({ size: video.length, sha256: sha(video) });
    const audit = (await ctx.db.query(`SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id`, [uploadId])).rows.map((x) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['media.original_restored', 'media.renditions_recreated']));
  }, 60_000);

  it('refuses to start in s3 mode without credentials', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', APP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), MEDIA_SIGNING_KEY: Buffer.alloc(32).toString('base64'),
      STRIPE_WEBHOOK_SECRET: 'whsec_x', MEDIA_STORE: 's3', MEDIA_S3_BUCKET: 'b' })).toThrow(/MEDIA_S3_ACCESS_KEY_ID/);
  });
});

describe.skipIf(!reachable)('media bucket CORS for the tablet offline cache', () => {
  it('the worker’s ensureMediaCors allows exactly the app’s web addresses, read-only, and is safe to repeat', async () => {
    const bucket = `rmn-cors-${run}`;
    await raw.send(new CreateBucketCommand({ Bucket: bucket }));
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', APP_ENCRYPTION_KEY: 'A'.repeat(43) + '=', MEDIA_SIGNING_KEY: 'B'.repeat(43) + '=',
      PAYMENTS_PROVIDER: 'disabled', MEDIA_STORE: 's3', ...s3env('MEDIA_S3', bucket), APP_PUBLIC_URL: 'https://app.azothadz.example',
      MEDIA_CORS_EXTRA_ORIGINS: 'https://api-production-81031.up.railway.app/, https://app.azothadz.example' });
    expect(await ensureMediaCors(config)).toEqual({ applied: true, origins: ['https://app.azothadz.example', 'https://api-production-81031.up.railway.app'] });
    await ensureMediaCors(config);
    const rules = (await raw.send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules!;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ AllowedOrigins: ['https://app.azothadz.example', 'https://api-production-81031.up.railway.app'], AllowedMethods: ['GET', 'HEAD'] });
  });
});

describe.skipIf(!reachable)('backup storage class', () => {
  it('the locked AWS-style backup is written as Glacier Instant Retrieval (instant restores, low cost)', async () => {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const keys = (await raw.send(new ListObjectVersionsCommand({ Bucket: BACKUP1, Prefix: 'originals/' }))).Versions ?? [];
    expect(keys.length).toBeGreaterThan(0);
    const h = await raw.send(new HeadObjectCommand({ Bucket: BACKUP1, Key: keys[0]!.Key! }));
    expect(h.StorageClass).toBe('GLACIER_IR');
  });
});
