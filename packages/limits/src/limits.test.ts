import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccount,
  createAuction,
  createTestDatabase,
  DB_TESTS_ENABLED,
  loadPublishedRuleSetForTests,
  readRuleSetDocument,
  RulebookStore,
  SYSTEM,
  type TestDatabase,
} from '@abc/db';
import { postJournal, topUp, wallet } from '@abc/ledger';
import { RuleSnapshot } from '@abc/rules';
import { capacity, computeLimit, decideRegistration, exposure, RegistrationService, type LimitInput } from './index';

const DOC = readRuleSetDocument();
const snapshot = new RuleSnapshot('v', DOC.label, DOC.rules);

const base: LimitInput = {
  snapshot,
  currency: 'USD',
  tier: 'verified',
  verificationLevel: 'partial',
  accountStatus: 'active',
  depositRequired: false,
  heldDepositMinor: 0n,
  paidInFull12mMinor: 0n,
};

describe('limit formula: the worked examples in docs/02 §6.3', () => {
  it('1: partial verification, no deposit → US$100', () => {
    expect(computeLimit(base).limitMinor).toBe(10_000n);
  });

  it('2: full verification, US$30 deposit → US$500 (the larger of free allowance and deposit × 10)', () => {
    expect(computeLimit({ ...base, verificationLevel: 'full', heldDepositMinor: 3_000n }).limitMinor).toBe(50_000n);
  });

  it('3: full verification, US$200 deposit, deposit auction → US$2,000 (no free allowance)', () => {
    expect(computeLimit({ ...base, verificationLevel: 'full', heldDepositMinor: 20_000n, depositRequired: true }).limitMinor).toBe(200_000n);
  });

  it('4: Trusted, US$500 deposit, US$8,000 paid in 12 months → US$7,000', () => {
    const r = computeLimit({ ...base, tier: 'trusted', verificationLevel: 'full', heldDepositMinor: 50_000n, paidInFull12mMinor: 800_000n });
    expect(r.limitMinor).toBe(700_000n);
    expect(r.parts).toMatchObject({ depositComponentMinor: 500_000n, upliftMinor: 200_000n });
  });

  it('the Trusted history bonus is capped at US$5,000', () => {
    const r = computeLimit({ ...base, tier: 'trusted', verificationLevel: 'full', paidInFull12mMinor: 100_000_000n });
    expect(r.parts.upliftMinor).toBe(500_000n);
  });

  it('5: Restricted, US$300 deposit → US$300 (multiplier 1, no free allowance)', () => {
    expect(computeLimit({ ...base, tier: 'restricted', heldDepositMinor: 30_000n }).limitMinor).toBe(30_000n);
  });

  it('6: ZiG with no ZiG deposit → nothing until finance sets a ZiG allowance', () => {
    const r = computeLimit({ ...base, currency: 'ZWG' });
    expect(r.limitMinor).toBe(0n);
    expect(r.notes[0]).toContain('not set yet');
  });

  it('guests and inactive accounts cannot bid; a staff override replaces the formula', () => {
    expect(computeLimit({ ...base, tier: 'guest', verificationLevel: 'none' }).limitMinor).toBe(0n);
    expect(computeLimit({ ...base, accountStatus: 'suspended' }).limitMinor).toBe(0n);
    expect(computeLimit({ ...base, overrideMinor: 123_400n })).toMatchObject({ limitMinor: 123_400n, basis: 'override' });
  });
});

describe('exposure and capacity', () => {
  const leading = [
    { auctionLotId: 'a', allInAtMaxMinor: 39_450n, allInAtCurrentMinor: 13_050n },
    { auctionLotId: 'b', allInAtMaxMinor: 10_000n, allInAtCurrentMinor: 5_000n },
  ];

  it('counts leading lots at the maximum, all-in, plus unpaid invoices (A21)', () => {
    expect(exposure(snapshot, leading, 2_000n)).toBe(51_450n);
  });

  it('leaves out the lot being bid on, because the new maximum replaces it', () => {
    expect(exposure(snapshot, leading, 0n, 'a')).toBe(10_000n);
  });

  it('example from docs/02: US$500 limit, US$394.50 exposure → US$105.50 room', () => {
    expect(capacity(50_000n, 39_450n)).toBe(10_550n);
    expect(capacity(10_000n, 39_450n)).toBe(0n);
  });
});

describe('registration decision: one tap unless flagged', () => {
  const reg = {
    snapshot,
    tier: 'verified' as const,
    verificationLevel: 'partial' as const,
    accountStatus: 'active' as const,
    depositRequired: false,
    minimumDeposit: {},
    depositOffered: {},
    linkedToSeller: false,
    openRiskFlag: false,
    kycPending: false,
  };

  it('approves a verified account in good standing straight away', () => {
    expect(decideRegistration(reg)).toEqual({ status: 'approved', reasons: [] });
  });

  it('sends flagged accounts to the review queue with their reasons', () => {
    expect(decideRegistration({ ...reg, tier: 'restricted', linkedToSeller: true })).toEqual({
      status: 'pending_review',
      reasons: ['tier_restricted', 'linked_to_seller'],
    });
  });

  it('refuses unverified accounts and deposit auctions without the minimum deposit', () => {
    expect(decideRegistration({ ...reg, tier: 'guest', verificationLevel: 'none' })).toMatchObject({ status: 'rejected', reasons: ['not_verified'] });
    expect(decideRegistration({ ...reg, depositRequired: true, minimumDeposit: { USD: 50_000n }, depositOffered: { USD: 10_000n } })).toMatchObject({
      status: 'rejected',
      reasons: ['deposit_needed'],
    });
    expect(decideRegistration({ ...reg, depositRequired: true, minimumDeposit: { USD: 50_000n }, depositOffered: { USD: 50_000n } }).status).toBe('approved');
  });

  it('refuses a deposit auction whose minimum deposit is not configured in that currency', () => {
    expect(decideRegistration({ ...reg, depositRequired: true, minimumDeposit: { ZWG: null }, depositOffered: { ZWG: 1_000n } })).toMatchObject({
      reasons: ['deposit_not_configured'],
    });
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('registration service against PostgreSQL', () => {
  let t: TestDatabase;
  let service: RegistrationService;
  let staff: string;
  let seller: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true });
    service = new RegistrationService(new RulebookStore(t.db));
    staff = await createAccount(t.db, { name: 'Staff' });
    seller = await createAccount(t.db, { name: 'Seller' });
  });
  afterAll(async () => {
    await t?.drop();
  });

  const inAnHour = () => new Date(Date.now() + 3_600_000);

  it('joins a goods auction in one tap with the free allowance, and a second tap changes nothing', async () => {
    const bidder = await createAccount(t.db);
    const a = await createAuction(t.db, { createdBy: staff, lots: [{ sellerId: seller, startingBidMinor: 1_000n, endsAt: inAnHour() }] });
    const first = await t.db.tx(SYSTEM, (c) => service.join(c, { accountId: bidder, auctionId: a.auctionId }));
    expect(first.decision.status).toBe('approved');
    expect(first.limits.USD?.limitMinor).toBe(10_000n);
    const again = await t.db.tx(SYSTEM, (c) => service.join(c, { accountId: bidder, auctionId: a.auctionId }));
    expect(again).toMatchObject({ registrationId: first.registrationId, alreadyRegistered: true });
  });

  it('a deposit auction holds the deposit and sets the limit to deposit × 10', async () => {
    const bidder = await createAccount(t.db, { verification: 'full' });
    await t.db.tx(SYSTEM, (c) =>
      postJournal(c, topUp({ paymentId: crypto.randomUUID(), accountId: bidder, currency: 'USD', amountMinor: 400_000n, gateway: 'paynow' })),
    );
    const a = await createAuction(t.db, {
      createdBy: staff,
      depositRequired: true,
      lots: [{ sellerId: seller, category: 'vehicles', startingBidMinor: 100_000n, endsAt: inAnHour() }],
    });
    const tooLittle = await t.db.tx(SYSTEM, (c) => service.join(c, { accountId: bidder, auctionId: a.auctionId, deposit: { USD: 50_000n } }));
    expect(tooLittle.decision).toMatchObject({ status: 'rejected', reasons: ['deposit_needed'] }); // vehicles need US$3,000 (placeholder)
    const ok = await t.db.tx(SYSTEM, (c) => service.join(c, { accountId: bidder, auctionId: a.auctionId, deposit: { USD: 300_000n } }));
    expect(ok.decision.status).toBe('approved');
    expect(ok.limits.USD?.limitMinor).toBe(3_000_000n);
    expect(await wallet(t.db, bidder, 'USD')).toEqual({ currency: 'USD', availableMinor: 100_000n, heldMinor: 300_000n });
  });

  it('an account sharing a device with the seller goes to review, not straight in', async () => {
    const bidder = await createAccount(t.db);
    await t.db.tx(SYSTEM, (c) =>
      c.query(
        `INSERT INTO identity.link_signal (account_id, signal_type, signal_hmac) VALUES ($1, 'device', '\\xbeef'), ($2, 'device', '\\xbeef')`,
        [bidder, seller],
      ),
    );
    const a = await createAuction(t.db, { createdBy: staff, lots: [{ sellerId: seller, startingBidMinor: 1_000n, endsAt: inAnHour() }] });
    const r = await t.db.tx(SYSTEM, (c) => service.join(c, { accountId: bidder, auctionId: a.auctionId }));
    expect(r.decision).toEqual({ status: 'pending_review', reasons: ['linked_to_seller'] });
    const row = await t.db.query<{ status: string; flag_reasons: string[] }>('SELECT status, flag_reasons FROM registration.registration WHERE id = $1', [r.registrationId]);
    expect(row.rows[0]).toEqual({ status: 'pending_review', flag_reasons: ['linked_to_seller'] });
  });
});
