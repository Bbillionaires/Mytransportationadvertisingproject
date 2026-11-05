/**
 * First-time production setup: creates the platform organization and the FIRST super admin, then prints a
 * single-use, 30-minute link to choose a password (also emailed when an email provider is configured).
 * Refuses to run once any active super admin exists — later staff are invited from the portal (Team).
 *   npm run jobs:bootstrap-admin -w @rmn/api -- --email you@company.com --name "Your Name"
 * After choosing the password, enable two-step verification under Security: staff actions require it.
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { bootstrapAdmin } from '../modules/platform/bootstrap.js';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const email = arg('email')?.trim().toLowerCase(), name = arg('name')?.trim();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
  console.error('usage: jobs:bootstrap-admin -- --email you@company.com --name "Your Name"');
  process.exit(2);
}
const config = loadConfig();
const db = createPool(config.DATABASE_URL);
try {
  const resetLink = await bootstrapAdmin(db, config, email, name);
  console.log(`Super admin ${email} created.\nChoose a password within 30 minutes (single use):\n${resetLink}\nThen sign in at ${config.APP_PUBLIC_URL}/portal/ and turn on two-step verification under Security.`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
