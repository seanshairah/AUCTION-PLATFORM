import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccount, createTestDatabase, DB_TESTS_ENABLED, loadPublishedRuleSetForTests, readRuleSetDocument, RulebookStore, SYSTEM, type TestDatabase } from '@abc/db';
import { isLinkedToSellerOfLot } from '@abc/limits';
import {
  deriveOtpCode,
  IdentityService,
  ipSubnet,
  linkSignalHmac,
  maskContact,
  normalisePhone,
  OtpCodeSource,
  otpCodeHmac,
  otpCodeMatches,
  parseContact,
} from './index';

const OTP_SECRET = 'test-otp-secret-0123456789abcdef';
const SIGNAL_SECRET = 'test-signal-secret-0123456789abcd';

describe('contacts', () => {
  it('normalises Zimbabwe numbers however they are typed', () => {
    for (const typed of ['0771234567', '077 123 4567', '771234567', '263771234567', '+263 77 123 4567', '+263 077 123 4567', '00263771234567', '(077) 123-4567']) {
      expect(normalisePhone(typed), typed).toBe('+263771234567');
    }
    expect(normalisePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('07712345678')).toBeNull();
  });

  it('accepts mobiles and emails for sign-in, refuses landlines', () => {
    expect(parseContact(' Farai@Example.TEST ')).toEqual({ type: 'email', value: 'farai@example.test' });
    expect(parseContact('0712 345 678')).toEqual({ type: 'phone', value: '+263712345678' });
    expect(parseContact('0242 123456')).toBe('not_a_mobile');
    expect(parseContact('not an email@')).toBe('invalid_contact');
    expect(maskContact({ type: 'phone', value: '+263771234567' })).toBe('+26377••••567');
    expect(maskContact({ type: 'email', value: 'farai@example.test' })).toBe('f•••@example.test');
  });
});

describe('one-time codes and keyed hashes', () => {
  it('derives the same code from the salt, and verifies only the right one', () => {
    const salt = Buffer.alloc(16, 7);
    const code = deriveOtpCode(OTP_SECRET, 'c1', salt, 6);
    expect(code).toMatch(/^\d{6}$/);
    expect(deriveOtpCode(OTP_SECRET, 'c1', salt, 6)).toBe(code);
    expect(deriveOtpCode('other-secret', 'c1', salt, 6)).not.toBe(code);
    const stored = otpCodeHmac(OTP_SECRET, 'c1', code);
    expect(otpCodeMatches(OTP_SECRET, 'c1', ` ${code} `, stored)).toBe(true);
    expect(otpCodeMatches(OTP_SECRET, 'c2', code, stored)).toBe(false);
    expect(otpCodeMatches(OTP_SECRET, 'c1', '000000' === code ? '111111' : '000000', stored)).toBe(false);
  });

  it('reduces addresses to their network', () => {
    expect(ipSubnet('196.43.12.200')).toBe('196.43.12.0/24');
    expect(ipSubnet('::ffff:196.43.12.200')).toBe('196.43.12.0/24');
    expect(ipSubnet('2c0f:f8f0:1:2::7')).toBe('2c0f:f8f0:1::/48');
    expect(ipSubnet('nonsense')).toBeNull();
    expect(linkSignalHmac('k', 'phone', '+263771234567').equals(linkSignalHmac('k', 'phone', ' +263771234567'))).toBe(true);
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('sign-in by one-time code against PostgreSQL', () => {
  let t: TestDatabase;
  let identity: IdentityService;
  let codes: OtpCodeSource;
  const T0 = new Date('2026-11-20T10:00:00Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

  async function codeOf(challengeId: string, now = T0): Promise<string> {
    return (await codes.codeFor(t.db, challengeId, now))!.code;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    await loadPublishedRuleSetForTests(t.db, readRuleSetDocument());
    identity = new IdentityService(t.db, new RulebookStore(t.db), { otpSecret: OTP_SECRET, signalSecret: SIGNAL_SECRET });
    codes = new OtpCodeSource(OTP_SECRET);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('stores only a salt and an HMAC, and asks the dispatcher to send the code', async () => {
    const r = await identity.startOtp({ contact: '0771 000 001', ip: '196.43.12.9' }, T0);
    expect(r).toMatchObject({ ok: true, destinationType: 'phone', resent: false });
    if (!r.ok) throw new Error('start failed');
    expect(r.expiresAt.toISOString()).toBe(at(600).toISOString());
    const row = await t.db.query<{ destination: string; code_hmac: Buffer; code_salt: Buffer; code_length: number }>('SELECT destination, code_hmac, code_salt, code_length FROM identity.otp_challenge WHERE id = $1', [r.challengeId]);
    expect(row.rows[0]).toMatchObject({ destination: '+263771000001', code_length: 6 });
    const code = await codeOf(r.challengeId);
    const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    const dump = JSON.stringify((await t.db.query('SELECT * FROM identity.otp_challenge')).rows, big) + JSON.stringify((await t.db.query('SELECT * FROM core.outbox')).rows, big);
    expect(dump).not.toContain(code);
    const ob = await t.db.query<{ topic: string; payload: unknown }>(`SELECT topic, payload FROM core.outbox WHERE aggregate_id = $1`, [r.challengeId]);
    expect(ob.rows).toEqual([{ topic: 'otp.requested', payload: { challengeId: r.challengeId, send: 1 } }]);
  });

  it('a new phone needs a name and consent; the right code without them is not used up', async () => {
    const r = await identity.startOtp({ contact: '+263771000002' }, T0);
    if (!r.ok) throw new Error('start failed');
    const code = await codeOf(r.challengeId);
    expect(await identity.verifyOtp({ challengeId: r.challengeId, code }, at(10))).toEqual({ ok: false, reason: 'details_required' });
    const ok = await identity.verifyOtp(
      { challengeId: r.challengeId, code, ip: '196.43.12.10', device: { fingerprint: 'device-fp-0002-abcdef', platform: 'android', label: 'Tecno Spark' },
        signUp: { displayName: 'Rudo K.', consent: { whatsapp: true, sms: true, email: false } } },
      at(20),
    );
    expect(ok).toMatchObject({ ok: true, created: true, verificationLevel: 'none', tier: 'guest', newDevice: true });
    if (!ok.ok) throw new Error('verify failed');
    const consent = await t.db.query<{ channel: string; granted: boolean; source: string }>('SELECT channel, granted, source FROM identity.contact_consent WHERE account_id = $1 ORDER BY channel', [ok.accountId]);
    expect(consent.rows).toEqual([
      { channel: 'email', granted: false, source: 'signup_form' },
      { channel: 'push', granted: false, source: 'signup_form' },
      { channel: 'sms', granted: true, source: 'signup_form' },
      { channel: 'whatsapp', granted: true, source: 'signup_form' },
    ]);
    const signals = await t.db.query<{ signal_type: string }>('SELECT signal_type FROM identity.link_signal WHERE account_id = $1 ORDER BY signal_type', [ok.accountId]);
    expect(signals.rows.map((s) => s.signal_type)).toEqual(['device', 'ip_subnet', 'phone']);
    expect(await identity.verifyOtp({ challengeId: r.challengeId, code }, at(30))).toEqual({ ok: false, reason: 'used' });

    // Adding a verified email makes the account partial (both OTPs) and Verified.
    const e = await identity.startOtp({ contact: 'rudo@example.test', purpose: 'add_contact', accountId: ok.accountId }, at(40));
    if (!e.ok) throw new Error('start failed');
    expect(await identity.verifyOtp({ challengeId: e.challengeId, code: await codeOf(e.challengeId, at(40)) }, at(50))).toEqual({ ok: false, reason: 'not_yours' });
    const linked = await identity.verifyOtp({ challengeId: e.challengeId, code: await codeOf(e.challengeId, at(40)), accountId: ok.accountId }, at(60));
    expect(linked).toMatchObject({ ok: true, created: false, verificationLevel: 'partial', tier: 'verified', purpose: 'add_contact' });
    const audit = await t.db.query<{ actor_type: string; to_state: string }>(
      `SELECT actor_type, to_state FROM audit.event WHERE entity_type = 'identity.account' AND entity_id = $1 AND action = 'verification_level_change'`, [ok.accountId],
    );
    expect(audit.rows).toEqual([{ actor_type: 'account', to_state: 'partial' }]);

    // Signing in again by email finds the same account; the device is not new.
    const again = await identity.startOtp({ contact: 'RUDO@example.test' }, at(100));
    if (!again.ok) throw new Error('start failed');
    expect(await identity.verifyOtp({ challengeId: again.challengeId, code: await codeOf(again.challengeId, at(100)), device: { fingerprint: 'device-fp-0002-abcdef', platform: 'android' } }, at(110)))
      .toMatchObject({ ok: true, accountId: ok.accountId, created: false, newDevice: false });
  });

  it('wrong codes count down, then the code locks', async () => {
    const r = await identity.startOtp({ contact: '+263771000003' }, T0);
    if (!r.ok) throw new Error('start failed');
    const code = await codeOf(r.challengeId);
    const wrong = code === '123456' ? '654321' : '123456';
    expect(await identity.verifyOtp({ challengeId: r.challengeId, code: wrong }, at(5))).toEqual({ ok: false, reason: 'wrong_code', attemptsLeft: 4 });
    for (let i = 0; i < 3; i++) await identity.verifyOtp({ challengeId: r.challengeId, code: wrong }, at(6 + i));
    expect(await identity.verifyOtp({ challengeId: r.challengeId, code: wrong }, at(10))).toEqual({ ok: false, reason: 'locked' });
    expect(await identity.verifyOtp({ challengeId: r.challengeId, code }, at(11))).toEqual({ ok: false, reason: 'locked' });
  });

  it('codes expire; resends wait for the cooldown and reuse the same code', async () => {
    const r = await identity.startOtp({ contact: '+263771000004' }, T0);
    if (!r.ok) throw new Error('start failed');
    expect(await identity.startOtp({ contact: '0771000004' }, at(30))).toEqual({ ok: false, reason: 'resend_too_soon', retryAfterSeconds: 30 });
    const resent = await identity.startOtp({ contact: '0771000004' }, at(61));
    expect(resent).toMatchObject({ ok: true, resent: true, challengeId: r.challengeId });
    expect(await codeOf(r.challengeId, at(61))).toBe(await codeOf(r.challengeId));
    const sends = await t.db.query<{ payload: { send: number } }>(`SELECT payload FROM core.outbox WHERE aggregate_id = $1 ORDER BY id`, [r.challengeId]);
    expect(sends.rows.map((x) => x.payload.send)).toEqual([1, 2]);
    expect(await identity.verifyOtp({ challengeId: r.challengeId, code: await codeOf(r.challengeId) }, at(601))).toEqual({ ok: false, reason: 'expired' });
    expect(await codes.codeFor(t.db, r.challengeId, at(601))).toBeNull();
  });

  it('rate-limits new codes per contact and per network', async () => {
    let last;
    for (let i = 0; i < 6; i++) {
      // Each start after the first max_sends replaces the challenge; spacing past the cooldown.
      last = await identity.startOtp({ contact: '+263771000005', ip: '41.57.100.1' }, at(i * 100));
      if (last.ok) await t.db.tx(SYSTEM, (c) => c.query(`UPDATE identity.otp_challenge SET status = 'superseded' WHERE id = $1`, [last!.ok ? last!.challengeId : '']));
    }
    expect(last).toMatchObject({ ok: false, reason: 'rate_limited' });
    let ipLimited;
    for (let i = 0; i < 21; i++) ipLimited = await identity.startOtp({ contact: `+2637720000${String(i).padStart(2, '0')}`, ip: '41.57.200.1' }, at(i));
    expect(ipLimited).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('sign-in link signals feed the seller-link bar in bidding', async () => {
    // A seller and a "new" bidder sign in from the same device.
    const seller = await createAccount(t.db, { name: 'Seller' });
    const sellerPhone = (await t.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM identity.account WHERE id = $1', [seller])).rows[0]!.phone_e164;
    const s = await identity.startOtp({ contact: sellerPhone }, T0);
    if (!s.ok) throw new Error('start failed');
    await identity.verifyOtp({ challengeId: s.challengeId, code: await codeOf(s.challengeId), device: { fingerprint: 'shared-phone-fingerprint', platform: 'android' } }, at(5));
    const b = await identity.startOtp({ contact: '+263771000009' }, T0);
    if (!b.ok) throw new Error('start failed');
    const bidder = await identity.verifyOtp(
      { challengeId: b.challengeId, code: await codeOf(b.challengeId), device: { fingerprint: 'shared-phone-fingerprint', platform: 'android' }, signUp: { displayName: 'Shill', consent: {} } },
      at(5),
    );
    if (!bidder.ok) throw new Error('verify failed');
    const consignment = await t.db.tx(SYSTEM, async (c) => {
      const k = await c.query<{ id: string }>(`INSERT INTO seller.consignment (seller_account_id, consignment_type, intake_channel) VALUES ($1, 'commission', 'branch') RETURNING id`, [seller]);
      const l = await c.query<{ id: string }>(
        `INSERT INTO catalogue.lot (lot_ref, consignment_id, seller_account_id, category_code, is_vehicle, title, description, item_state, condition, location_branch, settlement_currency, tax_class, starting_bid_minor)
         VALUES ('HRE-LINK-1', $1, $2, 'it', false, 'Laptop', 'A laptop for the link test.', 'used', 'working', 'HRE', 'USD', 'goods_standard', 1000) RETURNING id`,
        [k.rows[0]!.id, seller],
      );
      return l.rows[0]!.id;
    });
    expect(await isLinkedToSellerOfLot(t.db, bidder.accountId, consignment)).toBe(true);
  });

  it('the database refuses to change a finished challenge or its terms', async () => {
    const r = await identity.startOtp({ contact: '+263771000010' }, T0);
    if (!r.ok) throw new Error('start failed');
    await expect(t.db.tx(SYSTEM, (c) => c.query(`UPDATE identity.otp_challenge SET expires_at = expires_at + interval '1 hour' WHERE id = $1`, [r.challengeId]))).rejects.toThrow(/immutable/);
    await expect(t.db.tx(SYSTEM, (c) => c.query(`UPDATE identity.otp_challenge SET attempts = 99 WHERE id = $1`, [r.challengeId]))).rejects.toThrow(/check constraint/);
    await identity.verifyOtp({ challengeId: r.challengeId, code: await codeOf(r.challengeId), signUp: { displayName: 'X', consent: {} } }, at(1));
    await expect(t.db.tx(SYSTEM, (c) => c.query(`UPDATE identity.otp_challenge SET status = 'pending', verified_at = NULL WHERE id = $1`, [r.challengeId]))).rejects.toThrow(/cannot change/);
  });
});
