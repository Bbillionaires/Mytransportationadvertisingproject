import type { Queryable, Tx } from '../../db/pool.js';
import { sha256hex } from '../../lib/crypto.js';
import { conflict, unprocessable } from '../../lib/errors.js';

export type PartyType = 'ADVERTISER' | 'CREATOR' | 'DRIVER' | 'RECIPIENT' | 'PLATFORM';

export interface LineInput {
  accountCode: string;
  currency: string;
  debit?: bigint;
  credit?: bigint;
  partyType?: PartyType | null;
  partyId?: string | null;
  processor?: string | null;
  memo?: string | null;
}

export interface EntryInput {
  idempotencyKey: string;
  entryDate: string; // YYYY-MM-DD
  description: string;
  sourceType: 'MANUAL' | 'ALLOCATION' | 'PAYMENT' | 'SUBSCRIPTION' | 'PAYOUT' | 'REFUND' | 'CHARGEBACK' | 'REVERSAL' | 'ADJUSTMENT' | 'PERIOD_CLOSE';
  sourceId?: string | null;
  reversesEntryId?: string | null;
  postedBy?: string | null;
  approvedBy?: string | null;
  metadata?: Record<string, unknown>;
  lines: LineInput[];
}

export interface PostedEntry {
  id: string;
  entryNumber: string;
  idempotent: boolean; // true when an identical earlier posting was returned
}

function canonicalPayload(e: EntryInput): string {
  return JSON.stringify({
    d: e.entryDate, s: e.sourceType, sid: e.sourceId ?? null, r: e.reversesEntryId ?? null,
    l: e.lines.map((l) => [l.accountCode, l.currency, (l.debit ?? 0n).toString(), (l.credit ?? 0n).toString(), l.partyType ?? null, l.partyId ?? null]),
  });
}

/** Application-level validation; the database independently enforces balance, immutability and periods. */
export function validateEntry(e: EntryInput): void {
  if (e.lines.length < 2) throw unprocessable('a journal entry needs at least two lines');
  const byCcy = new Map<string, bigint>();
  for (const l of e.lines) {
    const d = l.debit ?? 0n, c = l.credit ?? 0n;
    if (d < 0n || c < 0n) throw unprocessable('debits and credits must be non-negative');
    if ((d === 0n) === (c === 0n)) throw unprocessable('each line must have exactly one of debit or credit');
    byCcy.set(l.currency, (byCcy.get(l.currency) ?? 0n) + d - c);
  }
  for (const [ccy, diff] of byCcy) if (diff !== 0n) throw unprocessable(`entry is unbalanced in ${ccy} by ${diff}`);
}

/**
 * Post a balanced journal entry. Idempotent on idempotencyKey: replaying the same key with the
 * same content returns the original entry; the same key with different content is a conflict.
 * Must run inside a transaction (balance is verified at COMMIT by the database).
 */
export async function postEntry(tx: Tx, e: EntryInput): Promise<PostedEntry> {
  validateEntry(e);
  const payloadHash = sha256hex(canonicalPayload(e));
  // Serialize concurrent posts of the same key.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [e.idempotencyKey]);
  const existing = await tx.query('SELECT id, entry_number, metadata->>$2 AS h FROM journal_entries WHERE idempotency_key = $1', [e.idempotencyKey, 'payload_hash']);
  if (existing.rows[0]) {
    if (existing.rows[0].h !== payloadHash) throw conflict('idempotency key reused with a different journal entry');
    return { id: existing.rows[0].id, entryNumber: existing.rows[0].entry_number, idempotent: true };
  }
  const ins = await tx.query(
    `INSERT INTO journal_entries (idempotency_key, entry_date, description, source_type, source_id, reverses_entry_id, posted_by, approved_by, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, entry_number`,
    [e.idempotencyKey, e.entryDate, e.description, e.sourceType, e.sourceId ?? null, e.reversesEntryId ?? null, e.postedBy ?? null, e.approvedBy ?? null,
     JSON.stringify({ ...(e.metadata ?? {}), payload_hash: payloadHash })],
  );
  const entry = ins.rows[0];
  let n = 0;
  for (const l of e.lines) {
    n += 1;
    await tx.query(
      `INSERT INTO journal_lines (entry_id, line_no, account_code, currency, debit, credit, party_type, party_id, processor, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entry.id, n, l.accountCode, l.currency, (l.debit ?? 0n).toString(), (l.credit ?? 0n).toString(), l.partyType ?? null, l.partyId ?? null, l.processor ?? null, l.memo ?? null],
    );
  }
  return { id: entry.id, entryNumber: entry.entry_number, idempotent: false };
}

/** Build and post the exact mirror of an existing entry. One reversal per entry (DB-enforced). */
export async function reverseEntry(tx: Tx, entryId: string, opts: { idempotencyKey: string; entryDate: string; reason: string; postedBy: string | null; approvedBy?: string | null }): Promise<PostedEntry> {
  const orig = await tx.query('SELECT id, source_type FROM journal_entries WHERE id = $1', [entryId]);
  if (!orig.rows[0]) throw unprocessable('entry to reverse does not exist');
  if (orig.rows[0].source_type === 'REVERSAL') throw unprocessable('reversals cannot themselves be reversed; post a new correcting entry');
  const lines = await tx.query('SELECT * FROM journal_lines WHERE entry_id = $1 ORDER BY line_no', [entryId]);
  return postEntry(tx, {
    idempotencyKey: opts.idempotencyKey,
    entryDate: opts.entryDate,
    description: `Reversal of entry ${entryId}: ${opts.reason}`,
    sourceType: 'REVERSAL',
    sourceId: entryId,
    reversesEntryId: entryId,
    postedBy: opts.postedBy,
    approvedBy: opts.approvedBy ?? null,
    lines: lines.rows.map((l) => ({
      accountCode: l.account_code, currency: l.currency.trim(),
      debit: BigInt(l.credit), credit: BigInt(l.debit),
      partyType: l.party_type, partyId: l.party_id, processor: l.processor, memo: `reversal: ${l.memo ?? ''}`.trim(),
    })),
  });
}

export interface TrialBalanceRow { accountCode: string; name: string; type: string; currency: string; debit: string; credit: string; balance: string }

export async function trialBalance(q: Queryable, asOf?: string): Promise<{ rows: TrialBalanceRow[]; totals: Record<string, { debit: string; credit: string }> }> {
  const r = await q.query(
    `SELECT l.account_code, a.name, a.type, a.normal_balance, l.currency, sum(l.debit) d, sum(l.credit) c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.code = l.account_code
      WHERE ($1::date IS NULL OR e.entry_date <= $1::date)
      GROUP BY 1,2,3,4,5 ORDER BY 1,5`,
    [asOf ?? null],
  );
  const totals: Record<string, { debit: bigint; credit: bigint }> = {};
  const rows = r.rows.map((x) => {
    const d = BigInt(x.d), c = BigInt(x.c);
    const t = (totals[x.currency] ??= { debit: 0n, credit: 0n });
    t.debit += d; t.credit += c;
    return { accountCode: x.account_code, name: x.name, type: x.type, currency: x.currency, debit: d.toString(), credit: c.toString(), balance: (x.normal_balance === 'DEBIT' ? d - c : c - d).toString() };
  });
  return { rows, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, { debit: v.debit.toString(), credit: v.credit.toString() }])) };
}
