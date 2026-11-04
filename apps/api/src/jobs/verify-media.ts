/**
 * Nightly media audit: every original present with the right size/SHA-256 in the main bucket and every backup.
 * `--deep` re-downloads and re-hashes everything (run monthly). Non-zero exit = a problem needs attention.
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { verifyMedia } from '../modules/media/backup.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const r = await verifyMedia(db, config, { deep: process.argv.includes('--deep') });
console.log(JSON.stringify({ ...r, problems: r.problems.slice(0, 50), problemCount: r.problems.length }));
if (r.problems.length || r.backups.length === 0) process.exitCode = 1; // no backups configured is itself a problem
await db.end();
