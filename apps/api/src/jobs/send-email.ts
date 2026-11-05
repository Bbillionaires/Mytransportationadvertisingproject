/** Scheduled job: deliver queued transactional email. Run every minute. */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { deliverPendingEmail, emailSender } from '../lib/email.js';

const config = loadConfig();
if (config.NODE_ENV === 'production' && config.EMAIL_PROVIDER === 'log') throw new Error('set EMAIL_PROVIDER=resend (D-044) before sending email in production');
const db = createPool(config.DATABASE_URL);
console.log(JSON.stringify(await deliverPendingEmail(db, emailSender(config))));
await db.end();
