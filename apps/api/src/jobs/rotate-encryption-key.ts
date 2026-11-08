/**
 * Encryption key rotation (R-016, docs/KEY_ROTATION.md). After setting a new APP_ENCRYPTION_KEY and moving the old one
 * to APP_ENCRYPTION_KEY_PREVIOUS, run this to re-encrypt every stored secret under the new key. When it reports
 * `remaining: 0` and `unreadable: 0`, remove APP_ENCRYPTION_KEY_PREVIOUS. `--check` only counts.
 *   node --import tsx src/jobs/rotate-encryption-key.ts [--check]
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { rotateEncryptedValues } from '../modules/platform/rotateKeys.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
try {
  const r = await rotateEncryptedValues(db, config, { checkOnly: process.argv.includes('--check') });
  console.log(JSON.stringify(r));
  if (r.unreadable) console.error(`${r.unreadable} value(s) cannot be opened with any configured key; do NOT remove APP_ENCRYPTION_KEY_PREVIOUS until resolved`);
  if (r.remaining || r.unreadable) process.exitCode = 1;
} finally {
  await db.end();
}
