/**
 * Weighted pool distribution for the creator pool and the driver pool.
 *
 * score_i = Σ_k w'_k · x_ik / X_k,   X_k = Σ_i x_ik over eligible participants
 * where w'_k are the configured component weights renormalised over components with
 * X_k > 0 (zero-denominator policy REWEIGHT_NONZERO_V1). If every component is zero
 * the pool is HELD — nothing is distributed and nothing divides by zero.
 *
 * Scores are exact rationals; we compute integer numerators over a common
 * denominator and allocate with the largest-remainder method so payouts sum
 * exactly to the funded pool.
 */
import { allocateByWeights, type Share } from './allocate.js';

export interface PoolComponentWeights {
  /** Component name -> weight in bps; weights must sum to 10000. */
  readonly [component: string]: number;
}

export interface PoolParticipant {
  readonly id: string;
  readonly eligible: boolean;
  /** Component name -> non-negative integer metric (minor units, seconds, counts). */
  readonly metrics: Readonly<Record<string, bigint>>;
}

export type PoolStatus = 'ALLOCATED' | 'HELD_NO_ACTIVITY' | 'EMPTY_POOL';

export interface PoolAllocation {
  readonly status: PoolStatus;
  readonly pool: bigint;
  readonly policy: 'REWEIGHT_NONZERO_V1';
  readonly effectiveWeights: Readonly<Record<string, number>>; // bps after renormalisation (informational, rounded)
  readonly shares: readonly Share[];
  /** Exact score numerators and their common denominator for audit. */
  readonly scoreNumerators: Readonly<Record<string, string>>;
  readonly scoreDenominator: string;
}

export class PoolError extends Error {
  override name = 'PoolError';
}

export const CREATOR_POOL_WEIGHTS_V1: PoolComponentWeights = { attributedRevenue: 5000, verifiedWatchSeconds: 3000, qualifiedViews: 2000 };
export const DRIVER_POOL_WEIGHTS_V1: PoolComponentWeights = { monetizedAdDelivery: 5000, qualifiedEngagement: 2500, eligibleActiveSeconds: 2500 };

export function allocatePool(pool: bigint, participants: readonly PoolParticipant[], weights: PoolComponentWeights): PoolAllocation {
  if (pool < 0n) throw new PoolError('pool must be >= 0');
  const comps = Object.keys(weights).sort();
  const wsum = comps.reduce((a, c) => a + weights[c]!, 0);
  if (wsum !== 10000) throw new PoolError('component weights must sum to 10000 bps');
  for (const c of comps) if (!Number.isInteger(weights[c]) || weights[c]! < 0) throw new PoolError(`invalid weight for ${c}`);

  const ids = new Set<string>();
  for (const p of participants) {
    if (ids.has(p.id)) throw new PoolError(`duplicate participant ${p.id}`);
    ids.add(p.id);
    for (const c of comps) {
      const v = p.metrics[c];
      if (v === undefined) throw new PoolError(`participant ${p.id} missing metric ${c}`);
      if (v < 0n) throw new PoolError(`participant ${p.id} has negative ${c}`);
    }
  }
  const eligible = participants.filter((p) => p.eligible);
  const totals = new Map<string, bigint>(comps.map((c) => [c, eligible.reduce((a, p) => a + p.metrics[c]!, 0n)]));
  const active = comps.filter((c) => totals.get(c)! > 0n && weights[c]! > 0);
  const base = { pool, policy: 'REWEIGHT_NONZERO_V1' as const };

  if (active.length === 0) {
    return { ...base, status: pool === 0n ? 'EMPTY_POOL' : 'HELD_NO_ACTIVITY', effectiveWeights: {}, shares: [], scoreNumerators: {}, scoreDenominator: '0' };
  }
  const activeW = active.reduce((a, c) => a + weights[c]!, 0);
  const effectiveWeights = Object.fromEntries(active.map((c) => [c, Math.round((weights[c]! * 10000) / activeW)]));

  // numerator_i = Σ_k w_k · x_ik · Π_{j≠k} X_j ; denominator = activeW · Π_k X_k
  const prodAll = active.reduce((a, c) => a * totals.get(c)!, 1n);
  const numerators = new Map<string, bigint>();
  for (const p of eligible) {
    let n = 0n;
    for (const c of active) n += BigInt(weights[c]!) * p.metrics[c]! * (prodAll / totals.get(c)!);
    numerators.set(p.id, n);
  }
  const denominator = BigInt(activeW) * prodAll;
  const numSum = [...numerators.values()].reduce((a, b) => a + b, 0n);
  if (numSum !== denominator) throw new PoolError('internal: scores do not sum to 1');

  const shares = allocateByWeights(pool, eligible.map((p) => ({ key: p.id, weight: numerators.get(p.id)! })));
  return {
    ...base,
    status: pool === 0n ? 'EMPTY_POOL' : 'ALLOCATED',
    effectiveWeights,
    shares,
    scoreNumerators: Object.fromEntries([...numerators].map(([k, v]) => [k, v.toString()])),
    scoreDenominator: denominator.toString(),
  };
}
