/**
 * Money is always an integer count of minor units (e.g. cents) held in a bigint,
 * paired with an ISO-4217 currency code. Binary floating point is never used.
 */
export interface Money {
  readonly amount: bigint;
  readonly currency: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
/** Minor-unit exponent per currency. Extend deliberately; unknown currencies are rejected. */
export const CURRENCY_EXPONENT: Readonly<Record<string, number>> = { USD: 2, CAD: 2, EUR: 2, GBP: 2, JPY: 0 };

export class MoneyError extends Error {
  override name = 'MoneyError';
}

export function money(amount: bigint, currency: string): Money {
  if (typeof amount !== 'bigint') throw new MoneyError('amount must be a bigint of minor units');
  assertCurrency(currency);
  return { amount, currency };
}

export function assertCurrency(currency: string): void {
  if (!CURRENCY_RE.test(currency) || CURRENCY_EXPONENT[currency] === undefined) {
    throw new MoneyError(`unsupported currency: ${currency}`);
  }
}

export function assertSameCurrency(...values: Money[]): string {
  const first = values[0];
  if (!first) throw new MoneyError('no values');
  for (const v of values) if (v.currency !== first.currency) throw new MoneyError(`currency mismatch: ${first.currency} vs ${v.currency}`);
  return first.currency;
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount - b.amount, currency: a.currency };
}

export function sum(values: Money[], currency: string): Money {
  assertCurrency(currency);
  let total = 0n;
  for (const v of values) {
    if (v.currency !== currency) throw new MoneyError(`currency mismatch: ${currency} vs ${v.currency}`);
    total += v.amount;
  }
  return { amount: total, currency };
}

/** Parse a decimal string such as "1234.56" into minor units. Rejects excess precision instead of rounding. */
export function parseDecimal(value: string, currency: string): Money {
  assertCurrency(currency);
  const exp = CURRENCY_EXPONENT[currency]!;
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new MoneyError(`invalid decimal amount: ${value}`);
  const [, neg, whole, frac = ''] = m;
  if (frac.length > exp) throw new MoneyError(`amount ${value} has more precision than ${currency} allows`);
  const minor = BigInt(whole! + frac.padEnd(exp, '0'));
  return { amount: neg ? -minor : minor, currency };
}

export function formatDecimal(m: Money): string {
  const exp = CURRENCY_EXPONENT[m.currency]!;
  const neg = m.amount < 0n;
  const abs = (neg ? -m.amount : m.amount).toString().padStart(exp + 1, '0');
  const whole = exp === 0 ? abs : abs.slice(0, -exp);
  const frac = exp === 0 ? '' : '.' + abs.slice(-exp);
  return `${neg ? '-' : ''}${whole}${frac}`;
}
