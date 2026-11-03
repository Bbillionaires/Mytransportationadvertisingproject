/**
 * SYNTHETIC DEMO DATA ONLY. Every organization and user created here is flagged is_synthetic and
 * named "(SYNTHETIC)". Never run against a production database. Revenue rule v1 approvals here are
 * made by synthetic approver accounts purely for the demo; real rules need real approvers.
 */
import { randomBytes } from 'node:crypto';
import { createPool, withTx } from './pool.js';
import { hashPassword } from '../lib/crypto.js';
import { INITIAL_RULE_SPLITS, REVENUE_CATEGORIES } from '@rmn/finance-core';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed synthetic data in production');

const db = createPool(url);
const password = process.env.SEED_PASSWORD ?? randomBytes(12).toString('base64url');

await withTx(db, async (tx) => {
  const exists = await tx.query(`SELECT 1 FROM organizations WHERE kind = 'PLATFORM'`);
  if (exists.rows[0]) { console.log('already seeded'); return; }
  const pw = await hashPassword(password);
  const org = async (kind: string, name: string) => (await tx.query('INSERT INTO organizations (kind, name, is_synthetic) VALUES ($1,$2,true) RETURNING id', [kind, `${name} (SYNTHETIC)`])).rows[0].id as string;
  const user = async (email: string, name: string) => (await tx.query('INSERT INTO users (email, password_hash, display_name, is_synthetic) VALUES ($1,$2,$3,true) RETURNING id', [email, pw, `${name} (SYNTHETIC)`])).rows[0].id as string;
  const member = (u: string, o: string, role: string) => tx.query('INSERT INTO memberships (user_id, org_id, role_code) VALUES ($1,$2,$3)', [u, o, role]);

  const platform = await org('PLATFORM', 'Rideshare Media Network');
  const admin = await user('admin@example.test', 'Super Admin'); await member(admin, platform, 'super_admin');
  const fin = await user('finance@example.test', 'Finance Admin'); await member(fin, platform, 'finance_admin');
  const ap1 = await user('approver1@example.test', 'Finance Approver 1'); await member(ap1, platform, 'finance_approver');
  const ap2 = await user('approver2@example.test', 'Finance Approver 2'); await member(ap2, platform, 'finance_approver');

  for (const [i, fleetName] of ['Springfield Rides', 'Capital City Cabs'].entries()) {
    const op = await org('FLEET_OPERATOR', fleetName);
    const fa = await user(`fleet${i + 1}@example.test`, `${fleetName} Admin`); await member(fa, op, 'fleet_admin');
    const fleet = (await tx.query('INSERT INTO fleets (org_id, name, market, timezone) VALUES ($1,$2,$3,$4) RETURNING id', [op, `${fleetName} Main`, 'Springfield (synthetic city)', 'America/Chicago'])).rows[0].id;
    for (let v = 1; v <= 3; v++) {
      await tx.query('INSERT INTO vehicles (org_id, fleet_id, label, make_model) VALUES ($1,$2,$3,$4)', [op, fleet, `UNIT-${i + 1}0${v}`, 'Synthetic Sedan']);
      const du = await user(`driver${i + 1}${v}@example.test`, `Driver ${i + 1}-${v}`); await member(du, op, 'driver');
      await tx.query(`INSERT INTO drivers (org_id, fleet_id, user_id, eligibility_status) VALUES ($1,$2,$3,$4)`, [op, fleet, du, v === 3 ? 'PENDING' : 'ELIGIBLE']);
    }
  }
  const advOrg = await org('ADVERTISER', 'Main Street Coffee');
  const au = await user('advertiser@example.test', 'Advertiser Admin'); await member(au, advOrg, 'advertiser_admin');
  for (const name of ['Family Cooking Channel', 'City Walks Channel']) {
    const co = await org('CREATOR_STUDIO', name);
    const cu = await user(`${name.split(' ')[0]!.toLowerCase()}@example.test`, `${name} Owner`); await member(cu, co, 'creator_owner');
    await tx.query(`INSERT INTO creator_profiles (org_id, display_name, monetization_status) VALUES ($1,$2,'ELIGIBLE')`, [co, `${name} (SYNTHETIC)`]);
  }

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  await tx.query('INSERT INTO accounting_periods (period_start, period_end) VALUES ($1,$2)', [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]);

  for (const cat of REVENUE_CATEGORIES) {
    const s = INITIAL_RULE_SPLITS[cat];
    await tx.query(
      `INSERT INTO revenue_rule_versions (category, version, effective_from, driver_bps, creator_bps, platform_bps, unallocated_driver_share, unallocated_creator_share,
         eligible_revenue_definition, contract_ref, status, created_by, approved_by_1, approved_by_2, approved_at)
       VALUES ($1,1,'2026-01-01T00:00:00Z',$2,$3,$4,'TO_PLATFORM','TO_PLATFORM',$5,'SYNTHETIC-DEMO-TERMS-v1','APPROVED',$6,$7,$8,now())`,
      [cat, s.driverBps, s.creatorBps, s.platformBps, 'Validated, billable net revenue per specification v1.0 (synthetic demo approval)', fin, ap1, ap2],
    );
  }
  console.log('Seeded SYNTHETIC demo data. All demo users share the password below; MFA must be enrolled before finance/platform actions.');
  console.log(`  users: admin@, finance@, approver1@, approver2@, fleet1@, fleet2@, advertiser@ (example.test)`);
  console.log(`  password: ${password}`);
});
await db.end();
