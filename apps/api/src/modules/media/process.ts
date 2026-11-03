import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { MODERATION_POLICY_VERSION, screenText, summarize, unavailableVisualProvider, type ModerationProvider, type ProviderResult } from './moderation.js';
import { isVideo, type Detected } from './sniff.js';
import { assetKey, LocalMediaStore, uploadPartKey } from './storage.js';

const run = promisify(execFile);

/**
 * Untrusted media is parsed by ffmpeg (R-023). Every ffmpeg/ffprobe run:
 *  - may open local files only (`-protocol_whitelist file`), so a crafted file cannot make it fetch URLs
 *    (internal network / cloud metadata) through playlist or concat tricks;
 *  - runs under kernel resource limits via prlimit when available: address space, CPU seconds, output file size,
 *    open files, no core dumps — a decoder bug cannot exhaust the host;
 *  - has a wall-clock timeout and never reads stdin.
 * Production additionally runs the worker in an isolated container (infra/media-worker, docs/DEPLOYMENT.md).
 */
export const SANDBOX_LIMITS = { addressSpaceBytes: 3 * 1024 ** 3, cpuSeconds: 900, fileSizeBytes: 4 * 1024 ** 3, openFiles: 256 };
const PRLIMIT = ['/usr/bin/prlimit', '/bin/prlimit'].find((p) => existsSync(p)) ?? null;
export function sandboxed(cmd: 'ffmpeg' | 'ffprobe', args: string[]): [string, string[]] {
  const safe = [...(cmd === 'ffmpeg' ? ['-nostdin'] : []), '-protocol_whitelist', 'file', ...args];
  if (!PRLIMIT) return [cmd, safe];
  const l = SANDBOX_LIMITS;
  return [PRLIMIT, [`--as=${l.addressSpaceBytes}`, `--cpu=${l.cpuSeconds}`, `--fsize=${l.fileSizeBytes}`, `--nofile=${l.openFiles}`, '--core=0', '--', cmd, ...safe]];
}
const ff = (args: string[]) => { const [c, a] = sandboxed('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); return run(c, a, { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000 }); };

export const LIMITS = {
  CREATOR_VIDEO: { maxDurationMs: 30 * 60_000, minDurationMs: 5_000 },
  AD_CREATIVE: { maxDurationMs: 180_000, minDurationMs: 1_000 },
} as const;

async function probe(file: string) {
  const [c, a] = sandboxed('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const { stdout } = await run(c, a, { timeout: 120_000 });
  return JSON.parse(stdout) as { format?: { duration?: string; format_name?: string }; streams?: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; duration?: string }> };
}

/** Probe, transcode, thumbnail, sample frames, extract audio, moderate. Throws a user-facing message on rejection. */
async function processOne(store: LocalMediaStore, upload: any, assetId: string, providers: ModerationProvider[], texts: string[]) {
  const src = store.pathFor(assetKey(assetId, 'original'));
  const info = await probe(src);
  const v = info.streams?.find((s) => s.codec_type === 'video');
  const a = info.streams?.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('file contains no video or image stream');
  const detected = upload.detected_type as Detected;
  const video = isVideo(detected);
  const durationMs = video ? Math.round(Number(info.format?.duration ?? v.duration ?? 0) * 1000) : null;
  if (video) {
    const lim = LIMITS[upload.purpose as keyof typeof LIMITS];
    if (!durationMs || durationMs < lim.minDurationMs) throw new Error(`video is too short (${durationMs ?? 0} ms)`);
    if (durationMs > lim.maxDurationMs) throw new Error(`video exceeds the ${lim.maxDurationMs / 1000}s limit for ${upload.purpose}`);
  }
  if (!video && upload.purpose === 'CREATOR_VIDEO') throw new Error('creator uploads must be video');

  await store.ensureDir(`assets/${assetId}`);
  const rendition = video ? assetKey(assetId, '720p.mp4') : assetKey(assetId, 'display.jpg');
  const thumb = assetKey(assetId, 'thumb.jpg');
  if (video) {
    await ff(['-i', src, '-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      ...(a ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']), '-movflags', '+faststart', store.pathFor(rendition)]);
    await ff(['-ss', String(Math.min(1, (durationMs! / 1000) / 2)), '-i', src, '-frames:v', '1', '-vf', 'scale=-2:360', store.pathFor(thumb)]);
  } else {
    await ff(['-i', src, '-vf', 'scale=min(1920\\,iw):-2', '-q:v', '3', store.pathFor(rendition)]);
    await ff(['-i', src, '-vf', 'scale=-2:360', store.pathFor(thumb)]);
  }

  // Moderation inputs: up to 30 frames evenly spaced, plus mono 16 kHz audio for speech recognition.
  const work = await mkdtemp(path.join(tmpdir(), 'rmn-mod-'));
  try {
    if (video) {
      const every = Math.max(1, Math.ceil(durationMs! / 1000 / 30));
      await ff(['-i', src, '-vf', `fps=1/${every},scale=-2:480`, '-frames:v', '30', path.join(work, 'f%03d.jpg')]);
      if (a) await ff(['-i', src, '-vn', '-ac', '1', '-ar', '16000', path.join(work, 'audio.wav')]);
    } else {
      await ff(['-i', src, '-vf', 'scale=-2:480', path.join(work, 'f001.jpg')]);
    }
    const files = await readdir(work);
    const input = { framePaths: files.filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(work, f)), audioPath: files.includes('audio.wav') ? path.join(work, 'audio.wav') : null, texts };
    const results: ProviderResult[] = [];
    for (const p of providers) {
      try { results.push(await p.analyze(input)); }
      catch (e) { results.push({ provider: p.name, status: 'ERROR', notes: [`provider failed: ${(e as Error).message}`.slice(0, 500)] }); }
    }
    const transcripts = results.map((r) => r.transcript).filter(Boolean) as string[];
    results.push(screenText([...texts, ...transcripts]));
    return {
      asset: { kind: video ? 'VIDEO' : 'IMAGE', durationMs, width: v.width ?? null, height: v.height ?? null, hasAudio: !!a, rendition, thumb, probe: info },
      moderation: { ...summarize(results), findings: { frameCount: input.framePaths.length, hasAudio: !!input.audioPath, providers: results.map((r) => ({ ...r, transcript: r.transcript?.slice(0, 2000) })) } },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Process uploaded media. Single runner per upload (row lock with SKIP LOCKED). Creator videos waiting on
 * the upload move to PENDING_REVIEW (or PROCESSING_FAILED); nothing is ever approved here.
 */
export async function processPendingUploads(db: Db, config: Config, providers: ModerationProvider[] = [unavailableVisualProvider], limit = 5) {
  const store = new LocalMediaStore(config.MEDIA_ROOT);
  const out = { processed: 0, ready: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const claimed = await withTx(db, async (tx) => {
      const r = await tx.query(`SELECT * FROM media_uploads WHERE status = 'UPLOADED' ORDER BY completed_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!r.rows[0]) return null;
      await tx.query(`UPDATE media_uploads SET status = 'PROCESSING' WHERE id = $1`, [r.rows[0].id]);
      return r.rows[0];
    });
    if (!claimed) break;
    out.processed += 1;
    const assetId = crypto.randomUUID();
    const vids = await db.query('SELECT id, title, description FROM videos WHERE upload_id = $1', [claimed.id]);
    const texts = vids.rows.flatMap((v) => [v.title, v.description ?? '']).filter(Boolean);
    try {
      await store.move(uploadPartKey(claimed.id), assetKey(assetId, 'original'));
      const res = await processOne(store, claimed, assetId, providers, texts);
      await withTx(db, async (tx) => {
        await tx.query(
          `INSERT INTO media_assets (id, upload_id, org_id, kind, duration_ms, width, height, has_audio, rendition_key, thumbnail_key, probe) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [assetId, claimed.id, claimed.org_id, res.asset.kind, res.asset.durationMs, res.asset.width, res.asset.height, res.asset.hasAudio, res.asset.rendition, res.asset.thumb, JSON.stringify(res.asset.probe)]);
        await tx.query(`UPDATE media_uploads SET status = 'READY', processed_at = now() WHERE id = $1`, [claimed.id]);
        const subjects = vids.rows.length ? vids.rows.map((v) => ({ type: 'VIDEO', id: v.id })) : [{ type: 'ASSET', id: null }];
        for (const s of subjects) {
          await tx.query(
            `INSERT INTO moderation_cases (asset_id, subject_type, subject_id, policy_version, ai_recommendation, priority, scores, findings) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [assetId, s.type, s.id, MODERATION_POLICY_VERSION, res.moderation.recommendation, res.moderation.priority, JSON.stringify(res.moderation.scores), JSON.stringify(res.moderation.findings)]);
        }
        await tx.query(`UPDATE videos SET asset_id = $2, media_key = $3, duration_ms = $4, status = 'PENDING_REVIEW' WHERE upload_id = $1 AND status = 'PROCESSING'`,
          [claimed.id, assetId, res.asset.rendition, res.asset.durationMs]);
        await audit(tx, {}, 'media.processed', { type: 'media_upload', id: claimed.id, orgId: claimed.org_id }, { assetId, recommendation: res.moderation.recommendation });
      });
      out.ready += 1;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      await withTx(db, async (tx) => {
        await tx.query(`UPDATE media_uploads SET status = 'FAILED', error = $2, processed_at = now() WHERE id = $1`, [claimed.id, msg]);
        await tx.query(`UPDATE videos SET status = 'PROCESSING_FAILED' WHERE upload_id = $1 AND status = 'PROCESSING'`, [claimed.id]);
        await audit(tx, {}, 'media.processing_failed', { type: 'media_upload', id: claimed.id, orgId: claimed.org_id }, { error: msg });
      });
      await store.remove(assetKey(assetId, 'original')).catch(() => {});
      out.failed += 1;
    }
  }
  return out;
}
