/**
 * Versioned, effective-dated revenue split rules. Percentages are basis points
 * (1% = 100 bps) and must sum to exactly 10000. Rules apply to NET distributable
 * amounts only (see waterfall.ts).
 */
export const REVENUE_CATEGORIES = [
  'CREATOR_CONTENT_AD',
  'STANDALONE_AD',
  'SALES_COMMISSION_WITH_CREATOR',
  'SALES_COMMISSION_NO_CREATOR',
] as const;
export type RevenueCategory = (typeof REVENUE_CATEGORIES)[number];

export type RuleStatus = 'DRAFT' | 'APPROVED' | 'RETIRED';

/** What happens to a share whose party has no eligible recipient. */
export type UnallocatedSharePolicy = 'TO_PLATFORM' | 'HOLD';

export interface RevenueRuleVersion {
  readonly id: string;
  readonly category: RevenueCategory;
  readonly version: number;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null; // exclusive
  readonly driverBps: number;
  readonly creatorBps: number;
  readonly platformBps: number;
  readonly unallocatedDriverShare: UnallocatedSharePolicy;
  readonly unallocatedCreatorShare: UnallocatedSharePolicy;
  readonly status: RuleStatus;
}

export class RuleError extends Error {
  override name = 'RuleError';
}

export function validateRule(r: RevenueRuleVersion): void {
  for (const [k, v] of [['driverBps', r.driverBps], ['creatorBps', r.creatorBps], ['platformBps', r.platformBps]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 10000) throw new RuleError(`${k} must be an integer in [0, 10000]`);
  }
  if (r.driverBps + r.creatorBps + r.platformBps !== 10000) throw new RuleError('split must sum to 10000 bps');
  if (!REVENUE_CATEGORIES.includes(r.category)) throw new RuleError(`unknown category ${r.category}`);
  if ((r.category === 'STANDALONE_AD' || r.category === 'SALES_COMMISSION_NO_CREATOR') && r.creatorBps !== 0) {
    throw new RuleError(`${r.category} cannot allocate to a creator`);
  }
  if (r.effectiveTo && r.effectiveTo <= r.effectiveFrom) throw new RuleError('effectiveTo must be after effectiveFrom');
}

/**
 * Select the single APPROVED rule effective at `at` for `category`. Throws rather
 * than silently falling back when no rule (or more than one) matches, so a new or
 * mismatched revenue category can never be paid out under the wrong split.
 */
export function selectRule(rules: readonly RevenueRuleVersion[], category: RevenueCategory, at: Date): RevenueRuleVersion {
  const matches = rules.filter(
    (r) => r.status !== 'DRAFT' && r.category === category && r.effectiveFrom <= at && (r.effectiveTo === null || at < r.effectiveTo),
  );
  const approved = matches.filter((r) => r.status === 'APPROVED' || r.status === 'RETIRED');
  if (approved.length === 0) throw new RuleError(`no approved ${category} rule effective at ${at.toISOString()}`);
  if (approved.length > 1) throw new RuleError(`overlapping ${category} rules effective at ${at.toISOString()}`);
  const rule = approved[0]!;
  validateRule(rule);
  return rule;
}

/** Category routing: whether an attributable, eligible creator exists decides the category. */
export function categoryFor(kind: 'AD' | 'SALES_COMMISSION', hasAttributableCreator: boolean): RevenueCategory {
  if (kind === 'AD') return hasAttributableCreator ? 'CREATOR_CONTENT_AD' : 'STANDALONE_AD';
  return hasAttributableCreator ? 'SALES_COMMISSION_WITH_CREATOR' : 'SALES_COMMISSION_NO_CREATOR';
}

/** Initial-version business rules from the specification (version 1). */
export const INITIAL_RULE_SPLITS: Readonly<Record<RevenueCategory, { driverBps: number; creatorBps: number; platformBps: number }>> = {
  CREATOR_CONTENT_AD: { driverBps: 500, creatorBps: 6000, platformBps: 3500 },
  STANDALONE_AD: { driverBps: 500, creatorBps: 0, platformBps: 9500 },
  SALES_COMMISSION_WITH_CREATOR: { driverBps: 1500, creatorBps: 1000, platformBps: 7500 },
  SALES_COMMISSION_NO_CREATOR: { driverBps: 1500, creatorBps: 0, platformBps: 8500 },
};
