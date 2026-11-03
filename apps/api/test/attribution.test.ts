import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { commissionFor, couponCode, offerApplies, withinWindow, type Offer } from '../src/modules/commissions/attribution.js';

const offer = (o: Partial<Offer> = {}): Offer => ({ kind: 'PERCENT_OF_SALE', rate_bps: 800, fixed_minor: null, product_sku: null, currency: 'USD',
  valid_from: new Date('2026-11-01T00:00:00Z'), valid_to: new Date('2026-12-01T00:00:00Z'), ...o });

describe('ATTRIBUTION_POLICY_V1', () => {
  it('commission is a percentage of the sale (floored) or a fixed amount per sale', () => {
    expect(commissionFor(offer(), 12_345n)).toBe(987n);             // 8% of $123.45 = $9.876
    expect(commissionFor(offer({ kind: 'FIXED_PER_SALE', rate_bps: null, fixed_minor: '500' }), 1n)).toBe(500n);
    expect(commissionFor(offer({ kind: 'FIXED_PER_SALE', rate_bps: null, fixed_minor: '500' }), 0n)).toBe(0n); // fully refunded
  });
  it('offer scope: dates, product and currency', () => {
    expect(offerApplies(offer(), new Date('2026-11-15T00:00:00Z'), null, 'USD')).toBeNull();
    expect(offerApplies(offer(), new Date('2026-12-02T00:00:00Z'), null, 'USD')).toMatch(/not active/);
    expect(offerApplies(offer({ product_sku: 'LATTE' }), new Date('2026-11-15T00:00:00Z'), 'MUG', 'USD')).toMatch(/product/);
    expect(offerApplies(offer(), new Date('2026-11-15T00:00:00Z'), null, 'CAD')).toMatch(/currency/);
  });
  it('windows: never before the touchpoint, never after the window closes', () => {
    const t = new Date('2026-11-10T00:00:00Z'), end = new Date('2026-11-17T00:00:00Z');
    expect(withinWindow(t, new Date('2026-11-12T00:00:00Z'), end)).toBeNull();
    expect(withinWindow(t, new Date('2026-11-09T00:00:00Z'), end)).toMatch(/precedes/);
    expect(withinWindow(t, new Date('2026-11-18T00:00:00Z'), end)).toMatch(/outside/);
  });
  it('coupon codes are 10 unambiguous characters', () => {
    for (let i = 0; i < 200; i++) expect(couponCode(randomBytes(10))).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
  });
});
