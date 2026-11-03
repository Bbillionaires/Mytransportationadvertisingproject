import { describe, expect, it } from 'vitest';
import { classifyActiveSegment, classifyAd, classifyContent, decideStatus, earnedSpend, exposureIsPossible, timingReasons } from '../src/modules/events/policy.js';

const t0 = new Date('2026-11-03T12:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const exp = (visibleMs: number, mutedMs = 0, wallMs = visibleMs) => ({ startedAt: t0, endedAt: at(wallMs), visibleMs, mutedMs });

describe('VALIDATION_POLICY_V1', () => {
  it('video ad: impression at 1s visible, qualified at min(15s, 50% duration) UNMUTED', () => {
    expect(classifyAd('VIDEO', 30_000, exp(999))).toMatchObject({ impression: false, qualified: false });
    expect(classifyAd('VIDEO', 30_000, exp(14_999))).toMatchObject({ impression: true, qualified: false });
    expect(classifyAd('VIDEO', 30_000, exp(15_000))).toMatchObject({ qualified: true });
    expect(classifyAd('VIDEO', 10_000, exp(5_000))).toMatchObject({ qualified: true });         // 50% of a 10s ad
    expect(classifyAd('VIDEO', 30_000, exp(30_000, 20_000))).toMatchObject({ impression: true, qualified: false }); // muted
  });
  it('banner/display: shown for 1s is an impression and a qualified view', () => {
    expect(classifyAd('BANNER', null, exp(1_000, 1_000))).toMatchObject({ impression: true, qualified: true });
    expect(classifyAd('DISPLAY', null, exp(500))).toMatchObject({ impression: false, qualified: false });
  });
  it('content: verified watch seconds are unmuted, capped at duration; qualified at min(30s, 50%)', () => {
    expect(classifyContent(600_000, exp(45_500, 5_000))).toEqual({ qualified: true, watchSeconds: 40, unmutedVisibleMs: 40_500 });
    expect(classifyContent(600_000, exp(29_999))).toMatchObject({ qualified: false, watchSeconds: 29 });
    expect(classifyContent(20_000, exp(10_000))).toMatchObject({ qualified: true });
    expect(classifyContent(20_000, exp(21_000)).watchSeconds).toBe(20);
  });
  it('rejects impossible exposure', () => {
    expect(exposureIsPossible(exp(10_000, 0, 5_000))).toBe(false);          // more visible than wall clock
    expect(exposureIsPossible(exp(5_000, 6_000, 5_000))).toBe(false);       // muted > visible
    expect(exposureIsPossible(exp(40_000, 0, 40_000), 30_000)).toBe(false); // longer than the media
    expect(exposureIsPossible(exp(31_000, 0, 31_000), 30_000)).toBe(true);  // within tolerance
  });
  it('anti-idle active segments', () => {
    const seg = (ms: number, screenOn = true, interactions = 1) => ({ startedAt: t0, endedAt: at(ms), screenOn, interactions });
    expect(classifyActiveSegment(seg(600_000), false)).toEqual({ reasons: [], eligibleSeconds: 600 });
    expect(classifyActiveSegment(seg(600_000, true, 0), false).reasons).toEqual(['IDLE_SEGMENT']);
    expect(classifyActiveSegment(seg(600_000, true, 0), true).eligibleSeconds).toBe(600);
    expect(classifyActiveSegment(seg(600_000, false, 5), true).reasons).toEqual(['IDLE_SEGMENT']);
    expect(classifyActiveSegment(seg(20 * 60_000), true).reasons).toEqual(['SEGMENT_TOO_LONG']);
  });
  it('timing: future, stale and offline', () => {
    expect(timingReasons(at(120_000), t0)).toEqual(['FUTURE_TIMESTAMP']);
    expect(timingReasons(at(-60_000), t0)).toEqual([]);
    expect(timingReasons(at(-11 * 60_000), t0)).toEqual(['OFFLINE_DELAYED']);
    expect(timingReasons(at(-8 * 24 * 3600_000), t0)).toEqual(['STALE_EVENT']);
  });
  it('status precedence: invalid beats hold beats valid', () => {
    expect(decideStatus([])).toBe('VALID');
    expect(decideStatus(['OFFLINE_DELAYED'])).toBe('HELD_REVIEW');
    expect(decideStatus(['OFFLINE_DELAYED', 'OVERLAPPING_PLAYBACK'])).toBe('INVALID');
  });
  it('earned spend floors CPM and multiplies CPQV exactly', () => {
    expect(earnedSpend('CPM', 1250n, { impressions: 1999n, qualifiedViews: 0n })).toBe(2498n); // $12.50 CPM x 1999 = 2498.75c
    expect(earnedSpend('CPQV', 5n, { impressions: 0n, qualifiedViews: 37n })).toBe(185n);
  });
});
