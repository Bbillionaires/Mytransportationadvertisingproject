/** Scheduled job: deliver queued transactional email. Run every minute. */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { deliverPendingEmail, LogEmailSender } from '../lib/email.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('configure a production email provider (D-044) before running in production');
const db = createPool(config.DATABASE_URL);
console.log(JSON.stringify(await deliverPendingEmail(db, new LogEmailSender())));
await db.end();
