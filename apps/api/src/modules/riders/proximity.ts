/**
 * PROXIMITY_POLICY_V1 — passenger-tablet alerts for nearby sponsors. Pure functions.
 *  - Never at highway speed (> 25 m/s ≈ 90 km/h): the alert would describe a place already passed.
 *  - At most one alert per tablet every 10 minutes overall, per-geofence cooldown, per-geofence daily cap.
 *  - Randomized: an eligible alert is shown with probability 1/2, so passengers aren't spammed on every pass.
 *  - Alerts are silent, passenger-only, say "near your route", and expire after 60 s.
 */
export const PROXIMITY_POLICY = { maxSpeedMps: 25, globalGapMinutes: 10, showProbability: 0.5, alertTtlSeconds: 60 } as const;

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface FenceState { id: string; distanceM: number; radiusM: number; lastAlertAt: Date | null; cooldownMinutes: number; todayCount: number; dailyCap: number }

export function eligibleFences(fences: FenceState[], now: Date, speedMps: number | null, lastAnyAlertAt: Date | null): { eligible: FenceState[]; reason?: string } {
  if (speedMps !== null && speedMps > PROXIMITY_POLICY.maxSpeedMps) return { eligible: [], reason: 'SPEED_TOO_HIGH' };
  if (lastAnyAlertAt && now.getTime() - lastAnyAlertAt.getTime() < PROXIMITY_POLICY.globalGapMinutes * 60_000) return { eligible: [], reason: 'GLOBAL_GAP' };
  const eligible = fences
    .filter((f) => f.distanceM <= f.radiusM)
    .filter((f) => !f.lastAlertAt || now.getTime() - f.lastAlertAt.getTime() >= f.cooldownMinutes * 60_000)
    .filter((f) => f.todayCount < f.dailyCap)
    .sort((a, b) => a.distanceM - b.distanceM);
  return eligible.length ? { eligible } : { eligible: [], reason: 'NONE_ELIGIBLE' };
}

import { randomInt } from 'node:crypto';
let source = () => randomInt(1_000_000) / 1_000_000;
/** Uniform [0,1) used for pacing. Tests may pin it; production uses the CSPRNG. */
export const proximityRandom = () => source();
export function setProximityRandomForTests(fn: () => number) { source = fn; }

/** Randomized pacing; `rand` in [0,1) is injected for testability. */
export const shouldShow = (rand: number) => rand < PROXIMITY_POLICY.showProbability;
