import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring media URLs. The CDN edge (or a media proxy) must verify `sig` with the same key
 * using verifyMediaSignature() and refuse expired links, so unapproved or expired media is never served.
 */
const sign = (key: string, exp: number, secretB64: string) =>
  createHmac('sha256', Buffer.from(secretB64, 'base64')).update(`${key}\n${exp}`).digest('base64url');

export function signMediaUrl(baseUrl: string, key: string, expiresAt: Date, secretB64: string): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${baseUrl.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sign(key, exp, secretB64)}`;
}

export function verifyMediaSignature(key: string, exp: number, sig: string, secretB64: string, nowMs = Date.now()): boolean {
  if (!Number.isInteger(exp) || exp * 1000 < nowMs) return false;
  const expected = Buffer.from(sign(key, exp, secretB64));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
