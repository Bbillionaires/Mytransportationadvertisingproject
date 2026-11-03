import type { Queryable } from '../../db/pool.js';

const B = (v: unknown) => BigInt((v as string | number | null) ?? 0);
const s = (v: bigint) => v.toString();

/** Account activity with per-account running balances (normal-balance sign). */
export async function generalLedger(q: Queryable, from: string, to: string, account?: string) {
  const open = await q.query(
    `SELECT l.account_code, l.currency, sum(l.debit) d, sum(l.credit) c FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.entry_date < $1 AND ($2::text IS NULL OR l.account_code = $2) GROUP BY 1, 2`, [from, account ?? null]);
  const rows = await q.query(
    `SELECT e.entry_date::text AS date, e.entry_number, e.source_type, e.description, l.account_code, a.name AS account_name, a.normal_balance, l.currency, l.debit, l.credit,
            l.party_type, l.party_id, l.memo
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.code = l.account_code
      WHERE e.entry_date >= $1 AND e.entry_date < $2 AND ($3::text IS NULL OR l.account_code = $3)
      ORDER BY l.account_code, l.currency, e.entry_date, e.entry_number, l.line_no`, [from, to, account ?? null]);
  const normal = new Map((await q.query('SELECT code, normal_balance FROM ledger_accounts')).rows.map((r) => [r.code, r.normal_balance]));
  const running = new Map<string, bigint>();
  for (const o of open.rows) running.set(`${o.account_code}:${o.currency}`, normal.get(o.account_code) === 'DEBIT' ? B(o.d) - B(o.c) : B(o.c) - B(o.d));
  return rows.rows.map((r) => {
    const k = `${r.account_code}:${r.currency}`;
    const delta = r.normal_balance === 'DEBIT' ? B(r.debit) - B(r.credit) : B(r.credit) - B(r.debit);
    const opening = running.get(k) ?? 0n;
    running.set(k, opening + delta);
    return { date: r.date, entry: String(r.entry_number), account: r.account_code, accountName: r.account_name, currency: r.currency, debit: String(r.debit), credit: String(r.credit),
      balance: s(opening + delta), source: r.source_type, description: r.description, partyType: r.party_type, partyId: r.party_id, memo: r.memo };
  });
}

async function balancesBy(q: Queryable, where: string, params: unknown[]) {
  return (await q.query(
    `SELECT a.code, a.name, a.type, a.normal_balance, a.is_client_liability, l.currency,
            CASE WHEN a.normal_balance = 'DEBIT' THEN sum(l.debit) - sum(l.credit) ELSE sum(l.credit) - sum(l.debit) END AS balance
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.code = l.account_code
      WHERE ${where} GROUP BY a.code, a.name, a.type, a.normal_balance, a.is_client_liability, l.currency ORDER BY a.code`, params)).rows;
}

/**
 * Income statement. Contra-expense accounts (normal credit within EXPENSE) reduce expenses. Presentation of
 * creator/driver shares (net, as here, vs gross) awaits D-011.
 */
export async function incomeStatement(q: Queryable, from: string, to: string) {
  const rows = await balancesBy(q, `e.entry_date >= $1 AND e.entry_date < $2 AND a.type IN ('REVENUE','EXPENSE')`, [from, to]);
  const byCcy: Record<string, { revenue: any[]; expenses: any[]; totalRevenue: bigint; totalExpenses: bigint }> = {};
  for (const r of rows) {
    const c = (byCcy[r.currency] ??= { revenue: [], expenses: [], totalRevenue: 0n, totalExpenses: 0n });
    if (r.type === 'REVENUE') { c.revenue.push({ account: r.code, name: r.name, amount: s(B(r.balance)) }); c.totalRevenue += B(r.balance); }
    else {
      const amt = r.normal_balance === 'DEBIT' ? B(r.balance) : -B(r.balance); // contra-expense reduces expenses
      c.expenses.push({ account: r.code, name: r.name, amount: s(amt) }); c.totalExpenses += amt;
    }
  }
  return {
    period: { from, to }, presentation: 'NET_OF_RECIPIENT_SHARES (D-011 pending)',
    currencies: Object.fromEntries(Object.entries(byCcy).map(([k, v]) => [k, { revenue: v.revenue, expenses: v.expenses, totalRevenue: s(v.totalRevenue), totalExpenses: s(v.totalExpenses), netIncome: s(v.totalRevenue - v.totalExpenses) }])),
  };
}

/** Balance sheet as of a date. Current-period earnings (all unclosed revenue - expenses) shown within equity. Checks A = L + E. */
export async function balanceSheet(q: Queryable, asOf: string) {
  const rows = await balancesBy(q, `e.entry_date <= $1`, [asOf]);
  const byCcy: Record<string, any> = {};
  for (const r of rows) {
    const c = (byCcy[r.currency] ??= { assets: [], liabilities: [], equity: [], A: 0n, L: 0n, E: 0n, clientLiabilities: 0n, earnings: 0n });
    const amt = B(r.balance);
    if (r.type === 'ASSET') { c.assets.push({ account: r.code, name: r.name, amount: s(amt) }); c.A += amt; }
    else if (r.type === 'LIABILITY') { c.liabilities.push({ account: r.code, name: r.name, amount: s(amt), clientFunds: r.is_client_liability }); c.L += amt; if (r.is_client_liability) c.clientLiabilities += amt; }
    else if (r.type === 'EQUITY') { c.equity.push({ account: r.code, name: r.name, amount: s(amt) }); c.E += amt; }
    else if (r.type === 'REVENUE') c.earnings += amt;
    else c.earnings -= r.normal_balance === 'DEBIT' ? amt : -amt;
  }
  return {
    asOf,
    currencies: Object.fromEntries(Object.entries(byCcy).map(([k, c]) => {
      const equity = [...c.equity, { account: 'CURRENT', name: 'Current earnings (unclosed)', amount: s(c.earnings) }];
      const totalEquity = c.E + c.earnings;
      return [k, { assets: c.assets, liabilities: c.liabilities, equity, totalAssets: s(c.A), totalLiabilities: s(c.L), clientFundLiabilities: s(c.clientLiabilities),
        totalEquity: s(totalEquity), balanced: c.A === c.L + totalEquity }];
    })),
  };
}

/** Direct-method cash flow over cash (1000) and processor clearing (1010), classified by entry source. */
export async function cashFlow(q: Queryable, from: string, to: string) {
  const rows = (await q.query(
    `SELECT l.currency, e.source_type, sum(l.debit) - sum(l.credit) AS net
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_code IN ('1000','1010') AND e.entry_date >= $1 AND e.entry_date < $2
        AND NOT (e.source_type = 'PAYMENT' AND EXISTS (SELECT 1 FROM journal_lines o WHERE o.entry_id = e.id AND o.account_code = '1000')
                 AND EXISTS (SELECT 1 FROM journal_lines o WHERE o.entry_id = e.id AND o.account_code = '1010'))
      GROUP BY 1, 2 ORDER BY 1, 2`, [from, to])).rows;
  const CLASS: Record<string, string> = { PAYMENT: 'OPERATING', SUBSCRIPTION: 'OPERATING', REFUND: 'OPERATING', CHARGEBACK: 'OPERATING', PAYOUT: 'OPERATING', MANUAL: 'FINANCING_OR_OTHER', ADJUSTMENT: 'FINANCING_OR_OTHER', REVERSAL: 'FINANCING_OR_OTHER' };
  const out: Record<string, any> = {};
  for (const r of rows) {
    const c = (out[r.currency] ??= { lines: [], netChange: 0n });
    c.lines.push({ source: r.source_type, class: CLASS[r.source_type] ?? 'OTHER', net: s(B(r.net)) });
    c.netChange += B(r.net);
  }
  const opening = (await q.query(`SELECT l.currency, sum(l.debit) - sum(l.credit) AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_code IN ('1000','1010') AND e.entry_date < $1 GROUP BY 1`, [from])).rows;
  return {
    period: { from, to }, note: 'Transfers between processor clearing and the bank are internal and excluded.',
    currencies: Object.fromEntries(Object.entries(out).map(([k, v]) => { const o = B(opening.find((x) => x.currency === k)?.b); return [k, { openingCash: s(o), lines: v.lines, netChange: s(v.netChange), closingCash: s(o + v.netChange) }]; })),
  };
}

/** What the platform owes others, by account and party, as of a date. */
export async function liabilities(q: Queryable, asOf: string) {
  return (await q.query(
    `SELECT a.code AS account, a.name, a.is_client_liability AS client_funds, l.currency, l.party_type, l.party_id, sum(l.credit) - sum(l.debit) AS balance
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.code = l.account_code
      WHERE a.type = 'LIABILITY' AND e.entry_date <= $1 GROUP BY 1, 2, 3, 4, 5, 6 HAVING sum(l.credit) - sum(l.debit) <> 0 ORDER BY 1, 5, 6`, [asOf])).rows
    .map((r) => ({ ...r, balance: String(r.balance) }));
}

/** Advertiser receivables (1100) with the date of the oldest unpaid posting (FIFO) for aging. */
export async function receivables(q: Queryable, asOf: string) {
  const rows = (await q.query(
    `SELECT l.party_id, o.name, l.currency, sum(l.debit) - sum(l.credit) AS balance, min(e.entry_date) FILTER (WHERE l.debit > 0)::text AS oldest
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN organizations o ON o.id = l.party_id
      WHERE l.account_code = '1100' AND e.entry_date <= $1 GROUP BY 1, 2, 3 HAVING sum(l.debit) - sum(l.credit) <> 0 ORDER BY 4 DESC`, [asOf])).rows;
  return rows.map((r) => {
    const days = Math.floor((new Date(asOf).getTime() - new Date(r.oldest).getTime()) / 86_400_000);
    return { advertiserOrgId: r.party_id, name: r.name, currency: r.currency, balance: String(r.balance), oldestOpenItem: r.oldest, ageBucket: days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+' };
  });
}

/** Annual allocated earnings per recipient (for information-return preparation; payouts-based reporting follows the payout phase). */
export async function recipientEarnings(q: Queryable, year: number) {
  return (await q.query(
    `SELECT l.party_type, l.party_id, coalesce(cp.display_name, u.display_name) AS name, l.currency,
            sum(l.credit) FILTER (WHERE e.source_type = 'ALLOCATION') AS allocated, sum(l.debit) FILTER (WHERE e.source_type <> 'PAYOUT') AS reductions,
            sum(l.credit) - sum(l.debit) AS net_change
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       LEFT JOIN creator_profiles cp ON l.party_type = 'CREATOR' AND cp.id = l.party_id
       LEFT JOIN drivers d ON l.party_type = 'DRIVER' AND d.id = l.party_id LEFT JOIN users u ON u.id = d.user_id
      WHERE l.account_code IN ('2200','2210') AND e.entry_date >= make_date($1, 1, 1) AND e.entry_date < make_date($1 + 1, 1, 1)
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 3`, [year])).rows
    .map((r) => ({ partyType: r.party_type, partyId: r.party_id, name: r.name, currency: r.currency, allocated: String(r.allocated ?? 0), reductions: String(r.reductions ?? 0), netEarnings: String(B(r.allocated) - B(r.reductions)) }));
}
