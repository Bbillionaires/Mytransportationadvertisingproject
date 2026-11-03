import { describe, expect, it } from 'vitest';
import { distanceMeters, eligibleFences, shouldShow } from '../src/modules/riders/proximity.js';

const now = new Date('2026-11-03T12:00:00Z');
const fence = (o: Partial<Parameters<typeof eligibleFences>[0][number]> = {}) => ({ id: 'f', distanceM: 100, radiusM: 200, lastAlertAt: null, cooldownMinutes: 30, todayCount: 0, dailyCap: 2, ...o });

describe('PROXIMITY_POLICY_V1', () => {
  it('measures great-circle distance', () => {
    expect(Math.round(distanceMeters(39.7817, -89.6501, 39.7817, -89.6501))).toBe(0);
    const d = distanceMeters(39.7817, -89.6501, 39.7907, -89.6501); // ~0.009° latitude ≈ 1 km
    expect(d).toBeGreaterThan(990);
    expect(d).toBeLessThan(1010);
  });
  it('suppresses at highway speed and within the global gap', () => {
    expect(eligibleFences([fence()], now, 30, null)).toEqual({ eligible: [], reason: 'SPEED_TOO_HIGH' });
    expect(eligibleFences([fence()], now, 10, new Date(now.getTime() - 5 * 60_000)).reason).toBe('GLOBAL_GAP');
  });
  it('applies radius, per-fence cooldown and daily cap, nearest first', () => {
    const r = eligibleFences([
      fence({ id: 'far', distanceM: 300 }),
      fence({ id: 'cool', lastAlertAt: new Date(now.getTime() - 10 * 60_000) }),
      fence({ id: 'capped', todayCount: 2 }),
      fence({ id: 'b', distanceM: 150 }),
      fence({ id: 'a', distanceM: 50 }),
    ], now, 8, null);
    expect(r.eligible.map((f) => f.id)).toEqual(['a', 'b']);
  });
  it('randomized pacing shows about half of eligible alerts', () => {
    expect(shouldShow(0.2)).toBe(true);
    expect(shouldShow(0.7)).toBe(false);
  });
});
