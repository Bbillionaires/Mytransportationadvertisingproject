/**
 * ATTRIBUTION_POLICY_V1 (D-022). Pure functions.
 *  - Only an explicit, advertiser-reported order is a sale. A landing-page visit is never a sale.
 *  - Touchpoints: a unique coupon/QR code issued on a tablet, or a validated tap on the ad ("click").
 *  - Tie-break: a valid coupon code beats a click (it is the stronger, single-use proof).
 *  - Windows: click → order within offer.click_window_hours (default 7 days); coupon → before the code expires
 *    (default 30 days after issue). Orders before the touchpoint never attribute.
 *  - The commission base is the advertiser-funded commission, never the whole sale.
 */
export const ATTRIBUTION_POLICY_VERSION = 'ATTRIBUTION_POLICY_V1';

export interface Offer {
  kind: 'PERCENT_OF_SALE' | 'FIXED_PER_SALE';
  rate_bps: number | null;
  fixed_minor: string | bigint | null;
  product_sku: string | null;
  currency: string;
  valid_from: Date;
  valid_to: Date;
}

/** Commission owed on a (net) sale amount. Fixed commissions apply once while any part of the sale stands. */
export function commissionFor(offer: Offer, netSaleMinor: bigint): bigint {
  if (netSaleMinor <= 0n) return 0n;
  if (offer.kind === 'FIXED_PER_SALE') return BigInt(offer.fixed_minor!);
  return (netSaleMinor * BigInt(offer.rate_bps!)) / 10000n;
}

export function offerApplies(offer: Offer, touchAt: Date, sku: string | null, currency: string): string | null {
  if (touchAt < offer.valid_from || touchAt >= offer.valid_to) return 'offer was not active at the time of the touchpoint';
  if (offer.product_sku && offer.product_sku !== sku) return 'product is not covered by the offer';
  if (offer.currency.trim() !== currency) return 'currency differs from the offer';
  return null;
}

export function withinWindow(touchAt: Date, orderAt: Date, windowEnd: Date): string | null {
  if (orderAt < touchAt) return 'order precedes the touchpoint';
  if (orderAt > windowEnd) return 'order is outside the attribution window';
  return null;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
export function couponCode(random: Buffer): string {
  if (random.length < 10) throw new Error('need 10 random bytes');
  return Array.from(random.subarray(0, 10), (b) => ALPHABET[b % ALPHABET.length]).join('');
}
