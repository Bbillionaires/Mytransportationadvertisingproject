import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { mediaStores, ObjectExistsError, sha256File, type ObjectStore } from '../../lib/objectStore.js';
import { renderAsset } from './process.js';

/**
 * Media backups (R-021). Every verified original (originals/<upload id>) is copied to each configured backup bucket.
 * Copies are add-only: a backup is never overwritten (conditional put) and the app holds no delete path for it. The
 * production backup bucket additionally has versioning + Object Lock (Governance), so even stolen keys cannot erase it.
 * Processed renditions are not backed up; they are re-created from the original on restore.
 */

const withScratch = async <T>(fn: (dir: string) => Promise<T>) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rmn-bak-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

async function copyObject(from: ObjectStore, to: ObjectStore, key: string, sha256: string, contentType: string, scratch: string) {
  const file = path.join(scratch, 'obj');
  await from.getToFile(key, file);
  const actual = await sha256File(file);
  if (actual !== sha256) throw new Error(`${from.name}/${key} content does not match its recorded SHA-256 (${actual})`);
  try { await to.putFile(key, file, { sha256, contentType, ifNotExists: true }); }
  catch (e) {
    if (!(e instanceof ObjectExistsError)) throw e;
    const h = await to.head(key); // already there (e.g. an interrupted earlier run): accept only if it is the same file
    if (h?.sha256 !== sha256) throw new Error(`${to.name}/${key} exists with different content; refusing to overwrite`);
  }
}

/** Copy originals that are missing from a backup target. Returns per-target counts. */
export async function runBackups(db: Db, config: Config, limit = 50) {
  const { primary, backups } = mediaStores(config);
  const out: Record<string, { copied: number; failed: number }> = {};
  for (const target of backups) {
    out[target.name] = { copied: 0, failed: 0 };
    const todo = await db.query(
      `SELECT u.id, u.org_id, u.original_key, u.sha256, u.size_bytes, u.declared_type FROM media_uploads u
        WHERE u.original_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM media_backups b WHERE b.upload_id = u.id AND b.target = $1)
        ORDER BY u.completed_at LIMIT $2`, [target.name, limit]);
    for (const u of todo.rows) {
      try {
        await withScratch((dir) => copyObject(primary, target, u.original_key, u.sha256, u.declared_type, dir));
        await db.query(`INSERT INTO media_backups (upload_id, target, sha256, size_bytes, verified_at) VALUES ($1,$2,$3,$4, now()) ON CONFLICT DO NOTHING`,
          [u.id, target.name, u.sha256, u.size_bytes]);
        out[target.name]!.copied += 1;
      } catch (e) {
        out[target.name]!.failed += 1;
        await audit(db, {}, 'media.backup_failed', { type: 'media_upload', id: u.id, orgId: u.org_id }, { target: target.name, error: (e as Error).message.slice(0, 300) });
      }
    }
  }
  return out;
}

export interface MediaProblem { uploadId: string; where: string; problem: 'MISSING' | 'SIZE_MISMATCH' | 'CHECKSUM_MISMATCH' | 'RENDITION_MISSING'; detail?: string }

/**
 * Nightly audit: every original must exist in the primary store and in every backup with the recorded size and
 * SHA-256 (metadata check; `deep` re-downloads and re-hashes the main bucket's copies). Missing backups are re-copied
 * automatically; anything else is reported (restore with jobs:restore-media). Stored in media_audit_runs.
 */
export async function verifyMedia(db: Db, config: Config, opts: { deep?: boolean } = {}) {
  const { primary, backups } = mediaStores(config);
  const run = (await db.query(`INSERT INTO media_audit_runs (deep) VALUES ($1) RETURNING id`, [!!opts.deep])).rows[0].id;
  const problems: MediaProblem[] = [];
  let checked = 0, repaired = 0;
  const uploads = (await db.query(
    `SELECT u.id, u.original_key, u.sha256, u.size_bytes, u.declared_type, a.rendition_key, a.thumbnail_key
       FROM media_uploads u LEFT JOIN media_assets a ON a.upload_id = u.id WHERE u.original_key IS NOT NULL ORDER BY u.completed_at`)).rows;
  const check = async (store: ObjectStore, u: any): Promise<MediaProblem['problem'] | null> => {
    const h = await store.head(u.original_key);
    if (!h) return 'MISSING';
    if (h.size !== Number(u.size_bytes)) return 'SIZE_MISMATCH';
    if (h.sha256 !== null && h.sha256 !== u.sha256) return 'CHECKSUM_MISMATCH';
    // Deep (re-download + re-hash) only on the main bucket: its egress is free; AWS charges per GB read, and S3
    // already verifies its own copies' integrity.
    if (opts.deep && store === primary) return withScratch(async (dir) => { const f = path.join(dir, 'o'); await store.getToFile(u.original_key, f); return (await sha256File(f)) === u.sha256 ? null : 'CHECKSUM_MISMATCH'; });
    return null;
  };
  for (const u of uploads) {
    checked += 1;
    const p = await check(primary, u);
    if (p) problems.push({ uploadId: u.id, where: primary.name, problem: p });
    for (const key of [u.rendition_key, u.thumbnail_key]) if (key && !(await primary.head(key))) problems.push({ uploadId: u.id, where: primary.name, problem: 'RENDITION_MISSING', detail: key });
    for (const b of backups) {
      const bp = await check(b, u);
      if (bp === 'MISSING' && !p) {
        try { await withScratch((dir) => copyObject(primary, b, u.original_key, u.sha256, u.declared_type, dir)); repaired += 1; continue; }
        catch (e) { problems.push({ uploadId: u.id, where: b.name, problem: 'MISSING', detail: `re-copy failed: ${(e as Error).message.slice(0, 200)}` }); continue; }
      }
      if (bp) problems.push({ uploadId: u.id, where: b.name, problem: bp });
      else await db.query(`UPDATE media_backups SET verified_at = now() WHERE upload_id = $1 AND target = $2`, [u.id, b.name]);
    }
  }
  await db.query(`UPDATE media_audit_runs SET finished_at = now(), checked = $2, repaired = $3, problems = $4 WHERE id = $1`, [run, checked, repaired, JSON.stringify(problems)]);
  return { runId: String(run), checked, repaired, backups: backups.map((b) => b.name), problems };
}

/**
 * Restore: originals missing or damaged in the primary store are copied back from the first backup holding a good
 * copy; renditions/thumbnails that are missing are re-created from the original. Never touches the backups.
 */
export async function restoreMedia(db: Db, config: Config, opts: { uploadIds?: string[] } = {}) {
  const { primary, backups } = mediaStores(config);
  const out = { restoredOriginals: 0, rerendered: 0, failed: [] as Array<{ uploadId: string; error: string }> };
  const rows = (await db.query(
    `SELECT u.id, u.org_id, u.original_key, u.sha256, u.size_bytes, u.declared_type, a.id AS asset_id, a.kind, a.duration_ms, a.has_audio, a.rendition_key, a.thumbnail_key
       FROM media_uploads u LEFT JOIN media_assets a ON a.upload_id = u.id
      WHERE u.original_key IS NOT NULL AND ($1::uuid[] IS NULL OR u.id = ANY($1::uuid[]))`, [opts.uploadIds ?? null])).rows;
  for (const u of rows) {
    try {
      await withScratch(async (dir) => {
        const h = await primary.head(u.original_key);
        let originalOk = !!h && h.size === Number(u.size_bytes) && (h.sha256 === null || h.sha256 === u.sha256);
        if (!originalOk) {
          let restored = false;
          for (const b of backups) {
            const f = path.join(dir, 'restore');
            if (!(await b.head(u.original_key))) continue;
            await b.getToFile(u.original_key, f);
            if ((await sha256File(f)) !== u.sha256) continue;
            await primary.putFile(u.original_key, f, { sha256: u.sha256, contentType: u.declared_type });
            restored = true; break;
          }
          if (!restored) throw new Error('no backup holds a good copy of this original');
          out.restoredOriginals += 1; originalOk = true;
          await audit(db, {}, 'media.original_restored', { type: 'media_upload', id: u.id, orgId: u.org_id });
        }
        const renditionsMissing = u.asset_id && (!(await primary.head(u.rendition_key)) || !(await primary.head(u.thumbnail_key)));
        if (renditionsMissing) {
          const src = path.join(dir, 'original');
          await primary.getToFile(u.original_key, src);
          await renderAsset(primary, src, dir, u.asset_id, u.kind === 'VIDEO', u.duration_ms, u.has_audio);
          out.rerendered += 1;
          await audit(db, {}, 'media.renditions_recreated', { type: 'media_upload', id: u.id, orgId: u.org_id }, { assetId: u.asset_id });
        }
      });
    } catch (e) { out.failed.push({ uploadId: u.id, error: (e as Error).message.slice(0, 300) }); }
  }
  return out;
}
