/** Campaign dayparting, evaluated in the campaign's IANA time zone. Pure. */
export interface Schedule {
  timezone: string;
  daysOfWeek: number[]; // 0 = Sunday
  startMinute: number;  // inclusive, minutes after local midnight
  endMinute: number;    // exclusive; 1440 = end of day. start > end means an overnight window.
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(timezone: string, at: Date): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { day: WEEKDAY[get('weekday')]!, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function isScheduleActive(s: Schedule, at: Date): boolean {
  const { day, minute } = localParts(s.timezone, at);
  if (s.startMinute < s.endMinute) return s.daysOfWeek.includes(day) && minute >= s.startMinute && minute < s.endMinute;
  // Overnight window (e.g. 22:00-02:00): the early-morning part belongs to the previous day's window.
  if (minute >= s.startMinute) return s.daysOfWeek.includes(day);
  if (minute < s.endMinute) return s.daysOfWeek.includes((day + 6) % 7);
  return false;
}

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
