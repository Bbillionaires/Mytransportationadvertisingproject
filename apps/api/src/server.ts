import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp } from './app.js';
import { startInProcessJobs } from './jobs/inProcess.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const app = await buildApp({ config, db });
const stopJobs = config.DEV_IN_PROCESS_JOBS === 'true' ? startInProcessJobs(db, config, app.log) : () => {};

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutting down');
  stopJobs();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
