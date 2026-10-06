import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, DB_TESTS_ENABLED, SYSTEM, type TestDatabase } from '@abc/db';
import {
  activeHolds,
  balance,
  clawbackRecovery,
  createHold,
  deliveryCharge,
  fullRefundAndReturn,
  storageFee,
  forfeitHold,
  forfeitHoldById,
  invoiceCredit,
  invoiceIssued,
  invoicePayment,
  placeHold,
  postJournal,
  reconcileLedger,
  releaseHoldById,
  reversal,
  topUp,
  UnbalancedJournalError,
  wallet,
  type JournalSpec,
} from './index';

const BUYER = '00000000-0000-0000-0000-0000000000b1';
const SELLER = '00000000-0000-0000-0000-0000000000a1';

function sum(spec: JournalSpec): bigint {
  return spec.lines.reduce((a, l) => a + l.amountMinor, 0n);
}

describe('posting recipes (pure)', () => {
  it('every recipe balances', () => {
    const specs = [
      topUp({ paymentId: 'p1', accountId: BUYER, currency: 'USD', amountMinor: 50_000n, gateway: 'paynow' }),
      placeHold({ holdId: 'h1', accountId: BUYER, currency: 'USD', amountMinor: 20_000n }),
      forfeitHold({ holdId: 'h1', accountId: BUYER, currency: 'USD', amountMinor: 20_000n, sellerId: SELLER, sellerShareMinor: 10_000n }),
      invoiceIssued({
        invoiceId: 'i1',
        buyerId: BUYER,
        currency: 'USD',
        lines: [
          { type: 'hammer', amountMinor: 100_000n, sellerId: SELLER },
          { type: 'purchasers_levy', amountMinor: 15_000n },
          { type: 'vat', amountMinor: 15_500n },
          { type: 'delivery', amountMinor: 1_000n },
        ],
      }),
    ];
    for (const s of specs) expect(sum(s)).toBe(0n);
  });

  it('the invoice journal matches the data-model example (US$1,315.00)', () => {
    const j = invoiceIssued({
      invoiceId: 'i1',
      buyerId: BUYER,
      currency: 'USD',
      lines: [
        { type: 'hammer', amountMinor: 100_000n, sellerId: SELLER },
        { type: 'purchasers_levy', amountMinor: 15_000n },
        { type: 'vat', amountMinor: 15_500n },
        { type: 'delivery', amountMinor: 1_000n },
      ],
    });
    expect(j.lines.map((l) => [l.account.purpose, l.account.sub ?? '', l.amountMinor])).toEqual([
      ['customer_receivable', '', 131_500n],
      ['seller_payable', '', -100_000n],
      ['tax_payable', 'purchasers_levy', -15_000n],
      ['tax_payable', 'vat', -15_500n],
      ['delivery_income', '', -1_000n],
    ]);
  });

  it('credit and reversal are exact mirrors', () => {
    const issued = invoiceIssued({ invoiceId: 'i1', buyerId: BUYER, currency: 'USD', lines: [{ type: 'hammer', amountMinor: 500n, sellerId: SELLER }] });
    expect(invoiceCredit(issued, 'i1').lines.map((l) => l.amountMinor)).toEqual([-500n, 500n]);
    expect(reversal(issued, 'j1', 'test').reversesJournalId).toBe('j1');
  });

  it('logistics and dispute recipes balance and hit the right accounts (deliverables 15 and 17)', () => {
    const full = fullRefundAndReturn({
      disputeId: 'd1', buyerId: BUYER, sellerId: SELLER, currency: 'USD', hammerMinor: 26_000n, commissionMinor: 2_600n,
      otherLines: [{ type: 'purchasers_levy', amountMinor: 3_900n }, { type: 'vat', amountMinor: 4_030n }], fundedBy: 'seller',
    });
    expect(full.lines.map((l) => [l.account.purpose, l.account.sub ?? '', l.amountMinor])).toEqual([
      ['seller_payable', '', 23_400n],
      ['commission_income', '', 2_600n],
      ['tax_payable', 'purchasers_levy', 3_900n],
      ['tax_payable', 'vat', 4_030n],
      ['wallet_available', '', -33_930n],
    ]);
    const fronted = fullRefundAndReturn({ disputeId: 'd2', buyerId: BUYER, sellerId: SELLER, currency: 'USD', hammerMinor: 1_000n, commissionMinor: 0n, otherLines: [], fundedBy: 'platform' });
    expect(fronted.lines.map((l) => [l.account.purpose, l.amountMinor])).toEqual([['suspense', 1_000n], ['wallet_available', -1_000n]]);
    const specs = [
      full,
      fronted,
      clawbackRecovery({ clawbackId: 'c1', payoutId: 'p1', sellerId: SELLER, currency: 'USD', amountMinor: 500n }),
      storageFee({ collectionId: 'c1', buyerId: BUYER, currency: 'USD', amountMinor: 520n, days: 2 }),
      deliveryCharge({ deliveryId: 'dl1', buyerId: BUYER, currency: 'USD', lines: [{ type: 'delivery', amountMinor: 1_000n }, { type: 'vat', amountMinor: 155n }] }),
    ];
    for (const s of specs) expect(sum(s)).toBe(0n);
    expect(() => fullRefundAndReturn({ disputeId: 'd3', buyerId: BUYER, sellerId: SELLER, currency: 'USD', hammerMinor: 100n, commissionMinor: 200n, otherLines: [], fundedBy: 'seller' })).toThrow(RangeError);
  });

  it('refuses zero, negative and one-sided journals', () => {
    expect(() => topUp({ paymentId: 'p', accountId: BUYER, currency: 'USD', amountMinor: 0n, gateway: 'paynow' })).toThrow(RangeError);
    expect(() => invoiceIssued({ invoiceId: 'i', buyerId: BUYER, currency: 'USD', lines: [] })).toThrow(UnbalancedJournalError);
    expect(() => forfeitHold({ holdId: 'h', accountId: BUYER, currency: 'USD', amountMinor: 100n, sellerShareMinor: 200n, sellerId: SELLER })).toThrow(RangeError);
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('ledger store against PostgreSQL', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
    await t.db.tx(SYSTEM, (c) =>
      c.query(
        `INSERT INTO identity.account (id, email, phone_e164, email_verified_at, phone_verified_at, display_name, verification_level, tier)
         VALUES ($1, 'b@x.test', '+263770000001', now(), now(), 'Buyer', 'partial', 'verified'),
                ($2, 's@x.test', '+263770000002', now(), now(), 'Seller', 'partial', 'verified')`,
        [BUYER, SELLER],
      ),
    );
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('a top-up credits the wallet, and repeating it changes nothing', async () => {
    const spec = topUp({ paymentId: '00000000-0000-0000-0000-00000000f001', accountId: BUYER, currency: 'USD', amountMinor: 50_000n, gateway: 'paynow' });
    const first = await t.db.tx(SYSTEM, (c) => postJournal(c, spec));
    const second = await t.db.tx(SYSTEM, (c) => postJournal(c, spec));
    expect(second).toBe(first);
    expect(await wallet(t.db, BUYER, 'USD')).toEqual({ currency: 'USD', availableMinor: 50_000n, heldMinor: 0n });
  });

  it('holds move money to held, release and forfeit close them exactly once', async () => {
    const hold = await t.db.tx(SYSTEM, (c) => createHold(c, { accountId: BUYER, currency: 'USD', amountMinor: 20_000n, referenceType: 'registration', referenceId: 'r1' }));
    expect(await wallet(t.db, BUYER, 'USD')).toEqual({ currency: 'USD', availableMinor: 30_000n, heldMinor: 20_000n });
    expect(await t.db.tx(SYSTEM, (c) => releaseHoldById(c, hold.id))).toBe(true);
    expect(await t.db.tx(SYSTEM, (c) => releaseHoldById(c, hold.id))).toBe(false);
    expect(await wallet(t.db, BUYER, 'USD')).toEqual({ currency: 'USD', availableMinor: 50_000n, heldMinor: 0n });

    const h2 = await t.db.tx(SYSTEM, (c) => createHold(c, { accountId: BUYER, currency: 'USD', amountMinor: 10_000n, referenceType: 'registration', referenceId: 'r2' }));
    await t.db.tx(SYSTEM, (c) => forfeitHoldById(c, h2.id));
    expect(await wallet(t.db, BUYER, 'USD')).toEqual({ currency: 'USD', availableMinor: 40_000n, heldMinor: 0n });
    expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'forfeiture_income' }, 'USD')).toBe(10_000n);
    expect(await activeHolds(t.db, BUYER, 'USD')).toEqual([]);
  });

  it('a hold larger than the available balance is refused by the database', async () => {
    await expect(
      t.db.tx(SYSTEM, (c) => createHold(c, { accountId: BUYER, currency: 'USD', amountMinor: 1_000_000n, referenceType: 'registration', referenceId: 'r3' })),
    ).rejects.toThrow(/book_account_check|check constraint/);
    expect(await wallet(t.db, BUYER, 'USD')).toEqual({ currency: 'USD', availableMinor: 40_000n, heldMinor: 0n });
  });

  it('two concurrent holds cannot overdraw the wallet', async () => {
    const attempt = () =>
      t.db
        .tx(SYSTEM, (c) => createHold(c, { accountId: BUYER, currency: 'USD', amountMinor: 30_000n, referenceType: 'registration', referenceId: 'race' }))
        .then(() => 'ok', () => 'refused');
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.sort()).toEqual(['ok', 'refused']);
    const w = await wallet(t.db, BUYER, 'USD');
    expect(w.availableMinor + w.heldMinor).toBe(40_000n);
    expect(w.availableMinor).toBe(10_000n);
  });

  it('the books reconcile: holds match held balances and customer money is covered', async () => {
    expect(await reconcileLedger(t.db)).toEqual([]);
  });

  it('a wallet payment cannot exceed the available balance', async () => {
    await expect(
      t.db.tx(SYSTEM, (c) =>
        postJournal(c, invoicePayment({ invoiceId: 'i9', buyerId: BUYER, currency: 'USD', amountMinor: 999_999n, paymentId: '00000000-0000-0000-0000-00000000f009' })),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
