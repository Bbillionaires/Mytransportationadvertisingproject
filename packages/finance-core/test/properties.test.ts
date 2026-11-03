import { describe, it } from 'vitest';
import fc from 'fast-check';
import { allocateByWeights, proportionalReversal, REVENUE_CATEGORIES, splitParties } from '../src/index.js';
import { rule } from './helpers.js';

describe('allocation properties', () => {
  it('largest remainder sums exactly and each share is within one unit of its exact value', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.uniqueArray(fc.record({ key: fc.string({ minLength: 1, maxLength: 4 }), weight: fc.bigInt({ min: 1n, max: 10n ** 12n }) }), { selector: (x) => x.key, minLength: 1, maxLength: 30 }),
        (total, items) => {
          const shares = allocateByWeights(total, items);
          const W = items.reduce((a, i) => a + i.weight, 0n);
          const s = shares.reduce((a, x) => a + x.amount, 0n);
          return s === total && shares.every((x, i) => {
            const exactTimesW = total * items[i]!.weight;
            const diff = x.amount * W - exactTimesW;
            return diff > -W && diff < W && x.amount >= 0n;
          });
        },
      ),
      { numRuns: 1000 },
    );
  });
  it('is deterministic regardless of input order', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.uniqueArray(fc.record({ key: fc.string({ minLength: 1, maxLength: 4 }), weight: fc.bigInt({ min: 0n, max: 1000n }) }), { selector: (x) => x.key, minLength: 1, maxLength: 20 }).filter((xs) => xs.some((x) => x.weight > 0n)),
        (total, items) => {
          const a = new Map(allocateByWeights(total, items).map((s) => [s.key, s.amount]));
          const b = new Map(allocateByWeights(total, [...items].reverse()).map((s) => [s.key, s.amount]));
          return [...a].every(([k, v]) => b.get(k) === v);
        },
      ),
    );
  });
  it('party splits never exceed net, reconcile exactly, and residual is at most 2 units', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.constantFrom(...REVENUE_CATEGORIES), fc.boolean(), fc.boolean(), (net, cat, d, c) => {
        const r = splitParties({ net, rule: rule(cat), hasEligibleDriver: d, hasEligibleCreator: c || cat === 'CREATOR_CONTENT_AD' || cat === 'SALES_COMMISSION_WITH_CREATOR' ? c : false });
        const t = r.driver + r.creator + r.platform + r.platformFromUnallocatedDriver + r.platformFromUnallocatedCreator + r.held + r.roundingResidual;
        return t === net && r.roundingResidual >= 0n && r.roundingResidual <= 2n && r.driver >= 0n && r.creator >= 0n;
      }),
      { numRuns: 1000 },
    );
  });
  it('repeated partial reversals never exceed the original allocation and fully reverse to zero', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 8n }), { minLength: 1, maxLength: 10 }),
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 6 }),
        (amounts, pcts) => {
          const lines = amounts.map((a, i) => ({ key: `k${i}`, originalAmount: a, alreadyReversed: 0n }));
          let state = lines;
          const total = amounts.reduce((a, b) => a + b, 0n);
          let reversed = 0n;
          for (const p of pcts) {
            const remaining = total - reversed;
            const amt = (remaining * BigInt(p)) / 100n;
            const shares = proportionalReversal(state, amt);
            state = state.map((l) => ({ ...l, alreadyReversed: l.alreadyReversed + shares.find((s) => s.key === l.key)!.amount }));
            reversed += amt;
            if (state.some((l) => l.alreadyReversed > l.originalAmount)) return false;
          }
          const final = proportionalReversal(state, total - reversed);
          state = state.map((l) => ({ ...l, alreadyReversed: l.alreadyReversed + final.find((s) => s.key === l.key)!.amount }));
          return state.every((l) => l.alreadyReversed === l.originalAmount);
        },
      ),
      { numRuns: 500 },
    );
  });
});
