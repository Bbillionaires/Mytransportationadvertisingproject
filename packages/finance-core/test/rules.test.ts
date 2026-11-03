import { describe, expect, it } from 'vitest';
import { categoryFor, RuleError, selectRule, splitParties, validateRule } from '../src/index.js';
import { rule } from './helpers.js';

describe('revenue rules', () => {
  it('initial splits match the specification exactly', () => {
    const cases = [
      ['CREATOR_CONTENT_AD', 500, 6000, 3500],
      ['STANDALONE_AD', 500, 0, 9500],
      ['SALES_COMMISSION_WITH_CREATOR', 1500, 1000, 7500],
      ['SALES_COMMISSION_NO_CREATOR', 1500, 0, 8500],
    ] as const;
    for (const [cat, d, c, p] of cases) {
      const r = rule(cat);
      expect([r.driverBps, r.creatorBps, r.platformBps]).toEqual([d, c, p]);
      expect(() => validateRule(r)).not.toThrow();
    }
  });
  it('rejects splits that do not sum to 100% and creator shares on no-creator categories', () => {
    expect(() => validateRule(rule('STANDALONE_AD', { platformBps: 9400 }))).toThrow(RuleError);
    expect(() => validateRule(rule('STANDALONE_AD', { creatorBps: 100, platformBps: 9400 }))).toThrow(RuleError);
  });
  it('selects by effective date and never uses drafts or overlaps', () => {
    const v1 = rule('STANDALONE_AD', { effectiveTo: new Date('2026-06-01T00:00:00Z') });
    const v2 = rule('STANDALONE_AD', { id: 'v2', version: 2, effectiveFrom: new Date('2026-06-01T00:00:00Z'), driverBps: 600, platformBps: 9400 });
    const draft = rule('STANDALONE_AD', { id: 'draft', version: 3, status: 'DRAFT', effectiveFrom: new Date('2026-01-01T00:00:00Z') });
    expect(selectRule([v1, v2, draft], 'STANDALONE_AD', new Date('2026-03-01T00:00:00Z')).id).toBe(v1.id);
    expect(selectRule([v1, v2, draft], 'STANDALONE_AD', new Date('2026-06-01T00:00:00Z')).id).toBe('v2');
    expect(() => selectRule([v1, v2], 'CREATOR_CONTENT_AD', new Date('2026-03-01T00:00:00Z'))).toThrow(/no approved/);
    expect(() => selectRule([rule('STANDALONE_AD'), rule('STANDALONE_AD', { id: 'dup' })], 'STANDALONE_AD', new Date('2026-03-01T00:00:00Z'))).toThrow(/overlapping/);
  });
  it('routes categories by creator attribution', () => {
    expect(categoryFor('AD', true)).toBe('CREATOR_CONTENT_AD');
    expect(categoryFor('AD', false)).toBe('STANDALONE_AD');
    expect(categoryFor('SALES_COMMISSION', true)).toBe('SALES_COMMISSION_WITH_CREATOR');
    expect(categoryFor('SALES_COMMISSION', false)).toBe('SALES_COMMISSION_NO_CREATOR');
  });
});

describe('party split', () => {
  it('creator-content ad: $1,000.00 net -> 50.00 / 600.00 / 350.00', () => {
    const r = splitParties({ net: 100000n, rule: rule('CREATOR_CONTENT_AD'), hasEligibleDriver: true, hasEligibleCreator: true });
    expect([r.driver, r.creator, r.platform, r.roundingResidual]).toEqual([5000n, 60000n, 35000n, 0n]);
  });
  it('standalone ad 5/0/95 and commission 15/10/75, 15/0/85', () => {
    const s = splitParties({ net: 100000n, rule: rule('STANDALONE_AD'), hasEligibleDriver: true, hasEligibleCreator: false });
    expect([s.driver, s.creator, s.platform]).toEqual([5000n, 0n, 95000n]);
    const c = splitParties({ net: 100000n, rule: rule('SALES_COMMISSION_WITH_CREATOR'), hasEligibleDriver: true, hasEligibleCreator: true });
    expect([c.driver, c.creator, c.platform]).toEqual([15000n, 10000n, 75000n]);
    const n = splitParties({ net: 100000n, rule: rule('SALES_COMMISSION_NO_CREATOR'), hasEligibleDriver: true, hasEligibleCreator: false });
    expect([n.driver, n.creator, n.platform]).toEqual([15000n, 0n, 85000n]);
  });
  it('rounding residual is explicit: 1 cent creator-content ad', () => {
    const r = splitParties({ net: 1n, rule: rule('CREATOR_CONTENT_AD'), hasEligibleDriver: true, hasEligibleCreator: true });
    expect([r.driver, r.creator, r.platform, r.roundingResidual]).toEqual([0n, 0n, 0n, 1n]);
    const r2 = splitParties({ net: 333n, rule: rule('CREATOR_CONTENT_AD'), hasEligibleDriver: true, hasEligibleCreator: true });
    expect([r2.driver, r2.creator, r2.platform, r2.roundingResidual]).toEqual([16n, 199n, 116n, 2n]);
  });
  it('no eligible driver: share goes to platform under TO_PLATFORM, or is held under HOLD', () => {
    const r = splitParties({ net: 100000n, rule: rule('STANDALONE_AD'), hasEligibleDriver: false, hasEligibleCreator: false });
    expect([r.driver, r.platformFromUnallocatedDriver, r.platform]).toEqual([0n, 5000n, 95000n]);
    const h = splitParties({ net: 100000n, rule: rule('STANDALONE_AD', { unallocatedDriverShare: 'HOLD' }), hasEligibleDriver: false, hasEligibleCreator: false });
    expect([h.driver, h.held, h.platformFromUnallocatedDriver]).toEqual([0n, 5000n, 0n]);
  });
  it('refuses negative net', () => {
    expect(() => splitParties({ net: -1n, rule: rule('STANDALONE_AD'), hasEligibleDriver: true, hasEligibleCreator: false })).toThrow();
  });
});
