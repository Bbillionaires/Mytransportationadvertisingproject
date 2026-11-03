import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocatePool, CREATOR_POOL_WEIGHTS_V1, DRIVER_POOL_WEIGHTS_V1, PoolError } from '../src/index.js';

const creator = (id: string, r: bigint, w: bigint, v: bigint, eligible = true) => ({
  id, eligible, metrics: { attributedRevenue: r, verifiedWatchSeconds: w, qualifiedViews: v },
});

describe('creator pool (hybrid 50/30/20)', () => {
  it('matches the specification formula on a worked example', () => {
    // pool 600.00; A has all revenue, watch split 3:1, views split 1:1
    // score_A = .5*1 + .3*.75 + .2*.5 = .825 -> 495.00 ; score_B = .175 -> 105.00
    const r = allocatePool(60000n, [creator('A', 1000n, 300n, 10n), creator('B', 0n, 100n, 10n)], CREATOR_POOL_WEIGHTS_V1);
    expect(r.status).toBe('ALLOCATED');
    expect(Object.fromEntries(r.shares.map((s) => [s.key, s.amount]))).toEqual({ A: 49500n, B: 10500n });
  });
  it('reweights remaining components when a denominator is zero (no division by zero)', () => {
    // no attributed revenue at all -> weights become watch 60%, views 40%
    const r = allocatePool(10000n, [creator('A', 0n, 100n, 0n), creator('B', 0n, 0n, 10n)], CREATOR_POOL_WEIGHTS_V1);
    expect(r.effectiveWeights).toEqual({ verifiedWatchSeconds: 6000, qualifiedViews: 4000 });
    expect(Object.fromEntries(r.shares.map((s) => [s.key, s.amount]))).toEqual({ A: 6000n, B: 4000n });
  });
  it('holds the pool when there is no eligible activity', () => {
    const r = allocatePool(10000n, [creator('A', 0n, 0n, 0n), creator('B', 5n, 5n, 5n, false)], CREATOR_POOL_WEIGHTS_V1);
    expect(r.status).toBe('HELD_NO_ACTIVITY');
    expect(r.shares).toEqual([]);
  });
  it('never pays ineligible participants', () => {
    const r = allocatePool(10000n, [creator('A', 1n, 1n, 1n), creator('X', 1000n, 1000n, 1000n, false)], CREATOR_POOL_WEIGHTS_V1);
    expect(r.shares).toEqual([{ key: 'A', amount: 10000n }]);
  });
  it('rejects negative metrics, missing metrics and bad weights', () => {
    expect(() => allocatePool(1n, [creator('A', -1n, 0n, 0n)], CREATOR_POOL_WEIGHTS_V1)).toThrow(PoolError);
    expect(() => allocatePool(1n, [{ id: 'A', eligible: true, metrics: {} }], CREATOR_POOL_WEIGHTS_V1)).toThrow(PoolError);
    expect(() => allocatePool(1n, [], { a: 5000 })).toThrow(PoolError);
  });
});

const metric = fc.bigInt({ min: 0n, max: 10n ** 9n });
const participants = (comps: string[]) =>
  fc.uniqueArray(
    fc.record({ id: fc.string({ minLength: 1, maxLength: 6 }), eligible: fc.boolean(), vals: fc.array(metric, { minLength: comps.length, maxLength: comps.length }) }),
    { selector: (p) => p.id, maxLength: 25 },
  ).map((ps) => ps.map((p) => ({ id: p.id, eligible: p.eligible, metrics: Object.fromEntries(comps.map((c, i) => [c, p.vals[i]!])) })));

describe('pool properties', () => {
  for (const [name, weights] of [['creator', CREATOR_POOL_WEIGHTS_V1], ['driver', DRIVER_POOL_WEIGHTS_V1]] as const) {
    it(`${name} pool payouts sum exactly to the funded pool, are non-negative, and only go to eligible participants`, () => {
      fc.assert(
        fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), participants(Object.keys(weights)), (pool, ps) => {
          const r = allocatePool(pool, ps, weights);
          if (r.status === 'HELD_NO_ACTIVITY' || (r.status === 'EMPTY_POOL' && r.shares.length === 0)) return r.shares.length === 0 && (r.status === 'EMPTY_POOL') === (pool === 0n);
          const total = r.shares.reduce((a, s) => a + s.amount, 0n);
          const eligibleIds = new Set(ps.filter((p) => p.eligible).map((p) => p.id));
          return total === pool && r.shares.every((s) => s.amount >= 0n && eligibleIds.has(s.key)) && BigInt(r.scoreDenominator) > 0n;
        }),
        { numRuns: 500 },
      );
    });
  }
});
