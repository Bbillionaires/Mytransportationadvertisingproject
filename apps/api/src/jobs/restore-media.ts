/**
 * Manual recovery: restore missing/damaged originals from the backups and re-create missing renditions.
 *   npm run jobs:restore-media -w @rmn/api                 (everything)
 *   npm run jobs:restore-media -w @rmn/api -- <uploadId>…  (selected uploads)
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { restoreMedia } from '../modules/media/backup.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const ids = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/.test(a));
const r = await restoreMedia(db, config, ids.length ? { uploadIds: ids } : {});
console.log(JSON.stringify(r));
if (r.failed.length) process.exitCode = 1;
await db.end();
