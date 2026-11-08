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

// ---------- AES-256-GCM for secrets at rest (key rotation: R-016) ----------
/** Short, non-secret identifier of a key, stored with each ciphertext so the right key is picked during rotation. */
export const keyId = (keyB64: string) => createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex').slice(0, 8);

/** Encrypts with the current key. Format v2.<keyId>.<iv>.<tag>.<ciphertext> (base64 parts). */
export function encrypt(plaintext: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v2', keyId(keyB64), iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

const gcmOpen = (keyB64: string, iv: string, tag: string, ct: string) => {
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
};

/**
 * Decrypts with whichever key in the keyring (current first, then previous keys) made the ciphertext. v2 blobs name
 * their key; legacy v1 blobs (no key id) are tried against each key, and the GCM tag rejects the wrong ones.
 */
export function decrypt(blob: string, keys: string | readonly string[]): string {
  const ring = typeof keys === 'string' ? [keys] : keys;
  const parts = blob.split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, iv, tag, ct] = parts as [string, string, string, string, string];
    const key = ring.find((k) => keyId(k) === kid);
    if (!key) throw new Error(`no encryption key with id ${kid} is configured (was APP_ENCRYPTION_KEY_PREVIOUS removed too early?)`);
    return gcmOpen(key, iv, tag, ct);
  }
  if (parts[0] === 'v1' && parts.length === 4) {
    const [, iv, tag, ct] = parts as [string, string, string, string];
    for (const k of ring) { try { return gcmOpen(k, iv, tag, ct); } catch { /* try the next key */ } }
    throw new Error('no configured encryption key opens this value');
  }
  throw new Error('bad ciphertext');
}

/** True when the value is already encrypted under exactly this key (rotation progress). */
export const encryptedWith = (blob: string, keyB64: string) => blob.startsWith(`v2.${keyId(keyB64)}.`);

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

// ---------- Device signatures: Ed25519 (web player) or ECDSA P-256 (Android Keystore / StrongBox) ----------
/** Accepts an SPKI public key that is Ed25519 or ECDSA on P-256; anything else is refused. */
export function parseDevicePublicKey(derB64: string): Buffer {
  const der = Buffer.from(derB64, 'base64');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  const ok = key.asymmetricKeyType === 'ed25519' || (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1');
  if (!ok) throw new Error('device key must be Ed25519 or ECDSA P-256');
  return der;
}
/** Ed25519 signs the payload directly; P-256 uses SHA-256 with a DER-encoded ECDSA signature (Android's SHA256withECDSA). */
export function verifyDeviceSignature(der: Buffer, data: Buffer, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    const sig = Buffer.from(signatureB64, 'base64');
    if (key.asymmetricKeyType === 'ed25519') return edVerify(null, data, key, sig);
    if (key.asymmetricKeyType === 'ec') return edVerify('sha256', data, key, sig);
    return false;
  } catch {
    return false;
  }
}
/** Canonical string a device signs for every request. */
export function deviceSigningPayload(method: string, path: string, timestamp: string, nonce: string, body: string): Buffer {
  return Buffer.from([method.toUpperCase(), path, timestamp, nonce, sha256hex(body)].join('\n'), 'utf8');
}

/**
 * ECDSA_P256 = Android shell (Keystore) key; ED25519 = web-player (browser) key. The key type alone does not prove the
 * key is hardware-backed; that needs key attestation at enrollment (R-028).
 */
export function deviceKeyType(der: Buffer): 'ECDSA_P256' | 'ED25519' | 'UNKNOWN' {
  try {
    const t = createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyType;
    return t === 'ec' ? 'ECDSA_P256' : t === 'ed25519' ? 'ED25519' : 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}
