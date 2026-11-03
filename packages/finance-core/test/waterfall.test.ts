import { describe, expect, it } from 'vitest';
import { computeNet, WaterfallError, type WaterfallInput } from '../src/index.js';

const base: WaterfallInput = {
  currency: 'USD',
  grossReceipts: 108_250n,
  taxCollected: 8_250n,
  refunds: 0n,
  credits: 0n,
  chargebacks: 0n,
  deductions: [{ type: 'PAYMENT_PROCESSING_FEE', amount: 3_169n, description: 'card fee', contractRef: 'ADV-MSA-v1 §4.2' }],
  permittedDeductionTypes: ['PAYMENT_PROCESSING_FEE', 'DIRECT_CAMPAIGN_COST'],
};

describe('net waterfall', () => {
  it('excludes tax and deducts only permitted, cited deductions', () => {
    const r = computeNet(base);
    expect(r.taxExcluded).toBe(8_250n);
    expect(r.totalDeductions).toBe(3_169n);
    expect(r.net).toBe(96_831n);
    expect(r.status).toBe('DISTRIBUTABLE');
  });
  it('never deducts income taxes or general overhead', () => {
    for (const type of ['CORPORATE_INCOME_TAX', 'PERSONAL_INCOME_TAX', 'GENERAL_OVERHEAD']) {
      expect(() => computeNet({ ...base, deductions: [{ type, amount: 1n, description: 'x', contractRef: 'x' }] })).toThrow(WaterfallError);
    }
  });
  it('rejects deductions the contract does not permit or that are uncited', () => {
    expect(() => computeNet({ ...base, permittedDeductionTypes: [] })).toThrow(/not permitted/);
    expect(() => computeNet({ ...base, deductions: [{ type: 'PAYMENT_PROCESSING_FEE', amount: 1n, description: 'x', contractRef: '' }] })).toThrow(/cite/);
  });
  it('flags negative net for review rather than distributing', () => {
    const r = computeNet({ ...base, refunds: 100_000n });
    expect(r.net).toBeLessThan(0n);
    expect(r.status).toBe('NEGATIVE_REQUIRES_REVIEW');
  });
});
