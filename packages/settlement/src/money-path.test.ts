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
import { balance, gatewaySettlement, postJournal, reconcileLedger, wallet } from '@abc/ledger';
import { RegistrationService } from '@abc/limits';
import { FakeGateway, PaymentService } from '@abc/payments';
import { quoteLot } from '@abc/quote';
import { RuleSnapshot } from '@abc/rules';
import { buildInvoiceDrafts, dueLadderSteps, relistFeeAmount, reminderTimes, SettlementService } from './index';

const DOC = readRuleSetDocument();
const HOUR = 3_600_000;

// Commission is not published yet (Q3). These tests use an illustrative flat 10 %.
const COMMISSION = {
  key: 'commission.schedule',
  scope: { type: 'global' as const, ref: '*' },
  value: { basis: 'flat_band', bands: { USD: [{ from: 0, rateBp: 1000 }], ZWG: null }, minimumPerLot: { USD: 0, ZWG: null } },
  provenance: 'assumption' as const,
  source: 'TEST ONLY: illustrative commission pending Q3',
};

describe('settlement rules (pure)', () => {
  const snapshot = new RuleSnapshot('v', DOC.label, DOC.rules);
  it('reminders at 12 h and 36 h; ladder steps when their time comes', () => {
    const issued = new Date('2026-11-20T18:00:00Z');
    expect(reminderTimes(issued, snapshot).map((r) => r.at.toISOString())).toEqual(['2026-11-21T06:00:00.000Z', '2026-11-22T06:00:00.000Z']);
    const due = new Date(issued.getTime() + 48 * HOUR);
    expect(dueLadderSteps(due, new Date(due.getTime() - 1), new Set(), snapshot)).toEqual([]);
    expect(dueLadderSteps(due, due, new Set(), snapshot)).toEqual(['warning']);
    expect(dueLadderSteps(due, new Date(due.getTime() + 24 * HOUR), new Set(['warning']), snapshot)).toEqual(['deposit_forfeit', 'relist_fee', 'tier_drop']);
  });

  it('relist fee is 10 % of the hammer, at least US$10', () => {
    expect(relistFeeAmount(70_000n, 'USD', snapshot)).toBe(7_000n);
    expect(relistFeeAmount(5_000n, 'USD', snapshot)).toBe(1_000n);
  });

  it('groups lots into one invoice per buyer and currency', () => {
    const rates = DOC.taxRates.map((r) => ({ ...r, active: true }));
    const it = { currency: 'USD' as const, taxClass: 'goods_standard', categoryPath: ['it'], isVehicle: false };
    const at = new Date('2026-11-20T18:00:00Z');
    const drafts = buildInvoiceDrafts(
      [
        { auctionLotId: 'al1', lotId: 'l1', sellerId: 's', buyerId: 'b', pricing: it, hammerMinor: 10_000n, hammerAt: at },
        { auctionLotId: 'al2', lotId: 'l2', sellerId: 's', buyerId: 'b', pricing: it, hammerMinor: 20_000n, hammerAt: at },
        { auctionLotId: 'al3', lotId: 'l3', sellerId: 's', buyerId: 'c', pricing: it, hammerMinor: 30_000n, hammerAt: at },
      ],
      snapshot,
      rates,
      at,
    );
    expect(drafts.map((d) => [d.buyerId, d.totalMinor])).toEqual([
      ['b', 39_150n],
      ['c', 39_150n],
    ]);
    expect(drafts[0]!.dueAt.toISOString()).toBe('2026-11-22T18:00:00.000Z');
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('the money path, end to end, against PostgreSQL', () => {
  let t: TestDatabase;
  let rulebook: RulebookStore;
  let versionId: string;
  let registrations: RegistrationService;
  let bidding: BiddingService;
  let payments: PaymentService;
  let settlement: SettlementService;
  let paynow: FakeGateway;
  let staffId: string;
  let staff: Actor & { type: 'staff' };
  let seller: string;
  let alice: string;
  let bob: string;

  const as = (id: string, name: string): Actor => ({ type: 'account', id, name });

  async function ecocashTopUp(accountId: string, amountMinor: bigint) {
    const start = await payments.startTopUp(as(accountId, 'Bidder'), { accountId, currency: 'USD', amountMinor, method: 'ecocash', clientKey: randomUUID() });
    const ref = (await t.db.query<{ gateway_reference: string }>('SELECT gateway_reference FROM payment.payment WHERE id = $1', [start.paymentId])).rows[0]!.gateway_reference;
    const cb = paynow.payerResponds(ref, true);
    await payments.handleCallback('paynow', cb.headers, cb.body);
  }

  async function bid(accountId: string, auctionLotId: string, maxMinor: bigint, pricing = { currency: 'USD' as const, taxClass: 'goods_standard', categoryPath: ['it'], isVehicle: false }) {
    const snapshot = await rulebook.snapshot(versionId);
    const total = quoteLot({ lot: pricing, hammerMinor: maxMinor, snapshot, taxRates: await rulebook.taxRates(), at: new Date() }).totalMinor;
    return bidding.placeBid(as(accountId, 'Bidder'), {
      accountId, auctionLotId, maxMinor, clientRequestId: randomUUID(), quotedTotalMinor: total, quotedRuleVersionId: versionId, channel: 'android',
    });
  }

  async function lotStates(lotId: string): Promise<string[]> {
    const r = await t.db.query<{ to_state: string }>(
      `SELECT to_state FROM audit.event WHERE entity_type = 'catalogue.lot' AND entity_id = $1 ORDER BY id`,
      [lotId],
    );
    return r.rows.map((x) => x.to_state);
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    versionId = await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true, overrides: [COMMISSION] });
    rulebook = new RulebookStore(t.db);
    registrations = new RegistrationService(rulebook);
    bidding = new BiddingService(t.db, rulebook, registrations);
    paynow = new FakeGateway('paynow', 'paynow-secret');
    payments = new PaymentService(t.db, rulebook, [paynow, new FakeGateway('contipay', 'contipay-secret')]);
    settlement = new SettlementService(t.db, rulebook, { gatePassSecret: 'gate-pass-secret' });
    staffId = await createAccount(t.db, { name: 'Staff' });
    staff = { type: 'staff', id: staffId, name: 'Gate staff' };
    seller = await createAccount(t.db, { name: 'Seller' });
    alice = await createAccount(t.db, { name: 'Alice', verification: 'full' });
    bob = await createAccount(t.db, { name: 'Bob', verification: 'full' });
    await t.db.tx(SYSTEM, (c) =>
      c.query(
        `INSERT INTO payout.destination (account_id, method, currency, details_enc, details_hmac, verified_at, cooling_off_until)
         VALUES ($1, 'ecocash', 'USD', '\\x01', '\\x02', now(), now() - interval '1 day')`,
        [seller],
      ),
    );
  });
  afterAll(async () => {
    await t?.drop();
  });

  describe('A: deposit, bid, win, pay in one tap, collect, seller paid', () => {
    let lotId: string;
    let invoiceId: string;
    let gatePass: string;

    it('money in: Alice tops up by EcoCash, Bob pays cash at the Harare counter', async () => {
      await ecocashTopUp(alice, 70_000n);
      await payments.recordBranchCash(staff, { cashierId: staffId, branch: 'HRE', accountId: bob, currency: 'USD', amountMinor: 60_000n, receiptNumber: 'HRE-0001' });
      expect((await wallet(t.db, alice, 'USD')).availableMinor).toBe(70_000n);
      expect((await wallet(t.db, bob, 'USD')).availableMinor).toBe(60_000n);
    });

    it('both join a deposit auction in one tap; deposits are held and set their limits', async () => {
      const end = new Date(Date.now() + 2 * HOUR);
      const a = await createAuction(t.db, { createdBy: staffId, depositRequired: true, lots: [{ sellerId: seller, startingBidMinor: 5_000n, endsAt: end, title: 'Dell laptop' }] });
      lotId = a.lots[0]!.lotId;
      await bidding.openAuction(SYSTEM, a.auctionId);
      for (const who of [alice, bob]) {
        const j = await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: who, auctionId: a.auctionId, deposit: { USD: 50_000n } }));
        expect(j.decision.status).toBe('approved');
        expect(j.limits.USD?.limitMinor).toBe(500_000n); // US$500 deposit × 10
      }
      expect(await wallet(t.db, alice, 'USD')).toEqual({ currency: 'USD', availableMinor: 20_000n, heldMinor: 50_000n });

      expect(await bid(alice, a.lots[0]!.auctionLotId, 30_000n)).toMatchObject({ accepted: true });
      expect(await bid(bob, a.lots[0]!.auctionLotId, 25_000n)).toMatchObject({ accepted: true, receipt: { outcome: 'outbid', currentPriceMinor: 26_000n } });

      const closed = await bidding.closeDueLots(new Date(end.getTime() + 1_000));
      expect(closed[0]!.result).toEqual({ result: 'sold', winnerAccountId: alice, hammerMinor: 26_000n });

      const issued = await settlement.settleClosedAuction(a.auctionId);
      expect(issued).toEqual([{ invoiceId: expect.any(String), buyerId: alice, totalMinor: 33_930n }]); // 260 + 39 levy + 40.30 VAT
      invoiceId = issued[0]!.invoiceId;
      expect(await settlement.settleClosedAuction(a.auctionId)).toEqual([]); // idempotent
    });

    it('the invoice is ready at the close, itemised, and Bob’s deposit is back', async () => {
      const lines = await t.db.query<{ line_type: string; amount_minor: bigint }>('SELECT line_type, amount_minor FROM settlement.invoice_line WHERE invoice_id = $1 ORDER BY sort', [invoiceId]);
      expect(lines.rows.map((l) => [l.line_type, l.amount_minor])).toEqual([
        ['hammer', 26_000n],
        ['purchasers_levy', 3_900n],
        ['vat', 4_030n],
      ]);
      expect(await wallet(t.db, bob, 'USD')).toEqual({ currency: 'USD', availableMinor: 60_000n, heldMinor: 0n });
    });

    it('Alice pays in one tap: her deposit counts towards it, and she gets a gate pass', async () => {
      const paid = await settlement.payFromWallet(as(alice, 'Alice'), { invoiceId, accountId: alice, clientKey: 'pay-1' });
      expect(paid).toMatchObject({ paid: true, alreadyPaid: false });
      gatePass = (paid as { gatePassToken: string }).gatePassToken;
      expect(gatePass.length).toBeGreaterThan(20);
      expect(await wallet(t.db, alice, 'USD')).toEqual({ currency: 'USD', availableMinor: 70_000n - 33_930n, heldMinor: 0n });
      expect(await settlement.payFromWallet(as(alice, 'Alice'), { invoiceId, accountId: alice, clientKey: 'pay-1' })).toMatchObject({ paid: true, alreadyPaid: true });
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'commission_income' }, 'USD')).toBe(2_600n);
    });

    it('the gate pass releases the goods once, and schedules the seller payout after the claim window', async () => {
      expect(await settlement.releaseAtGate(staff, 'not-a-real-pass')).toEqual({ released: false, reason: 'invalid_pass' });
      const released = await settlement.releaseAtGate(staff, gatePass);
      expect(released).toMatchObject({ released: true, payoutsBlocked: [] });
      expect(await settlement.releaseAtGate(staff, gatePass)).toEqual({ released: false, reason: 'not_ready' });

      const p = await t.db.query<{ status: string; gross_minor: bigint; deductions_minor: bigint; net_minor: bigint; due_date: Date }>(
        'SELECT status, gross_minor, deductions_minor, net_minor, due_date FROM payout.payout WHERE id = $1',
        [(released as { payouts: string[] }).payouts[0]],
      );
      expect(p.rows[0]).toMatchObject({ status: 'scheduled', gross_minor: 26_000n, deductions_minor: 2_600n, net_minor: 23_400n });
      const days = (p.rows[0]!.due_date.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(1.5); // 48 h claim window + 24 h processing
    });

    it('finance pays the seller from the trust account; the lot is complete', async () => {
      await t.db.tx(SYSTEM, (c) => postJournal(c, gatewaySettlement({ settlementId: 'paynow-2026-11-20', gateway: 'paynow', currency: 'USD', amountMinor: 70_000n })));
      const payoutId = (await t.db.query<{ id: string }>('SELECT id FROM payout.payout WHERE seller_account_id = $1', [seller])).rows[0]!.id;
      await settlement.markPayoutPaid(staff, payoutId, 'ECO-REF-123');
      expect(await balance(t.db, { owner: { type: 'seller', id: seller }, purpose: 'seller_payable' }, 'USD')).toBe(0n);
      expect(await lotStates(lotId)).toEqual(['draft', 'listed', 'live', 'closed', 'invoiced', 'paid', 'released', 'paid_out']);
    });

    it('the books reconcile and every figure lands where the data model says', async () => {
      expect(await reconcileLedger(t.db)).toEqual([]);
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'tax_payable', sub: 'vat' }, 'USD')).toBe(4_030n);
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'tax_payable', sub: 'purchasers_levy' }, 'USD')).toBe(3_900n);
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'trust_bank' }, 'USD')).toBe(70_000n - 23_400n);
      expect(await balance(t.db, { owner: { type: 'branch', id: 'HRE' }, purpose: 'branch_cash' }, 'USD')).toBe(60_000n);
    });
  });

  describe('B: a winner who does not pay meets the default ladder', () => {
    let invoiceId: string;
    let lotId: string;
    let issuedAt: Date;

    it('Bob wins a lot he cannot pay for; paying fails cleanly and keeps his deposit held', async () => {
      const end = new Date(Date.now() + 2 * HOUR);
      const a = await createAuction(t.db, { createdBy: staffId, depositRequired: true, lots: [{ sellerId: seller, startingBidMinor: 70_000n, endsAt: end }] });
      lotId = a.lots[0]!.lotId;
      await bidding.openAuction(SYSTEM, a.auctionId);
      await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: bob, auctionId: a.auctionId, deposit: { USD: 50_000n } }));
      expect(await bid(bob, a.lots[0]!.auctionLotId, 80_000n)).toMatchObject({ accepted: true, receipt: { currentPriceMinor: 70_000n } });
      await bidding.closeDueLots(new Date(end.getTime() + 1_000));
      issuedAt = new Date();
      invoiceId = (await settlement.settleClosedAuction(a.auctionId, issuedAt))[0]!.invoiceId;

      const attempt = await settlement.payFromWallet(as(bob, 'Bob'), { invoiceId, accountId: bob, clientKey: 'bob-pay' });
      expect(attempt).toEqual({ paid: false, reason: 'insufficient_funds', shortfallMinor: 91_350n - 60_000n, availableMinor: 60_000n, totalMinor: 91_350n });
      expect(await wallet(t.db, bob, 'USD')).toEqual({ currency: 'USD', availableMinor: 10_000n, heldMinor: 50_000n }); // nothing moved
    });

    it('reminders go out at 12 h and 36 h, once each', async () => {
      expect(await settlement.queueDueReminders(new Date(issuedAt.getTime() + 11 * HOUR))).toBe(0);
      expect(await settlement.queueDueReminders(new Date(issuedAt.getTime() + 13 * HOUR))).toBe(1);
      expect(await settlement.queueDueReminders(new Date(issuedAt.getTime() + 14 * HOUR))).toBe(0);
      expect(await settlement.queueDueReminders(new Date(issuedAt.getTime() + 37 * HOUR))).toBe(1);
    });

    it('at the deadline: a warning, the invoice is overdue', async () => {
      const due = new Date(issuedAt.getTime() + 48 * HOUR);
      expect(await settlement.runDefaultLadder(new Date(due.getTime() - 60_000))).toEqual([]);
      expect(await settlement.runDefaultLadder(due)).toEqual([{ invoiceId, applied: ['warning'] }]);
      expect(await settlement.runDefaultLadder(due)).toEqual([]);
    });

    it('24 hours later: deposit forfeited, invoice cancelled, relist fee charged, account Restricted, lot back on sale', async () => {
      const later = new Date(issuedAt.getTime() + 72 * HOUR);
      expect(await settlement.runDefaultLadder(later)).toEqual([{ invoiceId, applied: ['deposit_forfeit', 'relist_fee', 'tier_drop'] }]);
      expect(await wallet(t.db, bob, 'USD')).toEqual({ currency: 'USD', availableMinor: 10_000n - 7_000n, heldMinor: 0n });
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'forfeiture_income' }, 'USD')).toBe(50_000n);
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'fee_income', sub: 'relist_fee' }, 'USD')).toBe(7_000n);
      const inv = await t.db.query<{ status: string }>('SELECT status FROM settlement.invoice WHERE id = $1', [invoiceId]);
      expect(inv.rows[0]!.status).toBe('defaulted');
      const acct = await t.db.query<{ tier: string }>('SELECT tier FROM identity.account WHERE id = $1', [bob]);
      expect(acct.rows[0]!.tier).toBe('restricted');
      const dc = await t.db.query<{ status: string }>('SELECT status FROM settlement.default_case WHERE invoice_id = $1', [invoiceId]);
      expect(dc.rows[0]!.status).toBe('completed');
      expect((await lotStates(lotId)).slice(-3)).toEqual(['invoiced', 'payment_overdue', 'listed']);
    });

    it('a Restricted bidder’s limit is now just their deposit', async () => {
      const snapshot = await rulebook.snapshot(versionId);
      const limit = await t.db.tx(SYSTEM, (c) => registrations.limit(c, bob, 'USD', false, snapshot));
      expect(limit.limitMinor).toBe(0n); // no deposit held, no free allowance when Restricted
    });

    it('the books still reconcile', async () => {
      expect(await reconcileLedger(t.db)).toEqual([]);
    });
  });

  describe('C: a vehicle is held until its title steps are done', () => {
    it('pays, is held at the gate, and is released only after ZRP, ZIMRA and CVR', async () => {
      await ecocashTopUp(alice, 300_000n);
      const end = new Date(Date.now() + 2 * HOUR);
      const a = await createAuction(t.db, { createdBy: staffId, depositRequired: true, lots: [{ sellerId: seller, category: 'vehicles', startingBidMinor: 100_000n, endsAt: end, title: 'Toyota Hilux' }] });
      const lotId = a.lots[0]!.lotId;
      await bidding.openAuction(SYSTEM, a.auctionId);
      const joined = await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: alice, auctionId: a.auctionId, deposit: { USD: 300_000n } }));
      expect(joined.decision.status).toBe('approved');
      const vehicle = { currency: 'USD' as const, taxClass: 'vehicle_standard', categoryPath: ['vehicles'], isVehicle: true };
      expect(await bid(alice, a.lots[0]!.auctionLotId, 150_000n, vehicle)).toMatchObject({ accepted: true });
      await bidding.closeDueLots(new Date(end.getTime() + 1_000));
      const { invoiceId, totalMinor } = (await settlement.settleClosedAuction(a.auctionId))[0]!;
      expect(totalMinor).toBe(130_500n);

      const paid = (await settlement.payFromWallet(as(alice, 'Alice'), { invoiceId, accountId: alice, clientKey: 'pay-vehicle' })) as { gatePassToken: string };
      expect(await settlement.releaseAtGate(staff, paid.gatePassToken)).toEqual({ released: false, reason: 'title_incomplete' });

      await t.db.tx({ ...staff, reason: 'title steps evidenced' }, async (c) => {
        await c.query(
          `UPDATE logistics.title_step SET status = 'done', evidence_object_key = 'evidence/' || step || '.pdf', completed_by = $2, completed_at = now()
            WHERE title_case_id = (SELECT id FROM logistics.title_case WHERE lot_id = $1)`,
          [lotId, staffId],
        );
        await c.query(`UPDATE logistics.title_case SET status = 'complete', completed_at = now() WHERE lot_id = $1`, [lotId]);
      });
      expect(await settlement.releaseAtGate(staff, paid.gatePassToken)).toMatchObject({ released: true });
      expect((await lotStates(lotId)).slice(-3)).toEqual(['paid', 'title_hold', 'released']);
      expect(await reconcileLedger(t.db)).toEqual([]);
    });
  });
});
