import { INITIAL_RULE_SPLITS, type RevenueCategory, type RevenueRuleVersion } from '../src/index.js';

export function rule(category: RevenueCategory, over: Partial<RevenueRuleVersion> = {}): RevenueRuleVersion {
  return {
    id: `rule-${category}-v1`,
    category,
    version: 1,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    ...INITIAL_RULE_SPLITS[category],
    unallocatedDriverShare: 'TO_PLATFORM',
    unallocatedCreatorShare: 'TO_PLATFORM',
    status: 'APPROVED',
    ...over,
  };
}
