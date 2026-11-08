import { encryptionKeys, type Config } from '../../config.js';
import { withTx, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { decrypt, encrypt, encryptedWith, keyId } from '../../lib/crypto.js';

/** Every column holding values encrypted with APP_ENCRYPTION_KEY. Add new encrypted columns here. */
export const ENCRYPTED_COLUMNS = [
  { table: 'users', column: 'mfa_secret_enc' },
  { table: 'rider_pairings', column: 'session_token_enc' },
] as const;

/**
 * Re-encrypts every value under the current APP_ENCRYPTION_KEY (R-016). Safe to run repeatedly and while the app is
 * serving: each row is re-read and updated in its own short transaction only if it still holds the old value.
 * checkOnly: just count what is still on an old key. Unreadable values are reported, never overwritten.
 */
export async function rotateEncryptedValues(db: Db, config: Config, opts: { checkOnly?: boolean } = {}) {
  const keys = encryptionKeys(config);
  const current = config.APP_ENCRYPTION_KEY;
  const out: Array<{ table: string; column: string; total: number; onOldKey: number; reencrypted: number; unreadable: number }> = [];
  for (const { table, column } of ENCRYPTED_COLUMNS) {
    const rows = (await db.query(`SELECT id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`)).rows as Array<{ id: string; v: string }>;
    const stats = { table, column, total: rows.length, onOldKey: 0, reencrypted: 0, unreadable: 0 };
    for (const r of rows) {
      if (encryptedWith(r.v, current)) continue;
      stats.onOldKey++;
      let plain: string;
      try { plain = decrypt(r.v, keys); } catch { stats.unreadable++; continue; }
      if (opts.checkOnly) continue;
      const u = await db.query(`UPDATE ${table} SET ${column} = $3 WHERE id = $1 AND ${column} = $2`, [r.id, r.v, encrypt(plain, current)]);
      stats.reencrypted += u.rowCount ?? 0;
    }
    out.push(stats);
  }
  if (!opts.checkOnly) {
    await withTx(db, (tx) => audit(tx, { requestId: 'rotate-encryption-key' }, 'platform.encryption_key_rotated', { type: 'encryption_key', id: keyId(current) },
      { columns: out.map((o) => ({ ...o })) }));
  }
  const remaining = out.reduce((n, o) => n + (opts.checkOnly ? o.onOldKey : o.onOldKey - o.reencrypted), 0);
  return { currentKeyId: keyId(current), previousKeyIds: keys.slice(1).map(keyId), columns: out, remaining, unreadable: out.reduce((n, o) => n + o.unreadable, 0) };
}
