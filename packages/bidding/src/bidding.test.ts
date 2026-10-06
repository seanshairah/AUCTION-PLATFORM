import { randomUUID } from 'node:crypto';
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
  type AuctionFixture,
  type TestDatabase,
} from '@abc/db';
import { RegistrationService } from '@abc/limits';
import { quoteLot } from '@abc/quote';
import { BiddingService, type PlaceBidRequest } from './index';

describe.skipIf(!DB_TESTS_ENABLED)('bidding service against PostgreSQL', () => {
  let t: TestDatabase;
  let rulebook: RulebookStore;
  let bidding: BiddingService;
  let registrations: RegistrationService;
  let versionId: string;
  let staff: string;
  let seller: string;
  let alice: string;
  let bob: string;
  let auction: AuctionFixture;
  const END = new Date(Date.now() + 2 * 3_600_000);

  async function quoted(maxMinor: bigint) {
    const snapshot = await rulebook.snapshot(versionId);
    const taxRates = await rulebook.taxRates();
    return quoteLot({ lot: { currency: 'USD', taxClass: 'goods_standard', categoryPath: ['it'], isVehicle: false }, hammerMinor: maxMinor, snapshot, taxRates, at: new Date() }).totalMinor;
  }

  async function bid(accountId: string, maxMinor: bigint, extra: Partial<PlaceBidRequest> = {}) {
    return bidding.placeBid(
      { type: 'account', id: accountId, name: 'Bidder' },
      {
        accountId,
        auctionLotId: auction.lots[0]!.auctionLotId,
        maxMinor,
        clientRequestId: randomUUID(),
        quotedTotalMinor: await quoted(maxMinor),
        quotedRuleVersionId: versionId,
        channel: 'android',
        ...extra,
      },
    );
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    versionId = await loadPublishedRuleSetForTests(t.db, readRuleSetDocument(), { activateTaxRates: true });
    rulebook = new RulebookStore(t.db);
    registrations = new RegistrationService(rulebook);
    bidding = new BiddingService(t.db, rulebook, registrations);
    staff = await createAccount(t.db, { name: 'Staff' });
    seller = await createAccount(t.db, { name: 'Seller' });
    alice = await createAccount(t.db, { name: 'Alice', verification: 'full' });
    bob = await createAccount(t.db, { name: 'Bob', verification: 'full' });
    auction = await createAuction(t.db, { createdBy: staff, lots: [{ sellerId: seller, startingBidMinor: 5_000n, endsAt: END }] });
    expect(await bidding.openAuction(SYSTEM, auction.auctionId)).toBe(versionId);
    for (const who of [alice, bob]) {
      await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: who, auctionId: auction.auctionId }));
    }
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('refuses a bidder who has not joined the auction', async () => {
    const carol = await createAccount(t.db);
    expect(await bid(carol, 6_000n)).toEqual({ accepted: false, reason: 'not_registered' });
  });

  it('accepts a first maximum bid at the starting price, with a receipt', async () => {
    const r = await bid(alice, 20_000n);
    expect(r).toMatchObject({ accepted: true, receipt: { seq: 1n, outcome: 'leading', currentPriceMinor: 5_000n, youAreLeading: true } });
  });

  it('a lower challenger is outbid at once; the proxy row is logged with its parent', async () => {
    const r = await bid(bob, 8_000n);
    expect(r).toMatchObject({ accepted: true, receipt: { outcome: 'outbid', currentPriceMinor: 8_500n } });
    const rows = await t.db.query<{ sequence_no: bigint; origin: string; amount_minor: bigint; outcome_at_placement: string; has_parent: boolean }>(
      `SELECT sequence_no, origin, amount_minor, outcome_at_placement, parent_bid_id IS NOT NULL AS has_parent
         FROM bidding.bid WHERE auction_lot_id = $1 ORDER BY sequence_no`,
      [auction.lots[0]!.auctionLotId],
    );
    expect(rows.rows.map((r) => [r.sequence_no, r.origin, r.amount_minor, r.outcome_at_placement, r.has_parent])).toEqual([
      [1n, 'bidder', 5_000n, 'leading', false],
      [2n, 'bidder', 8_000n, 'outbid', false],
      [3n, 'proxy', 8_500n, 'leading', true],
    ]);
  });

  it('a retried request returns the original receipt and places nothing new', async () => {
    const id = randomUUID();
    const first = await bid(bob, 9_000n, { clientRequestId: id });
    const again = await bid(bob, 9_000n, { clientRequestId: id });
    expect(again).toMatchObject({ accepted: true, repeated: true, receipt: { seq: (first as { receipt: { seq: bigint } }).receipt.seq } });
    const n = await t.db.query<{ n: bigint }>('SELECT count(*) AS n FROM bidding.bid WHERE client_request_id = $1', [id]);
    expect(n.rows[0]!.n).toBe(1n);
  });

  it('refuses a bid whose quoted total no longer matches, returning the server figure (screen = bill)', async () => {
    const r = await bid(bob, 9_500n, { quotedTotalMinor: 1n });
    expect(r).toMatchObject({ accepted: false, reason: 'price_changed' });
    expect((r as { serverQuote: { totalMinor: bigint } }).serverQuote.totalMinor).toBe(await quoted(9_500n));
  });

  it('refuses a maximum whose all-in total exceeds the limit, and says how much room there is', async () => {
    // Full verification gives US$500; US$450 hammer is US$587.25 all-in with the placeholder rates.
    const r = await bid(bob, 45_000n);
    expect(r).toMatchObject({ accepted: false, reason: 'over_limit', capacityMinor: 50_000n });
  });

  it('refuses the seller bidding on their own lot, even if a reviewer approved their registration', async () => {
    const joined = await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: seller, auctionId: auction.auctionId }));
    expect(joined.decision).toEqual({ status: 'pending_review', reasons: ['linked_to_seller'] });
    // A reviewer approves (they may sell other lots and bid on some); the lot-level bar still holds.
    await t.db.tx({ type: 'staff', id: staff, name: 'Reviewer', reason: 'Seller may bid on other sellers’ lots' }, (c) =>
      c.query(`UPDATE registration.registration SET status = 'approved', decided_by_type = 'staff', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [joined.registrationId, staff, 'Seller may bid on other sellers’ lots']),
    );
    expect(await bid(seller, 30_000n)).toMatchObject({ accepted: false, reason: 'seller_linked' });
  });

  it('rejections are in the immutable log with their reasons', async () => {
    const r = await t.db.query<{ reject_reason: string }>(
      `SELECT reject_reason FROM bidding.bid WHERE auction_lot_id = $1 AND outcome_at_placement = 'rejected' ORDER BY sequence_no`,
      [auction.lots[0]!.auctionLotId],
    );
    expect(r.rows.map((x) => x.reject_reason)).toEqual(['price_changed', 'over_limit', 'seller_linked']);
  });

  it('a leading bidder’s exposure counts their maximum, all-in, against other lots', async () => {
    const snapshot = await rulebook.snapshot(versionId);
    const room = await t.db.tx(SYSTEM, async (c) =>
      registrations.capacityFor(c, { accountId: alice, auctionLotId: randomUUID(), currency: 'USD', depositRequired: false, snapshot, taxRates: await rulebook.taxRates(c), at: new Date() }),
    );
    expect(room.exposureMinor).toBe(await quoted(20_000n)); // Alice leads with a US$200 maximum
    expect(room.capacityMinor).toBe(50_000n - (await quoted(20_000n)));
  });

  it('closes the lot after its end time and sells to the leader', async () => {
    expect(await bidding.closeDueLots(new Date(Date.now()))).toEqual([]);
    const closed = await bidding.closeDueLots(new Date(END.getTime() + 1_000));
    expect(closed).toEqual([{ auctionLotId: auction.lots[0]!.auctionLotId, result: { result: 'sold', winnerAccountId: alice, hammerMinor: 9_500n } }]);
    const a = await t.db.query<{ status: string }>('SELECT status FROM auction.auction WHERE id = $1', [auction.auctionId]);
    expect(a.rows[0]!.status).toBe('closed');
    expect(await bid(bob, 30_000n)).toEqual({ accepted: false, reason: 'auction_not_open' });
  });

  it('every bid and lot state change was audited', async () => {
    const r = await t.db.query<{ entity_type: string; n: bigint }>(
      `SELECT entity_type, count(*) AS n FROM audit.event WHERE entity_type IN ('bidding.bid', 'catalogue.lot', 'auction.auction_lot') GROUP BY 1 ORDER BY 1`,
    );
    const counts = Object.fromEntries(r.rows.map((x) => [x.entity_type, x.n]));
    expect(counts['bidding.bid']).toBeGreaterThanOrEqual(8n);
    expect(counts['catalogue.lot']).toBeGreaterThanOrEqual(4n); // created, listed, live, closed
  });
});
