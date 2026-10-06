import { randomUUID } from 'node:crypto';
import type { Currency } from '@abc/domain';
import { big, Db, isUniqueViolation, run, type Actor, type Client, type Queryable, type RulebookStore } from '@abc/db';
import { deliveryCharge, postJournal, reversal, storageFee, wallet } from '@abc/ledger';
import { lotPricing } from '@abc/limits';
import { QuoteError, type QuoteLine } from '@abc/quote';
import type { RuleSnapshot } from '@abc/rules';
import type { ReleaseCheck, ReleaseResult, SettlementService } from '@abc/settlement';
import {
  bundleDeliveryQuote,
  DELIVERY_TRANSITIONS,
  expectedDeliveryDate,
  slotReminderTimes,
  slotTimes,
  storageAccrual,
  type DeliveryQuote,
  type OpeningHours,
  type StorageAccrual,
} from './logistics';

/**
 * Logistics service (docs/15-logistics.md): collection slots, the storage clock,
 * courier delivery and release at the gate. It builds on the settlement module:
 * paying an invoice already creates the collection (all the invoice's lots, status
 * ready) with its QR gate pass, and the gate release, payouts and title hold stay
 * in SettlementService. Money moves only through ledger recipes.
 */

type Account = Actor & { type: 'account' };
type Staff = Actor & { type: 'staff' };
const SYSTEM_LOGISTICS: Actor = { type: 'system', id: 'logistics', name: 'Logistics' };

async function outbox(c: Client, topic: string, aggregateType: string, aggregateId: string, payload: unknown): Promise<void> {
  await c.query('INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4::jsonb)', [
    topic,
    aggregateType,
    aggregateId,
    JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ]);
}

export interface SlotView {
  id: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  booked: number;
  available: number;
}

export type BookSlotResult =
  | { booked: true; bookingId: string; slot: { id: string; startsAt: Date; endsAt: Date }; rebooked: boolean; repeated: boolean }
  | { booked: false; reason: 'not_found' | 'not_bookable' | 'wrong_branch' | 'past' | 'full' };

export type DeliveryQuoteResult =
  | { ok: true; quote: DeliveryQuote; expectedOn: string }
  | { ok: false; reason: 'not_found' | 'not_deliverable' | 'delivery_unavailable'; message: string };

export type BookDeliveryResult =
  | { booked: true; deliveryId: string; chargeMinor: bigint; currency: Currency; partner: { name: string; phone: string }; expectedOn: string; repeated: boolean }
  | { booked: false; reason: 'not_found' | 'not_deliverable' | 'delivery_unavailable' | 'no_courier'; message: string }
  | { booked: false; reason: 'price_changed'; message: string; quote: DeliveryQuote }
  | { booked: false; reason: 'insufficient_funds'; message: string; shortfallMinor: bigint; currency: Currency };

export type DeliveryStatus = 'booked' | 'collected' | 'in_transit' | 'delivered' | 'failed' | 'cancelled';

interface CollectionRow {
  id: string;
  invoice_id: string;
  status: string;
  method: string;
  buyer_account_id: string;
  currency: Currency;
  rule_version_id: string;
  storage_clock_from: Date | null;
  released_at: Date | null;
  branch: string;
}

const COLLECTION_SQL = `
  SELECT c.id, c.invoice_id, c.status, c.method, i.buyer_account_id, i.currency, i.rule_version_id, c.storage_clock_from, c.released_at,
         (SELECT l.location_branch FROM logistics.collection_lot cl JOIN catalogue.lot l ON l.id = cl.lot_id
           WHERE cl.collection_id = c.id ORDER BY l.lot_ref LIMIT 1) AS branch
    FROM logistics.collection c JOIN settlement.invoice i ON i.id = c.invoice_id
   WHERE c.id = $1`;

export class LogisticsService {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    private readonly settlement: SettlementService,
  ) {}

  private async activeSnapshot(at: Date, c?: Client): Promise<RuleSnapshot> {
    return this.rulebook.snapshot(await this.rulebook.activeVersionId(at, c), c);
  }

  private async collection(q: Queryable, collectionId: string, lock = false): Promise<CollectionRow | null> {
    if (!/^[0-9a-f-]{36}$/.test(collectionId)) return null;
    const r = await run<CollectionRow>(q, COLLECTION_SQL + (lock ? ' FOR UPDATE OF c' : ''), [collectionId]);
    return r.rows[0] ?? null;
  }

  private async lotsOf(q: Queryable, collectionId: string, invoiceId: string): Promise<Array<{ lot_id: string; hammer: bigint; is_vehicle: boolean }>> {
    const r = await run<{ lot_id: string; hammer: bigint; is_vehicle: boolean }>(
      q,
      `SELECT cl.lot_id, il.amount_minor AS hammer, l.is_vehicle
         FROM logistics.collection_lot cl
         JOIN catalogue.lot l ON l.id = cl.lot_id
         JOIN settlement.invoice_line il ON il.lot_id = cl.lot_id AND il.invoice_id = $2 AND il.line_type = 'hammer'
        WHERE cl.collection_id = $1 ORDER BY l.lot_ref`,
      [collectionId, invoiceId],
    );
    return r.rows;
  }

  // --- Collection slots ------------------------------------------------------------------

  /**
   * Creates the collection slots for the coming days from each branch's opening hours
   * (rule logistics.collection_slot). Idempotent: existing slots are kept as they are.
   */
  async ensureSlots(now: Date = new Date(), branchCode?: string): Promise<number> {
    const snapshot = await this.activeSnapshot(now);
    const rule = snapshot.get('logistics.collection_slot');
    return this.db.tx(SYSTEM_LOGISTICS, async (c) => {
      const branches = await c.query<{ code: string; opening_hours: OpeningHours }>(
        'SELECT code, opening_hours FROM core.branch WHERE $1::text IS NULL OR code = $1 ORDER BY code',
        [branchCode ?? null],
      );
      let created = 0;
      for (const b of branches.rows) {
        for (const s of slotTimes(b.opening_hours, now, rule.bookAheadDays, rule.minutes)) {
          const r = await c.query(
            `INSERT INTO logistics.collection_slot (branch_code, starts_at, ends_at, capacity) VALUES ($1, $2, $3, $4)
             ON CONFLICT (branch_code, starts_at) DO NOTHING`,
            [b.code, s.startsAt, s.endsAt, rule.capacity],
          );
          created += r.rowCount ?? 0;
        }
      }
      return created;
    });
  }

  /** Bookable slots at a branch from now to the booking horizon, with places left. */
  async availableSlots(branchCode: string, now: Date = new Date()): Promise<SlotView[] | null> {
    const branch = await this.db.query('SELECT 1 FROM core.branch WHERE code = $1', [branchCode]);
    if (!branch.rowCount) return null;
    const horizon = (await this.activeSnapshot(now)).get('logistics.collection_slot').bookAheadDays;
    const r = await this.db.query<{ id: string; starts_at: Date; ends_at: Date; capacity: number; booked: bigint }>(
      `SELECT s.id, s.starts_at, s.ends_at, s.capacity,
              (SELECT count(*) FROM logistics.slot_booking b WHERE b.slot_id = s.id AND b.status = 'booked') AS booked
         FROM logistics.collection_slot s
        WHERE s.branch_code = $1 AND s.starts_at > $2 AND s.starts_at < $3
        ORDER BY s.starts_at`,
      [branchCode, now, new Date(now.getTime() + (horizon + 1) * 86_400_000)],
    );
    return r.rows.map((s) => ({
      id: s.id,
      startsAt: s.starts_at,
      endsAt: s.ends_at,
      capacity: s.capacity,
      booked: Number(s.booked),
      available: Math.max(0, s.capacity - Number(s.booked)),
    }));
  }

  /**
   * Books (or rebooks) the collection slot for a paid collection. Capacity holds under
   * simultaneous bookings: the database locks the slot row and counts live bookings.
   * Rebooking cancels the old booking in the same transaction, so a full slot leaves
   * the old booking in place.
   */
  async bookSlot(account: Account, p: { collectionId: string; slotId: string; clientKey?: string }, now: Date = new Date()): Promise<BookSlotResult> {
    try {
      return await this.db.tx(account, async (c): Promise<BookSlotResult> => {
        const col = await this.collection(c, p.collectionId, true);
        if (!col || col.buyer_account_id !== account.id) return { booked: false, reason: 'not_found' };
        if (p.clientKey) {
          const prior = await c.query<{ id: string; slot_id: string; starts_at: Date; ends_at: Date }>(
            `SELECT b.id, b.slot_id, s.starts_at, s.ends_at FROM logistics.slot_booking b JOIN logistics.collection_slot s ON s.id = b.slot_id
              WHERE b.account_id = $1 AND b.client_key = $2`,
            [account.id, p.clientKey],
          );
          const x = prior.rows[0];
          if (x) return { booked: true, bookingId: x.id, slot: { id: x.slot_id, startsAt: x.starts_at, endsAt: x.ends_at }, rebooked: false, repeated: true };
        }
        if (!['ready', 'scheduled'].includes(col.status) || col.method !== 'pickup') return { booked: false, reason: 'not_bookable' };
        if (!/^[0-9a-f-]{36}$/.test(p.slotId)) return { booked: false, reason: 'not_found' };
        const slot = (await c.query<{ id: string; branch_code: string; starts_at: Date; ends_at: Date }>(
          'SELECT id, branch_code, starts_at, ends_at FROM logistics.collection_slot WHERE id = $1',
          [p.slotId],
        )).rows[0];
        if (!slot) return { booked: false, reason: 'not_found' };
        if (slot.starts_at.getTime() <= now.getTime()) return { booked: false, reason: 'past' };
        if (slot.branch_code !== col.branch) return { booked: false, reason: 'wrong_branch' };

        const current = (await c.query<{ id: string; slot_id: string }>(
          `SELECT id, slot_id FROM logistics.slot_booking WHERE collection_id = $1 AND status = 'booked'`,
          [col.id],
        )).rows[0];
        if (current?.slot_id === slot.id) {
          return { booked: true, bookingId: current.id, slot: { id: slot.id, startsAt: slot.starts_at, endsAt: slot.ends_at }, rebooked: false, repeated: true };
        }
        if (current) await c.query(`UPDATE logistics.slot_booking SET status = 'cancelled', cancelled_at = $2 WHERE id = $1`, [current.id, now]);
        const b = await c.query<{ id: string }>(
          'INSERT INTO logistics.slot_booking (collection_id, slot_id, account_id, client_key) VALUES ($1, $2, $3, $4) RETURNING id',
          [col.id, slot.id, account.id, p.clientKey ?? null],
        );
        await c.query(`UPDATE logistics.collection SET slot_id = $2, status = 'scheduled' WHERE id = $1`, [col.id, slot.id]);
        await outbox(c, 'collection.slot_booked', 'collection', col.id, { slotId: slot.id, startsAt: slot.starts_at, rebooked: Boolean(current) });
        return { booked: true, bookingId: b.rows[0]!.id, slot: { id: slot.id, startsAt: slot.starts_at, endsAt: slot.ends_at }, rebooked: Boolean(current), repeated: false };
      });
    } catch (e) {
      if ((e as Error).message?.includes('is full')) return { booked: false, reason: 'full' };
      if (isUniqueViolation(e) && p.clientKey) return this.bookSlot(account, p, now); // a concurrent retry with the same key won
      throw e;
    }
  }

  /** Queues a reminder before each booked slot (rule logistics.slot_reminder_hours), once each. */
  async queueSlotReminders(now: Date = new Date()): Promise<number> {
    const snapshot = await this.activeSnapshot(now);
    const maxHours = Math.max(0, ...snapshot.get('logistics.slot_reminder_hours'));
    return this.db.tx(SYSTEM_LOGISTICS, async (c) => {
      const due = await c.query<{ id: string; collection_id: string; account_id: string; starts_at: Date; branch_code: string }>(
        `SELECT b.id, b.collection_id, b.account_id, s.starts_at, s.branch_code
           FROM logistics.slot_booking b JOIN logistics.collection_slot s ON s.id = b.slot_id
          WHERE b.status = 'booked' AND s.starts_at > $1 AND s.starts_at <= $2`,
        [now, new Date(now.getTime() + maxHours * 3_600_000)],
      );
      let queued = 0;
      for (const b of due.rows) {
        for (const r of slotReminderTimes(b.starts_at, snapshot)) {
          if (r.at > now) continue;
          const exists = await c.query(
            `SELECT 1 FROM core.outbox WHERE topic = 'collection.slot_reminder' AND aggregate_id = $1 AND payload->>'hoursBefore' = $2`,
            [b.id, String(r.hoursBefore)],
          );
          if (exists.rowCount) continue;
          await outbox(c, 'collection.slot_reminder', 'slot_booking', b.id, {
            hoursBefore: r.hoursBefore, collectionId: b.collection_id, accountId: b.account_id, startsAt: b.starts_at, branch: b.branch_code,
          });
          queued++;
        }
      }
      return queued;
    });
  }

  // --- Storage clock ---------------------------------------------------------------------

  /** The storage clock for a collection as of `asOf` (read model; nothing is charged here). */
  async storage(q: Queryable, collectionId: string, asOf: Date = new Date()): Promise<StorageAccrual | null> {
    const col = await this.collection(q, collectionId);
    if (!col || !col.storage_clock_from) return null;
    const snapshot = await this.rulebook.snapshot(col.rule_version_id, clientOf(q));
    const lots = await this.lotsOf(q, col.id, col.invoice_id);
    return storageAccrual({ clockFrom: col.storage_clock_from, hammersMinor: lots.map((l) => l.hammer), snapshot, asOf: col.released_at ?? asOf });
  }

  /**
   * Runs inside the gate release: charges accrued storage from the wallet once, or
   * refuses the release with the amount due if the wallet cannot cover it.
   */
  private readonly storageCheck: ReleaseCheck = async (c, collection, now) => {
    const accrual = await this.storage(c, collection.id, now);
    if (!accrual || accrual.accruedMinor === 0n) return null;
    const w = await wallet(c, collection.buyerId, collection.currency);
    if (w.availableMinor < accrual.accruedMinor) return { chargesDueMinor: accrual.accruedMinor };
    const journalId = await postJournal(c, storageFee({ collectionId: collection.id, buyerId: collection.buyerId, currency: collection.currency, amountMinor: accrual.accruedMinor, days: accrual.days }));
    await c.query(
      'INSERT INTO logistics.storage_charge (collection_id, currency, days, amount_minor, journal_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (collection_id) DO NOTHING',
      [collection.id, collection.currency, accrual.days, big(accrual.accruedMinor), journalId],
    );
    await outbox(c, 'storage.charged', 'collection', collection.id, { days: accrual.days, amountMinor: accrual.accruedMinor });
    return null;
  };

  /** Staff scan the buyer's QR pass at the gate (the settlement flow), after any storage is paid. */
  releaseAtGate(staff: Staff, token: string, now: Date = new Date()): Promise<ReleaseResult> {
    return this.settlement.releaseAtGate(staff, token, now, this.storageCheck);
  }

  // --- Delivery --------------------------------------------------------------------------

  private async quoteFor(q: Queryable, col: CollectionRow, choice: { town: string; sizeClass: 'small' | 'medium' | 'large' }, at: Date): Promise<DeliveryQuote> {
    const client = clientOf(q);
    const snapshot = await this.rulebook.snapshot(col.rule_version_id, client);
    const taxRates = await this.rulebook.taxRates(client);
    const lots = await this.lotsOf(q, col.id, col.invoice_id);
    const priced = [];
    for (const l of lots) priced.push({ pricing: await lotPricing(q, l.lot_id), hammerMinor: l.hammer });
    return bundleDeliveryQuote({ lots: priced, choice: { method: 'delivery', ...choice }, snapshot, taxRates, at });
  }

  /** The delivery price for a paid collection: the same quoteLot delivery lines the lot page shows (R2). */
  async quoteDelivery(accountId: string, p: { collectionId: string; town: string; sizeClass: 'small' | 'medium' | 'large' }, now: Date = new Date()): Promise<DeliveryQuoteResult> {
    const col = await this.collection(this.db, p.collectionId);
    if (!col || col.buyer_account_id !== accountId) return { ok: false, reason: 'not_found', message: 'We could not find that collection.' };
    if (!['ready', 'scheduled'].includes(col.status)) return { ok: false, reason: 'not_deliverable', message: 'These goods are no longer waiting at the branch.' };
    try {
      const quote = await this.quoteFor(this.db, col, p, now);
      const snapshot = await this.rulebook.snapshot(col.rule_version_id);
      return { ok: true, quote, expectedOn: expectedDeliveryDate(now, snapshot) };
    } catch (e) {
      if (e instanceof QuoteError && e.code === 'DELIVERY_UNAVAILABLE') return { ok: false, reason: 'delivery_unavailable', message: e.message };
      throw e;
    }
  }

  /**
   * Books door delivery with a courier partner and charges it from the wallet. The
   * client sends the total it showed; if the price has changed nothing is booked
   * (the bill can never differ from the screen). Idempotent on the client key.
   */
  async bookDelivery(
    account: Account,
    p: { collectionId: string; town: string; sizeClass: 'small' | 'medium' | 'large'; address: Record<string, unknown>; quotedTotalMinor: bigint; clientKey: string; partnerId?: string },
    now: Date = new Date(),
  ): Promise<BookDeliveryResult> {
    try {
      return await this.db.tx(account, async (c): Promise<BookDeliveryResult> => {
        const prior = await c.query<{ id: string; charge_minor: bigint; currency: Currency; booked_at: Date; name: string; phone_e164: string; rule_version_id: string }>(
          `SELECT d.id, d.charge_minor, d.currency, d.booked_at, d.rule_version_id, p.name, p.phone_e164
             FROM logistics.delivery d JOIN logistics.partner p ON p.id = d.partner_id WHERE d.account_id = $1 AND d.client_key = $2`,
          [account.id, p.clientKey],
        );
        if (prior.rows[0]) {
          const d = prior.rows[0];
          const snapshot = await this.rulebook.snapshot(d.rule_version_id, c);
          return { booked: true, deliveryId: d.id, chargeMinor: d.charge_minor, currency: d.currency, partner: { name: d.name, phone: d.phone_e164 }, expectedOn: expectedDeliveryDate(d.booked_at, snapshot), repeated: true };
        }
        const col = await this.collection(c, p.collectionId, true);
        if (!col || col.buyer_account_id !== account.id) return { booked: false, reason: 'not_found', message: 'We could not find that collection.' };
        if (!['ready', 'scheduled'].includes(col.status)) return { booked: false, reason: 'not_deliverable', message: 'These goods are no longer waiting at the branch.' };
        const live = await c.query(`SELECT 1 FROM logistics.delivery WHERE collection_id = $1 AND status NOT IN ('cancelled', 'failed')`, [col.id]);
        if (live.rowCount) return { booked: false, reason: 'not_deliverable', message: 'A delivery is already booked for these goods.' };

        let quote: DeliveryQuote;
        try {
          quote = await this.quoteFor(c, col, p, now);
        } catch (e) {
          if (e instanceof QuoteError && e.code === 'DELIVERY_UNAVAILABLE') return { booked: false, reason: 'delivery_unavailable', message: e.message };
          throw e;
        }
        if (quote.totalMinor !== p.quotedTotalMinor) {
          return { booked: false, reason: 'price_changed', message: 'The delivery price changed since you looked. Check the new price and confirm again.', quote };
        }
        const partner = (await c.query<{ id: string; name: string; phone_e164: string }>(
          `SELECT id, name, phone_e164 FROM logistics.partner
            WHERE kind = 'courier' AND active AND $1 = ANY(branches) AND ($2::uuid IS NULL OR id = $2::uuid)
            ORDER BY name LIMIT 1`,
          [col.branch, p.partnerId ?? null],
        )).rows[0];
        if (!partner) return { booked: false, reason: 'no_courier', message: 'No courier partner delivers from this branch yet. You can book a collection slot instead.' };

        const w = await wallet(c, account.id, col.currency);
        if (w.availableMinor < quote.totalMinor) {
          return { booked: false, reason: 'insufficient_funds', message: 'Top up your wallet to pay for delivery.', shortfallMinor: quote.totalMinor - w.availableMinor, currency: col.currency };
        }
        const deliveryId = randomUUID();
        const journalId = await postJournal(c, deliveryCharge({ deliveryId, buyerId: account.id, currency: col.currency, lines: chargeLines(quote.lines) }));
        await c.query(
          `INSERT INTO logistics.delivery (id, collection_id, partner_id, account_id, town, size_class, address, currency, charge_minor, quote_lines,
                                           rule_version_id, charge_journal_id, client_key, booked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11, $12, $13, $14)`,
          [deliveryId, col.id, partner.id, account.id, p.town, p.sizeClass, JSON.stringify(p.address), col.currency, big(quote.totalMinor),
           JSON.stringify(quote.lines, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), quote.ruleVersionId, journalId, p.clientKey, now],
        );
        await c.query('INSERT INTO logistics.delivery_event (delivery_id, status, note, recorded_by) VALUES ($1, $2, $3, $4)', [deliveryId, 'booked', `Courier ${partner.name}`, account.id]);
        // A pickup slot is no longer needed.
        await c.query(`UPDATE logistics.slot_booking SET status = 'cancelled', cancelled_at = $2 WHERE collection_id = $1 AND status = 'booked'`, [col.id, now]);
        await c.query(
          `UPDATE logistics.collection SET method = 'delivery', delivery_address = $2::jsonb, slot_id = NULL, status = 'scheduled' WHERE id = $1`,
          [col.id, JSON.stringify({ ...p.address, town: p.town })],
        );
        await outbox(c, 'delivery.booked', 'delivery', deliveryId, { collectionId: col.id, partnerId: partner.id, town: p.town, sizeClass: p.sizeClass, chargeMinor: quote.totalMinor });
        const snapshot = await this.rulebook.snapshot(col.rule_version_id, c);
        return {
          booked: true, deliveryId, chargeMinor: quote.totalMinor, currency: col.currency,
          partner: { name: partner.name, phone: partner.phone_e164 }, expectedOn: expectedDeliveryDate(now, snapshot), repeated: false,
        };
      });
    } catch (e) {
      if (isUniqueViolation(e)) return this.bookDelivery(account, p, now); // a concurrent retry with the same key won
      throw e;
    }
  }

  /**
   * ABC staff hand the goods to the courier: the collection is released without the
   * buyer's QR pass (storage first, title hold and payouts as at the gate), and the
   * delivery becomes "collected".
   */
  async handOverToCourier(staff: Staff, deliveryId: string, now: Date = new Date()): Promise<ReleaseResult | { released: false; reason: 'not_found' | 'not_booked' }> {
    const d = (await this.db.query<{ collection_id: string; status: string }>('SELECT collection_id, status FROM logistics.delivery WHERE id = $1', [deliveryId])).rows[0];
    if (!d) return { released: false, reason: 'not_found' };
    if (d.status !== 'booked') return { released: false, reason: 'not_booked' };
    return this.settlement.releaseCollection(staff, d.collection_id, now, async (c, collection, at) => {
      const due = await this.storageCheck(c, collection, at);
      if (due) return due;
      const r = await c.query(`UPDATE logistics.delivery SET status = 'collected' WHERE id = $1 AND status = 'booked'`, [deliveryId]);
      if (r.rowCount) await c.query('INSERT INTO logistics.delivery_event (delivery_id, status, note, recorded_by) VALUES ($1, $2, $3, $4)', [deliveryId, 'collected', 'Handed to the courier at the branch', staff.id]);
      await outbox(c, 'delivery.status_changed', 'delivery', deliveryId, { status: 'collected' });
      return null;
    });
  }

  /**
   * Courier status updates recorded by staff, with proof of delivery (an object key for
   * a photo or signed note). Cancelling before pickup refunds the charge in full.
   */
  async updateDelivery(
    staff: Staff,
    deliveryId: string,
    p: { status: Exclude<DeliveryStatus, 'booked' | 'collected'>; proofObjectKey?: string; note?: string },
    now: Date = new Date(),
  ): Promise<{ updated: true; status: DeliveryStatus } | { updated: false; reason: 'not_found' | 'not_allowed' | 'proof_required' | 'note_required'; message: string }> {
    return this.db.tx(staff, async (c) => {
      const d = (await c.query<{ id: string; collection_id: string; status: DeliveryStatus; account_id: string; currency: Currency; quote_lines: Array<{ type: QuoteLine['type']; amountMinor: string }>; charge_journal_id: string }>(
        'SELECT id, collection_id, status, account_id, currency, quote_lines, charge_journal_id FROM logistics.delivery WHERE id = $1 FOR UPDATE',
        [deliveryId],
      )).rows[0];
      if (!d) return { updated: false, reason: 'not_found', message: 'We could not find that delivery.' } as const;
      if (d.status === p.status) return { updated: true, status: d.status } as const;
      if (!DELIVERY_TRANSITIONS[d.status]!.includes(p.status)) {
        return { updated: false, reason: 'not_allowed', message: `A delivery that is ${d.status.replace('_', ' ')} cannot become ${p.status.replace('_', ' ')}.` } as const;
      }
      if (p.status === 'delivered' && !p.proofObjectKey) return { updated: false, reason: 'proof_required', message: 'Attach the proof of delivery.' } as const;
      if ((p.status === 'failed' || p.status === 'cancelled') && !p.note?.trim()) return { updated: false, reason: 'note_required', message: 'Say why.' } as const;

      if (p.status === 'cancelled') {
        const original = deliveryCharge({ deliveryId, buyerId: d.account_id, currency: d.currency, lines: chargeLines(d.quote_lines.map((l) => ({ ...l, amountMinor: BigInt(l.amountMinor) }))) });
        const refund = await postJournal(c, reversal(original, d.charge_journal_id, `delivery cancelled: ${p.note}`));
        await c.query(`UPDATE logistics.delivery SET status = 'cancelled', refund_journal_id = $2 WHERE id = $1`, [deliveryId, refund]);
        await c.query(`UPDATE logistics.collection SET method = 'pickup', status = 'ready' WHERE id = $1 AND status = 'scheduled'`, [d.collection_id]);
      } else if (p.status === 'delivered') {
        await c.query(`UPDATE logistics.delivery SET status = 'delivered', proof_object_key = $2, delivered_at = $3 WHERE id = $1`, [deliveryId, p.proofObjectKey, now]);
        await c.query(`UPDATE logistics.collection SET status = 'delivered' WHERE id = $1 AND status = 'released'`, [d.collection_id]);
      } else {
        await c.query('UPDATE logistics.delivery SET status = $2 WHERE id = $1', [deliveryId, p.status]);
      }
      await c.query(
        'INSERT INTO logistics.delivery_event (delivery_id, status, note, proof_object_key, recorded_by, recorded_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [deliveryId, p.status, p.note ?? null, p.proofObjectKey ?? null, staff.id, now],
      );
      await outbox(c, 'delivery.status_changed', 'delivery', deliveryId, { status: p.status, proofObjectKey: p.proofObjectKey ?? null });
      return { updated: true, status: p.status } as const;
    });
  }

  // --- Read model: my purchases ---------------------------------------------------------------

  /** Everything a buyer needs after winning: invoices, lines, collection, gate pass, storage clock, delivery and title progress. */
  async purchases(accountId: string, now: Date = new Date()): Promise<Purchase[]> {
    const invoices = await this.db.query<{
      id: string; invoice_number: string; status: string; currency: Currency; total_minor: bigint; issued_at: Date; due_at: Date; paid_at: Date | null; rule_version_id: string; auction_title: string;
    }>(
      `SELECT i.id, i.invoice_number, i.status, i.currency, i.total_minor, i.issued_at, i.due_at, i.paid_at, i.rule_version_id, a.title AS auction_title
         FROM settlement.invoice i JOIN auction.auction a ON a.id = i.auction_id
        WHERE i.buyer_account_id = $1 ORDER BY i.issued_at DESC`,
      [accountId],
    );
    const out: Purchase[] = [];
    for (const inv of invoices.rows) {
      const lines = await this.db.query<{ lot_id: string | null; line_type: string; description: string; amount_minor: bigint }>(
        'SELECT lot_id, line_type, description, amount_minor FROM settlement.invoice_line WHERE invoice_id = $1 ORDER BY sort, id',
        [inv.id],
      );
      const lots = await this.db.query<{ id: string; lot_ref: string; title: string; state: string; is_vehicle: boolean; location_branch: string }>(
        `SELECT DISTINCT l.id, l.lot_ref, l.title, l.state, l.is_vehicle, l.location_branch
           FROM settlement.invoice_line il JOIN catalogue.lot l ON l.id = il.lot_id WHERE il.invoice_id = $1 ORDER BY l.lot_ref`,
        [inv.id],
      );
      const lotViews: PurchaseLot[] = [];
      for (const l of lots.rows) {
        let title: PurchaseLot['titleCase'] = null;
        if (l.is_vehicle) {
          const tc = (await this.db.query<{ id: string; status: string; deadline_at: Date; completed_at: Date | null }>(
            'SELECT id, status, deadline_at, completed_at FROM logistics.title_case WHERE lot_id = $1',
            [l.id],
          )).rows[0];
          if (tc) {
            const steps = await this.db.query<{ step: string; status: string; due_at: Date; completed_at: Date | null }>(
              'SELECT step, status, due_at, completed_at FROM logistics.title_step WHERE title_case_id = $1 ORDER BY sort',
              [tc.id],
            );
            title = {
              status: tc.status, deadlineAt: tc.deadline_at, completedAt: tc.completed_at,
              done: steps.rows.filter((s) => s.status === 'done').length, total: steps.rows.length,
              steps: steps.rows.map((s) => ({ step: s.step, status: s.status, dueAt: s.due_at, completedAt: s.completed_at })),
            };
          }
        }
        const dispute = (await this.db.query<{ id: string; status: string }>(
          'SELECT id, status FROM support.dispute WHERE lot_id = $1 AND raised_by = $2 ORDER BY raised_at DESC LIMIT 1',
          [l.id, accountId],
        )).rows[0];
        lotViews.push({
          id: l.id, ref: l.lot_ref, title: l.title, state: l.state, isVehicle: l.is_vehicle, branch: l.location_branch,
          lines: lines.rows.filter((x) => x.lot_id === l.id).map((x) => ({ type: x.line_type, description: x.description, amountMinor: x.amount_minor })),
          titleCase: title, dispute: dispute ? { id: dispute.id, status: dispute.status } : null,
        });
      }
      out.push({
        invoiceId: inv.id, invoiceNumber: inv.invoice_number, auctionTitle: inv.auction_title, status: inv.status, currency: inv.currency,
        totalMinor: inv.total_minor, issuedAt: inv.issued_at, dueAt: inv.due_at, paidAt: inv.paid_at, lots: lotViews,
        collection: await this.collectionView(inv.id, now),
      });
    }
    return out;
  }

  private async collectionView(invoiceId: string, now: Date): Promise<PurchaseCollection | null> {
    const c = (await this.db.query<{ id: string; status: string; method: string; qr: boolean; released_at: Date | null; slot_id: string | null; starts_at: Date | null; ends_at: Date | null }>(
      `SELECT c.id, c.status, c.method, c.qr_token_hmac IS NOT NULL AS qr, c.released_at, c.slot_id, s.starts_at, s.ends_at
         FROM logistics.collection c LEFT JOIN logistics.collection_slot s ON s.id = c.slot_id
        WHERE c.invoice_id = $1 ORDER BY c.id LIMIT 1`,
      [invoiceId],
    )).rows[0];
    if (!c) return null;
    const col = (await this.collection(this.db, c.id))!;
    const storage = await this.storage(this.db, c.id, now);
    const charged = (await this.db.query<{ amount_minor: bigint; days: number }>('SELECT amount_minor, days FROM logistics.storage_charge WHERE collection_id = $1', [c.id])).rows[0];
    const delivery = (await this.db.query<{ id: string; status: string; town: string; size_class: string; charge_minor: bigint; booked_at: Date; delivered_at: Date | null; name: string; phone_e164: string }>(
      `SELECT d.id, d.status, d.town, d.size_class, d.charge_minor, d.booked_at, d.delivered_at, p.name, p.phone_e164
         FROM logistics.delivery d JOIN logistics.partner p ON p.id = d.partner_id
        WHERE d.collection_id = $1 ORDER BY d.booked_at DESC LIMIT 1`,
      [c.id],
    )).rows[0];
    const gatePass: PurchaseCollection['gatePass'] = !c.qr ? 'not_issued' : c.status === 'released' || c.status === 'delivered' ? 'used' : ['ready', 'scheduled'].includes(c.status) ? 'valid' : 'void';
    return {
      id: c.id, status: c.status, method: c.method, branch: col.branch, gatePass, releasedAt: c.released_at,
      slot: c.slot_id && c.starts_at && c.ends_at ? { id: c.slot_id, startsAt: c.starts_at, endsAt: c.ends_at } : null,
      storage: storage ? { ...storage, chargedMinor: charged?.amount_minor ?? null } : null,
      delivery: delivery
        ? { id: delivery.id, status: delivery.status, town: delivery.town, sizeClass: delivery.size_class, chargeMinor: delivery.charge_minor, bookedAt: delivery.booked_at, deliveredAt: delivery.delivered_at, partner: { name: delivery.name, phone: delivery.phone_e164 } }
        : null,
    };
  }
}

/** The transaction client, when a query runs inside one (so rule reads see the same snapshot). */
function clientOf(q: Queryable): Client | undefined {
  return q instanceof Db ? undefined : q;
}

/** quoteLot delivery lines as ledger lines (the charge and the tax on it). */
function chargeLines(lines: ReadonlyArray<{ type: QuoteLine['type']; amountMinor: bigint }>): Array<{ type: 'delivery' | 'purchasers_levy' | 'vat' | 'imtt' | 'transfer_tax'; amountMinor: bigint }> {
  return lines
    .filter((l) => l.amountMinor !== 0n)
    .map((l) => {
      if (l.type === 'hammer' || l.type === 'buyers_premium') throw new Error(`Unexpected ${l.type} line in a delivery quote`);
      return { type: l.type, amountMinor: l.amountMinor };
    });
}

export interface PurchaseLot {
  id: string;
  ref: string;
  title: string;
  state: string;
  isVehicle: boolean;
  branch: string;
  lines: Array<{ type: string; description: string; amountMinor: bigint }>;
  titleCase: { status: string; deadlineAt: Date; completedAt: Date | null; done: number; total: number; steps: Array<{ step: string; status: string; dueAt: Date; completedAt: Date | null }> } | null;
  dispute: { id: string; status: string } | null;
}

export interface PurchaseCollection {
  id: string;
  status: string;
  method: string;
  branch: string;
  gatePass: 'not_issued' | 'valid' | 'used' | 'void';
  releasedAt: Date | null;
  slot: { id: string; startsAt: Date; endsAt: Date } | null;
  storage: (StorageAccrual & { chargedMinor: bigint | null }) | null;
  delivery: { id: string; status: string; town: string; sizeClass: string; chargeMinor: bigint; bookedAt: Date; deliveredAt: Date | null; partner: { name: string; phone: string } } | null;
}

export interface Purchase {
  invoiceId: string;
  invoiceNumber: string;
  auctionTitle: string;
  status: string;
  currency: Currency;
  totalMinor: bigint;
  issuedAt: Date;
  dueAt: Date;
  paidAt: Date | null;
  lots: PurchaseLot[];
  collection: PurchaseCollection | null;
}
