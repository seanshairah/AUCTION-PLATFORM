import { randomUUID } from 'node:crypto';
import { BiddingService } from '@abc/bidding';
import { createAuction, RulebookStore, SYSTEM, type Db } from '@abc/db';
import { lotPricing, RegistrationService } from '@abc/limits';
import { PaymentService } from '@abc/payments';
import { quoteLot } from '@abc/quote';
import { SettlementService } from '@abc/settlement';

/**
 * TEST FIXTURES ONLY (@abc/logistics/testing): paid invoices made the way the money
 * path makes them (packages/settlement/src/money-path.test.ts): cash at the Harare
 * counter, one-tap registration with a deposit, one bid per lot, close, invoice at
 * the close, pay from the wallet. Each buyer ends with a ready collection and a QR pass.
 */

export interface PaidPurchase {
  buyerId: string;
  invoiceId: string;
  collectionId: string;
  gatePassToken: string;
  lotIds: string[];
  totalMinor: bigint;
  auctionId: string;
}

let receipt = 0;

export async function createPaidInvoices(
  db: Db,
  p: {
    staffId: string;
    sellerId: string;
    gatePassSecret: string;
    purchases: Array<{ buyerId: string; lots: Array<{ title?: string; category?: string; startingBidMinor: bigint }>; topUpMinor?: bigint }>;
  },
): Promise<PaidPurchase[]> {
  const rulebook = new RulebookStore(db);
  const registrations = new RegistrationService(rulebook);
  const bidding = new BiddingService(db, rulebook, registrations);
  const payments = new PaymentService(db, rulebook, []);
  const settlement = new SettlementService(db, rulebook, { gatePassSecret: p.gatePassSecret });
  const staff = { type: 'staff' as const, id: p.staffId, name: 'Fixture cashier' };

  const endsAt = new Date(Date.now() + 3_600_000);
  const flat = p.purchases.flatMap((pu) => pu.lots.map((l) => ({ ...l, buyerId: pu.buyerId })));
  const auction = await createAuction(db, {
    createdBy: p.staffId,
    lots: flat.map((l) => ({ sellerId: p.sellerId, category: l.category ?? 'it', startingBidMinor: l.startingBidMinor, endsAt, ...(l.title ? { title: l.title } : {}) })),
  });
  const versionId = await bidding.openAuction(SYSTEM, auction.auctionId);
  const snapshot = await rulebook.snapshot(versionId);
  const taxRates = await rulebook.taxRates();

  for (const pu of p.purchases) {
    const hammer = pu.lots.reduce((a, l) => a + l.startingBidMinor, 0n);
    await payments.recordBranchCash(staff, {
      cashierId: p.staffId, branch: 'HRE', accountId: pu.buyerId, currency: 'USD',
      amountMinor: pu.topUpMinor ?? hammer * 2n + 100_000n, receiptNumber: `FIX-${Date.now()}-${++receipt}-${randomUUID().slice(0, 6)}`,
    });
    const deposit = hammer / 5n > 10_000n ? hammer / 5n : 10_000n; // limit = 10 × deposit, comfortably above the all-in price
    await db.tx({ type: 'account', id: pu.buyerId, name: 'Fixture buyer' }, (c) => registrations.join(c, { accountId: pu.buyerId, auctionId: auction.auctionId, deposit: { USD: deposit } }));
  }
  for (const [i, l] of flat.entries()) {
    const lot = auction.lots[i]!;
    const total = quoteLot({ lot: await lotPricing(db, lot.lotId), hammerMinor: l.startingBidMinor, snapshot, taxRates, at: new Date() }).totalMinor;
    const r = await bidding.placeBid({ type: 'account', id: l.buyerId, name: 'Fixture buyer' }, {
      accountId: l.buyerId, auctionLotId: lot.auctionLotId, maxMinor: l.startingBidMinor, clientRequestId: randomUUID(),
      quotedTotalMinor: total, quotedRuleVersionId: versionId, channel: 'web',
    });
    if (!r.accepted) throw new Error(`Fixture bid refused: ${r.reason}`);
  }
  await bidding.closeDueLots(new Date(endsAt.getTime() + 1_000));
  const issued = await settlement.settleClosedAuction(auction.auctionId);

  const out: PaidPurchase[] = [];
  for (const pu of p.purchases) {
    const inv = issued.find((x) => x.buyerId === pu.buyerId);
    if (!inv) throw new Error('Fixture invoice missing');
    const paid = await settlement.payFromWallet({ type: 'account', id: pu.buyerId, name: 'Fixture buyer' }, { invoiceId: inv.invoiceId, accountId: pu.buyerId, clientKey: randomUUID() });
    if (!paid.paid || !('gatePassToken' in paid) || !paid.gatePassToken) throw new Error(`Fixture payment failed: ${JSON.stringify(paid, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    out.push({
      buyerId: pu.buyerId,
      invoiceId: inv.invoiceId,
      collectionId: paid.collectionId,
      gatePassToken: paid.gatePassToken,
      lotIds: flat.map((l, i) => (l.buyerId === pu.buyerId ? auction.lots[i]!.lotId : null)).filter((x): x is string => x !== null),
      totalMinor: inv.totalMinor,
      auctionId: auction.auctionId,
    });
  }
  return out;
}

/** A usable payout destination, so payouts are scheduled rather than held. */
export async function addPayoutDestination(db: Db, sellerId: string): Promise<void> {
  await db.tx(SYSTEM, (c) =>
    c.query(
      `INSERT INTO payout.destination (account_id, method, currency, details_enc, details_hmac, verified_at, cooling_off_until)
       VALUES ($1, 'ecocash', 'USD', '\\x01', $2, now(), now() - interval '1 day')`,
      [sellerId, Buffer.from(randomUUID())],
    ),
  );
}

/** Test courier and towing partners for both branches. */
export async function addPartners(db: Db): Promise<{ courierId: string }> {
  return db.tx(SYSTEM, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO logistics.partner (kind, name, phone_e164, branches) VALUES ('courier', 'Test Courier', '+263772000001', ARRAY['HRE', 'BYO'])
       ON CONFLICT (kind, name) DO UPDATE SET active = true RETURNING id`,
    );
    await c.query(`INSERT INTO logistics.partner (kind, name, phone_e164, branches) VALUES ('towing', 'Test Towing', '+263772000002', ARRAY['HRE']) ON CONFLICT DO NOTHING`);
    return { courierId: r.rows[0]!.id };
  });
}
