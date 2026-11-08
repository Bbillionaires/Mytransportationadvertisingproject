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
    const existing = await tx.query(
      `SELECT u.id, u.email, u.password_changed_at FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.role_code = 'super_admin' AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'`);
    if (existing.rows[0]) {
      // The first admin's link expired before they used it (no email provider to send a reset yet): re-issue it, but
      // only for that same email and only while no super admin has ever chosen a password.
      const unclaimed = existing.rows.every((r) => r.password_changed_at === null);
      const same = existing.rows.find((r) => String(r.email).toLowerCase() === email.toLowerCase());
      if (!unclaimed || !same) throw new Error('a super admin already exists; invite further staff from the portal (Team) instead');
      await audit(tx, { requestId: 'bootstrap' }, 'platform.bootstrap_link_reissued', { type: 'user', id: same.id }, { email });
      return issueUserToken(tx, config, same.id, same.email, 'PASSWORD_RESET');
    }
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

/**
 * No-terminal first-admin setup (Railway): set BOOTSTRAP_ADMIN_EMAIL (and optionally BOOTSTRAP_ADMIN_NAME) on the
 * worker. On start it creates the first super admin, or re-issues the unused link for that same email, and logs the
 * single-use 30-minute password link. Once a password has been chosen it does nothing (remove the variables then).
 */
export async function bootstrapFromEnv(db: Db, config: Config, env: NodeJS.ProcessEnv): Promise<{ status: 'skipped' | 'link' | 'refused'; link?: string; reason?: string }> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return { status: 'skipped' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { status: 'refused', reason: 'BOOTSTRAP_ADMIN_EMAIL is not a valid email address' };
  const name = env.BOOTSTRAP_ADMIN_NAME?.trim().slice(0, 200) || 'Administrator';
  try {
    return { status: 'link', link: await bootstrapAdmin(db, config, email, name) };
  } catch (e) {
    return { status: 'refused', reason: (e as Error).message };
  }
}
