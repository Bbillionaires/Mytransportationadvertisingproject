import {
  allocatePool, categoryFor, computeNet, CREATOR_POOL_WEIGHTS_V1, DRIVER_POOL_WEIGHTS_V1, splitParties,
  type DeductionType, type PoolAllocation, type RevenueCategory, type RevenueRuleVersion,
} from '@rmn/finance-core';
import type { Queryable, Tx } from '../../db/pool.js';
import { conflict, unprocessable } from '../../lib/errors.js';
import { postEntry, type LineInput } from '../ledger/service.js';

export function rowToRule(r: any): RevenueRuleVersion & { permittedDeductions: DeductionType[] } {
  return {
    id: r.id, category: r.category, version: r.version, effectiveFrom: new Date(r.effective_from), effectiveTo: r.effective_to ? new Date(r.effective_to) : null,
    driverBps: r.driver_bps, creatorBps: r.creator_bps, platformBps: r.platform_bps,
    unallocatedDriverShare: r.unallocated_driver_share, unallocatedCreatorShare: r.unallocated_creator_share, status: r.status,
    permittedDeductions: r.permitted_deductions,
  };
}

export async function ruleEffectiveAt(q: Queryable, category: RevenueCategory, at: Date) {
  const r = await q.query(
    `SELECT * FROM revenue_rule_versions WHERE category = $1 AND status <> 'DRAFT' AND effective_from <= $2 AND (effective_to IS NULL OR $2 < effective_to)`,
    [category, at.toISOString()],
  );
  if (r.rows.length !== 1) throw unprocessable(`no single approved ${category} rule is effective at ${at.toISOString()}; a split must be explicitly approved before revenue can be allocated`);
  return rowToRule(r.rows[0]);
}

export interface AllocationRequest {
  idempotencyKey: string;
  kind: 'AD' | 'SALES_COMMISSION';
  sourceRef: string;               // campaign id + window, or commission event id
  advertiserOrgId: string;
  fundingAccount: '2000' | '1100'; // advertiser prepaid balance, or receivable for invoiced commission
  currency: string;
  periodStart: string;
  periodEnd: string;
  entryDate: string;
  grossReceipts: bigint;
  taxCollected: bigint;
  refunds: bigint;
  credits: bigint;
  chargebacks: bigint;
  deductions: Array<{ type: string; amount: bigint; description: string; contractRef: string }>;
  creators: Array<{ creatorId: string; attributedRevenue: bigint; verifiedWatchSeconds: bigint; qualifiedViews: bigint }>;
  drivers: Array<{ driverId: string; monetizedAdDelivery: bigint; qualifiedEngagement: bigint; eligibleActiveSeconds: bigint }>;
}

const str = (v: bigint) => v.toString();

/** Pure-ish calculation using DB for rule lookup and eligibility. Used by both preview and post. */
export async function calculateAllocation(q: Queryable, req: AllocationRequest) {
  const adv = await q.query(`SELECT id FROM organizations WHERE id = $1 AND kind = 'ADVERTISER'`, [req.advertiserOrgId]);
  if (!adv.rows[0]) throw unprocessable('advertiserOrgId is not an advertiser organization');

  // Eligibility comes from the database, never from the caller.
  const creatorIds = req.creators.map((c) => c.creatorId);
  const driverIds = req.drivers.map((d) => d.driverId);
  const ce = await q.query(`SELECT id, monetization_status = 'ELIGIBLE' AS ok FROM creator_profiles WHERE id = ANY($1::uuid[])`, [creatorIds]);
  const de = await q.query(`SELECT id, eligibility_status = 'ELIGIBLE' AS ok FROM drivers WHERE id = ANY($1::uuid[])`, [driverIds]);
  const cOk = new Map<string, boolean>(ce.rows.map((r) => [r.id, r.ok]));
  const dOk = new Map<string, boolean>(de.rows.map((r) => [r.id, r.ok]));
  for (const id of creatorIds) if (!cOk.has(id)) throw unprocessable(`unknown creator ${id}`);
  for (const id of driverIds) if (!dOk.has(id)) throw unprocessable(`unknown driver ${id}`);

  const hasEligibleCreator = creatorIds.some((id) => cOk.get(id));
  const hasEligibleDriver = driverIds.some((id) => dOk.get(id));
  const category = categoryFor(req.kind, hasEligibleCreator);
  const rule = await ruleEffectiveAt(q, category, new Date(req.periodEnd));

  const waterfall = computeNet({
    currency: req.currency, grossReceipts: req.grossReceipts, taxCollected: req.taxCollected, refunds: req.refunds,
    credits: req.credits, chargebacks: req.chargebacks, deductions: req.deductions, permittedDeductionTypes: rule.permittedDeductions,
  });

  if (waterfall.status !== 'DISTRIBUTABLE') {
    return { category, rule, waterfall, split: null, creatorPool: null, driverPool: null };
  }
  const split = splitParties({ net: waterfall.net, rule, hasEligibleDriver, hasEligibleCreator });
  const creatorPool = allocatePool(split.creator, req.creators.map((c) => ({
    id: c.creatorId, eligible: cOk.get(c.creatorId)!, metrics: { attributedRevenue: c.attributedRevenue, verifiedWatchSeconds: c.verifiedWatchSeconds, qualifiedViews: c.qualifiedViews },
  })), CREATOR_POOL_WEIGHTS_V1);
  const driverPool = allocatePool(split.driver, req.drivers.map((d) => ({
    id: d.driverId, eligible: dOk.get(d.driverId)!, metrics: { monetizedAdDelivery: d.monetizedAdDelivery, qualifiedEngagement: d.qualifiedEngagement, eligibleActiveSeconds: d.eligibleActiveSeconds },
  })), DRIVER_POOL_WEIGHTS_V1);
  return { category, rule, waterfall, split, creatorPool, driverPool };
}

type Calc = Awaited<ReturnType<typeof calculateAllocation>>;

const poolJson = (p: PoolAllocation | null) => p && { ...p, pool: str(p.pool), shares: p.shares.map((s) => ({ key: s.key, amount: str(s.amount) })) };

export function calculationToJson(c: Calc) {
  const w = c.waterfall;
  return {
    category: c.category,
    ruleVersionId: c.rule.id,
    ruleVersion: c.rule.version,
    split: { driverBps: c.rule.driverBps, creatorBps: c.rule.creatorBps, platformBps: c.rule.platformBps },
    waterfall: {
      currency: w.currency, grossReceipts: str(w.grossReceipts), taxExcluded: str(w.taxExcluded),
      refunds: str(w.adjustments.refunds), credits: str(w.adjustments.credits), chargebacks: str(w.adjustments.chargebacks),
      deductions: w.deductions.map((d) => ({ ...d, amount: str(d.amount) })), totalDeductions: str(w.totalDeductions), net: str(w.net), status: w.status,
    },
    partySplit: c.split && Object.fromEntries(Object.entries(c.split).map(([k, v]) => [k, typeof v === 'bigint' ? str(v) : v])),
    creatorPool: poolJson(c.creatorPool),
    driverPool: poolJson(c.driverPool),
    roundingPolicy: 'RESIDUAL_TO_PLATFORM_V1',
  };
}

/**
 * Journal for a distributable batch. The funding account (advertiser prepaid or receivable) is
 * debited by the earned amount after tax and adjustments (those are posted by their own payment-side
 * entries); permitted deductions credit contra-expense recovery accounts; every party share credits
 * its payable/revenue/held account. Pools that are HELD credit 2400 rather than any party.
 */
function buildLines(req: AllocationRequest, c: Calc): { lines: LineInput[]; alloc: Array<{ kind: string; partyId: string | null; amount: bigint; basis: object }> } {
  const ccy = req.currency;
  const w = c.waterfall;
  const s = c.split!;
  const isCommission = req.kind === 'SALES_COMMISSION';
  const lines: LineInput[] = [];
  const alloc: Array<{ kind: string; partyId: string | null; amount: bigint; basis: object }> = [];
  const earned = w.grossReceipts - w.taxExcluded - w.adjustments.refunds - w.adjustments.credits - w.adjustments.chargebacks;
  lines.push({ accountCode: req.fundingAccount, currency: ccy, debit: earned, partyType: 'ADVERTISER', partyId: req.advertiserOrgId, memo: `earned ${req.sourceRef}` });

  for (const d of w.deductions) {
    if (d.amount === 0n) continue;
    lines.push({ accountCode: d.type === 'PAYMENT_PROCESSING_FEE' ? '5001' : '5101', currency: ccy, credit: d.amount, memo: `${d.description} [${d.contractRef}]` });
    alloc.push({ kind: 'DEDUCTION', partyId: null, amount: d.amount, basis: { type: d.type, contractRef: d.contractRef } });
  }
  const credit = (accountCode: string, amount: bigint, memo: string, partyType?: 'CREATOR' | 'DRIVER', partyId?: string) => {
    if (amount > 0n) lines.push({ accountCode, currency: ccy, credit: amount, memo, partyType: partyType ?? null, partyId: partyId ?? null });
  };

  const distributePool = (pool: PoolAllocation, party: 'CREATOR' | 'DRIVER') => {
    const payable = party === 'CREATOR' ? '2200' : '2210';
    if (pool.status === 'HELD_NO_ACTIVITY') {
      credit('2400', pool.pool, `${party.toLowerCase()} pool held: no eligible activity`);
      alloc.push({ kind: 'HELD', partyId: null, amount: pool.pool, basis: { reason: `${party}_POOL_NO_ACTIVITY`, policy: pool.policy } });
      return;
    }
    for (const sh of pool.shares) {
      credit(payable, sh.amount, `${party.toLowerCase()} share ${req.sourceRef}`, party, sh.key);
      if (sh.amount > 0n) alloc.push({ kind: party, partyId: sh.key, amount: sh.amount, basis: { score: pool.scoreNumerators[sh.key], denominator: pool.scoreDenominator, effectiveWeights: pool.effectiveWeights } });
    }
  };
  distributePool(c.driverPool!, 'DRIVER');
  distributePool(c.creatorPool!, 'CREATOR');

  credit(isCommission ? '4100' : '4000', s.platform, 'platform contractual share');
  alloc.push({ kind: 'PLATFORM', partyId: null, amount: s.platform, basis: { bps: c.rule.platformBps } });
  credit('4010', s.platformFromUnallocatedDriver, 'no eligible driver: share to platform per signed terms');
  if (s.platformFromUnallocatedDriver > 0n) alloc.push({ kind: 'PLATFORM_UNALLOCATED_DRIVER', partyId: null, amount: s.platformFromUnallocatedDriver, basis: {} });
  credit('4010', s.platformFromUnallocatedCreator, 'no eligible creator: share to platform per signed terms');
  if (s.platformFromUnallocatedCreator > 0n) alloc.push({ kind: 'PLATFORM_UNALLOCATED_CREATOR', partyId: null, amount: s.platformFromUnallocatedCreator, basis: {} });
  credit('2400', s.held, 'party share held per rule policy');
  if (s.held > 0n) alloc.push({ kind: 'HELD', partyId: null, amount: s.held, basis: { reason: 'UNALLOCATED_SHARE_HOLD_POLICY' } });
  credit('4020', s.roundingResidual, 'rounding residual (RESIDUAL_TO_PLATFORM_V1)');
  if (s.roundingResidual > 0n) alloc.push({ kind: 'ROUNDING', partyId: null, amount: s.roundingResidual, basis: { policy: 'RESIDUAL_TO_PLATFORM_V1' } });
  return { lines, alloc };
}

export async function postAllocation(tx: Tx, req: AllocationRequest, userId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['alloc:' + req.idempotencyKey]);
  const prior = await tx.query('SELECT id, status, journal_entry_id, calculation FROM allocation_batches WHERE idempotency_key = $1', [req.idempotencyKey]);
  if (prior.rows[0]) return { batchId: prior.rows[0].id, status: prior.rows[0].status, journalEntryId: prior.rows[0].journal_entry_id, calculation: prior.rows[0].calculation, idempotent: true };

  // Guard against allocating the same source window twice under different keys.
  const dup = await tx.query(
    `SELECT id FROM allocation_batches WHERE source_type = $1 AND source_ref = $2 AND status = 'POSTED'`,
    [req.kind === 'AD' ? 'CAMPAIGN_SPEND' : 'SALES_COMMISSION', req.sourceRef],
  );
  if (dup.rows[0]) throw conflict(`source ${req.sourceRef} has already been allocated (batch ${dup.rows[0].id})`);

  const calc = await calculateAllocation(tx, req);
  const json = calculationToJson(calc);
  const w = calc.waterfall;
  const status = w.status === 'DISTRIBUTABLE' ? 'POSTED' : w.status === 'ZERO' ? 'NO_DISTRIBUTION' : 'REVIEW_NEGATIVE_NET';

  let journalEntryId: string | null = null;
  let alloc: ReturnType<typeof buildLines>['alloc'] = [];
  if (status === 'POSTED') {
    const built = buildLines(req, calc);
    if (req.fundingAccount === '2000') {
      // Funding validation: earned spend can never exceed the advertiser's prepaid balance (serialized per advertiser).
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['funding:' + req.advertiserOrgId]);
      const bal = await tx.query(
        `SELECT coalesce(sum(credit) - sum(debit), 0)::text AS b FROM journal_lines WHERE account_code = '2000' AND party_id = $1 AND currency = $2`,
        [req.advertiserOrgId, req.currency],
      );
      const earned = built.lines[0]!.debit!;
      if (BigInt(bal.rows[0].b) < earned) throw unprocessable(`campaign is underfunded: prepaid balance ${bal.rows[0].b} < earned ${earned}`, { code: 'UNDERFUNDED' });
    }
    alloc = built.alloc;
    const entry = await postEntry(tx, {
      idempotencyKey: `alloc:${req.idempotencyKey}`, entryDate: req.entryDate, description: `${calc.category} allocation for ${req.sourceRef}`,
      sourceType: 'ALLOCATION', sourceId: req.sourceRef, postedBy: userId, lines: built.lines, metadata: { ruleVersionId: calc.rule.id },
    });
    journalEntryId = entry.id;
  }
  const b = await tx.query(
    `INSERT INTO allocation_batches (idempotency_key, category, rule_version_id, currency, source_type, source_ref, advertiser_org_id, funding_account,
        period_start, period_end, gross_receipts, tax_excluded, refunds, credits, chargebacks, total_deductions, net, status, calculation, journal_entry_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
    [req.idempotencyKey, calc.category, calc.rule.id, req.currency, req.kind === 'AD' ? 'CAMPAIGN_SPEND' : 'SALES_COMMISSION', req.sourceRef, req.advertiserOrgId, req.fundingAccount,
     req.periodStart, req.periodEnd, str(w.grossReceipts), str(w.taxExcluded), str(w.adjustments.refunds), str(w.adjustments.credits), str(w.adjustments.chargebacks),
     str(w.totalDeductions), str(w.net), status, JSON.stringify(json), journalEntryId, userId],
  );
  const batchId = b.rows[0].id;
  for (const a of alloc) {
    await tx.query(`INSERT INTO allocation_lines (batch_id, line_kind, party_id, amount, status, basis) VALUES ($1,$2,$3,$4,$5,$6)`,
      [batchId, a.kind, a.partyId, str(a.amount), a.kind === 'HELD' ? 'HELD' : 'PENDING', JSON.stringify(a.basis)]);
  }
  return { batchId, status, journalEntryId, calculation: json, idempotent: false };
}
