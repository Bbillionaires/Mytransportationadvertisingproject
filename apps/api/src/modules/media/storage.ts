import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Storage keys are opaque, slash-separated, and validated so they can never escape the root.
 * LocalMediaStore serves development and tests; production swaps in an object-store implementation
 * (S3/GCS) of the same interface behind the CDN that verifies signed URLs.
 */
export const KEY_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

export class LocalMediaStore {
  constructor(private readonly root: string) {}

  pathFor(key: string): string {
    if (!KEY_RE.test(key) || key.split('/').some((p) => p === '..' || p === '.')) throw new Error(`invalid storage key ${key}`);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('storage key escapes root');
    return p;
  }
  async append(key: string, chunk: Buffer) {
    const p = this.pathFor(key);
    await mkdir(path.dirname(p), { recursive: true });
    await appendFile(p, chunk);
  }
  async size(key: string): Promise<number | null> {
    try { return (await stat(this.pathFor(key))).size; } catch { return null; }
  }
  async move(from: string, to: string) {
    const dest = this.pathFor(to);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(this.pathFor(from), dest);
  }
  async remove(key: string) { await rm(this.pathFor(key), { force: true }); }
  read(key: string, range?: { start: number; end: number }): Readable { return createReadStream(this.pathFor(key), range); }
  writer(key: string) { return createWriteStream(this.pathFor(key)); }
  async ensureDir(key: string) { await mkdir(this.pathFor(key), { recursive: true }); }
}

export const uploadPartKey = (uploadId: string) => `uploads/${uploadId}.part`;
export const assetKey = (assetId: string, file: string) => `assets/${assetId}/${file}`;
