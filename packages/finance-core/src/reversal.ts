/**
 * Proportional reversal of a prior allocation (refunds, chargebacks, credits after
 * allocation). The reversal amount is spread across the original lines in
 * proportion to their original amounts via largest remainder, and can never
 * exceed what remains un-reversed on any line.
 */
import { allocateByWeights, AllocationError, type Share } from './allocate.js';

export interface AllocatedLine {
  readonly key: string;
  readonly originalAmount: bigint;
  readonly alreadyReversed: bigint;
}

export function proportionalReversal(lines: readonly AllocatedLine[], reverseAmount: bigint): Share[] {
  if (reverseAmount < 0n) throw new AllocationError('reverseAmount must be >= 0');
  const remaining = lines.map((l) => {
    if (l.originalAmount < 0n || l.alreadyReversed < 0n || l.alreadyReversed > l.originalAmount) {
      throw new AllocationError(`invalid line state for ${l.key}`);
    }
    return { key: l.key, weight: l.originalAmount - l.alreadyReversed };
  });
  const capacity = remaining.reduce((a, r) => a + r.weight, 0n);
  if (reverseAmount > capacity) throw new AllocationError('reversal exceeds the un-reversed allocation');
  const shares = allocateByWeights(reverseAmount, remaining);
  for (const s of shares) {
    const cap = remaining.find((r) => r.key === s.key)!.weight;
    if (s.amount > cap) throw new AllocationError('internal: reversal exceeds line capacity');
  }
  return shares;
}
