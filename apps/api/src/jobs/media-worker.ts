/**
 * Long-running media worker (R-023): claims uploaded files and processes them (probe, transcode, thumbnails, AI
 * pre-screen). Designed to run in the isolated container in infra/media-worker: non-root, read-only filesystem,
 * no capabilities, no internet (database-only network), memory/CPU/process limits; ffmpeg additionally runs under
 * prlimit with local-file-only input (see modules/media/process.ts).
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { processPendingUploads } from '../modules/media/process.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stopping = true; });
console.log(JSON.stringify({ msg: 'media worker started', mediaRoot: config.MEDIA_ROOT }));
while (!stopping) {
  try {
    const r = await processPendingUploads(db, config);
    if (r.processed) console.log(JSON.stringify({ msg: 'processed uploads', ...r }));
    else await new Promise((res) => setTimeout(res, 3000));
  } catch (e) {
    console.error(JSON.stringify({ msg: 'media worker error', error: (e as Error).message }));
    await new Promise((res) => setTimeout(res, 5000));
  }
}
await db.end();
