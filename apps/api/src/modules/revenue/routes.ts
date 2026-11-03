import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { currency, idemKey, isoDate, minor, parse, uuid } from '../../lib/validation.js';
import { actorOf, authorize } from '../../auth/context.js';
import { calculateAllocation, calculationToJson, postAllocation, type AllocationRequest } from './service.js';

const ruleDraft = z.object({
  category: z.enum(['CREATOR_CONTENT_AD', 'STANDALONE_AD', 'SALES_COMMISSION_WITH_CREATOR', 'SALES_COMMISSION_NO_CREATOR']),
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().optional(),
  driverBps: z.number().int().min(0).max(10000),
  creatorBps: z.number().int().min(0).max(10000),
  platformBps: z.number().int().min(0).max(10000),
  unallocatedDriverShare: z.enum(['TO_PLATFORM', 'HOLD']),
  unallocatedCreatorShare: z.enum(['TO_PLATFORM', 'HOLD']),
  permittedDeductions: z.array(z.enum(['PAYMENT_PROCESSING_FEE', 'DIRECT_CAMPAIGN_COST'])).default(['PAYMENT_PROCESSING_FEE', 'DIRECT_CAMPAIGN_COST']),
  eligibleRevenueDefinition: z.string().min(10).max(4000),
  contractRef: z.string().min(2).max(200),
});

const allocationSchema = z.object({
  idempotencyKey: idemKey,
  kind: z.enum(['AD', 'SALES_COMMISSION']),
  sourceRef: z.string().min(3).max(200),
  advertiserOrgId: uuid,
  fundingAccount: z.enum(['2000', '1100']),
  currency,
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  entryDate: isoDate,
  grossReceipts: minor,
  taxCollected: minor.default(0n),
  refunds: minor.default(0n),
  credits: minor.default(0n),
  chargebacks: minor.default(0n),
  deductions: z.array(z.object({ type: z.string(), amount: minor, description: z.string().min(1).max(200), contractRef: z.string().min(1).max(200) })).default([]),
  creators: z.array(z.object({ creatorId: uuid, attributedRevenue: minor, verifiedWatchSeconds: minor, qualifiedViews: minor })).max(10000).default([]),
  drivers: z.array(z.object({ driverId: uuid, monetizedAdDelivery: minor, qualifiedEngagement: minor, eligibleActiveSeconds: minor })).max(10000).default([]),
}).refine((v) => new Date(v.periodEnd) > new Date(v.periodStart), 'periodEnd must be after periodStart');

export async function revenueRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/v1/finance/revenue-rules', async (req) => {
    await authorize(db, req, 'finance.read');
    return { items: (await db.query('SELECT * FROM revenue_rule_versions ORDER BY category, version')).rows };
  });

  app.post('/v1/finance/revenue-rules', async (req, reply) => {
    const auth = await authorize(db, req, 'finance.rules.draft');
    const b = parse(ruleDraft, req.body);
    const r = await withTx(db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rule:' + b.category]);
      const v = await tx.query('SELECT coalesce(max(version), 0) + 1 AS v FROM revenue_rule_versions WHERE category = $1', [b.category]);
      const ins = await tx.query(
        `INSERT INTO revenue_rule_versions (category, version, effective_from, effective_to, driver_bps, creator_bps, platform_bps, unallocated_driver_share,
            unallocated_creator_share, permitted_deductions, eligible_revenue_definition, contract_ref, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [b.category, v.rows[0].v, b.effectiveFrom, b.effectiveTo ?? null, b.driverBps, b.creatorBps, b.platformBps, b.unallocatedDriverShare,
         b.unallocatedCreatorShare, b.permittedDeductions, b.eligibleRevenueDefinition, b.contractRef, auth.userId],
      );
      await audit(tx, actorOf(req), 'finance.rule_drafted', { type: 'revenue_rule_version', id: ins.rows[0].id }, b);
      return ins.rows[0];
    });
    reply.code(201);
    return r;
  });

  /**
   * Two distinct approvers (neither the drafter) are required. On final approval an open-ended predecessor
   * is closed at the new version's effective_from, which must be in the future so history never changes.
   */
  app.post('/v1/finance/revenue-rules/:id/approve', async (req) => {
    const auth = await authorize(db, req, 'finance.rules.approve');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return withTx(db, async (tx) => {
      const r = await tx.query('SELECT * FROM revenue_rule_versions WHERE id = $1 FOR UPDATE', [id]);
      const rule = r.rows[0];
      if (!rule) throw notFound();
      if (rule.status !== 'DRAFT') throw conflict('rule is not a draft');
      if (rule.created_by === auth.userId) throw forbidden('the drafter cannot approve their own rule', 'SEPARATION_OF_DUTIES');
      if (!rule.approved_by_1) {
        const u = await tx.query('UPDATE revenue_rule_versions SET approved_by_1 = $2 WHERE id = $1 RETURNING *', [id, auth.userId]);
        await audit(tx, actorOf(req), 'finance.rule_first_approval', { type: 'revenue_rule_version', id });
        return { ...u.rows[0], approvalsRemaining: 1 };
      }
      if (rule.approved_by_1 === auth.userId) throw forbidden('a second, different approver is required', 'SEPARATION_OF_DUTIES');
      const pred = await tx.query(
        `SELECT id, effective_from FROM revenue_rule_versions WHERE category = $1 AND status = 'APPROVED' AND effective_to IS NULL AND effective_from < $2 FOR UPDATE`,
        [rule.category, rule.effective_from],
      );
      if (pred.rows[0]) {
        if (new Date(rule.effective_from) < new Date()) throw conflict('a superseding rule must take effect in the future so historical calculations are preserved');
        await tx.query('UPDATE revenue_rule_versions SET effective_to = $2 WHERE id = $1', [pred.rows[0].id, rule.effective_from]);
      }
      const u = await tx.query(`UPDATE revenue_rule_versions SET approved_by_2 = $2, approved_at = now(), status = 'APPROVED' WHERE id = $1 RETURNING *`, [id, auth.userId]);
      await audit(tx, actorOf(req), 'finance.rule_approved', { type: 'revenue_rule_version', id }, { supersedes: pred.rows[0]?.id ?? null });
      return { ...u.rows[0], approvalsRemaining: 0 };
    });
  });

  app.post('/v1/finance/allocations/preview', async (req) => {
    await authorize(db, req, 'finance.read');
    const b = parse(allocationSchema, req.body) as AllocationRequest;
    return calculationToJson(await calculateAllocation(db, b));
  });

  app.post('/v1/finance/allocations', async (req, reply) => {
    const auth = await authorize(db, req, 'finance.allocation.post');
    const b = parse(allocationSchema, req.body) as AllocationRequest;
    const r = await withTx(db, async (tx) => {
      const out = await postAllocation(tx, b, auth.userId);
      if (!out.idempotent) await audit(tx, actorOf(req), 'finance.allocation_posted', { type: 'allocation_batch', id: out.batchId }, { status: out.status, sourceRef: b.sourceRef, journalEntryId: out.journalEntryId });
      return out;
    });
    reply.code(r.idempotent ? 200 : 201);
    return r;
  });

  app.get('/v1/finance/allocations/:id', async (req) => {
    await authorize(db, req, 'finance.read');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = await db.query('SELECT * FROM allocation_batches WHERE id = $1', [id]);
    if (!b.rows[0]) throw notFound();
    const l = await db.query('SELECT line_kind, party_id, amount, status, basis FROM allocation_lines WHERE batch_id = $1 ORDER BY id', [id]);
    return { ...b.rows[0], lines: l.rows };
  });

  /** Payable balances per recipient, from the ledger (source of truth), not from allocation rows. */
  app.get('/v1/finance/payables', async (req) => {
    await authorize(db, req, 'finance.read');
    const r = await db.query(`SELECT account_code, account_name, currency, party_type, party_id, balance FROM ledger_balances WHERE account_code IN ('2200','2210','2400') AND balance <> 0 ORDER BY account_code, party_id`);
    return { items: r.rows };
  });
}
