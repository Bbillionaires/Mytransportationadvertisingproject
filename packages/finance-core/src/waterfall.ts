/**
 * Net revenue waterfall. Splits are computed on the NET distributable amount:
 *   gross receipts
 *   - taxes collected on behalf of governments (a liability, never revenue)
 *   - refunds, credits, chargebacks, reversals
 *   - contractually permitted & disclosed deductions (processing fees, defined direct campaign costs)
 *   = net distributable
 * Corporate or personal income taxes and general overhead are NEVER deductible here.
 */
import { MoneyError } from './money.js';

export const DEDUCTION_TYPES = ['PAYMENT_PROCESSING_FEE', 'DIRECT_CAMPAIGN_COST'] as const;
export type DeductionType = (typeof DEDUCTION_TYPES)[number];

/** Deduction kinds that are prohibited by policy regardless of contract. */
export const PROHIBITED_DEDUCTIONS = ['CORPORATE_INCOME_TAX', 'PERSONAL_INCOME_TAX', 'GENERAL_OVERHEAD'] as const;

export interface Deduction {
  readonly type: string;
  readonly amount: bigint;
  readonly description: string;
  readonly contractRef: string; // the clause/version that permits it
}

export interface WaterfallInput {
  readonly currency: string;
  readonly grossReceipts: bigint;
  readonly taxCollected: bigint;
  readonly refunds: bigint;
  readonly credits: bigint;
  readonly chargebacks: bigint;
  readonly deductions: readonly Deduction[];
  /** Deduction types the governing contract version permits. */
  readonly permittedDeductionTypes: readonly DeductionType[];
}

export type WaterfallStatus = 'DISTRIBUTABLE' | 'ZERO' | 'NEGATIVE_REQUIRES_REVIEW';

export interface WaterfallResult {
  readonly currency: string;
  readonly grossReceipts: bigint;
  readonly taxExcluded: bigint;
  readonly adjustments: { refunds: bigint; credits: bigint; chargebacks: bigint };
  readonly deductions: readonly Deduction[];
  readonly totalDeductions: bigint;
  readonly net: bigint;
  readonly status: WaterfallStatus;
}

export class WaterfallError extends Error {
  override name = 'WaterfallError';
}

export function computeNet(input: WaterfallInput): WaterfallResult {
  const nonNeg: Array<[string, bigint]> = [
    ['grossReceipts', input.grossReceipts],
    ['taxCollected', input.taxCollected],
    ['refunds', input.refunds],
    ['credits', input.credits],
    ['chargebacks', input.chargebacks],
  ];
  for (const [k, v] of nonNeg) {
    if (typeof v !== 'bigint') throw new MoneyError(`${k} must be bigint minor units`);
    if (v < 0n) throw new WaterfallError(`${k} must be >= 0 (sign is implied by the waterfall step)`);
  }
  if (input.taxCollected > input.grossReceipts) throw new WaterfallError('tax collected exceeds gross receipts');
  let totalDeductions = 0n;
  for (const d of input.deductions) {
    if ((PROHIBITED_DEDUCTIONS as readonly string[]).includes(d.type)) {
      throw new WaterfallError(`deduction type ${d.type} is prohibited from distributable pools`);
    }
    if (!(input.permittedDeductionTypes as readonly string[]).includes(d.type)) {
      throw new WaterfallError(`deduction type ${d.type} is not permitted by the governing contract`);
    }
    if (d.amount < 0n) throw new WaterfallError('deduction amounts must be >= 0');
    if (!d.contractRef) throw new WaterfallError('each deduction must cite the contract clause that permits it');
    totalDeductions += d.amount;
  }
  const net = input.grossReceipts - input.taxCollected - input.refunds - input.credits - input.chargebacks - totalDeductions;
  return {
    currency: input.currency,
    grossReceipts: input.grossReceipts,
    taxExcluded: input.taxCollected,
    adjustments: { refunds: input.refunds, credits: input.credits, chargebacks: input.chargebacks },
    deductions: input.deductions,
    totalDeductions,
    net,
    status: net > 0n ? 'DISTRIBUTABLE' : net === 0n ? 'ZERO' : 'NEGATIVE_REQUIRES_REVIEW',
  };
}
