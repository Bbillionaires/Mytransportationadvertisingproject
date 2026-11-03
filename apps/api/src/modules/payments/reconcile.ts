import type { Db } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { postEntry } from '../ledger/service.js';
import type { PaymentProvider } from './provider.js';
import { PROCESSOR, postingDate, raiseException } from './webhooks.js';

/**
 * Match provider balance transactions for [from, to) against the ledger:
 *  - charges must match a recorded payment (same amount); their processing fee is booked (Dr 5000 / Cr 1010)
 *  - refunds must match a recorded refund
 *  - payouts to the bank move cash (Dr 1000 / Cr 1010)
 *  - recorded payments with no provider transaction, and anything unrecognised, become exceptions
 *  - optionally, the provider's lifetime net balance must equal ledger 1010 for this processor
 * Every posting is idempotent on the provider transaction id, so runs can be repeated safely.
 */
export async function runReconciliation(db: Db, provider: PaymentProvider, opts: { from: Date; to: Date; userId: string; compareBalance?: boolean }) {
  const txns = await provider.listBalanceTransactions(Math.floor(opts.from.getTime() / 1000), Math.floor(opts.to.getTime() / 1000));
  return withTx(db, async (tx) => {
    const run = (await tx.query(`INSERT INTO reconciliation_runs (provider, period_start, period_end, started_by, summary) VALUES ($1,$2,$3,$4,'{}') RETURNING id`,
      [PROCESSOR, opts.from, opts.to, opts.userId])).rows[0].id as string;
    const s = { transactions: txns.length, matched: 0, feesPosted: 0, payoutsPosted: 0, exceptions: 0 };
    const exc = async (kind: string, ref: string, amount: number | null, details: object) => { s.exceptions += 1; await raiseException(tx, kind, ref, amount, details, run); };
    const seen = new Set<string>();
    for (const t of txns) {
      const date = await postingDate(tx, new Date(t.created * 1000));
      if (t.type === 'charge' || t.type === 'payment') {
        seen.add(t.source ?? '');
        const p = (await tx.query('SELECT * FROM payments WHERE provider_charge_id = $1', [t.source])).rows[0];
        if (!p) { await exc('UNMATCHED_PROVIDER_TRANSACTION', t.id, t.amount, { type: t.type, source: t.source }); continue; }
        if (Number(p.amount_minor) !== t.amount) { await exc('AMOUNT_MISMATCH', t.id, t.amount, { paymentId: p.id, ledgerAmount: p.amount_minor }); continue; }
        s.matched += 1;
        if (t.fee > 0) {
          const e = await postEntry(tx, { idempotencyKey: `stripe-fee:${t.id}`, entryDate: date, description: `Processor fee for ${t.source}`, sourceType: 'PAYMENT', sourceId: t.id,
            lines: [{ accountCode: '5000', currency: t.currency, debit: BigInt(t.fee), memo: `fee ${t.id}` }, { accountCode: '1010', currency: t.currency, credit: BigInt(t.fee), processor: PROCESSOR, memo: `fee ${t.id}` }] });
          if (!e.idempotent) s.feesPosted += 1;
        }
      } else if (t.type === 'refund') {
        const r = (await tx.query('SELECT 1 FROM payment_refunds WHERE provider_refund_id = $1', [t.source])).rows[0];
        if (!r) await exc('UNMATCHED_PROVIDER_TRANSACTION', t.id, t.amount, { type: t.type, source: t.source });
        else s.matched += 1;
      } else if (t.type === 'payout') {
        const e = await postEntry(tx, { idempotencyKey: `stripe-payout:${t.id}`, entryDate: date, description: `Processor payout ${t.source} to bank`, sourceType: 'PAYMENT', sourceId: t.id,
          lines: [{ accountCode: '1000', currency: t.currency, debit: BigInt(-t.amount), memo: `payout ${t.source}` }, { accountCode: '1010', currency: t.currency, credit: BigInt(-t.amount), processor: PROCESSOR, memo: `payout ${t.source}` }] });
        if (!e.idempotent) s.payoutsPosted += 1;
        s.matched += 1;
      } else {
        await exc('UNMATCHED_PROVIDER_TRANSACTION', t.id, t.amount, { type: t.type, source: t.source });
      }
    }
    const missing = await tx.query(`SELECT id, provider_charge_id, amount_minor FROM payments WHERE provider = $1 AND paid_at >= $2 AND paid_at < $3`, [PROCESSOR, opts.from, opts.to]);
    for (const p of missing.rows) if (!seen.has(p.provider_charge_id)) await exc('MISSING_PROVIDER_TRANSACTION', p.provider_charge_id, Number(p.amount_minor), { paymentId: p.id });

    if (opts.compareBalance) {
      const all = await provider.listBalanceTransactions(0, Math.floor(opts.to.getTime() / 1000));
      const providerNet = all.reduce((a, t) => a + BigInt(t.net), 0n);
      const ledger = BigInt((await tx.query(`SELECT coalesce(sum(debit) - sum(credit), 0)::text b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                                             WHERE l.account_code = '1010' AND l.processor = $1 AND e.posted_at < $2`, [PROCESSOR, opts.to])).rows[0].b);
      Object.assign(s, { providerNetBalance: providerNet.toString(), ledgerClearingBalance: ledger.toString() });
      if (providerNet !== ledger) await exc('BALANCE_MISMATCH', `balance:${opts.to.toISOString()}`, Number(providerNet - ledger), { providerNet: providerNet.toString(), ledger: ledger.toString() });
    }
    await tx.query('UPDATE reconciliation_runs SET summary = $2 WHERE id = $1', [run, JSON.stringify(s)]);
    return { runId: run, ...s };
  });
}
