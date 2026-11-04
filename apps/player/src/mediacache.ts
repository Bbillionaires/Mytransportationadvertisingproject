/**
 * Tablet media cache (R-029). Approved media in the current playlist is downloaded once, in the background, into
 * Cache Storage and played from there, so a tablet keeps playing through poor coverage and uses far less data.
 *
 * Expiry is enforced: a cached file is only played while the current playlist lists it (the playlist itself only
 * offers unexpired, approved items), and anything the server no longer lists — ended campaigns, withdrawn or
 * taken-down videos — is deleted from the cache when a fresh playlist arrives.
 */
export interface CachedMedia { url: string; cacheKey?: string; expiresAt: string }

const CACHE = 'rmn-media-v1';
const MAX_BYTES = 1.5 * 1024 ** 3; // stay well inside typical tablet browser quotas
const req = (key: string) => new Request(`/__media-cache/${encodeURIComponent(key)}`);
const supported = () => typeof caches !== 'undefined';
const live = new Map<string, string>(); // cacheKey -> object URL currently handed to <video>/<img>

export async function cachedBytes(): Promise<number> {
  if (!supported()) return 0;
  const c = await caches.open(CACHE);
  let total = 0;
  for (const k of await c.keys()) total += Number((await c.match(k))?.headers.get('x-size') ?? 0);
  return total;
}

/** The URL to play: a local copy when cached, otherwise the signed network link. */
export async function playableUrl(m: CachedMedia): Promise<string> {
  if (!supported() || !m.cacheKey) return m.url;
  const hit = await (await caches.open(CACHE)).match(req(m.cacheKey));
  if (!hit) return m.url;
  const old = live.get(m.cacheKey);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(await hit.blob());
  live.set(m.cacheKey, url);
  return url;
}

/** Download playlist media that is not cached yet, one file at a time. Failures are ignored (streaming still works). */
export async function prefetch(items: CachedMedia[], signal?: AbortSignal): Promise<number> {
  if (!supported()) return 0;
  const c = await caches.open(CACHE);
  let added = 0, total = await cachedBytes();
  for (const m of items) {
    if (signal?.aborted || !m.cacheKey || new Date(m.expiresAt).getTime() <= Date.now()) continue;
    if (await c.match(req(m.cacheKey))) continue;
    try {
      const r = await fetch(m.url, { signal });
      if (!r.ok) continue;
      const blob = await r.blob();
      if (total + blob.size > MAX_BYTES) break;
      if (signal?.aborted) break; // superseded by a newer playlist: never write stale media
      await c.put(req(m.cacheKey), new Response(blob, { headers: { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'x-size': String(blob.size), 'x-cached-at': new Date().toISOString() } }));
      total += blob.size; added++;
    } catch { /* offline, CORS not configured, or quota: keep streaming */ }
  }
  return added;
}

/** Remove cached media the server no longer lists (expired, ended, withdrawn or taken down). */
export async function prune(keep: Set<string>): Promise<number> {
  if (!supported()) return 0;
  const c = await caches.open(CACHE);
  let removed = 0;
  for (const k of await c.keys()) {
    const key = decodeURIComponent(new URL(k.url).pathname.replace('/__media-cache/', ''));
    if (!keep.has(key)) { await c.delete(k); removed++; const u = live.get(key); if (u) { URL.revokeObjectURL(u); live.delete(key); } }
  }
  return removed;
}

/** Fleet command PURGE / sign-out style wipe of all cached media. */
export async function clearMediaCache() { if (supported()) await caches.delete(CACHE); }
