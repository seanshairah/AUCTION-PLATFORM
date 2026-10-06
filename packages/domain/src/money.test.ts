import { describe, expect, it } from 'vitest';
import {
  add,
  applyBasisPoints,
  CurrencyMismatchError,
  formatMinor,
  money,
  parseAmountInput,
  sum,
} from './money';

describe('money arithmetic', () => {
  it('adds amounts in the same currency', () => {
    expect(add(money('USD', 150), money('USD', 250))).toEqual(money('USD', 400));
  });

  it('refuses to combine USD and ZiG', () => {
    expect(() => add(money('USD', 1), money('ZWG', 1))).toThrow(CurrencyMismatchError);
    expect(() => sum('USD', [money('USD', 1), money('ZWG', 1)])).toThrow(CurrencyMismatchError);
  });

  it('applies basis points with half-up rounding to the cent', () => {
    expect(applyBasisPoints(100_000n, 1550)).toBe(15_500n); // 15.5 % of US$1,000.00
    expect(applyBasisPoints(333n, 1500)).toBe(50n);          // 49.95 → 50
    expect(applyBasisPoints(329n, 1500)).toBe(49n);          // 49.35 → 49
    expect(applyBasisPoints(-333n, 1500)).toBe(-50n);        // symmetric for credits
    expect(applyBasisPoints(12_345n, 0)).toBe(0n);
  });
});

describe('formatting', () => {
  it('formats USD and ZiG with the currency always shown', () => {
    expect(formatMinor(123_450n, 'USD')).toBe('US$1,234.50');
    expect(formatMinor(123_450n, 'ZWG')).toBe('ZiG 1,234.50');
    expect(formatMinor(5n, 'USD')).toBe('US$0.05');
    expect(formatMinor(-300n, 'USD')).toBe('−US$3.00');
    expect(formatMinor(100_000_000n, 'USD')).toBe('US$1,000,000.00');
  });
});

describe('parsing typed amounts', () => {
  it.each([
    ['1250', 125_000n],
    ['1,250', 125_000n],
    ['1250.5', 125_050n],
    ['US$ 40', 4_000n],
    ['ZiG 12.05', 1_205n],
    ['.75', 75n],
    ['7.', 700n],
  ])('parses %s', (input, expected) => {
    expect(parseAmountInput(input)).toEqual({ ok: true, minor: expected });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['abc', 'not_a_number'],
    ['1.2.3', 'not_a_number'],
    ['.', 'not_a_number'],
    ['10.999', 'too_many_decimals'],
    ['-5', 'negative'],
  ])('rejects %j as %s', (input, reason) => {
    expect(parseAmountInput(input)).toEqual({ ok: false, reason });
  });
});
