import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { isScheduleActive, localParts } from '../src/modules/campaigns/schedule.js';
import { signMediaUrl, verifyMediaSignature } from '../src/lib/media.js';

describe('campaign schedule (dayparting)', () => {
  // 2026-11-03 is a Tuesday. 14:30 UTC = 08:30 in Chicago (CST, UTC-6).
  const at = new Date('2026-11-03T14:30:00Z');
  it('evaluates in the campaign time zone', () => {
    expect(localParts('America/Chicago', at)).toEqual({ day: 2, minute: 8 * 60 + 30 });
    expect(isScheduleActive({ timezone: 'America/Chicago', daysOfWeek: [1, 2, 3, 4, 5], startMinute: 7 * 60, endMinute: 10 * 60 }, at)).toBe(true);
    expect(isScheduleActive({ timezone: 'UTC', daysOfWeek: [1, 2, 3, 4, 5], startMinute: 7 * 60, endMinute: 10 * 60 }, at)).toBe(false);
    expect(isScheduleActive({ timezone: 'America/Chicago', daysOfWeek: [0, 6], startMinute: 0, endMinute: 1440 }, at)).toBe(false);
  });
  it('handles overnight windows, attributing early hours to the previous day', () => {
    const late = { timezone: 'UTC', daysOfWeek: [1], startMinute: 22 * 60, endMinute: 2 * 60 }; // Monday 22:00 - Tuesday 02:00
    expect(isScheduleActive(late, new Date('2026-11-02T23:00:00Z'))).toBe(true);  // Mon 23:00
    expect(isScheduleActive(late, new Date('2026-11-03T01:30:00Z'))).toBe(true);  // Tue 01:30, Monday's window
    expect(isScheduleActive(late, new Date('2026-11-03T23:00:00Z'))).toBe(false); // Tue 23:00, not scheduled
    expect(isScheduleActive(late, new Date('2026-11-03T03:00:00Z'))).toBe(false);
  });
});

describe('signed media URLs', () => {
  const secret = randomBytes(32).toString('base64');
  it('verifies untampered, unexpired links only', () => {
    const exp = new Date(Date.now() + 60_000);
    const url = new URL(signMediaUrl('https://cdn.example.test/', 'creatives/abc/v1.mp4', exp, secret));
    const e = Number(url.searchParams.get('exp')); const sig = url.searchParams.get('sig')!;
    expect(verifyMediaSignature('creatives/abc/v1.mp4', e, sig, secret)).toBe(true);
    expect(verifyMediaSignature('creatives/abc/v2.mp4', e, sig, secret)).toBe(false);
    expect(verifyMediaSignature('creatives/abc/v1.mp4', e + 3600, sig, secret)).toBe(false);
    expect(verifyMediaSignature('creatives/abc/v1.mp4', e, sig, secret, Date.now() + 120_000)).toBe(false);
  });
});
