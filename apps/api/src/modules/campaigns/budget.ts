import type { Queryable } from '../../db/pool.js';

/**
 * Spend is tracked exactly in milli-minor units (1/1000 of a cent) so CPM impressions add up without rounding:
 *   CPM:  each impression costs rate_minor / 1000 minor  -> rate_minor milli-minor
 *   CPQV: each qualified view costs rate_minor minor     -> rate_minor x 1000 milli-minor
 * Committed spend = VALID + HELD_REVIEW billable plays (held plays count until rejected: conservative).
 */
export const unitMilli = (pricing: string, rate: bigint) => (pricing === 'CPM' ? rate : rate * 1000n);

/** A billable play: qualified view for CPQV, impression for CPM. Shared by budgets, billing and reports. */
export const COUNTABLE = `(CASE WHEN c.pricing_model = 'CPQV' THEN v.qualified ELSE v.impression END)`;

export interface CampaignSpend { spendMilli: bigint; todayMilli: bigint; unallocatedMilli: bigint }

/** Lifetime, today (campaign-local day) and not-yet-allocated committed spend for each campaign. */
/**
 * Committed spend from the trigger-maintained counters (migration 0017): O(days) per campaign instead of O(plays).
 * Equal to campaignSpendRecount() at all times; verified in tests and by the spend-counter consistency job.
 */
export async function campaignSpend(q: Queryable, campaignIds: string[], at: Date): Promise<Map<string, CampaignSpend>> {
  const r = await q.query(
    `SELECT c.id, c.pricing_model, c.rate_minor,
            coalesce((SELECT sum(d.billable) FROM campaign_spend_daily d WHERE d.campaign_id = c.id), 0) AS n_all,
            coalesce((SELECT sum(d.billable) FROM campaign_spend_daily d WHERE d.campaign_id = c.id AND d.day >= ($2::timestamptz AT TIME ZONE c.timezone)::date), 0) AS n_today,
            coalesce((SELECT a.billable FROM campaign_spend_allocated a WHERE a.campaign_id = c.id), 0) AS n_allocated
       FROM campaigns c WHERE c.id = ANY($1::uuid[])`, [campaignIds, at]);
  return new Map(r.rows.map((x) => {
    const u = unitMilli(x.pricing_model, BigInt(x.rate_minor));
    return [x.id, { spendMilli: BigInt(x.n_all) * u, todayMilli: BigInt(x.n_today) * u, unallocatedMilli: (BigInt(x.n_all) - BigInt(x.n_allocated)) * u }];
  }));
}

/** Exact recount from validated events — the reference the counters are verified against (tests, consistency job). */
export async function campaignSpendRecount(q: Queryable, campaignIds: string[], at: Date): Promise<Map<string, CampaignSpend>> {
  const r = await q.query(
    `SELECT c.id, c.pricing_model, c.rate_minor,
            count(v.id) FILTER (WHERE ${COUNTABLE}) AS n_all,
            count(v.id) FILTER (WHERE ${COUNTABLE} AND v.occurred_at >= (date_trunc('day', $2::timestamptz AT TIME ZONE c.timezone) AT TIME ZONE c.timezone)) AS n_today,
            count(v.id) FILTER (WHERE ${COUNTABLE} AND NOT EXISTS (
              SELECT 1 FROM allocation_windows w WHERE w.campaign_id = c.id AND tstzrange(w.period_start, w.period_end) @> v.occurred_at)) AS n_unallocated
       FROM campaigns c LEFT JOIN validated_events v ON v.campaign_id = c.id AND v.type = 'AD_PLAYBACK' AND v.status IN ('VALID','HELD_REVIEW')
      WHERE c.id = ANY($1::uuid[]) GROUP BY c.id`, [campaignIds, at]);
  return new Map(r.rows.map((x) => {
    const u = unitMilli(x.pricing_model, BigInt(x.rate_minor));
    return [x.id, { spendMilli: BigInt(x.n_all) * u, todayMilli: BigInt(x.n_today) * u, unallocatedMilli: BigInt(x.n_unallocated) * u }];
  }));
}

/** Prepaid ledger balance minus committed-but-unallocated spend across all of the advertiser's campaigns, in milli-minor. */
export async function advertiserAvailableMilli(q: Queryable, advertiserOrgId: string, currency: string, at: Date): Promise<bigint> {
  const bal = await q.query(
    `SELECT coalesce(sum(credit) - sum(debit), 0)::text AS b FROM journal_lines WHERE account_code = '2000' AND party_id = $1 AND currency = $2`, [advertiserOrgId, currency]);
  const camps = await q.query(`SELECT id FROM campaigns WHERE advertiser_org_id = $1 AND currency = $2`, [advertiserOrgId, currency]);
  const spend = await campaignSpend(q, camps.rows.map((c) => c.id), at);
  let committed = 0n;
  for (const s of spend.values()) committed += s.unallocatedMilli;
  return BigInt(bal.rows[0].b) * 1000n - committed;
}

export type DeliveryBlock = 'BUDGET_EXHAUSTED' | 'DAILY_BUDGET_EXHAUSTED' | 'ADVERTISER_FUNDS_EXHAUSTED';

/** Would one more billable play exceed a limit? Used identically by the playlist (stop serving) and the validator (stop billing). */
export function nextPlayBlock(c: { pricing_model: string; rate_minor: string | bigint; total_budget_minor: string | null; daily_budget_minor: string | null },
  s: CampaignSpend, availableMilli: bigint): DeliveryBlock | null {
  const u = unitMilli(c.pricing_model, BigInt(c.rate_minor));
  if (c.total_budget_minor !== null && s.spendMilli + u > BigInt(c.total_budget_minor) * 1000n) return 'BUDGET_EXHAUSTED';
  if (c.daily_budget_minor !== null && s.todayMilli + u > BigInt(c.daily_budget_minor) * 1000n) return 'DAILY_BUDGET_EXHAUSTED';
  if (availableMilli < u) return 'ADVERTISER_FUNDS_EXHAUSTED';
  return null;
}
