import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';
import { signMediaUrl } from './media.js';

/**
 * Object storage for media (R-021). Keys are opaque, slash-separated and validated.
 *   originals/<uploadId>          the uploaded file — written once, never modified or deleted by the app
 *   assets/<assetId>/<file>       processed renditions and thumbnails (re-creatable from the original)
 * The app only ever adds objects. Integrity is tracked with a SHA-256 stored as object metadata.
 */
export const OBJECT_KEY_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const checkKey = (key: string) => {
  if (!OBJECT_KEY_RE.test(key) || key.split('/').some((p) => p === '..' || p === '.')) throw new Error(`invalid object key ${key}`);
  return key;
};

export interface ObjectInfo { size: number; sha256: string | null }
export class ObjectExistsError extends Error { constructor(key: string) { super(`object ${key} already exists`); this.name = 'ObjectExistsError'; } }

export interface ObjectStore {
  readonly name: string;
  /** Upload a local file. With ifNotExists, refuses to replace an existing object (ObjectExistsError). */
  putFile(key: string, file: string, opts?: { contentType?: string; sha256?: string; ifNotExists?: boolean }): Promise<void>;
  /** Download an object to a local file (for ffmpeg, backups and restores). */
  getToFile(key: string, file: string): Promise<void>;
  head(key: string): Promise<ObjectInfo | null>;
  /** A short-lived link a tablet or browser can fetch directly (no API egress). */
  signedGetUrl(key: string, expiresAt: Date): Promise<string>;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(file)) h.update(c as Buffer);
  return h.digest('hex');
}

/** Development/test store on local disk; links are served by the API's signed /media route. */
export class LocalObjectStore implements ObjectStore {
  readonly name: string;
  constructor(private readonly root: string, private readonly sign: (key: string, expiresAt: Date) => string, name = 'local') { this.name = name; }
  pathFor(key: string) {
    const p = path.resolve(this.root, checkKey(key));
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('object key escapes root');
    return p;
  }
  async putFile(key: string, file: string, opts: { sha256?: string; ifNotExists?: boolean } = {}) {
    const dest = this.pathFor(key);
    if (opts.ifNotExists && (await this.head(key))) throw new ObjectExistsError(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(file, dest);
    await writeFile(`${dest}.sha256`, opts.sha256 ?? (await sha256File(dest)));
  }
  async getToFile(key: string, file: string) { await copyFile(this.pathFor(key), file); }
  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const p = this.pathFor(key);
      const s = await stat(p);
      const sha = await readFile(`${p}.sha256`, 'utf8').catch(() => null);
      return { size: s.size, sha256: sha?.trim() || null };
    } catch { return null; }
  }
  async signedGetUrl(key: string, expiresAt: Date) { return this.sign(checkKey(key), expiresAt); }
  read(key: string, range?: { start: number; end: number }): Readable { return createReadStream(this.pathFor(key), range); }
  /** Test helper only: simulate loss of an object. The app never deletes media. */
  async destroyForTests(key: string) { await rm(this.pathFor(key), { force: true }); await rm(`${this.pathFor(key)}.sha256`, { force: true }); }
}

export interface S3Settings { endpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean; storageClass?: string }

/** Any S3-compatible bucket: Railway Buckets (main store), AWS S3 (locked backup), MinIO/moto in tests. */
export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  constructor(readonly name: string, private readonly cfg: S3Settings) {
    const c: S3ClientConfig = { region: cfg.region || 'us-east-1', credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }, forcePathStyle: !!cfg.forcePathStyle };
    if (cfg.endpoint) c.endpoint = cfg.endpoint;
    this.s3 = new S3Client(c);
  }
  async putFile(key: string, file: string, opts: { contentType?: string; sha256?: string; ifNotExists?: boolean } = {}) {
    const size = (await stat(file)).size;
    const sha256 = opts.sha256 ?? (await sha256File(file));
    try {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.cfg.bucket, Key: checkKey(key), Body: createReadStream(file), ContentLength: size, ContentType: opts.contentType ?? 'application/octet-stream',
        Metadata: { sha256 }, ...(opts.ifNotExists ? { IfNoneMatch: '*' } : {}), ...(this.cfg.storageClass ? { StorageClass: this.cfg.storageClass as any } : {}),
      }));
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (opts.ifNotExists && (status === 412 || (e as Error).name === 'PreconditionFailed')) throw new ObjectExistsError(key);
      throw e;
    }
  }
  async getToFile(key: string, file: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: checkKey(key) }));
    await mkdir(path.dirname(file), { recursive: true });
    await pipeline(r.Body as Readable, createWriteStream(file));
  }
  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: checkKey(key) }));
      return { size: Number(r.ContentLength ?? 0), sha256: r.Metadata?.sha256 ?? null };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (e as Error).name === 'NotFound' || (e as Error).name === 'NoSuchKey') return null;
      throw e;
    }
  }
  async signedGetUrl(key: string, expiresAt: Date) {
    const seconds = Math.max(60, Math.min(7 * 86_400, Math.ceil((expiresAt.getTime() - Date.now()) / 1000)));
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: checkKey(key) }), { expiresIn: seconds });
  }
}

const s3FromEnv = (name: string, p: { endpoint?: string; region?: string; bucket?: string; key?: string; secret?: string; pathStyle?: string; storageClass?: string }): S3ObjectStore | null => {
  if (!p.bucket) return null;
  if (!p.key || !p.secret) throw new Error(`${name}: bucket is set but access key id / secret access key are missing`);
  return new S3ObjectStore(name, { endpoint: p.endpoint || undefined, region: p.region || 'us-east-1', bucket: p.bucket, accessKeyId: p.key, secretAccessKey: p.secret, forcePathStyle: p.pathStyle === 'true', storageClass: p.storageClass || undefined });
};

const stores = new WeakMap<Config, { primary: ObjectStore; backups: ObjectStore[] }>();

/** The main media store and the backup stores configured for this process (memoized per config). */
export function mediaStores(config: Config): { primary: ObjectStore; backups: ObjectStore[] } {
  let s = stores.get(config);
  if (s) return s;
  const primary: ObjectStore = config.MEDIA_STORE === 's3'
    ? s3FromEnv('primary', { endpoint: config.MEDIA_S3_ENDPOINT, region: config.MEDIA_S3_REGION, bucket: config.MEDIA_S3_BUCKET, key: config.MEDIA_S3_ACCESS_KEY_ID, secret: config.MEDIA_S3_SECRET_ACCESS_KEY, pathStyle: config.MEDIA_S3_FORCE_PATH_STYLE })!
    : new LocalObjectStore(config.MEDIA_ROOT, (key, exp) => signMediaUrl(config.MEDIA_BASE_URL, key, exp, config.MEDIA_SIGNING_KEY));
  const backups = [1, 2].map((n) => s3FromEnv(`backup${n}`, {
    endpoint: (config as any)[`BACKUP${n}_S3_ENDPOINT`], region: (config as any)[`BACKUP${n}_S3_REGION`], bucket: (config as any)[`BACKUP${n}_S3_BUCKET`],
    key: (config as any)[`BACKUP${n}_S3_ACCESS_KEY_ID`], secret: (config as any)[`BACKUP${n}_S3_SECRET_ACCESS_KEY`], pathStyle: (config as any)[`BACKUP${n}_S3_FORCE_PATH_STYLE`],
    storageClass: (config as any)[`BACKUP${n}_S3_STORAGE_CLASS`],
  })).filter((x): x is S3ObjectStore => x !== null);
  s = { primary, backups };
  stores.set(config, s);
  return s;
}

/** Signed, expiring link to a media object (playlists, previews, thumbnails). */
export const mediaUrl = (config: Config, key: string, expiresAt: Date) => mediaStores(config).primary.signedGetUrl(key, expiresAt);

/**
 * Origins that media links point to, for the player/portal Content-Security-Policy. Local mode: the API's /media
 * route. S3 mode: the bucket endpoint (path style) or <bucket>.<endpoint host> (virtual-hosted, Railway's default).
 */
export function mediaOrigins(config: Config): string[] {
  if (config.MEDIA_STORE !== 's3') return [new URL(config.MEDIA_BASE_URL).origin];
  const ep = new URL(config.MEDIA_S3_ENDPOINT ?? `https://s3.${config.MEDIA_S3_REGION === 'auto' ? 'us-east-1' : config.MEDIA_S3_REGION}.amazonaws.com`);
  return config.MEDIA_S3_FORCE_PATH_STYLE === 'true' ? [ep.origin] : [`${ep.protocol}//${config.MEDIA_S3_BUCKET}.${ep.host}`];
}
