/** Scheduled job: process uploaded media (probe, transcode, thumbnails, AI pre-screen). Run every minute. */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { processPendingUploads } from '../modules/media/process.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
let total = 0;
for (;;) {
  const r = await processPendingUploads(db, config);
  total += r.processed;
  if (r.processed === 0) break;
}
console.log(`processed ${total} uploads`);
await db.end();
