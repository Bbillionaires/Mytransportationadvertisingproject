/** Encryption key rotation (R-016): versioned ciphertexts, a keyring for decryption, and the re-encryption job. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { encryptionKeys, loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { decrypt, encrypt, encryptedWith, keyId, totpAt, totpStep } from '../src/lib/crypto.js';
import { rotateEncryptedValues } from '../src/modules/platform/rotateKeys.js';
import { PASSWORD, userWithRole } from './helpers.js';

const k = () => randomBytes(32).toString('base64');

describe('versioned encryption', () => {
  const A = k(), B = k();
  it('names its key; decrypts with the matching key from the ring; rejects tampering and missing keys', () => {
    const blob = encrypt('secret value', A);
    expect(blob.startsWith(`v2.${keyId(A)}.`)).toBe(true);
    expect(encryptedWith(blob, A)).toBe(true);
    expect(decrypt(blob, [B, A])).toBe('secret value');
    expect(() => decrypt(blob, [B])).toThrow(/no encryption key with id/);
    const parts = blob.split('.');
    parts[4] = Buffer.from('xxxxxxxxxxxx').toString('base64');
    expect(() => decrypt(parts.join('.'), [A])).toThrow();
    expect(() => decrypt('garbage', [A])).toThrow(/bad ciphertext/);
  });

  it('still reads legacy v1 values (written before rotation support) with any key in the ring', () => {
    // A v1 value: the same AES-GCM layout without the key id.
    const v2 = encrypt('legacy', A).split('.');
    const v1 = ['v1', v2[2], v2[3], v2[4]].join('.');
    expect(decrypt(v1, [B, A])).toBe('legacy');
    expect(() => decrypt(v1, [B])).toThrow(/no configured encryption key/);
  });

  it('reads previous keys from config, current first', () => {
    expect(encryptionKeys({ APP_ENCRYPTION_KEY: A, APP_ENCRYPTION_KEY_PREVIOUS: ` ${B} , ` })).toEqual([A, B]);
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x/y', APP_ENCRYPTION_KEY: A, MEDIA_SIGNING_KEY: B, PAYMENTS_PROVIDER: 'disabled', APP_ENCRYPTION_KEY_PREVIOUS: 'short' })).toThrow(/32 bytes/);
  });
});

describe('rotating APP_ENCRYPTION_KEY without locking anyone out of two-step verification', () => {
  const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://rmn:rmn@localhost:5432/rmn_test';
  const DB_NAME = 'rmn_rotation_test';
  const DB_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);
  const OLD = k(), NEW = k(), SIGN = k();
  const cfg = (env: Record<string, string>) => loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, MEDIA_SIGNING_KEY: SIGN, PAYMENTS_PROVIDER: 'disabled', LOG_LEVEL: 'silent', ...env });
  let db: Db;
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();
    await migrate(DB_URL, () => {});
    db = createPool(DB_URL);
  }, 60_000);
  afterAll(async () => { await db?.end(); });

  it('old key → new key with the old one as previous → re-encrypt → old key removed; sign-in with codes works throughout', async () => {
    const orgId = (await db.query(`INSERT INTO organizations (kind, name) VALUES ('PLATFORM','Platform') RETURNING id`)).rows[0].id;
    const step = totpStep();

    // 1. Running on the old key: a staff member turns on two-step verification.
    const appOld = await buildApp({ config: cfg({ APP_ENCRYPTION_KEY: OLD }), db, logger: false });
    const u = await userWithRole({ app: appOld, db, config: cfg({ APP_ENCRYPTION_KEY: OLD }) }, orgId, 'finance_admin');
    const { secret } = (await appOld.inject({ method: 'POST', url: '/v1/auth/mfa/enroll', headers: u.h, payload: {} })).json();
    expect((await appOld.inject({ method: 'POST', url: '/v1/auth/mfa/activate', headers: u.h, payload: { code: totpAt(secret, step - 1) } })).statusCode).toBe(200);
    await appOld.close();
    const stored = async () => (await db.query('SELECT mfa_secret_enc FROM users WHERE id = $1', [u.userId])).rows[0].mfa_secret_enc as string;
    expect(encryptedWith(await stored(), OLD)).toBe(true);

    const signIn = async (app: Awaited<ReturnType<typeof buildApp>>, code: string) => {
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: u.email, password: PASSWORD } });
      return app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', headers: { authorization: `Bearer ${login.json().token}` }, payload: { code } });
    };

    // 2. New key set, old key kept as previous: sign-in still works, and the check reports one value to move.
    const mid = cfg({ APP_ENCRYPTION_KEY: NEW, APP_ENCRYPTION_KEY_PREVIOUS: OLD });
    const appMid = await buildApp({ config: mid, db, logger: false });
    expect((await signIn(appMid, totpAt(secret, step))).statusCode).toBe(200);
    await appMid.close();
    const check = await rotateEncryptedValues(db, mid, { checkOnly: true });
    expect(check).toMatchObject({ currentKeyId: keyId(NEW), previousKeyIds: [keyId(OLD)], remaining: 1, unreadable: 0 });
    expect(encryptedWith(await stored(), OLD)).toBe(true); // check-only changed nothing

    // Removing the old key too early is caught by the check, not discovered by a locked-out user.
    expect((await rotateEncryptedValues(db, cfg({ APP_ENCRYPTION_KEY: NEW }), { checkOnly: true })).unreadable).toBe(1);

    // 3. Re-encrypt: everything moves to the new key; running again is a no-op; it is audited.
    expect(await rotateEncryptedValues(db, mid)).toMatchObject({ remaining: 0, unreadable: 0 });
    expect(encryptedWith(await stored(), NEW)).toBe(true);
    expect((await rotateEncryptedValues(db, mid)).columns.every((c) => c.reencrypted === 0)).toBe(true);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'platform.encryption_key_rotated'`)).rows[0].n).toBe(2);

    // 4. Old key removed entirely: sign-in still works.
    const appNew = await buildApp({ config: cfg({ APP_ENCRYPTION_KEY: NEW }), db, logger: false });
    expect((await signIn(appNew, totpAt(secret, step + 1))).statusCode).toBe(200);
    await appNew.close();
  });
});
