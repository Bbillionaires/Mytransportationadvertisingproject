import { describe, expect, it } from 'vitest';
import { add, formatDecimal, money, MoneyError, parseDecimal, sum } from '../src/index.js';

describe('money', () => {
  it('parses and formats exact decimals', () => {
    expect(parseDecimal('1234.56', 'USD').amount).toBe(123456n);
    expect(parseDecimal('-0.07', 'USD').amount).toBe(-7n);
    expect(parseDecimal('500', 'JPY').amount).toBe(500n);
    expect(formatDecimal(money(123456n, 'USD'))).toBe('1234.56');
    expect(formatDecimal(money(-7n, 'USD'))).toBe('-0.07');
    expect(formatDecimal(money(5n, 'JPY'))).toBe('5');
  });
  it('rejects excess precision instead of rounding', () => {
    expect(() => parseDecimal('1.005', 'USD')).toThrow(MoneyError);
    expect(() => parseDecimal('1e3', 'USD')).toThrow(MoneyError);
  });
  it('rejects currency mixing and floats', () => {
    expect(() => add(money(1n, 'USD'), money(1n, 'CAD'))).toThrow(MoneyError);
    expect(() => sum([money(1n, 'USD')], 'EUR')).toThrow(MoneyError);
    // @ts-expect-error number is not allowed
    expect(() => money(1.5, 'USD')).toThrow(MoneyError);
    expect(() => money(1n, 'usd')).toThrow(MoneyError);
  });
  it('0.1 + 0.2 is exactly 0.3', () => {
    expect(formatDecimal(add(parseDecimal('0.10', 'USD'), parseDecimal('0.20', 'USD')))).toBe('0.30');
  });
});
