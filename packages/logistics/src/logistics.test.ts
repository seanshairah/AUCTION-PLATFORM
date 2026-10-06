import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccount,
  createTestDatabase,
  DB_TESTS_ENABLED,
  loadPublishedRuleSetForTests,
  readRuleSetDocument,
  RulebookStore,
  SYSTEM,
  type Actor,
  type TestDatabase,
} from '@abc/db';
import { balance, reconcileLedger, wallet } from '@abc/ledger';
import { QuoteError } from '@abc/quote';
import { RuleSnapshot, type RuleRecord } from '@abc/rules';
import { SettlementService } from '@abc/settlement';
import { bundleDeliveryQuote, expectedDeliveryDate, LogisticsService, slotTimes, storageAccrual } from './index';
import { addPartners, addPayoutDestination, createPaidInvoices, type PaidPurchase } from './testing';

const DOC = readRuleSetDocument();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const g = (key: string, value: unknown): RuleRecord => ({ key, scope: { type: 'global', ref: '*' }, value, provenance: 'assumption', source: 'TEST ONLY' });
const COMMISSION = g('commission.schedule', { basis: 'flat_band', bands: { USD: [{ from: 0, rateBp: 1000 }], ZWG: null }, minimumPerLot: { USD: 0, ZWG: null } });
const RATE_CARD = g('delivery.rate_card', { USD: { Harare: { small: 500, medium: 1_500, large: 4_000 }, Bulawayo: { small: 1_500, medium: 3_000, large: 6_000 } }, ZWG: {} });
const STORAGE_ON = g('storage.enabled', true);
const HOURS = { mon_fri: '09:00-15:00', sat: '09:00-12:00' };
const goods = { currency: 'USD' as const, taxClass: 'goods_standard', categoryPath: ['it'], isVehicle: false };

describe('logistics rules (pure)', () => {
  const snapshot = new RuleSnapshot('v', DOC.label, [...DOC.rules.filter((r) => r.key !== 'delivery.rate_card'), RATE_CARD]);

  it('cuts 30-minute slots from branch hours in Harare time: 12 on a weekday, 6 on Saturday, none on Sunday', () => {
    const friday8am = new Date('2026-11-20T06:00:00Z'); // 08:00 CAT
    const slots = slotTimes(HOURS, friday8am, 3, 30);
    const byDay = (d: string) => slots.filter((s) => s.startsAt.toISOString().startsWith(d));
    expect(byDay('2026-11-20')).toHaveLength(12);
    expect(byDay('2026-11-20')[0]!.startsAt.toISOString()).toBe('2026-11-20T07:00:00.000Z'); // 09:00 CAT
    expect(byDay('2026-11-20').at(-1)!.endsAt.toISOString()).toBe('2026-11-20T13:00:00.000Z'); // closes 15:00 CAT
    expect(byDay('2026-11-21')).toHaveLength(6);
    expect(byDay('2026-11-22')).toHaveLength(0);
    // Slots already started are not offered.
    expect(slotTimes(HOURS, new Date('2026-11-20T12:10:00Z'), 1, 30)).toHaveLength(1);
  });

  it('storage: free until the later of the collection deadline and the free hours, then a day or part day at 1 % of hammer', () => {
    const paid = new Date('2026-11-20T10:00:00Z');
    const off = storageAccrual({ clockFrom: paid, hammersMinor: [26_000n], snapshot, asOf: new Date(paid.getTime() + 10 * DAY) });
    expect(off).toMatchObject({ enabled: false, accruedMinor: 0n, days: 8 });
    expect(off.collectBy.toISOString()).toBe('2026-11-22T10:00:00.000Z');
    const on = new RuleSnapshot('v', DOC.label, [...DOC.rules.filter((r) => r.key !== 'storage.enabled'), STORAGE_ON]);
    const at = (h: number) => storageAccrual({ clockFrom: paid, hammersMinor: [26_000n, 4_000n], snapshot: on, asOf: new Date(paid.getTime() + h * HOUR) });
    expect(at(48)).toMatchObject({ days: 0, accruedMinor: 0n, dailyFeeMinor: 300n });
    expect(at(49)).toMatchObject({ days: 1, accruedMinor: 300n });
    expect(at(73)).toMatchObject({ days: 2, accruedMinor: 600n });
  });

  it('a bundled delivery is the most expensive lot delivery from quoteLot; vehicles cannot be delivered', () => {
    const q = bundleDeliveryQuote({
      lots: [{ pricing: goods, hammerMinor: 10_000n }, { pricing: { ...goods, categoryPath: ['furniture'] }, hammerMinor: 5_000n }],
      choice: { method: 'delivery', town: 'Harare', sizeClass: 'medium' }, snapshot, taxRates: DOC.taxRates.map((r) => ({ ...r, active: true })), at: new Date(),
    });
    expect(q).toMatchObject({ totalMinor: 1_500n, town: 'Harare', currency: 'USD' });
    expect(q.lines.map((l) => [l.type, l.amountMinor])).toEqual([['delivery', 1_500n]]);
    expect(() => bundleDeliveryQuote({
      lots: [{ pricing: { ...goods, categoryPath: ['vehicles'], isVehicle: true, taxClass: 'vehicle_standard' }, hammerMinor: 10_000n }],
      choice: { method: 'delivery', town: 'Harare', sizeClass: 'large' }, snapshot, taxRates: DOC.taxRates.map((r) => ({ ...r, active: true })), at: new Date(),
    })).toThrow(QuoteError);
  });

  it('next-day delivery before the 14:30 cut-off, the day after once it has passed', () => {
    expect(expectedDeliveryDate(new Date('2026-11-20T12:00:00Z'), snapshot)).toBe('2026-11-21'); // 14:00 CAT
    expect(expectedDeliveryDate(new Date('2026-11-20T13:00:00Z'), snapshot)).toBe('2026-11-22'); // 15:00 CAT
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('logistics against PostgreSQL', () => {
  let t: TestDatabase;
  let rulebook: RulebookStore;
  let settlement: SettlementService;
  let logistics: LogisticsService;
  let staff: Actor & { type: 'staff' };
  let seller: string;
  let buyers: string[];
  let paid: PaidPurchase[];
  const SECRET = 'gate-pass-secret';
  const as = (id: string): Actor & { type: 'account' } => ({ type: 'account', id, name: 'Buyer' });

  beforeAll(async () => {
    t = await createTestDatabase();
    await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true, overrides: [COMMISSION, RATE_CARD, STORAGE_ON] });
    rulebook = new RulebookStore(t.db);
    settlement = new SettlementService(t.db, rulebook, { gatePassSecret: SECRET });
    logistics = new LogisticsService(t.db, rulebook, settlement);
    const staffId = await createAccount(t.db, { name: 'Gate staff' });
    staff = { type: 'staff', id: staffId, name: 'Gate staff' };
    seller = await createAccount(t.db, { name: 'Seller' });
    await addPayoutDestination(t.db, seller);
    await addPartners(t.db);
    buyers = [];
    for (let i = 0; i < 5; i++) buyers.push(await createAccount(t.db, { name: `Buyer ${i}`, verification: 'full' }));
    paid = await createPaidInvoices(t.db, {
      staffId, sellerId: seller, gatePassSecret: SECRET,
      purchases: [
        { buyerId: buyers[0]!, lots: [{ title: 'Laptop', startingBidMinor: 26_000n }, { title: 'Monitor', startingBidMinor: 4_000n }] },
        { buyerId: buyers[1]!, lots: [{ title: 'Desk', category: 'furniture', startingBidMinor: 26_000n }], topUpMinor: 40_000n },
        { buyerId: buyers[2]!, lots: [{ title: 'Printer', startingBidMinor: 10_000n }] },
        { buyerId: buyers[3]!, lots: [{ title: 'Router', startingBidMinor: 5_000n }] },
        { buyerId: buyers[4]!, lots: [{ title: 'Pickup truck', category: 'vehicles', startingBidMinor: 200_000n }] },
      ],
    });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('a paid invoice has one collection bundling all its lots, ready, with a QR pass', async () => {
    const r = await t.db.query<{ status: string; method: string; lots: bigint }>(
      `SELECT c.status, c.method, (SELECT count(*) FROM logistics.collection_lot cl WHERE cl.collection_id = c.id) AS lots
         FROM logistics.collection c WHERE c.id = $1`,
      [paid[0]!.collectionId],
    );
    expect(r.rows[0]).toEqual({ status: 'ready', method: 'pickup', lots: 2n });
  });

  it('slots are generated from branch hours, once', async () => {
    const created = await logistics.ensureSlots(new Date());
    expect(created).toBeGreaterThan(20);
    expect(await logistics.ensureSlots(new Date())).toBe(0);
    const hre = await logistics.availableSlots('HRE');
    expect(hre!.length).toBeGreaterThan(10);
    expect(hre![0]).toMatchObject({ capacity: 6, booked: 0, available: 6 });
    expect(await logistics.availableSlots('NOPE')).toBeNull();
  });

  it('capacity holds when several buyers book the last places at the same moment', async () => {
    const slot = await t.db.tx(SYSTEM, async (c) =>
      (await c.query<{ id: string }>(
        `INSERT INTO logistics.collection_slot (branch_code, starts_at, ends_at, capacity) VALUES ('HRE', now() + interval '20 days', now() + interval '20 days 30 minutes', 2) RETURNING id`,
      )).rows[0]!.id,
    );
    const results = await Promise.all(paid.slice(0, 4).map((pu) => logistics.bookSlot(as(pu.buyerId), { collectionId: pu.collectionId, slotId: slot })));
    expect(results.filter((r) => r.booked)).toHaveLength(2);
    expect(results.filter((r) => !r.booked && r.reason === 'full')).toHaveLength(2);
  });

  it('booking, rebooking and idempotent retries; a full slot leaves the old booking in place', async () => {
    const slots = (await logistics.availableSlots('HRE'))!;
    const pu = paid[2]!;
    const first = await logistics.bookSlot(as(pu.buyerId), { collectionId: pu.collectionId, slotId: slots[0]!.id, clientKey: 'slot-key-1' });
    expect(first).toMatchObject({ booked: true, repeated: false }); // may move a booking left by the capacity test
    expect(await logistics.bookSlot(as(pu.buyerId), { collectionId: pu.collectionId, slotId: slots[0]!.id, clientKey: 'slot-key-1' })).toMatchObject({ booked: true, repeated: true });
    const moved = await logistics.bookSlot(as(pu.buyerId), { collectionId: pu.collectionId, slotId: slots[1]!.id });
    expect(moved).toMatchObject({ booked: true, rebooked: true });
    const live = await t.db.query<{ slot_id: string }>(`SELECT slot_id FROM logistics.slot_booking WHERE collection_id = $1 AND status = 'booked'`, [pu.collectionId]);
    expect(live.rows.map((r) => r.slot_id)).toEqual([slots[1]!.id]);
    const col = await t.db.query<{ status: string; slot_id: string }>('SELECT status, slot_id FROM logistics.collection WHERE id = $1', [pu.collectionId]);
    expect(col.rows[0]).toEqual({ status: 'scheduled', slot_id: slots[1]!.id });

    // Fill another slot, then try to move into it.
    const full = await t.db.tx(SYSTEM, async (c) =>
      (await c.query<{ id: string }>(`INSERT INTO logistics.collection_slot (branch_code, starts_at, ends_at, capacity) VALUES ('HRE', now() + interval '21 days', now() + interval '21 days 30 minutes', 1) RETURNING id`)).rows[0]!.id,
    );
    expect(await logistics.bookSlot(as(paid[3]!.buyerId), { collectionId: paid[3]!.collectionId, slotId: full })).toMatchObject({ booked: true });
    expect(await logistics.bookSlot(as(pu.buyerId), { collectionId: pu.collectionId, slotId: full })).toEqual({ booked: false, reason: 'full' });
    const still = await t.db.query<{ slot_id: string }>(`SELECT slot_id FROM logistics.slot_booking WHERE collection_id = $1 AND status = 'booked'`, [pu.collectionId]);
    expect(still.rows.map((r) => r.slot_id)).toEqual([slots[1]!.id]);
    // Someone else's collection, and BYO slots for an HRE collection, are refused.
    expect(await logistics.bookSlot(as(buyers[0]!), { collectionId: pu.collectionId, slotId: slots[2]!.id })).toEqual({ booked: false, reason: 'not_found' });
    const byo = (await logistics.availableSlots('BYO'))!;
    expect(await logistics.bookSlot(as(pu.buyerId), { collectionId: pu.collectionId, slotId: byo[0]!.id })).toEqual({ booked: false, reason: 'wrong_branch' });
  });

  it('reminders before a booked slot go out once each', async () => {
    const booking = await t.db.query<{ starts_at: Date }>(
      `SELECT s.starts_at FROM logistics.slot_booking b JOIN logistics.collection_slot s ON s.id = b.slot_id WHERE b.collection_id = $1 AND b.status = 'booked'`,
      [paid[2]!.collectionId],
    );
    const start = booking.rows[0]!.starts_at.getTime();
    const before = await logistics.queueSlotReminders(new Date(start - 25 * HOUR));
    const at24 = await logistics.queueSlotReminders(new Date(start - 23 * HOUR));
    const again = await logistics.queueSlotReminders(new Date(start - 23 * HOUR));
    const at2 = await logistics.queueSlotReminders(new Date(start - 1 * HOUR));
    expect([before >= 0, at24 >= 1, again, at2 >= 1]).toEqual([true, true, 0, true]);
    const events = await t.db.query<{ n: bigint }>(
      `SELECT count(*) AS n FROM core.outbox WHERE topic = 'collection.slot_reminder' AND aggregate_id = (SELECT id::text FROM logistics.slot_booking WHERE collection_id = $1 AND status = 'booked')`,
      [paid[2]!.collectionId],
    );
    expect(events.rows[0]!.n).toBe(2n);
  });

  it('storage accrues after the free period; release waits for it to be paid, then charges it once through the ledger', async () => {
    const pu = paid[1]!; // US$260 desk; wallet left after paying: 400.00 − 339.30 = 60.70
    expect((await wallet(t.db, pu.buyerId, 'USD')).availableMinor).toBe(6_070n);
    const clock = (await t.db.query<{ storage_clock_from: Date }>('SELECT storage_clock_from FROM logistics.collection WHERE id = $1', [pu.collectionId])).rows[0]!.storage_clock_from;
    const day30 = new Date(clock.getTime() + 48 * HOUR + 24 * DAY - HOUR);
    const accrued = await logistics.storage(t.db, pu.collectionId, day30);
    expect(accrued).toMatchObject({ enabled: true, days: 24, dailyFeeMinor: 260n, accruedMinor: 6_240n });
    expect(await logistics.releaseAtGate(staff, pu.gatePassToken, day30)).toEqual({ released: false, reason: 'charges_due', amountMinor: 6_240n, currency: 'USD' });
    expect((await wallet(t.db, pu.buyerId, 'USD')).availableMinor).toBe(6_070n); // nothing moved

    const day3 = new Date(clock.getTime() + 48 * HOUR + 2 * DAY + HOUR);
    const released = await logistics.releaseAtGate(staff, pu.gatePassToken, day3);
    expect(released).toMatchObject({ released: true });
    expect((await wallet(t.db, pu.buyerId, 'USD')).availableMinor).toBe(6_070n - 780n);
    expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'fee_income', sub: 'storage' }, 'USD')).toBe(780n);
    const charge = await t.db.query<{ days: number; amount_minor: bigint }>('SELECT days, amount_minor FROM logistics.storage_charge WHERE collection_id = $1', [pu.collectionId]);
    expect(charge.rows[0]).toEqual({ days: 3, amount_minor: 780n });
    expect(await logistics.releaseAtGate(staff, pu.gatePassToken, day3)).toEqual({ released: false, reason: 'not_ready' });
  });

  it('delivery: quoted by quoteLot, re-checked at booking, charged from the wallet, idempotent', async () => {
    const pu = paid[0]!;
    const quote = await logistics.quoteDelivery(pu.buyerId, { collectionId: pu.collectionId, town: 'Harare', sizeClass: 'large' });
    expect(quote).toMatchObject({ ok: true, quote: { totalMinor: 4_000n, town: 'Harare' } });
    expect(await logistics.quoteDelivery(pu.buyerId, { collectionId: pu.collectionId, town: 'Mutare', sizeClass: 'large' })).toMatchObject({ ok: false, reason: 'delivery_unavailable' });
    expect(await logistics.quoteDelivery(paid[4]!.buyerId, { collectionId: paid[4]!.collectionId, town: 'Harare', sizeClass: 'large' })).toMatchObject({ ok: false, reason: 'delivery_unavailable' });

    const address = { line1: '12 Samora Machel Ave', suburb: 'Avondale', phone: '+263771234567' };
    const stale = await logistics.bookDelivery(as(pu.buyerId), { collectionId: pu.collectionId, town: 'Harare', sizeClass: 'large', address, quotedTotalMinor: 1_500n, clientKey: 'deliv-1' });
    expect(stale).toMatchObject({ booked: false, reason: 'price_changed', quote: { totalMinor: 4_000n } });

    const before = (await wallet(t.db, pu.buyerId, 'USD')).availableMinor;
    const booked = await logistics.bookDelivery(as(pu.buyerId), { collectionId: pu.collectionId, town: 'Harare', sizeClass: 'large', address, quotedTotalMinor: 4_000n, clientKey: 'deliv-1' });
    expect(booked).toMatchObject({ booked: true, chargeMinor: 4_000n, partner: { name: 'Test Courier' }, repeated: false });
    expect(await logistics.bookDelivery(as(pu.buyerId), { collectionId: pu.collectionId, town: 'Harare', sizeClass: 'large', address, quotedTotalMinor: 4_000n, clientKey: 'deliv-1' })).toMatchObject({ booked: true, repeated: true });
    expect((await wallet(t.db, pu.buyerId, 'USD')).availableMinor).toBe(before - 4_000n);
    expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'delivery_income' }, 'USD')).toBe(4_000n);
    const col = await t.db.query<{ method: string; status: string }>('SELECT method, status FROM logistics.collection WHERE id = $1', [pu.collectionId]);
    expect(col.rows[0]).toEqual({ method: 'delivery', status: 'scheduled' });
  });

  it('the courier collects at the branch (release and payouts), then delivers with proof', async () => {
    const pu = paid[0]!;
    const d = (await t.db.query<{ id: string }>('SELECT id FROM logistics.delivery WHERE collection_id = $1', [pu.collectionId])).rows[0]!.id;
    expect(await logistics.updateDelivery(staff, d, { status: 'in_transit' })).toMatchObject({ updated: false, reason: 'not_allowed' });
    const handed = await logistics.handOverToCourier(staff, d);
    expect(handed).toMatchObject({ released: true, payouts: [expect.any(String)] });
    expect(await logistics.updateDelivery(staff, d, { status: 'in_transit', note: 'Left the Harare depot' })).toEqual({ updated: true, status: 'in_transit' });
    expect(await logistics.updateDelivery(staff, d, { status: 'delivered' })).toMatchObject({ updated: false, reason: 'proof_required' });
    expect(await logistics.updateDelivery(staff, d, { status: 'delivered', proofObjectKey: 'proof/delivery-1.jpg' })).toEqual({ updated: true, status: 'delivered' });
    const col = await t.db.query<{ status: string }>('SELECT status FROM logistics.collection WHERE id = $1', [pu.collectionId]);
    expect(col.rows[0]!.status).toBe('delivered');
    const events = await t.db.query<{ status: string }>('SELECT status FROM logistics.delivery_event WHERE delivery_id = $1 ORDER BY id', [d]);
    expect(events.rows.map((e) => e.status)).toEqual(['booked', 'collected', 'in_transit', 'delivered']);
  });

  it('a delivery cancelled before pickup is refunded in full and the goods wait for collection again', async () => {
    const pu = paid[3]!;
    const before = (await wallet(t.db, pu.buyerId, 'USD')).availableMinor;
    const b = await logistics.bookDelivery(as(pu.buyerId), { collectionId: pu.collectionId, town: 'Harare', sizeClass: 'small', address: { line1: '1 Test Rd' }, quotedTotalMinor: 500n, clientKey: 'deliv-2' });
    expect(b).toMatchObject({ booked: true });
    const slotBooking = await t.db.query(`SELECT 1 FROM logistics.slot_booking WHERE collection_id = $1 AND status = 'booked'`, [pu.collectionId]);
    expect(slotBooking.rowCount).toBe(0); // the pickup slot was released
    const id = (b as { deliveryId: string }).deliveryId;
    expect(await logistics.updateDelivery(staff, id, { status: 'cancelled' })).toMatchObject({ updated: false, reason: 'note_required' });
    expect(await logistics.updateDelivery(staff, id, { status: 'cancelled', note: 'Buyer will collect instead' })).toEqual({ updated: true, status: 'cancelled' });
    expect((await wallet(t.db, pu.buyerId, 'USD')).availableMinor).toBe(before);
    const col = await t.db.query<{ method: string; status: string }>('SELECT method, status FROM logistics.collection WHERE id = $1', [pu.collectionId]);
    expect(col.rows[0]).toEqual({ method: 'pickup', status: 'ready' });
  });

  it('my purchases: lines, collection, gate pass, storage clock and vehicle title progress', async () => {
    const mine = await logistics.purchases(buyers[4]!);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.lots[0]).toMatchObject({ isVehicle: true, state: 'title_hold', titleCase: { status: 'open', done: 0, total: 3 } });
    expect(mine[0]!.collection).toMatchObject({ status: 'ready', gatePass: 'valid', branch: 'HRE', storage: { enabled: true, accruedMinor: 0n } });
    const delivered = await logistics.purchases(buyers[0]!);
    expect(delivered[0]!.collection).toMatchObject({ status: 'delivered', gatePass: 'used', delivery: { status: 'delivered', chargeMinor: 4_000n } });
    expect(delivered[0]!.lots.map((l) => l.lines.map((x) => x.type))).toEqual([['hammer', 'purchasers_levy', 'vat'], ['hammer', 'purchasers_levy', 'vat']]);
  });

  it('the books reconcile', async () => {
    expect(await reconcileLedger(t.db)).toEqual([]);
  });
});
