/**
 * Deterministic integer allocation primitives.
 *
 * Largest-remainder (Hamilton) method over integer weights:
 *   share_i = floor(total * w_i / W); leftover units (< n) go one each to the
 *   items with the largest remainders, ties broken by ascending key.
 * Guarantees: sum(shares) === total exactly, every share >= 0, and each share
 * differs from its exact rational value by less than one minor unit.
 */
export interface WeightedItem {
  readonly key: string;
  readonly weight: bigint;
}

export interface Share {
  readonly key: string;
  readonly amount: bigint;
}

export class AllocationError extends Error {
  override name = 'AllocationError';
}

export function allocateByWeights(total: bigint, items: readonly WeightedItem[]): Share[] {
  if (total < 0n) throw new AllocationError('total must be >= 0; handle negative amounts as explicit reversals');
  const keys = new Set<string>();
  let W = 0n;
  for (const it of items) {
    if (it.weight < 0n) throw new AllocationError(`negative weight for ${it.key}`);
    if (keys.has(it.key)) throw new AllocationError(`duplicate key ${it.key}`);
    keys.add(it.key);
    W += it.weight;
  }
  if (W === 0n) {
    if (total === 0n) return items.map((it) => ({ key: it.key, amount: 0n }));
    throw new AllocationError('cannot allocate a nonzero total over zero total weight');
  }
  const rows = items.map((it) => {
    const p = total * it.weight;
    return { key: it.key, floor: p / W, rem: p % W };
  });
  let leftover = total - rows.reduce((a, r) => a + r.floor, 0n);
  const order = [...rows].sort((a, b) => (a.rem === b.rem ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.rem > b.rem ? -1 : 1));
  const bonus = new Map<string, bigint>();
  for (const r of order) {
    if (leftover === 0n) break;
    if (r.rem === 0n) continue; // items with exact shares never receive residual units
    bonus.set(r.key, 1n);
    leftover -= 1n;
  }
  if (leftover !== 0n) throw new AllocationError('internal: leftover not exhausted');
  return rows.map((r) => ({ key: r.key, amount: r.floor + (bonus.get(r.key) ?? 0n) }));
}

/** floor(amount * bps / 10000) for non-negative amounts. */
export function applyBpsFloor(amount: bigint, bps: number): bigint {
  if (amount < 0n) throw new AllocationError('applyBpsFloor requires a non-negative amount');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new AllocationError(`invalid basis points: ${bps}`);
  return (amount * BigInt(bps)) / 10000n;
}
