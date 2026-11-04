/** Scheduled job (every 5 minutes): copy new original uploads to every configured backup bucket (add-only). */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { runBackups } from '../modules/media/backup.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const total: Record<string, { copied: number; failed: number }> = {};
for (;;) {
  const r = await runBackups(db, config);
  let copied = 0;
  for (const [k, v] of Object.entries(r)) { total[k] ??= { copied: 0, failed: 0 }; total[k].copied += v.copied; total[k].failed += v.failed; copied += v.copied; }
  if (copied === 0) break;
}
console.log(JSON.stringify(Object.keys(total).length ? total : { note: 'no backup buckets configured (BACKUP1_S3_BUCKET)' }));
if (Object.values(total).some((t) => t.failed > 0)) process.exitCode = 1;
await db.end();
