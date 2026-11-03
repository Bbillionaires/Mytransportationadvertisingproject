/** Scheduled job: retry failed/pending payment webhooks with backoff. Run every minute. */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { processPendingWebhooks } from '../modules/payments/webhooks.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
console.log(JSON.stringify(await processPendingWebhooks(db)));
await db.end();
