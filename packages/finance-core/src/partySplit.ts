/**
 * Party-level split of a net pool into driver / creator / platform shares.
 *
 * Rounding policy RESIDUAL_TO_PLATFORM_V1 (see DECISIONS.md D-007):
 *   driver  = floor(net * driverBps / 10000)
 *   creator = floor(net * creatorBps / 10000)
 *   platform (contractual) = floor(net * platformBps / 10000)
 *   roundingResidual = net - driver - creator - platform   (0..2 minor units, posted to an explicit rounding account)
 * Shares for a party with no eligible recipient follow the rule's unallocated-share policy.
 */
import { applyBpsFloor } from './allocate.js';
import type { RevenueRuleVersion } from './rules.js';

export interface PartySplitInput {
  readonly net: bigint;
  readonly rule: RevenueRuleVersion;
  readonly hasEligibleDriver: boolean;
  readonly hasEligibleCreator: boolean;
}

export interface PartySplitResult {
  readonly ruleId: string;
  readonly net: bigint;
  readonly driver: bigint;
  readonly creator: bigint;
  readonly platform: bigint;
  /** Driver share redirected to platform because no eligible driver exists. */
  readonly platformFromUnallocatedDriver: bigint;
  readonly platformFromUnallocatedCreator: bigint;
  /** Shares held (not allocated) pending review because policy is HOLD. */
  readonly held: bigint;
  readonly roundingResidual: bigint;
}

export class PartySplitError extends Error {
  override name = 'PartySplitError';
}

export function splitParties(input: PartySplitInput): PartySplitResult {
  const { net, rule } = input;
  if (net < 0n) throw new PartySplitError('negative net amounts are never split; route to review');
  const driverRaw = applyBpsFloor(net, rule.driverBps);
  const creatorRaw = applyBpsFloor(net, rule.creatorBps);
  const platform = applyBpsFloor(net, rule.platformBps);
  const roundingResidual = net - driverRaw - creatorRaw - platform;

  let driver = driverRaw;
  let creator = creatorRaw;
  let platformFromUnallocatedDriver = 0n;
  let platformFromUnallocatedCreator = 0n;
  let held = 0n;

  if (!input.hasEligibleDriver && driver > 0n) {
    if (rule.unallocatedDriverShare === 'TO_PLATFORM') platformFromUnallocatedDriver = driver;
    else held += driver;
    driver = 0n;
  }
  if (!input.hasEligibleCreator && creator > 0n) {
    if (rule.unallocatedCreatorShare === 'TO_PLATFORM') platformFromUnallocatedCreator = creator;
    else held += creator;
    creator = 0n;
  }
  const total = driver + creator + platform + platformFromUnallocatedDriver + platformFromUnallocatedCreator + held + roundingResidual;
  if (total !== net) throw new PartySplitError('internal: split does not reconcile to net');
  return { ruleId: rule.id, net, driver, creator, platform, platformFromUnallocatedDriver, platformFromUnallocatedCreator, held, roundingResidual };
}
