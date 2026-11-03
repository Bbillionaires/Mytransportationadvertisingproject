import type { Db, Tx } from '../../db/pool.js';
import { withTx } from '../../db/pool.js';
import { isScheduleActive } from '../campaigns/schedule.js';
import { advertiserAvailableMilli, campaignSpend, nextPlayBlock } from '../campaigns/budget.js';
import {
  classifyActiveSegment, classifyAd, classifyContent, decideStatus, exposureIsPossible, POLICY_V1, POLICY_VERSION, timingReasons, type Reason,
} from './policy.js';

interface RawRow { id: string; device_id: string; type: string; occurred_at: Date; received_at: Date; clock_offset_ms: number; payload: any }

const shift = (iso: string, offsetMs: number) => new Date(new Date(iso).getTime() + offsetMs);

async function deviceContext(tx: Tx, deviceId: string, at: Date) {
  const s = await tx.query(`SELECT status FROM device_status_history WHERE device_id = $1 AND changed_at <= $2 ORDER BY changed_at DESC, id DESC LIMIT 1`, [deviceId, at]);
  const a = await tx.query(
    `SELECT da.org_id, da.vehicle_id, da.driver_id, f.market FROM device_assignments da JOIN vehicles v ON v.id = da.vehicle_id JOIN fleets f ON f.id = v.fleet_id
      WHERE da.device_id = $1 AND tstzrange(da.starts_at, da.ends_at) @> $2::timestamptz`,
    [deviceId, at],
  );
  const reasons: Reason[] = [];
  if (s.rows[0]?.status !== 'ACTIVE') reasons.push('DEVICE_NOT_ACTIVE');
  if (!a.rows[0]) reasons.push('NOT_ASSIGNED_TO_VEHICLE');
  return { reasons, market: (a.rows[0]?.market ?? null) as string | null, fleetOrgId: a.rows[0]?.org_id ?? null, vehicleId: a.rows[0]?.vehicle_id ?? null, driverId: a.rows[0]?.driver_id ?? null };
}

async function campaignChecks(tx: Tx, campaignId: string, creativeId: string, at: Date, market: string | null) {
  const c = await tx.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
  const cr = await tx.query('SELECT id, campaign_id, kind, status, duration_ms FROM creatives WHERE id = $1', [creativeId]);
  const reasons: Reason[] = [];
  const camp = c.rows[0], creative = cr.rows[0];
  if (!camp) reasons.push('UNKNOWN_CAMPAIGN');
  else {
    if (camp.status !== 'APPROVED') reasons.push('CAMPAIGN_NOT_APPROVED');
    if (at < camp.starts_at || at >= camp.ends_at) reasons.push('OUTSIDE_CAMPAIGN_WINDOW');
    else if (!isScheduleActive({ timezone: camp.timezone, daysOfWeek: camp.days_of_week, startMinute: camp.start_minute, endMinute: camp.end_minute }, at)) reasons.push('OUTSIDE_SCHEDULE');
    if (camp.markets.length > 0 && (market === null || !camp.markets.includes(market))) reasons.push('MARKET_NOT_TARGETED');
  }
  if (!creative || creative.campaign_id !== campaignId) reasons.push('CREATIVE_MISMATCH');
  else if (creative.status !== 'APPROVED') reasons.push('CREATIVE_NOT_APPROVED');
  const late = await tx.query(`SELECT 1 FROM allocation_windows WHERE campaign_id = $1 AND tstzrange(period_start, period_end) @> $2::timestamptz`, [campaignId, at]);
  if (late.rows[0]) reasons.push('LATE_AFTER_ALLOCATION');
  return { reasons, creative: creative && creative.campaign_id === campaignId ? creative : null, known: !!camp, campaign: camp, frequencyCap: (camp?.frequency_cap_per_hour ?? null) as number | null };
}

/** Approved adjacent content attributes the ad to that content's creator; anything else is unattributed. */
async function approvedVideo(tx: Tx, videoId: string | undefined) {
  if (!videoId) return null;
  const v = await tx.query('SELECT id, creator_id, status, duration_ms FROM videos WHERE id = $1', [videoId]);
  return v.rows[0] ?? null;
}

async function overlapsPlayback(tx: Tx, deviceId: string, start: Date, end: Date): Promise<boolean> {
  const tol = `${POLICY_V1.overlapToleranceMs} milliseconds`;
  const r = await tx.query(
    `SELECT 1 FROM validated_events v LEFT JOIN creatives c ON c.id = v.creative_id
      WHERE v.device_id = $1 AND v.status IN ('VALID','HELD_REVIEW')
        AND (v.type = 'CONTENT_PLAYBACK' OR (v.type = 'AD_PLAYBACK' AND c.kind = 'VIDEO'))
        AND v.occurred_at < $3::timestamptz - $4::interval AND v.ended_at > $2::timestamptz + $4::interval LIMIT 1`,
    [deviceId, start, end, tol],
  );
  return !!r.rows[0];
}

async function validateOne(tx: Tx, e: RawRow) {
  const p = e.payload;
  const off = e.clock_offset_ms;
  const reasons: Reason[] = [...timingReasons(e.occurred_at, e.received_at)];
  const row: Record<string, unknown> = {
    raw_event_id: e.id, device_id: e.device_id, type: e.type, occurred_at: e.occurred_at, ended_at: e.occurred_at,
    campaign_id: null, creative_id: null, video_id: null, creator_id: null, visible_ms: 0, unmuted_visible_ms: 0, impression: false, qualified: false,
    completed: false, skipped: false, click: false, watch_seconds: 0, eligible_active_seconds: 0,
  };
  const ctx = await deviceContext(tx, e.device_id, e.occurred_at);
  reasons.push(...ctx.reasons);
  Object.assign(row, { fleet_org_id: ctx.fleetOrgId, vehicle_id: ctx.vehicleId, driver_id: ctx.driverId });

  if (e.type === 'AD_PLAYBACK' || e.type === 'CONTENT_PLAYBACK') {
    const x = { startedAt: shift(p.startedAt, off), endedAt: shift(p.endedAt, off), visibleMs: p.visibleMs, mutedMs: p.mutedMs };
    if (x.endedAt.getTime() > e.received_at.getTime() + POLICY_V1.futureToleranceMs) reasons.push('FUTURE_TIMESTAMP');
    row.ended_at = x.endedAt < x.startedAt ? x.startedAt : x.endedAt;
    Object.assign(row, { visible_ms: p.visibleMs, completed: !!p.completed });
    let isVideoMedia = true;
    if (e.type === 'AD_PLAYBACK') {
      const cc = await campaignChecks(tx, p.campaignId, p.creativeId, x.startedAt, ctx.market);
      reasons.push(...cc.reasons);
      Object.assign(row, { campaign_id: cc.known ? p.campaignId : null, creative_id: cc.creative ? p.creativeId : null, skipped: !!p.skipped });
      const v = await approvedVideo(tx, p.contentVideoId);
      if (v && v.status === 'APPROVED') Object.assign(row, { video_id: v.id, creator_id: v.creator_id });
      if (cc.creative) {
        isVideoMedia = cc.creative.kind === 'VIDEO';
        if (!exposureIsPossible(x, cc.creative.duration_ms)) reasons.push('IMPOSSIBLE_DURATION');
        const k = classifyAd(cc.creative.kind, cc.creative.duration_ms, x);
        Object.assign(row, { impression: k.impression, qualified: k.qualified, unmuted_visible_ms: Math.max(0, k.unmutedVisibleMs) });
        if (k.qualified) {
          const n = await tx.query(
            `SELECT count(*)::int n FROM validated_events WHERE device_id = $1 AND type = 'AD_PLAYBACK' AND qualified AND status IN ('VALID','HELD_REVIEW')
               AND occurred_at > $2::timestamptz - interval '1 hour' AND occurred_at <= $2::timestamptz`,
            [e.device_id, x.startedAt],
          );
          if (n.rows[0].n >= POLICY_V1.maxQualifiedAdViewsPerHour) reasons.push('RATE_ANOMALY');
          if (cc.frequencyCap !== null) {
            // The advertiser's own frequency cap: views beyond it on one tablet in a rolling hour are never billed.
            const f = await tx.query(
              `SELECT count(*)::int n FROM validated_events WHERE device_id = $1 AND campaign_id = $2 AND type = 'AD_PLAYBACK' AND qualified AND status IN ('VALID','HELD_REVIEW')
                 AND occurred_at > $3::timestamptz - interval '1 hour' AND occurred_at <= $3::timestamptz`,
              [e.device_id, p.campaignId, x.startedAt]);
            if (f.rows[0].n >= cc.frequencyCap) reasons.push('FREQUENCY_CAP_EXCEEDED');
          }
        }
      }
    } else {
      const v = await approvedVideo(tx, p.videoId);
      if (!v) reasons.push('UNKNOWN_VIDEO');
      else {
        if (v.status !== 'APPROVED') reasons.push('VIDEO_NOT_APPROVED');
        Object.assign(row, { video_id: v.id, creator_id: v.creator_id });
        if (!exposureIsPossible(x, v.duration_ms)) reasons.push('IMPOSSIBLE_DURATION');
        const k = classifyContent(v.duration_ms, x);
        Object.assign(row, { qualified: k.qualified, watch_seconds: k.watchSeconds, unmuted_visible_ms: Math.max(0, k.unmutedVisibleMs) });
      }
    }
    if (isVideoMedia && (await overlapsPlayback(tx, e.device_id, x.startedAt, x.endedAt))) reasons.push('OVERLAPPING_PLAYBACK');
    // Budget and funds: a billable play the advertiser has not funded or budgeted is never billed.
    if (e.type === 'AD_PLAYBACK' && reasons.length === 0) {
      const camp = (await tx.query('SELECT * FROM campaigns WHERE id = $1', [p.campaignId])).rows[0];
      const billable = camp.pricing_model === 'CPQV' ? row.qualified : row.impression;
      if (billable) {
        const spend = (await campaignSpend(tx, [camp.id], x.startedAt)).get(camp.id)!;
        const available = await advertiserAvailableMilli(tx, camp.advertiser_org_id, camp.currency.trim(), x.startedAt);
        const block = nextPlayBlock(camp, spend, available);
        if (block) reasons.push(block);
      }
    }
  } else if (e.type === 'CLICK') {
    const cc = await campaignChecks(tx, p.campaignId, p.creativeId, e.occurred_at, ctx.market);
    reasons.push(...cc.reasons);
    Object.assign(row, { campaign_id: cc.known ? p.campaignId : null, creative_id: cc.creative ? p.creativeId : null, click: true });
    const v = await approvedVideo(tx, p.contentVideoId);
    if (v && v.status === 'APPROVED') Object.assign(row, { video_id: v.id, creator_id: v.creator_id });
    const dup = await tx.query(
      `SELECT 1 FROM validated_events WHERE device_id = $1 AND type = 'CLICK' AND campaign_id = $2 AND status IN ('VALID','HELD_REVIEW')
         AND occurred_at > $3::timestamptz - make_interval(secs => $4) AND occurred_at <= $3::timestamptz LIMIT 1`,
      [e.device_id, p.campaignId, e.occurred_at, POLICY_V1.duplicateClickWindowMs / 1000],
    );
    if (dup.rows[0]) reasons.push('DUPLICATE_CLICK');
  } else if (e.type === 'ACTIVE_SEGMENT') {
    const s = { startedAt: shift(p.startedAt, off), endedAt: shift(p.endedAt, off), screenOn: p.screenOn, interactions: p.interactions };
    row.ended_at = s.endedAt < s.startedAt ? s.startedAt : s.endedAt;
    const ov = await tx.query(
      `SELECT 1 FROM validated_events WHERE device_id = $1 AND type IN ('CONTENT_PLAYBACK','AD_PLAYBACK') AND status IN ('VALID','HELD_REVIEW')
         AND occurred_at < $3 AND ended_at > $2 LIMIT 1`,
      [e.device_id, s.startedAt, s.endedAt],
    );
    const k = classifyActiveSegment(s, !!ov.rows[0]);
    reasons.push(...k.reasons);
    row.eligible_active_seconds = k.eligibleSeconds;
    if (k.eligibleSeconds > 0) {
      const day = await tx.query(
        `SELECT coalesce(sum(eligible_active_seconds), 0)::int s FROM validated_events WHERE device_id = $1 AND type = 'ACTIVE_SEGMENT' AND status IN ('VALID','HELD_REVIEW')
           AND occurred_at >= date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND occurred_at < (date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'`,
        [e.device_id, s.startedAt],
      );
      if (day.rows[0].s + k.eligibleSeconds > POLICY_V1.maxActiveSecondsPerDay) reasons.push('ACTIVE_CAP_EXCEEDED');
    }
  }

  const uniq = [...new Set(reasons)];
  const status = decideStatus(uniq);
  const cols = Object.keys(row);
  const vals = Object.values(row);
  await tx.query(
    `INSERT INTO validated_events (${cols.join(', ')}, offline, status, reasons, policy_version)
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}, $${cols.length + 2}, $${cols.length + 3}, $${cols.length + 4})`,
    [...vals, uniq.includes('OFFLINE_DELAYED'), status, uniq, POLICY_VERSION],
  );
  return status;
}

/**
 * Validate pending raw events. Single runner (advisory lock); deterministic order: by device, then time,
 * with ACTIVE_SEGMENTs after playback so anti-idle checks can see the playback they overlap.
 */
export async function runValidation(db: Db, limit = 5000) {
  return withTx(db, async (tx) => {
    const got = await tx.query('SELECT pg_try_advisory_xact_lock(7342002) AS ok');
    if (!got.rows[0].ok) return { processed: 0, valid: 0, invalid: 0, held: 0, busy: true };
    const pending = await tx.query<RawRow>(
      `SELECT r.id, r.device_id, r.type, r.occurred_at, r.received_at, r.clock_offset_ms, r.payload
         FROM raw_events r LEFT JOIN validated_events v ON v.raw_event_id = r.id
        WHERE v.id IS NULL
        ORDER BY r.device_id, (r.type = 'ACTIVE_SEGMENT'), r.occurred_at, r.id LIMIT $1`,
      [limit],
    );
    const out = { processed: 0, valid: 0, invalid: 0, held: 0, busy: false };
    for (const e of pending.rows) {
      const s = await validateOne(tx, e);
      out.processed += 1;
      if (s === 'VALID') out.valid += 1; else if (s === 'INVALID') out.invalid += 1; else out.held += 1;
    }
    return out;
  });
}
