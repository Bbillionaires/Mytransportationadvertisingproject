/**
 * Event validation policy VALIDATION_POLICY_V1 (see docs/EVENTS.md). Pure functions: no I/O.
 * Every threshold here is a business definition that affects billing and payouts; change it only by
 * adding a new policy version, never by editing V1 in place.
 */
export const POLICY_VERSION = 'VALIDATION_POLICY_V1';

export const POLICY_V1 = {
  /** Events received more than this long after they occurred are "offline" and need human review. */
  offlineThresholdMs: 10 * 60_000,
  /** Older than this when received: rejected outright. */
  staleAfterMs: 7 * 24 * 3600_000,
  /** Corrected event time may not be later than receipt plus this tolerance. */
  futureToleranceMs: 60_000,
  /** Reported intervals may exceed wall-clock or media duration by at most this much. */
  durationToleranceMs: 2_000,
  /** Two playbacks on one tablet may overlap by at most this much (player transitions). */
  overlapToleranceMs: 1_000,
  /** Video ad impression: at least this much visible playback. */
  videoImpressionMs: 1_000,
  /** Video ad qualified view: unmuted visible >= min(cap, ratio x creative duration). */
  videoQualifiedCapMs: 15_000,
  videoQualifiedRatio: 0.5,
  /** Banner/display impression = qualified view: visible at least this long (no audio component). */
  displayQualifiedMs: 1_000,
  /** Content qualified view: unmuted visible >= min(cap, ratio x video duration). */
  contentQualifiedCapMs: 30_000,
  contentQualifiedRatio: 0.5,
  /** Anti-farming: more qualified ad views than this per tablet in any rolling hour are held. */
  maxQualifiedAdViewsPerHour: 40,
  /** A second click on the same campaign from the same tablet within this window is invalid. */
  duplicateClickWindowMs: 10 * 60_000,
  /** Active segments longer than this are rejected (tablets must report in short segments). */
  maxActiveSegmentMs: 15 * 60_000,
  /** Eligible active time per tablet per UTC day above this is held. */
  maxActiveSecondsPerDay: 16 * 3600,
} as const;

export type Reason =
  // hard-invalid
  | 'UNKNOWN_CAMPAIGN' | 'CAMPAIGN_NOT_APPROVED' | 'OUTSIDE_CAMPAIGN_WINDOW' | 'CREATIVE_MISMATCH' | 'CREATIVE_NOT_APPROVED'
  | 'UNKNOWN_VIDEO' | 'VIDEO_NOT_APPROVED' | 'DEVICE_NOT_ACTIVE' | 'NOT_ASSIGNED_TO_VEHICLE'
  | 'FUTURE_TIMESTAMP' | 'STALE_EVENT' | 'IMPOSSIBLE_DURATION' | 'OVERLAPPING_PLAYBACK' | 'DUPLICATE_CLICK'
  | 'IDLE_SEGMENT' | 'SEGMENT_TOO_LONG' | 'OUTSIDE_SCHEDULE' | 'MARKET_NOT_TARGETED' | 'FREQUENCY_CAP_EXCEEDED'
  // hold for human review
  | 'OFFLINE_DELAYED' | 'RATE_ANOMALY' | 'ACTIVE_CAP_EXCEEDED' | 'LATE_AFTER_ALLOCATION';

export const HOLD_REASONS: ReadonlySet<Reason> = new Set(['OFFLINE_DELAYED', 'RATE_ANOMALY', 'ACTIVE_CAP_EXCEEDED', 'LATE_AFTER_ALLOCATION']);

export type Status = 'VALID' | 'INVALID' | 'HELD_REVIEW';

/** Any hard-invalid reason wins; otherwise any hold reason holds; otherwise valid. */
export function decideStatus(reasons: readonly Reason[]): Status {
  if (reasons.some((r) => !HOLD_REASONS.has(r))) return 'INVALID';
  if (reasons.length > 0) return 'HELD_REVIEW';
  return 'VALID';
}

export interface Interval { startedAt: Date; endedAt: Date }
export interface Exposure extends Interval { visibleMs: number; mutedMs: number }

/** Reported exposure must fit inside its own wall-clock interval (and media duration where known). */
export function exposureIsPossible(e: Exposure, mediaDurationMs?: number | null): boolean {
  const wall = e.endedAt.getTime() - e.startedAt.getTime();
  if (wall < 0 || e.visibleMs < 0 || e.mutedMs < 0 || e.mutedMs > e.visibleMs) return false;
  if (e.visibleMs > wall + POLICY_V1.durationToleranceMs) return false;
  if (mediaDurationMs != null && e.visibleMs > mediaDurationMs + POLICY_V1.durationToleranceMs) return false;
  return true;
}

export function classifyAd(kind: 'VIDEO' | 'BANNER' | 'DISPLAY', durationMs: number | null, e: Exposure) {
  const unmuted = e.visibleMs - e.mutedMs;
  if (kind === 'VIDEO') {
    const threshold = Math.min(POLICY_V1.videoQualifiedCapMs, Math.ceil((durationMs ?? 0) * POLICY_V1.videoQualifiedRatio));
    return { impression: e.visibleMs >= POLICY_V1.videoImpressionMs, qualified: unmuted >= threshold, unmutedVisibleMs: unmuted };
  }
  const shown = e.visibleMs >= POLICY_V1.displayQualifiedMs;
  return { impression: shown, qualified: shown, unmutedVisibleMs: unmuted };
}

export function classifyContent(durationMs: number, e: Exposure) {
  const unmuted = e.visibleMs - e.mutedMs;
  const verified = Math.min(unmuted, durationMs);
  const threshold = Math.min(POLICY_V1.contentQualifiedCapMs, Math.ceil(durationMs * POLICY_V1.contentQualifiedRatio));
  return { qualified: unmuted >= threshold, watchSeconds: Math.floor(verified / 1000), unmutedVisibleMs: unmuted };
}

/**
 * Anti-idle: an active segment counts only if the screen was on, it is short, and there is evidence a
 * passenger was present (touch interactions, or server-validated playback overlapping the segment).
 */
export function classifyActiveSegment(s: Interval & { screenOn: boolean; interactions: number }, hasValidatedPlaybackOverlap: boolean) {
  const ms = s.endedAt.getTime() - s.startedAt.getTime();
  const reasons: Reason[] = [];
  if (ms < 0) reasons.push('IMPOSSIBLE_DURATION');
  else if (ms > POLICY_V1.maxActiveSegmentMs) reasons.push('SEGMENT_TOO_LONG');
  else if (!s.screenOn || (s.interactions <= 0 && !hasValidatedPlaybackOverlap)) reasons.push('IDLE_SEGMENT');
  return { reasons, eligibleSeconds: reasons.length ? 0 : Math.floor(ms / 1000) };
}

/** Timing checks shared by every event type. `occurredAt` is already clock-offset corrected. */
export function timingReasons(occurredAt: Date, receivedAt: Date): Reason[] {
  const lag = receivedAt.getTime() - occurredAt.getTime();
  if (lag < -POLICY_V1.futureToleranceMs) return ['FUTURE_TIMESTAMP'];
  if (lag > POLICY_V1.staleAfterMs) return ['STALE_EVENT'];
  if (lag > POLICY_V1.offlineThresholdMs) return ['OFFLINE_DELAYED'];
  return [];
}

/** Earned spend for a set of billable ad events under the campaign's pricing. Floors to the minor unit. */
export function earnedSpend(pricing: 'CPM' | 'CPQV', rateMinor: bigint, counts: { impressions: bigint; qualifiedViews: bigint }): bigint {
  return pricing === 'CPQV' ? counts.qualifiedViews * rateMinor : (counts.impressions * rateMinor) / 1000n;
}
