import { randomBytes } from 'node:crypto';
import type { Config } from '../../config.js';
import { withTx, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { issueUserToken } from '../identity/accounts.js';

/** Create the platform org (if missing) and the first super admin; returns a single-use password link. See jobs/bootstrap-admin.ts. */
export async function bootstrapAdmin(db: Db, config: Config, email: string, name: string): Promise<string> {
  return withTx(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['bootstrap-admin']);
    const existing = await tx.query(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role_code = 'super_admin' AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'`);
    if (existing.rows[0]) throw new Error('a super admin already exists; invite further staff from the portal (Team) instead');
    let org = (await tx.query(`SELECT id FROM organizations WHERE kind = 'PLATFORM' ORDER BY created_at LIMIT 1`)).rows[0];
    org ??= (await tx.query(`INSERT INTO organizations (kind, name) VALUES ('PLATFORM', 'Platform') RETURNING id`)).rows[0];
    if ((await tx.query('SELECT 1 FROM users WHERE email = $1', [email])).rows[0]) throw new Error(`a user with ${email} already exists`);
    // Unusable random password: the admin proves control of the mailbox/link and chooses their own.
    const u = (await tx.query(`INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1,$2,$3, now()) RETURNING id`,
      [email, await hashPassword(randomBytes(32).toString('base64')), name])).rows[0];
    await tx.query(`INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,'super_admin')`, [u.id, org.id]);
    await audit(tx, { requestId: 'bootstrap' }, 'platform.bootstrap_admin', { type: 'user', id: u.id, orgId: org.id }, { email });
    return issueUserToken(tx, config, u.id, email, 'PASSWORD_RESET');
  });
}
