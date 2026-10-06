import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BiddingService } from '@abc/bidding';
import {
  createAccount,
  createAuction,
  createTestDatabase,
  DB_TESTS_ENABLED,
  loadPublishedRuleSetForTests,
  readRuleSetDocument,
  RulebookStore,
  SYSTEM,
  type Actor,
  type TestDatabase,
} from '@abc/db';
import { gatewaySettlement, postJournal } from '@abc/ledger';
import { RegistrationService } from '@abc/limits';
import { FakeGateway, PaymentService } from '@abc/payments';
import { quoteLot } from '@abc/quote';
import { SettlementService } from '@abc/settlement';
import { Analytics, AnalyticsError, checkPeriod, freezeBaseline, measuresToJson, type Measures } from './index';

const DOC = readRuleSetDocument();
const HOUR = 3_600_000;
const COMMISSION = {
  key: 'commission.schedule',
  scope: { type: 'global' as const, ref: '*' },
  value: { basis: 'flat_band', bands: { USD: [{ from: 0, rateBp: 1000 }], ZWG: null }, minimumPerLot: { USD: 0, ZWG: null } },
  provenance: 'assumption' as const,
  source: 'TEST ONLY: illustrative commission pending Q3',
};

describe('analytics periods (pure)', () => {
  it('refuses an empty, reversed or unbounded period and an unknown branch', () => {
    const now = new Date();
    expect(() => checkPeriod({ from: now, to: now })).toThrow(AnalyticsError);
    expect(() => checkPeriod({ from: now, to: new Date(now.getTime() - 1) })).toThrow(/after its start/);
    expect(() => checkPeriod({ from: new Date('2020-01-01'), to: new Date('2026-01-01') })).toThrow(/three years/);
    expect(() => checkPeriod({ from: new Date(now.getTime() - 1), to: now, branch: 'harare; drop' })).toThrow(/branch/);
    expect(() => checkPeriod({ from: new Date(now.getTime() - 1), to: now, branch: 'HRE' })).not.toThrow();
  });

  it('stores money as strings, so a frozen baseline never loses precision', () => {
    expect(measuresToJson({ revenue: [{ netRevenueMinor: 9_007_199_254_740_993n }] } as unknown as Measures)).toEqual({ revenue: [{ netRevenueMinor: '9007199254740993' }] });
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('blueprint §9 measures over the domain tables', () => {
  let t: TestDatabase;
  let rulebook: RulebookStore;
  let versionId: string;
  let registrations: RegistrationService;
  let bidding: BiddingService;
  let payments: PaymentService;
  let settlement: SettlementService;
  let paynow: FakeGateway;
  let analytics: Analytics;
  let staffId: string;
  let seller: string;
  let alice: string;
  let bob: string;
  let carol: string;
  let period: { from: Date; to: Date };
  let m: Measures;
  const staff = (): Actor & { type: 'staff' } => ({ type: 'staff', id: staffId, name: 'Staff' });
  const as = (id: string): Actor => ({ type: 'account', id, name: 'Bidder' });
  const it_ = { currency: 'USD' as const, taxClass: 'goods_standard', categoryPath: ['it'], isVehicle: false };

  async function bid(accountId: string, auctionLotId: string, maxMinor: bigint) {
    const total = quoteLot({ lot: it_, hammerMinor: maxMinor, snapshot: await rulebook.snapshot(versionId), taxRates: await rulebook.taxRates(), at: new Date() }).totalMinor;
    return bidding.placeBid(as(accountId), { accountId, auctionLotId, maxMinor, clientRequestId: randomUUID(), quotedTotalMinor: total, quotedRuleVersionId: versionId, channel: 'web' });
  }

  async function waitUntil(at: Date) {
    const ms = at.getTime() - Date.now();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  async function ecocash(accountId: string, amountMinor: bigint, approve = true) {
    const start = await payments.startTopUp(as(accountId), { accountId, currency: 'USD', amountMinor, method: 'ecocash', clientKey: randomUUID() });
    const ref = (await t.db.query<{ gateway_reference: string }>('SELECT gateway_reference FROM payment.payment WHERE id = $1', [start.paymentId])).rows[0]!.gateway_reference;
    const cb = paynow.payerResponds(ref, approve);
    await payments.handleCallback('paynow', cb.headers, cb.body);
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    versionId = await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true, overrides: [COMMISSION] });
    rulebook = new RulebookStore(t.db);
    registrations = new RegistrationService(rulebook);
    bidding = new BiddingService(t.db, rulebook, registrations);
    paynow = new FakeGateway('paynow', 'paynow-secret');
    payments = new PaymentService(t.db, rulebook, [paynow]);
    settlement = new SettlementService(t.db, rulebook, { gatePassSecret: 'secret' });
    analytics = new Analytics(t.db);
    staffId = await createAccount(t.db, { name: 'Staff', verification: 'full' });
    seller = await createAccount(t.db, { name: 'Seller', verification: 'full' });
    alice = await createAccount(t.db, { name: 'Alice', verification: 'full' });
    bob = await createAccount(t.db, { name: 'Bob', verification: 'full' });
    carol = await createAccount(t.db, { name: 'Carol', verification: 'full' });
    await t.db.tx(SYSTEM, (c) =>
      c.query(
        `INSERT INTO payout.destination (account_id, method, currency, details_enc, details_hmac, verified_at, cooling_off_until)
         VALUES ($1, 'ecocash', 'USD', '\\x01', '\\x02', now(), now() - interval '1 day')`,
        [seller],
      ),
    );
    period = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 10 * 86_400_000) };

    // Money in: Alice by EcoCash (in the app), Bob in cash at the Harare counter; one EcoCash attempt declined.
    await ecocash(alice, 300_000n);
    await ecocash(carol, 5_000n, false);
    await payments.recordBranchCash(staff(), { cashierId: staffId, branch: 'HRE', accountId: bob, currency: 'USD', amountMinor: 60_000n, receiptNumber: 'HRE-A-1' });

    // Auction 1: lot 1 sold to Alice (paid, collected, seller paid); lot 2 sold to Bob (defaults); lot 3 unsold.
    // Lots close in real time (a 1-second soft close), so payouts and payments come after the hammer.
    const end = new Date(Date.now() + 2_500);
    const a1 = await createAuction(t.db, {
      createdBy: staffId, depositRequired: true, softCloseSeconds: 1,
      lots: [
        { sellerId: seller, startingBidMinor: 10_000n, endsAt: end, title: 'Laptop' },
        { sellerId: seller, startingBidMinor: 70_000n, endsAt: end, title: 'Server' },
        { sellerId: seller, startingBidMinor: 5_000n, endsAt: end, title: 'Printer' },
      ],
    });
    await bidding.openAuction(SYSTEM, a1.auctionId);
    await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: alice, auctionId: a1.auctionId, deposit: { USD: 100_000n } }));
    await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: bob, auctionId: a1.auctionId, deposit: { USD: 50_000n } }));
    expect(await bid(alice, a1.lots[0]!.auctionLotId, 20_000n)).toMatchObject({ accepted: true });
    expect(await bid(bob, a1.lots[0]!.auctionLotId, 15_000n)).toMatchObject({ accepted: true });
    expect(await bid(bob, a1.lots[1]!.auctionLotId, 80_000n)).toMatchObject({ accepted: true });
    await waitUntil(new Date(end.getTime() + 1_100));
    await bidding.closeDueLots(new Date());
    const issued = await settlement.settleClosedAuction(a1.auctionId);
    const aliceInvoice = issued.find((i) => i.buyerId === alice)!.invoiceId;
    const bobInvoice = issued.find((i) => i.buyerId === bob)!;
    const paid = (await settlement.payFromWallet(as(alice), { invoiceId: aliceInvoice, accountId: alice, clientKey: 'pay-1' })) as { gatePassToken: string };
    const released = (await settlement.releaseAtGate(staff(), paid.gatePassToken)) as { payouts: string[] };
    await t.db.tx(SYSTEM, (c) => postJournal(c, gatewaySettlement({ settlementId: 'paynow-day-1', gateway: 'paynow', currency: 'USD', amountMinor: 300_000n })));
    await settlement.markPayoutPaid(staff(), released.payouts[0]!, 'ECO-1');

    // Bob does not pay: the ladder forfeits his deposit, charges the relist fee and relists the server.
    const issuedAt = (await t.db.query<{ issued_at: Date }>('SELECT issued_at FROM settlement.invoice WHERE id = $1', [bobInvoice.invoiceId])).rows[0]!.issued_at;
    await settlement.runDefaultLadder(new Date(issuedAt.getTime() + 48 * HOUR));
    await settlement.runDefaultLadder(new Date(issuedAt.getTime() + 72 * HOUR));

    // The relisted server sells to Alice in a second auction, and she pays: the default is recovered.
    const end2 = new Date(Date.now() + 2_500);
    const a2 = randomUUID();
    const al2 = randomUUID();
    await t.db.tx(SYSTEM, async (c) => {
      await c.query(
        `INSERT INTO auction.auction (id, code, title, format, branch_code, status, opens_at, first_close_at, soft_close_seconds, created_by)
         VALUES ($1, 'RELIST-1', 'Relist', 'timed_online', 'HRE', 'scheduled', now() - interval '1 hour', $2, 1, $3)`,
        [a2, end2, staffId],
      );
      await c.query(
        `INSERT INTO auction.auction_lot (id, auction_id, lot_id, currency, lot_number, starting_bid_minor, scheduled_end_at, current_end_at)
         VALUES ($1, $2, $3, 'USD', 1, 60000, $4, $4)`,
        [al2, a2, a1.lots[1]!.lotId, end2],
      );
      await c.query('UPDATE catalogue.lot SET current_auction_lot_id = $2 WHERE id = $1', [a1.lots[1]!.lotId, al2]);
    });
    await bidding.openAuction(SYSTEM, a2);
    await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: alice, auctionId: a2, deposit: { USD: 100_000n } }));
    expect(await bid(alice, al2, 60_000n)).toMatchObject({ accepted: true });
    await waitUntil(new Date(end2.getTime() + 1_100));
    await bidding.closeDueLots(new Date());
    const relistInvoice = (await settlement.settleClosedAuction(a2))[0]!.invoiceId;
    expect(await settlement.payFromWallet(as(alice), { invoiceId: relistInvoice, accountId: alice, clientKey: 'pay-2' })).toMatchObject({ paid: true });

    // Vehicles: two offered, one with a published inspection report.
    const a3 = await createAuction(t.db, {
      createdBy: staffId,
      lots: [
        { sellerId: seller, category: 'vehicles', startingBidMinor: 100_000n, endsAt: new Date(Date.now() + 5 * HOUR) },
        { sellerId: seller, category: 'vehicles', startingBidMinor: 100_000n, endsAt: new Date(Date.now() + 5 * HOUR) },
      ],
    });
    await t.db.tx(SYSTEM, (c) =>
      c.query(
        `INSERT INTO catalogue.inspection_report (lot_id, checklist_version, inspector_id, inspected_at, chassis_verified, engine_verified,
                                                  items, photo_count, has_video, summary, published_at)
         VALUES ($1, 'vehicle-v1', $2, now(), true, true, '{}', 38, true, 'All fine', now())`,
        [a3.lots[0]!.lotId, staffId],
      ),
    );
    await bidding.openAuction(SYSTEM, a3.auctionId);

    // A ZiG income line, to show currencies never mix.
    await t.db.tx(SYSTEM, async (c) => {
      const clearing = (await c.query<{ id: string }>(
        `INSERT INTO ledger.book_account (owner_type, owner_id, purpose, currency, normal_side, allow_negative) VALUES ('gateway', 'paynow', 'gateway_clearing', 'ZWG', 'D', true) RETURNING id`,
      )).rows[0]!.id;
      const fee = (await c.query<{ id: string }>(
        `INSERT INTO ledger.book_account (owner_type, purpose, sub_code, currency, normal_side, allow_negative) VALUES ('platform', 'fee_income', 'relist_fee', 'ZWG', 'C', false) RETURNING id`,
      )).rows[0]!.id;
      await c.query(`SELECT ledger.post_journal('adjustment', 'ZWG', 'zig-fee-1', 'ZiG fee (test)', $1::jsonb)`, [
        JSON.stringify([{ account: clearing, amount: '25000' }, { account: fee, amount: '-25000' }]),
      ]);
    });

    m = await analytics.measures(period);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('time from registration to first bid: median and 90th percentile', () => {
    expect(m.registrationToFirstBid.cohort).toBe(3); // Alice and Bob in auction 1, Alice in the relist
    expect(m.registrationToFirstBid.completed).toBe(3);
    expect(m.registrationToFirstBid.medianSeconds).toBeGreaterThanOrEqual(0);
    expect(m.registrationToFirstBid.p90Seconds).toBeGreaterThanOrEqual(m.registrationToFirstBid.medianSeconds!);
  });

  it('share of deposits and winnings paid in the app, per currency', () => {
    expect(m.inAppPayments).toEqual([
      expect.objectContaining({ currency: 'USD', depositCount: 2, depositInAppCount: 1, depositShare: 0.5, depositsMinor: 360_000n, depositsInAppMinor: 300_000n, winningCount: 2, winningInAppCount: 2, winningsShare: 1 }),
    ]);
  });

  it('time from hammer to payment, and from sale to seller payout', () => {
    expect(m.hammerToPayment).toMatchObject({ cohort: 3, completed: 2 });
    expect(m.hammerToPayment.medianSeconds).toBeGreaterThanOrEqual(0);
    expect(m.saleToPayout).toMatchObject({ cohort: 3, completed: 1 });
    expect(m.saleToPayout.p90Seconds).not.toBeNull();
  });

  it('sell-through by category', () => {
    expect(m.sellThrough).toMatchObject({ offered: 4, sold: 3, rate: 0.75, byCategory: [{ category: 'it', offered: 4, sold: 3, rate: 0.75 }] });
  });

  it('default rate, cure rate and recovery rate', () => {
    expect(m.defaults).toMatchObject({ invoices: 3, overdue: 1, defaulted: 1, cured: 0, defaultedLots: 1, recoveredLots: 1, recoveryRate: 1 });
    expect(m.defaults.defaultRate).toBeCloseTo(1 / 3, 3);
  });

  it('bids and unique bidders per lot', () => {
    expect(m.bidsPerLot).toMatchObject({ lots: 4, lotsWithBids: 3, bidderBids: 4, medianUniqueBidders: 1 });
    expect(m.bidsPerLot.bids).toBeGreaterThanOrEqual(4);
  });

  it('share of vehicle lots with an inspection report', () => {
    expect(m.inspectionCoverage).toEqual({ vehicleLots: 2, withReport: 1, share: 0.5 });
  });

  it('realised prices, revenue per currency (never added across) and gateway success', () => {
    expect(m.realisedPrices).toEqual([expect.objectContaining({ category: 'it', currency: 'USD', lotsSold: 3, medianHammerMinor: 60_000n, minHammerMinor: 15_500n, maxHammerMinor: 70_000n, totalHammerMinor: 15_500n + 70_000n + 60_000n })]);
    const usd = m.revenue.find((r) => r.currency === 'USD')!;
    const zwg = m.revenue.find((r) => r.currency === 'ZWG')!;
    expect(usd.lines).toEqual(expect.arrayContaining([
      { type: 'commission_income', amountMinor: 1_550n + 6_000n }, // 10 % (illustrative) of the two paid hammers
      { type: 'forfeiture_income', amountMinor: 50_000n },
      { type: 'fee_income:relist_fee', amountMinor: 7_000n },
    ]));
    expect(usd.grossHammerMinor).toBe(145_500n);
    expect(zwg).toEqual({ currency: 'ZWG', lines: [{ type: 'fee_income:relist_fee', amountMinor: 25_000n }], netRevenueMinor: 25_000n, grossHammerMinor: 0n });
    expect(m.gatewaySuccess).toEqual([expect.objectContaining({ gateway: 'paynow', method: 'ecocash', currency: 'USD', attempts: 2, succeeded: 1, cancelled: 1, successRate: 0.5 })]);
  });

  it('support measures are null until ticket events arrive, then per 100 sales with time to first reply', async () => {
    expect(m.support).toEqual({ instrumented: false, tickets: null, sales: 3, ticketsPer100Sales: null, replied: null, medianFirstReplySeconds: null, p90FirstReplySeconds: null });
    await t.db.query(
      `INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload, created_at) VALUES
         ('ticket.opened', 'ticket', 't1', '{"branch": "HRE"}', now()),
         ('ticket.first_reply', 'ticket', 't1', '{}', now() + interval '30 minutes')`,
    );
    const after = await analytics.measures(period);
    expect(after.support).toMatchObject({ instrumented: true, tickets: 1, sales: 3, ticketsPer100Sales: 33.33, replied: 1, medianFirstReplySeconds: 1800 });
  });

  it('the branch filter narrows to one branch', async () => {
    const byo = await analytics.measures({ ...period, branch: 'BYO' });
    expect(byo.sellThrough).toMatchObject({ offered: 0, sold: 0, rate: null });
    expect(byo.registrationToFirstBid).toMatchObject({ cohort: 0, medianSeconds: null });
    expect(byo.revenue).toEqual([]);
  });

  it('freezes a baseline once; the same label for another period is refused; the database keeps it unchanged', async () => {
    const by = { id: staffId, name: 'Staff' };
    const first = await freezeBaseline(t.db, by, { ...period, label: 'baseline-2026-11', notes: 'First measurement' });
    expect(first.created).toBe(true);
    expect((first.measures as { sellThrough: { sold: number } }).sellThrough.sold).toBe(3);
    expect((await freezeBaseline(t.db, by, { ...period, label: 'baseline-2026-11' })).created).toBe(false);
    await expect(freezeBaseline(t.db, by, { from: period.from, to: new Date(period.to.getTime() + 1), label: 'baseline-2026-11' })).rejects.toThrow(/different period/);
    expect((await analytics.baselines()).map((b) => b.label)).toEqual(['baseline-2026-11']);
    expect((await analytics.baseline('baseline-2026-11'))!.measures).toMatchObject({ revenue: expect.arrayContaining([expect.objectContaining({ currency: 'USD' })]) });
    await expect(t.db.query(`UPDATE analytics.baseline_snapshot SET notes = 'edited'`)).rejects.toThrow(/append-only/);
  });

  it('every measure reads without writing (safe on a read-only replica connection)', async () => {
    const c = await t.db.pool.connect();
    try {
      await c.query('BEGIN READ ONLY');
      const ro = await new Analytics(c).measures(period);
      expect(ro.sellThrough.sold).toBe(3);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });
});
