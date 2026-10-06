import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * One-time codes and keyed hashes (docs/16 §9).
 *
 * The code itself is never stored. A challenge row keeps a random salt and an
 * HMAC of the code. With the server secret the sender derives the same code from
 * the salt at send time, and the verifier checks a typed code against the HMAC.
 * Someone who reads the database without the secret learns neither.
 */

export function newSalt(): Buffer {
  return randomBytes(16);
}

function hmac(secret: string, label: string, ...parts: Array<string | Buffer>): Buffer {
  const h = createHmac('sha256', secret).update(label);
  for (const p of parts) h.update('|').update(p);
  return h.digest();
}

/** The code for a challenge: digits from an HMAC of its id and salt. */
export function deriveOtpCode(secret: string, challengeId: string, salt: Buffer, length: number): string {
  const n = hmac(secret, 'otp-code', challengeId, salt).readBigUInt64BE(0) % 10n ** BigInt(length);
  return n.toString().padStart(length, '0');
}

export function otpCodeHmac(secret: string, challengeId: string, code: string): Buffer {
  return hmac(secret, 'otp-verify', challengeId, code);
}

export function otpCodeMatches(secret: string, challengeId: string, typed: string, stored: Buffer): boolean {
  const given = otpCodeHmac(secret, challengeId, typed.trim());
  return given.length === stored.length && timingSafeEqual(given, stored);
}

export type LinkSignalType = 'device' | 'phone' | 'national_id' | 'payment_source' | 'payout_destination' | 'address' | 'ip_subnet';

/**
 * Keyed hash for identity.link_signal. Every module that writes link signals must
 * use this function and the same secret (LINK_SIGNAL_SECRET), or matches are missed.
 */
export function linkSignalHmac(secret: string, type: LinkSignalType, value: string): Buffer {
  return hmac(secret, 'link-signal', type, value.trim().toLowerCase());
}

/** Keyed hash of a device fingerprint for identity.device. */
export function deviceFingerprintHmac(secret: string, fingerprint: string): Buffer {
  return linkSignalHmac(secret, 'device', fingerprint);
}

function expandIpv6(ip: string): number[] | null {
  const [head, tail] = ip.split('::') as [string, string | undefined];
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((x) => parseInt(x, 16)));
  const h = parse(head);
  const t = tail === undefined ? [] : parse(tail);
  const groups = tail === undefined ? h : [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** The network a request came from: IPv4 /24 or IPv6 /48. Shared subnets link accounts weakly. */
export function ipSubnet(ip: string): string | null {
  let a = ip.trim();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) === 4) return `${a.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(a) === 6) {
    const g = expandIpv6(a.split('%')[0]!);
    return g ? `${g.slice(0, 3).map((x) => x.toString(16)).join(':')}::/48` : null;
  }
  return null;
}
