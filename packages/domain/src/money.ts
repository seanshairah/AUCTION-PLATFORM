/**
 * Money as integer minor units plus an ISO 4217 code (A13).
 * USD and ZWG (ZiG) are kept apart: nothing here converts between them.
 */

export const CURRENCIES = ['USD', 'ZWG'] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface Money {
  readonly currency: Currency;
  readonly minor: bigint;
}

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Cannot combine ${a} and ${b}: amounts in different currencies are never converted silently`);
    this.name = 'CurrencyMismatchError';
  }
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

export function money(currency: Currency, minor: bigint | number): Money {
  const m = typeof minor === 'number' ? BigInt(minor) : minor;
  return { currency, minor: m };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { currency: a.currency, minor: a.minor + b.minor };
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { currency: a.currency, minor: a.minor - b.minor };
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function sum(currency: Currency, amounts: readonly Money[]): Money {
  return amounts.reduce((acc, m) => add(acc, m), money(currency, 0n));
}

/**
 * Applies a rate in basis points (1550 = 15.5 %) and rounds to the minor unit,
 * half away from zero. Integer arithmetic only.
 */
export function applyBasisPoints(minor: bigint, rateBp: number | bigint): bigint {
  const rate = BigInt(rateBp);
  const product = minor * rate;
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs + 5000n) / 10000n;
  return negative ? -rounded : rounded;
}

const SYMBOL: Record<Currency, string> = { USD: 'US$', ZWG: 'ZiG ' };

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Formats minor units for display: US$1,234.50 · ZiG 1,234.50 · −US$3.00 */
export function formatMinor(minor: bigint, currency: Currency): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '−' : ''}${SYMBOL[currency]}${groupThousands(whole.toString())}.${cents}`;
}

export function formatMoney(m: Money): string {
  return formatMinor(m.minor, m.currency);
}

export type ParseResult =
  | { ok: true; minor: bigint }
  | { ok: false; reason: 'empty' | 'not_a_number' | 'too_many_decimals' | 'negative' };

/**
 * Parses what a person types into an amount field ("1,250", "1250.5", "US$ 40")
 * into minor units. Never uses floating point.
 */
export function parseAmountInput(input: string): ParseResult {
  const cleaned = input.replace(/US\$|ZiG|ZWG|USD|\$|,|\s/gi, '');
  if (cleaned === '') return { ok: false, reason: 'empty' };
  if (cleaned.startsWith('-')) return { ok: false, reason: 'negative' };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) return { ok: false, reason: 'not_a_number' };
  const whole = match[1] === '' ? '0' : match[1]!;
  const fraction = match[2] ?? '';
  if (fraction.length > 2) return { ok: false, reason: 'too_many_decimals' };
  return { ok: true, minor: BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0') };
}
