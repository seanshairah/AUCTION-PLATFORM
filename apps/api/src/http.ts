import { formatMinor, type Currency } from '@abc/domain';

/**
 * Wire format. Money always travels as integer minor units in a string (JSON has
 * no safe 64-bit integer) next to its currency and the text the screen shows, so
 * no client ever formats or rounds money itself.
 */
export interface MoneyJson {
  minor: string;
  currency: Currency;
  text: string;
}

export function moneyJson(minor: bigint, currency: Currency): MoneyJson {
  return { minor: minor.toString(), currency, text: formatMinor(minor, currency) };
}

export function maybeMoney(minor: bigint | null | undefined, currency: Currency): MoneyJson | null {
  return minor === null || minor === undefined ? null : moneyJson(minor, currency);
}

/** JSON replacer for anything else that carries a bigint (sequence numbers). */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Parses a minor-unit amount sent by a client: digits only, as a string. */
export function parseMinor(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  return BigInt(value);
}
