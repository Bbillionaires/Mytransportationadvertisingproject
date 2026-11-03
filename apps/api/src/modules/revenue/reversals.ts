import { proportionalReversal } from '@rmn/finance-core';
import type { Queryable, Tx } from '../../db/pool.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { postEntry, type LineInput } from '../ledger/service.js';

export type ReversalType = 'REFUND' | 'CHARGEBACK' | 'CREDIT';

export interface ReversalInput {
  idempotencyKey: string;
  batchId: string;
  type: ReversalType;
  amount: bigint;           // portion of the batch's earned amount being returned
  entryDate: string;
  reason: string;
  processor?: string | null;
}

/**
 * Where the reversed value goes (D-021):
 *   REFUND     -> 2600 Refunds payable (cash goes back to the advertiser in a separate payment entry)
 *   CHARGEBACK -> 1010 Processor clearing (the processor has already pulled the funds)
 *   CREDIT     -> the batch's funding account (restores prepaid balance, or reduces the commission receivable)
 */
function settlementAccount(type: ReversalType, fundingAccount: string): string {
  return type === 'REFUND' ? '2600' : type === 'CHARGEBACK' ? '1010' : fundingAccount;
}

/** Ledger account each allocation line was originally credited to. */
function accountFor(line: { line_kind: string; basis: any }, sourceType: string): string {
  switch (line.line_kind) {
    case 'DRIVER': return '2210';
    case 'CREATOR': return '2200';
    case 'PLATFORM': return sourceType === 'SALES_COMMISSION' ? '4100' : '4000';
    case 'PLATFORM_UNALLOCATED_DRIVER':
    case 'PLATFORM_UNALLOCATED_CREATOR': return '4010';
    case 'ROUNDING': return '4020';
    case 'HELD': return '2400';
    case 'DEDUCTION': return line.basis?.type === 'DIRECT_CAMPAIGN_COST' ? '5101' : '5001';
    default: throw new Error(`unknown allocation line kind ${line.line_kind}`);
  }
}

/** Compute the proportional reversal without writing anything (used for request validation and preview). */
export async function planReversal(q: Queryable, input: Pick<ReversalInput, 'batchId' | 'type' | 'amount'>) {
  const b = await q.query('SELECT * FROM allocation_batches WHERE id = $1', [input.batchId]);
  const batch = b.rows[0];
  if (!batch) throw notFound('allocation batch not found');
  if (batch.status !== 'POSTED') throw unprocessable('only posted batches can be reversed');
  const lines = await q.query(
    `SELECT l.id, l.line_kind, l.party_id, l.amount, l.status, l.basis, coalesce(sum(r.amount), 0) AS reversed
       FROM allocation_lines l LEFT JOIN allocation_reversal_lines r ON r.allocation_line_id = l.id
      WHERE l.batch_id = $1 GROUP BY l.id ORDER BY l.id`, [input.batchId]);
  const state = lines.rows.map((l) => ({ ...l, amount: BigInt(l.amount), reversed: BigInt(l.reversed) }));
  const remaining = state.reduce((a, l) => a + l.amount - l.reversed, 0n);
  if (input.amount > remaining) throw unprocessable(`reversal ${input.amount} exceeds the un-reversed allocation ${remaining}`);
  const shares = proportionalReversal(state.map((l) => ({ key: String(l.id), originalAmount: l.amount, alreadyReversed: l.reversed })), input.amount);
  const byId = new Map(shares.map((s) => [s.key, s.amount]));
  const plan = state
    .map((l) => ({ lineId: String(l.id), kind: l.line_kind as string, partyId: l.party_id as string | null, status: l.status as string, basis: l.basis,
      amount: byId.get(String(l.id)) ?? 0n, fullyReversedAfter: l.reversed + (byId.get(String(l.id)) ?? 0n) === l.amount,
      clawback: l.status === 'PAID' && (l.line_kind === 'DRIVER' || l.line_kind === 'CREATOR') }))
    .filter((p) => p.amount > 0n);
  return { batch, remainingBefore: remaining, plan };
}

export function planToJson(p: Awaited<ReturnType<typeof planReversal>>) {
  return {
    batchId: p.batch.id, remainingBefore: p.remainingBefore.toString(),
    lines: p.plan.map((l) => ({ allocationLineId: l.lineId, kind: l.kind, partyId: l.partyId, amount: l.amount.toString(), clawback: l.clawback })),
  };
}

/** Post a reversal. Caller must already have enforced dual approval. Idempotent on idempotencyKey. */
export async function postReversal(tx: Tx, input: ReversalInput, requestedBy: string, approvedBy: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['alloc-batch:' + input.batchId]);
  const prior = await tx.query('SELECT id, journal_entry_id FROM allocation_reversals WHERE idempotency_key = $1', [input.idempotencyKey]);
  if (prior.rows[0]) return { reversalId: prior.rows[0].id, journalEntryId: prior.rows[0].journal_entry_id, idempotent: true };
  if (input.type === 'CHARGEBACK' && !input.processor) throw unprocessable('a chargeback must name the processor');

  const { batch, plan } = await planReversal(tx, input);
  const ccy = batch.currency.trim();
  const settle = settlementAccount(input.type, batch.funding_account);
  const lines: LineInput[] = plan.map((p) => {
    const party = p.kind === 'DRIVER' ? 'DRIVER' : p.kind === 'CREATOR' ? 'CREATOR' : null;
    return {
      accountCode: p.clawback ? '1200' : accountFor({ line_kind: p.kind, basis: p.basis }, batch.source_type),
      currency: ccy, debit: p.amount, partyType: party, partyId: party ? p.partyId : null,
      memo: `${input.type.toLowerCase()} of ${p.kind.toLowerCase()} share${p.clawback ? ' (already paid: clawback receivable)' : ''}`,
    };
  });
  const advertiserParty = ['2600', '2000', '1100'].includes(settle);
  lines.push({ accountCode: settle, currency: ccy, credit: input.amount, partyType: advertiserParty ? 'ADVERTISER' : null,
    partyId: advertiserParty ? batch.advertiser_org_id : null, processor: settle === '1010' ? input.processor ?? null : null, memo: `${input.type.toLowerCase()}: ${input.reason}` });

  const entry = await postEntry(tx, {
    idempotencyKey: `alloc-reversal:${input.idempotencyKey}`, entryDate: input.entryDate,
    description: `${input.type} against allocation batch ${batch.id} (${batch.source_ref})`,
    sourceType: input.type === 'CREDIT' ? 'ADJUSTMENT' : input.type, sourceId: batch.id,
    postedBy: requestedBy, approvedBy, lines, metadata: { batchId: batch.id, reason: input.reason },
  });
  const rev = await tx.query(
    `INSERT INTO allocation_reversals (idempotency_key, batch_id, type, amount, settlement_account, processor, reason, journal_entry_id, requested_by, approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [input.idempotencyKey, batch.id, input.type, input.amount.toString(), settle, input.processor ?? null, input.reason, entry.id, requestedBy, approvedBy]);
  for (const p of plan) {
    await tx.query('INSERT INTO allocation_reversal_lines (reversal_id, allocation_line_id, amount, clawback) VALUES ($1,$2,$3,$4)',
      [rev.rows[0].id, p.lineId, p.amount.toString(), p.clawback]);
    if (p.fullyReversedAfter && p.status !== 'PAID') await tx.query(`UPDATE allocation_lines SET status = 'REVERSED' WHERE id = $1`, [p.lineId]);
  }
  return { reversalId: rev.rows[0].id, journalEntryId: entry.id, idempotent: false };
}
