import type { Queryable } from '../../db/pool.js';
import { formatDecimal } from '@rmn/finance-core';

export type Party = 'CREATOR' | 'DRIVER';
const PAYABLE: Record<Party, string> = { CREATOR: '2200', DRIVER: '2210' };
const B = (v: unknown) => BigInt((v as string | number | null) ?? 0);
export const usd = (minor: bigint) => formatDecimal({ amount: minor, currency: 'USD' });

export const EARNINGS_DISCLOSURE = 'Earnings are not guaranteed. Estimates are indicative only and become earnings only after validated delivery is allocated under the approved revenue rules. Amounts can be reduced by advertiser refunds or chargebacks.';

/**
 * Earnings drill-down for one or more recipients: every allocation line with its batch's
 * gross -> deductions -> net -> rule split -> pool basis -> amount -> reversed, plus ledger balances.
 */
export async function earnings(q: Queryable, party: Party, partyIds: string[], from: Date, to: Date) {
  const lines = await q.query(
    `SELECT l.id::text AS line_id, l.party_id, l.amount, l.status, l.basis, b.id AS batch_id, b.category, b.source_type, b.source_ref, b.period_start, b.period_end,
            b.currency, b.gross_receipts, b.total_deductions, b.net, b.created_at, b.calculation->'split' AS split,
            coalesce(sum(r.amount), 0) AS reversed, coalesce(bool_or(r.clawback), false) AS clawback
       FROM allocation_lines l JOIN allocation_batches b ON b.id = l.batch_id LEFT JOIN allocation_reversal_lines r ON r.allocation_line_id = l.id
      WHERE l.line_kind = $1 AND l.party_id = ANY($2::uuid[]) AND b.created_at >= $3 AND b.created_at < $4
      GROUP BY l.id, b.id ORDER BY b.created_at DESC, l.id`, [party, partyIds, from, to]);
  let earned = 0n, reversed = 0n;
  const byCategory: Record<string, bigint> = {};
  const items = lines.rows.map((r) => {
    earned += B(r.amount); reversed += B(r.reversed);
    byCategory[r.category] = (byCategory[r.category] ?? 0n) + B(r.amount) - B(r.reversed);
    return {
      lineId: r.line_id, partyId: r.party_id, batchId: r.batch_id, category: r.category, source: r.source_type, sourceRef: r.source_ref,
      period: { start: r.period_start, end: r.period_end }, allocatedAt: r.created_at, currency: r.currency.trim(),
      batch: { gross: String(r.gross_receipts), deductions: String(r.total_deductions), net: String(r.net), split: r.split },
      basis: r.basis, amount: String(r.amount), reversed: String(r.reversed), netAmount: String(B(r.amount) - B(r.reversed)),
      status: r.status, clawback: r.clawback,
    };
  });
  const bal = await q.query(
    `SELECT account_code, coalesce(sum(balance), 0) AS b FROM ledger_balances WHERE party_id = ANY($1::uuid[]) AND account_code IN ($2, '1200') GROUP BY account_code`,
    [partyIds, PAYABLE[party]]);
  const balance = (code: string) => B(bal.rows.find((x) => x.account_code === code)?.b);
  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    summary: {
      earned: String(earned), reversed: String(reversed), net: String(earned - reversed),
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, String(v)])),
      payableBalance: String(balance(PAYABLE[party])), owedBackClawback: String(balance('1200')), paidOut: '0',
      status: { pending: String(items.filter((i) => i.status === 'PENDING').reduce((a, i) => a + B(i.netAmount), 0n)), approved: '0', paid: '0' },
    },
    estimate: await estimate(q, party, partyIds),
    lines: items,
    disclosure: EARNINGS_DISCLOSURE,
  };
}

/**
 * Indicative, not-yet-allocated earnings: valid billable delivery and attributed commissions that have not been
 * allocated, times the party's rule share. Upper-bound style: before deductions and before sharing the pool.
 */
async function estimate(q: Queryable, party: Party, ids: string[]) {
  const col = party === 'CREATOR' ? 'creator_id' : 'driver_id';
  const ads = await q.query(
    `SELECT coalesce(sum(CASE WHEN c.pricing_model = 'CPQV' THEN c.rate_minor * 1000 ELSE c.rate_minor END), 0) AS milli
       FROM validated_events v JOIN campaigns c ON c.id = v.campaign_id
      WHERE v.${col} = ANY($1::uuid[]) AND v.type = 'AD_PLAYBACK' AND v.status = 'VALID'
        AND (CASE WHEN c.pricing_model = 'CPQV' THEN v.qualified ELSE v.impression END)
        AND NOT EXISTS (SELECT 1 FROM allocation_windows w WHERE w.campaign_id = c.id AND tstzrange(w.period_start, w.period_end) @> v.occurred_at)`, [ids]);
  const comm = await q.query(`SELECT coalesce(sum(commission_minor), 0) AS s FROM conversions WHERE ${col} = ANY($1::uuid[]) AND status = 'ATTRIBUTED' AND allocation_batch_id IS NULL`, [ids]);
  const rules = await q.query(`SELECT category, driver_bps, creator_bps FROM revenue_rule_versions WHERE status = 'APPROVED' AND effective_from <= now() AND (effective_to IS NULL OR now() < effective_to)`);
  const bps = (cat: string) => { const r = rules.rows.find((x) => x.category === cat); return BigInt(r ? (party === 'CREATOR' ? r.creator_bps : r.driver_bps) : 0); };
  const adSpend = B(ads.rows[0].milli) / 1000n;
  const adCat = party === 'CREATOR' ? 'CREATOR_CONTENT_AD' : 'STANDALONE_AD'; // driver share is 5% in both ad categories
  const commCat = party === 'CREATOR' ? 'SALES_COMMISSION_WITH_CREATOR' : 'SALES_COMMISSION_NO_CREATOR';
  const fromAds = (adSpend * bps(adCat)) / 10000n;
  const fromCommissions = (B(comm.rows[0].s) * bps(commCat)) / 10000n;
  return { indicativeOnly: true, unbilledAdSpend: String(adSpend), pendingCommissions: String(comm.rows[0].s), estimatedShare: String(fromAds + fromCommissions) };
}

/** Monthly statement from the ledger: opening payable, each posting affecting the recipient, closing payable. */
export async function statement(q: Queryable, party: Party, partyIds: string[], month: string) {
  const start = `${month}-01`;
  const end = (await q.query(`SELECT ($1::date + interval '1 month')::date::text AS e`, [start])).rows[0].e as string;
  const accounts = [PAYABLE[party], '1200'];
  const opening = await q.query(
    `SELECT l.account_code, coalesce(sum(l.credit) - sum(l.debit), 0) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.party_id = ANY($1::uuid[]) AND l.account_code = ANY($2::text[]) AND e.entry_date < $3 GROUP BY l.account_code`, [partyIds, accounts, start]);
  const rows = await q.query(
    `SELECT e.entry_date::text AS date, e.entry_number, e.source_type, e.description, l.account_code, l.debit, l.credit, l.memo
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.party_id = ANY($1::uuid[]) AND l.account_code = ANY($2::text[]) AND e.entry_date >= $3 AND e.entry_date < $4
      ORDER BY e.entry_date, e.entry_number, l.line_no`, [partyIds, accounts, start, end]);
  const openPayable = B(opening.rows.find((x) => x.account_code === PAYABLE[party])?.b);
  const openClawback = -B(opening.rows.find((x) => x.account_code === '1200')?.b);
  let payable = openPayable, clawback = openClawback, earned = 0n, reductions = 0n, newClawbacks = 0n, paid = 0n;
  const items = rows.rows.map((r) => {
    const cr = B(r.credit), dr = B(r.debit);
    let kind: string;
    if (r.account_code === '1200') { clawback += dr - cr; newClawbacks += dr; kind = 'OWED_BACK_AFTER_PAYOUT'; }
    else {
      payable += cr - dr;
      if (cr > 0n) { earned += cr; kind = 'EARNINGS'; }
      else if (r.source_type === 'PAYOUT') { paid += dr; kind = 'PAYOUT'; }
      else { reductions += dr; kind = 'REFUND_OR_CHARGEBACK'; }
    }
    return { date: r.date, entry: String(r.entry_number), kind, description: r.description, memo: r.memo, amount: String(cr > 0n ? cr : -dr) };
  });
  return {
    month, currency: 'USD',
    openingPayable: String(openPayable), earnings: String(earned), reductions: String(reductions), payouts: String(paid), closingPayable: String(payable),
    openingOwedBack: String(openClawback), newOwedBack: String(newClawbacks), closingOwedBack: String(clawback),
    lines: items, disclosure: EARNINGS_DISCLOSURE,
  };
}

export function statementPdfLines(title: string, who: string, s: Awaited<ReturnType<typeof statement>>) {
  const L = (text: string, o: { bold?: boolean; size?: number } = {}) => ({ text, ...o });
  return [
    L('Rideshare Media Network', { bold: true, size: 14 }), L(title, { bold: true, size: 12 }), L(who), L(`Statement month: ${s.month}   Currency: ${s.currency}`), L(''),
    L(`Opening balance owed to you:   ${usd(B(s.openingPayable))}`), L(`Earnings allocated:            ${usd(B(s.earnings))}`),
    L(`Refund/chargeback reductions: -${usd(B(s.reductions))}`), L(`Paid out:                     -${usd(B(s.payouts))}`),
    L(`Closing balance owed to you:   ${usd(B(s.closingPayable))}`, { bold: true }), L(`Owed back after payouts (offset against future earnings): ${usd(B(s.closingOwedBack))}`), L(''),
    L('Date        Entry   Type                          Amount', { bold: true }),
    ...s.lines.map((l) => L(`${l.date}  ${l.entry.padEnd(6)}  ${l.kind.padEnd(28)}  ${usd(B(l.amount)).padStart(10)}   ${(l.memo ?? '').slice(0, 40)}`)),
    L(''), L(s.disclosure.slice(0, 110)), L(s.disclosure.slice(110)),
  ];
}
