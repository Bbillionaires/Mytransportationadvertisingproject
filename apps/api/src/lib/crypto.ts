import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, randomBytes, scrypt as scryptCb, timingSafeEqual, verify as edVerify } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(expected, actual);
}

/** A precomputed hash used to keep login timing uniform for unknown emails. */
export const DUMMY_PASSWORD_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// ---------- AES-256-GCM for secrets at rest ----------
export function encrypt(plaintext: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}
export function decrypt(blob: string, keyB64: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(randomBytes(20));
export function totpAt(secretB32: string, step: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
export const totpStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / 30);
/** Returns the matching time-step within ±1 step, or null. Caller must reject steps <= last accepted (replay). */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  for (const s of [now - 1, now, now + 1]) {
    if (timingSafeEqual(Buffer.from(totpAt(secretB32, s)), Buffer.from(code))) return s;
  }
  return null;
}

// ---------- Ed25519 device signatures ----------
export function parseEd25519PublicKey(derB64: string): Buffer {
  const der = Buffer.from(derB64, 'base64');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('device key must be Ed25519');
  return der;
}
export function verifyEd25519(der: Buffer, data: Buffer, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return edVerify(null, data, key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
/** Canonical string a device signs for every request. */
export function deviceSigningPayload(method: string, path: string, timestamp: string, nonce: string, body: string): Buffer {
  return Buffer.from([method.toUpperCase(), path, timestamp, nonce, sha256hex(body)].join('\n'), 'utf8');
}
