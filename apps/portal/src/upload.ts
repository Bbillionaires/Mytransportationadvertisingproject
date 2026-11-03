/** Resumable media upload shared by the advertiser and creator sections. */
import { api } from './ui';

const MAX_BROWSER_UPLOAD = 1024 ** 3; // the browser hashes the file in memory; larger files need the resumable API directly

/** Resumable chunked upload: declare size + SHA-256, send chunks with Content-Range, then complete. */
export async function uploadFile(orgBase: string, f: File, onProgress: (pct: number) => void, say: (t: string) => void): Promise<string> {
  if (f.size > MAX_BROWSER_UPLOAD) throw new Error('Files over 1 GB must be uploaded with the API.');
  say('Preparing…');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const u = await api('POST', `${orgBase}/uploads`, { filename: f.name.slice(0, 255), contentType: f.type || 'application/octet-stream', sizeBytes: f.size, sha256: digest });
  const chunk = Math.min(u.chunkSizeLimit as number, 8 * 1024 * 1024);
  let offset = 0;
  while (offset < f.size) {
    const end = Math.min(offset + chunk, f.size);
    const token = sessionStorage.getItem('rmn_portal_token');
    const res = await fetch(`/v1/uploads/${u.uploadId}/content`, { method: 'PUT', body: f.slice(offset, end),
      headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${offset}-${end - 1}/${f.size}`, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error?.message ?? `upload failed (${res.status})`); }
    offset = end;
    onProgress(Math.round((offset / f.size) * 100));
  }
  const done = await api('POST', `/v1/uploads/${u.uploadId}/complete`);
  if (done.status === 'FAILED') throw new Error(done.error);
  return u.uploadId;
}

export async function waitForProcessing(uploadId: string, timeoutMs = 10 * 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = await api('GET', `/v1/uploads/${uploadId}`);
    if (s.status === 'READY') return s.asset;
    if (s.status === 'FAILED') throw new Error(s.error ?? 'processing failed');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Processing is taking longer than usual. The ad will appear once it finishes; try adding it again later.');
}

