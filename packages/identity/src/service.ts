import { randomUUID } from 'node:crypto';
import { isUniqueViolation, run, type Actor, type Client, type Db, type Queryable, type RulebookStore } from '@abc/db';
import type { RuleSnapshot } from '@abc/rules';
import { maskContact, parseContact, type Contact } from './contact';
import { deriveOtpCode, deviceFingerprintHmac, ipSubnet, linkSignalHmac, newSalt, otpCodeHmac, otpCodeMatches } from './otp';

/**
 * Sign-in by one-time code (docs/16 §9). A code goes to a phone (WhatsApp first,
 * then SMS) or an email address through the communications dispatcher: this
 * service only writes an `otp.requested` outbox event, so identity never calls
 * communications (docs/01 §4.2). Verifying signs in an existing account or creates
 * one; the second verified contact makes it `partial`, as the schema requires.
 */

export const CONTACT_CHANNELS = ['whatsapp', 'sms', 'email', 'push'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export interface IdentityOptions {
  /** Derives and verifies one-time codes (OTP_SECRET). The dispatcher needs the same value. */
  otpSecret: string;
  /** Keyed hashes for link signals, devices and IP addresses (LINK_SIGNAL_SECRET). */
  signalSecret: string;
}

export type OtpPurpose = 'sign_in' | 'add_contact';

export type StartOtpResult =
  | { ok: true; challengeId: string; destinationType: Contact['type']; maskedDestination: string; expiresAt: Date; resendAfter: Date; resent: boolean }
  | { ok: false; reason: 'invalid_contact' | 'not_a_mobile' | 'contact_in_use' | 'account_closed'; retryAfterSeconds?: undefined }
  | { ok: false; reason: 'rate_limited' | 'resend_too_soon'; retryAfterSeconds: number };

export interface DeviceInput {
  fingerprint: string;
  platform: 'android' | 'ios' | 'web' | 'pwa';
  label?: string;
}

export interface SignUpDetails {
  displayName: string;
  /** Legal consent to be contacted on each channel, as ticked on the sign-up form. */
  consent: Partial<Record<ContactChannel, boolean>>;
}

export type VerifyOtpResult =
  | {
      ok: true;
      accountId: string;
      created: boolean;
      purpose: OtpPurpose;
      verificationLevel: 'none' | 'partial' | 'full';
      tier: string;
      deviceId: string | null;
      newDevice: boolean;
    }
  | { ok: false; reason: 'wrong_code'; attemptsLeft: number }
  | { ok: false; reason: 'not_found' | 'expired' | 'used' | 'locked' | 'details_required' | 'contact_in_use' | 'account_closed' | 'not_yours' };

interface ChallengeRow {
  id: string;
  purpose: OtpPurpose;
  destination_type: Contact['type'];
  destination: string;
  account_id: string | null;
  code_salt: Buffer;
  code_hmac: Buffer;
  status: string;
  attempts: number;
  max_attempts: number;
  send_count: number;
  max_sends: number;
  last_sent_at: Date;
  created_at: Date;
  expires_at: Date;
}

interface AccountRow {
  id: string;
  email: string | null;
  phone_e164: string | null;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  verification_level: 'none' | 'partial' | 'full';
  tier: string;
  status: string;
}

const IDENTITY: Actor = { type: 'system', id: 'identity', name: 'Sign-in', reason: 'one-time code' };

async function outbox(c: Client, topic: string, aggregateType: string, aggregateId: string, payload: unknown): Promise<void> {
  await c.query('INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4::jsonb)', [
    topic, aggregateType, aggregateId, JSON.stringify(payload),
  ]);
}

const column = (t: Contact['type']) => (t === 'phone' ? 'phone_e164' : 'email');

export class IdentityService {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    private readonly options: IdentityOptions,
  ) {
    if (!options.otpSecret || !options.signalSecret) throw new Error('IdentityService needs otpSecret and signalSecret');
  }

  private async rules(c: Client, now: Date): Promise<RuleSnapshot> {
    return this.rulebook.snapshot(await this.rulebook.activeVersionId(now, c), c);
  }

  private ipHmac(ip: string | null | undefined): Buffer | null {
    return ip ? linkSignalHmac(this.options.signalSecret, 'ip_subnet', `ip:${ip}`) : null;
  }

  /**
   * Starts (or resends) a one-time code for a phone or email. `add_contact` adds a
   * second contact to the signed-in account. Rate limits and the resend wait come
   * from the rulebook.
   */
  async startOtp(
    p: { contact: string; ip?: string | null; purpose?: OtpPurpose; accountId?: string },
    now: Date = new Date(),
  ): Promise<StartOtpResult> {
    const contact = parseContact(p.contact);
    if (typeof contact === 'string') return { ok: false, reason: contact };
    const purpose = p.purpose ?? 'sign_in';
    if (purpose === 'add_contact' && !p.accountId) throw new Error('add_contact needs the signed-in account');
    const actor: Actor = p.accountId ? { type: 'account', id: p.accountId, name: 'Account holder', reason: 'one-time code' } : IDENTITY;
    const ipHmac = this.ipHmac(p.ip);

    return this.db.tx(actor, async (c): Promise<StartOtpResult> => {
      const rules = await this.rules(c, now);
      const cooldownMs = rules.get('identity.otp_resend_cooldown_seconds') * 1000;

      const owner = await c.query<{ id: string; status: string }>(`SELECT id, status FROM identity.account WHERE ${column(contact.type)} = $1`, [contact.value]);
      const accountId = purpose === 'add_contact' ? p.accountId! : (owner.rows[0]?.id ?? null);
      if (purpose === 'add_contact' && owner.rows[0] && owner.rows[0].id !== p.accountId) return { ok: false, reason: 'contact_in_use' };
      if (purpose === 'sign_in' && owner.rows[0]?.status === 'closed') return { ok: false, reason: 'account_closed' };

      const pending = await c.query<ChallengeRow>(`SELECT * FROM identity.otp_challenge WHERE destination = $1 AND status = 'pending' FOR UPDATE`, [contact.value]);
      const live = pending.rows[0];
      if (live) {
        const sameRequest = live.purpose === purpose && live.account_id === accountId;
        if (live.expires_at <= now) {
          await c.query(`UPDATE identity.otp_challenge SET status = 'expired' WHERE id = $1`, [live.id]);
        } else if (sameRequest && live.send_count < live.max_sends) {
          const resendAt = new Date(live.last_sent_at.getTime() + cooldownMs);
          if (now < resendAt) return { ok: false, reason: 'resend_too_soon', retryAfterSeconds: Math.ceil((resendAt.getTime() - now.getTime()) / 1000) };
          await c.query(`UPDATE identity.otp_challenge SET send_count = send_count + 1, last_sent_at = $2 WHERE id = $1`, [live.id, now]);
          await outbox(c, 'otp.requested', 'otp_challenge', live.id, { challengeId: live.id, send: live.send_count + 1 });
          return {
            ok: true, challengeId: live.id, destinationType: contact.type, maskedDestination: maskContact(contact),
            expiresAt: live.expires_at, resendAfter: new Date(now.getTime() + cooldownMs), resent: true,
          };
        } else {
          // Used up its resends, or a different request for the same contact: a fresh code replaces it.
          await c.query(`UPDATE identity.otp_challenge SET status = 'superseded' WHERE id = $1`, [live.id]);
        }
      }

      const limits = rules.get('identity.otp_rate_limits');
      const retryAfter = async (sql: string, value: unknown, max: number, windowMinutes: number): Promise<number | null> => {
        const since = new Date(now.getTime() - windowMinutes * 60_000);
        const r = await c.query<{ n: bigint; oldest: Date | null }>(sql, [value, since]);
        if (r.rows[0]!.n < BigInt(max)) return null;
        return Math.max(1, Math.ceil((r.rows[0]!.oldest!.getTime() + windowMinutes * 60_000 - now.getTime()) / 1000));
      };
      const byContact = await retryAfter(
        'SELECT count(*) AS n, min(created_at) AS oldest FROM identity.otp_challenge WHERE destination = $1 AND created_at > $2',
        contact.value, limits.perContact.max, limits.perContact.windowMinutes,
      );
      const byIp = ipHmac
        ? await retryAfter(
            'SELECT count(*) AS n, min(created_at) AS oldest FROM identity.otp_challenge WHERE ip_hmac = $1 AND created_at > $2',
            ipHmac, limits.perIp.max, limits.perIp.windowMinutes,
          )
        : null;
      if (byContact !== null || byIp !== null) return { ok: false, reason: 'rate_limited', retryAfterSeconds: Math.max(byContact ?? 0, byIp ?? 0) };

      const id = randomUUID();
      const salt = newSalt();
      const codeLength = rules.get('identity.otp_code_length');
      const code = deriveOtpCode(this.options.otpSecret, id, salt, codeLength);
      const expiresAt = new Date(now.getTime() + rules.get('identity.otp_expiry_seconds') * 1000);
      await c.query(
        `INSERT INTO identity.otp_challenge (id, purpose, destination_type, destination, account_id, code_salt, code_hmac, code_length,
                                             ip_hmac, max_attempts, max_sends, last_sent_at, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13)`,
        [id, purpose, contact.type, contact.value, accountId, salt, otpCodeHmac(this.options.otpSecret, id, code), codeLength, ipHmac,
         rules.get('identity.otp_max_attempts'), rules.get('identity.otp_max_sends'), now, expiresAt],
      );
      await outbox(c, 'otp.requested', 'otp_challenge', id, { challengeId: id, send: 1 });
      return {
        ok: true, challengeId: id, destinationType: contact.type, maskedDestination: maskContact(contact),
        expiresAt, resendAfter: new Date(now.getTime() + cooldownMs), resent: false,
      };
    });
  }

  /**
   * Checks a typed code. A right code for a contact with no account and no sign-up
   * details returns `details_required` without using the code up, so the person can
   * add their name and consent and send the same code again.
   */
  async verifyOtp(
    p: { challengeId: string; code: string; ip?: string | null; device?: DeviceInput; signUp?: SignUpDetails; accountId?: string },
    now: Date = new Date(),
  ): Promise<VerifyOtpResult> {
    if (!/^[0-9a-f-]{36}$/.test(p.challengeId)) return { ok: false, reason: 'not_found' };
    const pre = await this.db.query<{ account_id: string | null }>('SELECT account_id FROM identity.otp_challenge WHERE id = $1', [p.challengeId]);
    if (!pre.rows[0]) return { ok: false, reason: 'not_found' };
    const knownAccount = pre.rows[0].account_id ?? p.accountId;
    const actor: Actor = knownAccount ? { type: 'account', id: knownAccount, name: 'Account holder', reason: 'one-time code' } : IDENTITY;

    return this.db.tx(actor, async (c): Promise<VerifyOtpResult> => {
      const r = await c.query<ChallengeRow>('SELECT * FROM identity.otp_challenge WHERE id = $1 FOR UPDATE', [p.challengeId]);
      const ch = r.rows[0]!;
      if (ch.status === 'verified') return { ok: false, reason: 'used' };
      if (ch.status === 'locked') return { ok: false, reason: 'locked' };
      if (ch.status !== 'pending') return { ok: false, reason: 'expired' };
      if (ch.expires_at <= now) {
        await c.query(`UPDATE identity.otp_challenge SET status = 'expired' WHERE id = $1`, [ch.id]);
        return { ok: false, reason: 'expired' };
      }
      if (ch.purpose === 'add_contact' && ch.account_id !== p.accountId) return { ok: false, reason: 'not_yours' };

      if (!otpCodeMatches(this.options.otpSecret, ch.id, p.code, ch.code_hmac)) {
        const attempts = ch.attempts + 1;
        const locked = attempts >= ch.max_attempts;
        await c.query(`UPDATE identity.otp_challenge SET attempts = $2, status = $3 WHERE id = $1`, [ch.id, attempts, locked ? 'locked' : 'pending']);
        return locked ? { ok: false, reason: 'locked' } : { ok: false, reason: 'wrong_code', attemptsLeft: ch.max_attempts - attempts };
      }

      const col = column(ch.destination_type);
      const verifiedCol = ch.destination_type === 'phone' ? 'phone_verified_at' : 'email_verified_at';
      let account: AccountRow | undefined;
      let created = false;
      if (ch.purpose === 'add_contact') {
        const other = await c.query(`SELECT 1 FROM identity.account WHERE ${col} = $1 AND id <> $2`, [ch.destination, ch.account_id]);
        if (other.rowCount) return { ok: false, reason: 'contact_in_use' };
        account = (await c.query<AccountRow>(`UPDATE identity.account SET ${col} = $2, ${verifiedCol} = $3 WHERE id = $1 RETURNING *`, [ch.account_id, ch.destination, now])).rows[0];
      } else {
        account = (await c.query<AccountRow>(`SELECT * FROM identity.account WHERE ${col} = $1 FOR UPDATE`, [ch.destination])).rows[0];
        if (account?.status === 'closed') return { ok: false, reason: 'account_closed' };
        if (!account) {
          const name = p.signUp?.displayName.trim();
          if (!p.signUp || !name) return { ok: false, reason: 'details_required' };
          try {
            await c.query('SAVEPOINT create_account');
            account = (await c.query<AccountRow>(
              `INSERT INTO identity.account (${col}, ${verifiedCol}, display_name) VALUES ($1, $2, $3) RETURNING *`,
              [ch.destination, now, name.slice(0, 120)],
            )).rows[0]!;
          } catch (e) {
            if (isUniqueViolation(e)) {
              await c.query('ROLLBACK TO SAVEPOINT create_account');
              return { ok: false, reason: 'contact_in_use' };
            }
            throw e;
          }
          created = true;
          for (const channel of CONTACT_CHANNELS) {
            await c.query(
              `INSERT INTO identity.contact_consent (account_id, channel, granted, source, recorded_at) VALUES ($1, $2, $3, 'signup_form', $4)`,
              [account.id, channel, p.signUp.consent[channel] === true, now],
            );
          }
          await outbox(c, 'account.created', 'account', account.id, { via: ch.destination_type });
        } else if (account[verifiedCol] === null) {
          account = (await c.query<AccountRow>(`UPDATE identity.account SET ${verifiedCol} = $2 WHERE id = $1 RETURNING *`, [account.id, now])).rows[0]!;
        }
      }
      if (!account) return { ok: false, reason: 'not_found' };

      // partial = email and phone both verified (the schema's CHECK); a Guest becomes Verified.
      if (account.verification_level === 'none' && account.email_verified_at && account.phone_verified_at) {
        account = (await c.query<AccountRow>(
          `UPDATE identity.account SET verification_level = 'partial', tier = CASE WHEN tier = 'guest' THEN 'verified' ELSE tier END
            WHERE id = $1 RETURNING *`,
          [account.id],
        )).rows[0]!;
        await outbox(c, 'account.verified', 'account', account.id, { level: 'partial' });
      }

      await c.query(`UPDATE identity.otp_challenge SET status = 'verified', verified_at = $2, account_id = $3 WHERE id = $1`, [ch.id, now, account.id]);
      const device = await this.recordSignals(c, account, p.ip ?? null, p.device ?? null, now);
      return {
        ok: true, accountId: account.id, created, purpose: ch.purpose,
        verificationLevel: account.verification_level, tier: account.tier, deviceId: device?.id ?? null, newDevice: device?.inserted ?? false,
      };
    });
  }

  /** Link signals (verified phone, device, network) for the seller-link bar, and the device list. */
  private async recordSignals(c: Client, account: AccountRow, ip: string | null, device: DeviceInput | null, now: Date): Promise<{ id: string; inserted: boolean } | null> {
    const secret = this.options.signalSecret;
    const signals: Array<[string, Buffer]> = [];
    if (account.phone_e164 && account.phone_verified_at) signals.push(['phone', linkSignalHmac(secret, 'phone', account.phone_e164)]);
    const subnet = ip ? ipSubnet(ip) : null;
    if (subnet) signals.push(['ip_subnet', linkSignalHmac(secret, 'ip_subnet', subnet)]);
    let registered: { id: string; inserted: boolean } | null = null;
    if (device && device.fingerprint.trim().length >= 8) {
      const fp = deviceFingerprintHmac(secret, device.fingerprint);
      signals.push(['device', fp]);
      const d = await c.query<{ id: string; inserted: boolean }>(
        `INSERT INTO identity.device (account_id, fingerprint_hmac, label, platform, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (account_id, fingerprint_hmac) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, revoked_at = NULL
         RETURNING id, (xmax = 0) AS inserted`,
        [account.id, fp, device.label?.slice(0, 80) ?? null, device.platform, now],
      );
      registered = d.rows[0]!;
    }
    for (const [type, value] of signals) {
      await c.query(
        `INSERT INTO identity.link_signal (account_id, signal_type, signal_hmac, first_seen_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [account.id, type, value, now],
      );
    }
    return registered;
  }

  /** Records a change of legal contact consent on one channel (for example a WhatsApp opt-out). */
  async recordConsent(actor: Actor, accountId: string, channel: ContactChannel, granted: boolean, source: string): Promise<void> {
    await this.db.tx(actor, (c) =>
      c.query(
        `INSERT INTO identity.contact_consent (account_id, channel, granted, source) VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id, channel) DO UPDATE SET granted = EXCLUDED.granted, source = EXCLUDED.source, recorded_at = clock_timestamp()`,
        [accountId, channel, granted, source],
      ),
    );
  }
}

/**
 * The sender's side: re-derives a pending challenge's code at the moment it is
 * sent, so the code is never written to the outbox or the message log.
 */
export class OtpCodeSource {
  constructor(private readonly otpSecret: string) {}

  async codeFor(q: Queryable, challengeId: string, now: Date): Promise<{ code: string; minutes: number } | null> {
    const r = await run<{ code_salt: Buffer; code_length: number; status: string; expires_at: Date }>(
      q, 'SELECT code_salt, code_length, status, expires_at FROM identity.otp_challenge WHERE id = $1', [challengeId],
    );
    const ch = r.rows[0];
    if (!ch || ch.status !== 'pending' || ch.expires_at <= now) return null;
    return {
      code: deriveOtpCode(this.otpSecret, challengeId, ch.code_salt, ch.code_length),
      minutes: Math.max(1, Math.ceil((ch.expires_at.getTime() - now.getTime()) / 60_000)),
    };
  }
}
