import { allocateByWeights } from '@rmn/finance-core';
import type { Queryable, Tx } from '../../db/pool.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { earnedSpend } from './policy.js';
import { calculateAllocation, calculationToJson, postAllocation, type AllocationRequest } from '../revenue/service.js';

export interface WindowInput {
  campaignId: string;
  periodStart: string;
  periodEnd: string;
  entryDate: string;
  idempotencyKey: string;
  deductions: Array<{ type: string; amount: bigint; description: string; contractRef: string }>;
}

const B = (v: unknown) => BigInt((v as string | number | null) ?? 0);

/**
 * Derive allocation inputs for one campaign window purely from VALID validated events.
 * Creator-content (ad shown alongside approved creator content) and standalone spend become separate
 * batches, because they fall under different split rules.
 *
 * Grain (D-014 default): creators = those whose content carried this campaign's valid ads in the window;
 * their watch-seconds / qualified views are their validated content metrics over the same window.
 * Drivers = those whose tablets delivered the subset's valid ads or clicks; active seconds over the window.
 */
export async function aggregateWindow(q: Queryable, w: Pick<WindowInput, 'campaignId' | 'periodStart' | 'periodEnd'>) {
  const c = await q.query('SELECT * FROM campaigns WHERE id = $1', [w.campaignId]);
  const camp = c.rows[0];
  if (!camp) throw notFound('campaign not found');
  const range = [w.campaignId, w.periodStart, w.periodEnd];
  const base = `campaign_id = $1 AND occurred_at >= $2 AND occurred_at < $3 AND status = 'VALID'`;

  const subsets = await q.query(
    `SELECT (creator_id IS NOT NULL) AS cc, count(*) FILTER (WHERE type = 'AD_PLAYBACK' AND impression) AS impressions,
            count(*) FILTER (WHERE type = 'AD_PLAYBACK' AND qualified) AS qviews
       FROM validated_events WHERE ${base} GROUP BY 1`, range);
  const counts = { cc: { impressions: 0n, qualifiedViews: 0n }, sa: { impressions: 0n, qualifiedViews: 0n } };
  for (const r of subsets.rows) counts[r.cc ? 'cc' : 'sa'] = { impressions: B(r.impressions), qualifiedViews: B(r.qviews) };
  const rate = B(camp.rate_minor);
  const earned = { cc: earnedSpend(camp.pricing_model, rate, counts.cc), sa: earnedSpend(camp.pricing_model, rate, counts.sa) };

  const perCreator = await q.query(
    `SELECT creator_id, count(*) FILTER (WHERE type = 'AD_PLAYBACK' AND impression) AS impressions, count(*) FILTER (WHERE type = 'AD_PLAYBACK' AND qualified) AS qviews
       FROM validated_events WHERE ${base} AND creator_id IS NOT NULL GROUP BY creator_id`, range);
  const creatorIds = perCreator.rows.map((r) => r.creator_id);
  const content = await q.query(
    `SELECT creator_id, coalesce(sum(watch_seconds), 0) AS watch, count(*) FILTER (WHERE qualified) AS qviews
       FROM validated_events WHERE type = 'CONTENT_PLAYBACK' AND status = 'VALID' AND creator_id = ANY($1::uuid[]) AND occurred_at >= $2 AND occurred_at < $3
      GROUP BY creator_id`, [creatorIds, w.periodStart, w.periodEnd]);
  const contentBy = new Map(content.rows.map((r) => [r.creator_id, r]));
  const creators = perCreator.rows.map((r) => ({
    creatorId: r.creator_id as string,
    attributedRevenue: earnedSpend(camp.pricing_model, rate, { impressions: B(r.impressions), qualifiedViews: B(r.qviews) }),
    verifiedWatchSeconds: B(contentBy.get(r.creator_id)?.watch),
    qualifiedViews: B(contentBy.get(r.creator_id)?.qviews),
  }));

  const driversFor = async (cc: boolean) => {
    const d = await q.query(
      `SELECT driver_id, count(*) FILTER (WHERE type = 'AD_PLAYBACK' AND qualified) AS delivery, count(*) FILTER (WHERE type = 'CLICK') AS engagement
         FROM validated_events WHERE ${base} AND driver_id IS NOT NULL AND (creator_id IS NOT NULL) = $4 GROUP BY driver_id`, [...range, cc]);
    const ids = d.rows.map((r) => r.driver_id);
    const act = await q.query(
      `SELECT driver_id, coalesce(sum(eligible_active_seconds), 0) AS s FROM validated_events
        WHERE type = 'ACTIVE_SEGMENT' AND status = 'VALID' AND driver_id = ANY($1::uuid[]) AND occurred_at >= $2 AND occurred_at < $3 GROUP BY driver_id`,
      [ids, w.periodStart, w.periodEnd]);
    const actBy = new Map(act.rows.map((r) => [r.driver_id, B(r.s)]));
    return d.rows.map((r) => ({ driverId: r.driver_id as string, monetizedAdDelivery: B(r.delivery), qualifiedEngagement: B(r.engagement), eligibleActiveSeconds: actBy.get(r.driver_id) ?? 0n }));
  };

  return { campaign: camp, counts, earned, creators, drivers: { cc: await driversFor(true), sa: await driversFor(false) } };
}

type Agg = Awaited<ReturnType<typeof aggregateWindow>>;

/** Spread each permitted deduction across the two subsets in proportion to earned spend (exact, largest remainder). */
function splitDeductions(agg: Agg, deductions: WindowInput['deductions']) {
  const out = { cc: [] as WindowInput['deductions'], sa: [] as WindowInput['deductions'] };
  for (const d of deductions) {
    const shares = allocateByWeights(d.amount, [{ key: 'cc', weight: agg.earned.cc }, { key: 'sa', weight: agg.earned.sa }].filter((x) => x.weight > 0n));
    for (const s of shares) if (s.amount > 0n) out[s.key as 'cc' | 'sa'].push({ ...d, amount: s.amount });
  }
  return out;
}

function requests(agg: Agg, w: WindowInput): AllocationRequest[] {
  const ded = splitDeductions(agg, w.deductions);
  const camp = agg.campaign;
  const mk = (key: 'cc' | 'sa'): AllocationRequest => ({
    idempotencyKey: `${w.idempotencyKey}:${key.toUpperCase()}`,
    kind: 'AD',
    sourceRef: `campaign:${w.campaignId}:${w.periodStart}/${w.periodEnd}:${key === 'cc' ? 'CREATOR_CONTENT' : 'STANDALONE'}`,
    advertiserOrgId: camp.advertiser_org_id, fundingAccount: '2000', currency: camp.currency.trim(),
    periodStart: w.periodStart, periodEnd: w.periodEnd, entryDate: w.entryDate,
    grossReceipts: agg.earned[key], taxCollected: 0n, refunds: 0n, credits: 0n, chargebacks: 0n,
    deductions: ded[key], creators: key === 'cc' ? agg.creators : [], drivers: agg.drivers[key],
  });
  return (['cc', 'sa'] as const).filter((k) => agg.earned[k] > 0n).map(mk);
}

const aggJson = (agg: Agg) => ({
  campaignId: agg.campaign.id, pricingModel: agg.campaign.pricing_model, rateMinor: String(agg.campaign.rate_minor),
  earned: { creatorContent: agg.earned.cc.toString(), standalone: agg.earned.sa.toString() },
  counts: { creatorContent: { impressions: agg.counts.cc.impressions.toString(), qualifiedViews: agg.counts.cc.qualifiedViews.toString() },
            standalone: { impressions: agg.counts.sa.impressions.toString(), qualifiedViews: agg.counts.sa.qualifiedViews.toString() } },
});

/** Blocks allocation while any event that could belong to the window is unvalidated or awaiting review. */
async function assertWindowSettled(q: Queryable, w: WindowInput, settleMinutes: number) {
  const now = await q.query(`SELECT now() - make_interval(mins => $1) AS cutoff`, [settleMinutes]);
  if (new Date(w.periodEnd) > now.rows[0].cutoff) throw unprocessable(`window must end at least ${settleMinutes} minutes ago so in-flight events can arrive`);
  const pending = await q.query(
    `SELECT count(*)::int n FROM raw_events r LEFT JOIN validated_events v ON v.raw_event_id = r.id
      WHERE v.id IS NULL AND r.payload->>'campaignId' = $1`, [w.campaignId]);
  if (pending.rows[0].n > 0) throw conflict(`${pending.rows[0].n} event(s) for this campaign are not yet validated; run the validator first`);
  const held = await q.query(
    `SELECT count(*)::int n FROM validated_events WHERE campaign_id = $1 AND status = 'HELD_REVIEW' AND occurred_at >= $2 AND occurred_at < $3`,
    [w.campaignId, w.periodStart, w.periodEnd]);
  if (held.rows[0].n > 0) throw conflict(`${held.rows[0].n} held event(s) in this window must be reviewed before allocation`);
}

export async function previewWindow(q: Queryable, w: WindowInput) {
  const agg = await aggregateWindow(q, w);
  const batches = [];
  for (const r of requests(agg, w)) batches.push({ sourceRef: r.sourceRef, calculation: calculationToJson(await calculateAllocation(q, r)) });
  return { ...aggJson(agg), batches };
}

export async function postWindow(tx: Tx, w: WindowInput, userId: string, settleMinutes: number) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['window:' + w.campaignId]);
  const prior = await tx.query('SELECT id, result FROM allocation_windows WHERE idempotency_key = $1', [w.idempotencyKey]);
  if (prior.rows[0]) return { windowId: prior.rows[0].id, ...prior.rows[0].result, idempotent: true };
  await assertWindowSettled(tx, w, settleMinutes);
  const agg = await aggregateWindow(tx, w);
  const batches = [];
  for (const r of requests(agg, w)) {
    const b = await postAllocation(tx, r, userId);
    batches.push({ sourceRef: r.sourceRef, batchId: b.batchId, status: b.status, journalEntryId: b.journalEntryId, calculation: b.calculation });
  }
  const result = { ...aggJson(agg), batches };
  const ins = await tx.query(
    `INSERT INTO allocation_windows (idempotency_key, campaign_id, period_start, period_end, result, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [w.idempotencyKey, w.campaignId, w.periodStart, w.periodEnd, JSON.stringify(result), userId]);
  return { windowId: ins.rows[0].id, ...result, idempotent: false };
}

/** Advertiser-facing style metrics for a campaign window (VALID events only, plus integrity counts). */
export async function campaignMetrics(q: Queryable, campaignId: string, from: string, to: string) {
  const r = await q.query(
    `SELECT count(*) FILTER (WHERE status = 'VALID' AND type = 'AD_PLAYBACK' AND impression) AS impressions,
            count(*) FILTER (WHERE status = 'VALID' AND type = 'AD_PLAYBACK') AS starts,
            count(*) FILTER (WHERE status = 'VALID' AND type = 'AD_PLAYBACK' AND qualified) AS qualified_views,
            count(*) FILTER (WHERE status = 'VALID' AND type = 'AD_PLAYBACK' AND completed) AS completions,
            count(*) FILTER (WHERE status = 'VALID' AND type = 'AD_PLAYBACK' AND skipped) AS skips,
            coalesce(sum(visible_ms) FILTER (WHERE status = 'VALID' AND type = 'AD_PLAYBACK'), 0) AS visible_ms,
            count(*) FILTER (WHERE status = 'VALID' AND type = 'CLICK') AS clicks,
            count(*) FILTER (WHERE status = 'INVALID') AS invalid_events,
            count(*) FILTER (WHERE status = 'HELD_REVIEW') AS held_events
       FROM validated_events WHERE campaign_id = $1 AND occurred_at >= $2 AND occurred_at < $3`,
    [campaignId, from, to]);
  const m = r.rows[0];
  const imp = Number(m.impressions);
  return {
    impressions: String(m.impressions), starts: String(m.starts), qualifiedViews: String(m.qualified_views), completions: String(m.completions),
    skips: String(m.skips), visibleSeconds: String(BigInt(m.visible_ms) / 1000n),
    averageVisibleSeconds: imp ? (Number(m.visible_ms) / 1000 / Number(m.starts)).toFixed(2) : '0.00',
    clicks: String(m.clicks), ctr: imp ? (Number(m.clicks) / imp).toFixed(4) : '0.0000',
    invalidEvents: String(m.invalid_events), heldEvents: String(m.held_events),
  };
}
