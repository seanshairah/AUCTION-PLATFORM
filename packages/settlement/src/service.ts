import { randomUUID } from 'node:crypto';
import type { Currency } from '@abc/domain';
import { big, type Actor, type Client, type Db, type RulebookStore } from '@abc/db';
import {
  commission,
  forfeitHoldById,
  invoiceCredit,
  invoiceIssued,
  invoicePayment,
  payout,
  postJournal,
  relistFee,
  releaseHoldById,
  wallet,
  type InvoiceLineForLedger,
} from '@abc/ledger';
import { lotPricing } from '@abc/limits';
import { QuoteError, sellerProceeds } from '@abc/quote';
import type { RuleSnapshot } from '@abc/rules';
import {
  buildInvoiceDrafts,
  dueLadderSteps,
  hashGatePass,
  newGatePassToken,
  payoutDueAt,
  relistFeeAmount,
  reminderTimes,
  type LadderStep,
  type SoldLot,
} from './settlement';

/**
 * Close and settlement service (docs/11-close-settlement.md): invoices at the hammer,
 * one-tap payment from the wallet, the QR gate pass, release, payouts and the
 * default ladder. All money moves through ledger recipes.
 */

const SYSTEM_SETTLEMENT: Actor = { type: 'system', id: 'settlement', name: 'Settlement' };

export type PayResult =
  | { paid: true; paymentId: string; collectionId: string; gatePassToken: string | null; alreadyPaid: boolean }
  | { paid: false; reason: 'insufficient_funds'; shortfallMinor: bigint; availableMinor: bigint; totalMinor: bigint }
  | { paid: false; reason: 'not_payable' };

export type ReleaseResult =
  | { released: true; collectionId: string; payouts: string[]; payoutsBlocked: Array<{ sellerId: string; reason: string }> }
  | { released: false; reason: 'invalid_pass' | 'not_ready' | 'title_incomplete' };

async function outbox(c: Client, topic: string, aggregateType: string, aggregateId: string, payload: unknown): Promise<void> {
  await c.query('INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4::jsonb)', [
    topic,
    aggregateType,
    aggregateId,
    JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ]);
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  buyer_account_id: string;
  auction_id: string;
  currency: Currency;
  status: string;
  rule_version_id: string;
  issued_at: Date;
  due_at: Date;
  total_minor: bigint;
}

export class SettlementService {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    private readonly options: { gatePassSecret: string },
  ) {}

  /** Issues invoices for every sold lot of a closed auction and releases losing bidders' deposits. Idempotent. */
  async settleClosedAuction(auctionId: string, now: Date = new Date()): Promise<Array<{ invoiceId: string; buyerId: string; totalMinor: bigint }>> {
    return this.db.tx(SYSTEM_SETTLEMENT, async (c) => {
      const a = await c.query<{ code: string; status: string; rule_version_id: string }>('SELECT code, status, rule_version_id FROM auction.auction WHERE id = $1 FOR UPDATE', [auctionId]);
      const auction = a.rows[0];
      if (!auction || auction.status !== 'closed') throw new Error(`Auction ${auctionId} is not closed`);
      const already = await c.query('SELECT 1 FROM settlement.invoice WHERE auction_id = $1 LIMIT 1', [auctionId]);
      if (already.rowCount) return [];

      const snapshot = await this.rulebook.snapshot(auction.rule_version_id, c);
      const taxRates = await this.rulebook.taxRates(c);
      const soldRows = await c.query<{ auction_lot_id: string; lot_id: string; seller_account_id: string; winner_account_id: string; hammer_minor: bigint; closed_at: Date }>(
        `SELECT al.id AS auction_lot_id, al.lot_id, l.seller_account_id, al.winner_account_id, al.hammer_minor, al.closed_at
           FROM auction.auction_lot al JOIN catalogue.lot l ON l.id = al.lot_id
          WHERE al.auction_id = $1 AND al.result = 'sold' ORDER BY al.lot_number`,
        [auctionId],
      );
      const sold: SoldLot[] = [];
      for (const r of soldRows.rows) {
        sold.push({
          auctionLotId: r.auction_lot_id,
          lotId: r.lot_id,
          sellerId: r.seller_account_id,
          buyerId: r.winner_account_id,
          pricing: await lotPricing(c, r.lot_id),
          hammerMinor: r.hammer_minor,
          hammerAt: r.closed_at,
        });
      }

      const issued: Array<{ invoiceId: string; buyerId: string; totalMinor: bigint }> = [];
      let n = 0;
      for (const draft of buildInvoiceDrafts(sold, snapshot, taxRates, now)) {
        const invoiceId = randomUUID();
        await c.query(
          `INSERT INTO settlement.invoice (id, invoice_number, buyer_account_id, auction_id, currency, rule_version_id, issued_at, due_at, collect_by_at, total_minor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [invoiceId, `${auction.code}-${String(++n).padStart(4, '0')}`, draft.buyerId, auctionId, draft.currency, draft.ruleVersionId,
           draft.issuedAt, draft.dueAt, draft.collectByAt, big(draft.totalMinor)],
        );
        let sort = 0;
        for (const l of draft.lines) {
          await c.query(
            `INSERT INTO settlement.invoice_line (invoice_id, currency, lot_id, auction_lot_id, line_type, description, base_minor, rate_bp, amount_minor, tax_rate_id, sort)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [invoiceId, draft.currency, l.lotId, l.auctionLotId, l.type, l.description, l.baseMinor !== undefined ? big(l.baseMinor) : null,
             l.rateBp ?? null, big(l.amountMinor), l.taxRateId ?? null, sort++],
          );
        }
        const journalId = await postJournal(
          c,
          invoiceIssued({ invoiceId, buyerId: draft.buyerId, currency: draft.currency, lines: draft.lines.map((l) => ({ type: l.type, amountMinor: l.amountMinor, sellerId: l.sellerId })) }),
        );
        await c.query('UPDATE settlement.invoice SET issue_journal_id = $2 WHERE id = $1', [invoiceId, journalId]);
        for (const lotId of new Set(draft.lines.map((l) => l.lotId))) {
          await c.query(`UPDATE catalogue.lot SET state = 'invoiced' WHERE id = $1`, [lotId]);
        }
        await outbox(c, 'invoice.issued', 'invoice', invoiceId, { buyerId: draft.buyerId, totalMinor: draft.totalMinor, dueAt: draft.dueAt });
        issued.push({ invoiceId, buyerId: draft.buyerId, totalMinor: draft.totalMinor });
      }

      // Losing bidders get their deposits back now (rule deposit.release_on = auction_settled).
      const winners = new Set(issued.map((i) => i.buyerId));
      const holds = await c.query<{ id: string; account_id: string }>(
        `SELECT h.id, r.account_id FROM registration.registration r
           JOIN ledger.hold h ON h.reference_type = 'registration' AND h.reference_id = r.id::text AND h.status = 'active'
          WHERE r.auction_id = $1`,
        [auctionId],
      );
      for (const h of holds.rows) if (!winners.has(h.account_id)) await releaseHoldById(c, h.id);
      return issued;
    });
  }

  private async lockInvoice(c: Client, invoiceId: string): Promise<InvoiceRow> {
    const r = await c.query<InvoiceRow>('SELECT * FROM settlement.invoice WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (!r.rows[0]) throw new Error(`Invoice ${invoiceId} not found`);
    return r.rows[0];
  }

  private async auctionDepositHolds(c: Client, accountId: string, auctionId: string): Promise<string[]> {
    const r = await c.query<{ id: string }>(
      `SELECT h.id FROM registration.registration r
         JOIN ledger.hold h ON h.reference_type = 'registration' AND h.reference_id = r.id::text AND h.status = 'active'
        WHERE r.account_id = $1 AND r.auction_id = $2`,
      [accountId, auctionId],
    );
    return r.rows.map((x) => x.id);
  }

  /**
   * One tap: pay an invoice from the wallet. The auction's deposit counts towards
   * the payment. If the wallet is short, nothing changes and the shortfall is returned.
   */
  async payFromWallet(actor: Actor, p: { invoiceId: string; accountId: string; clientKey: string }, now: Date = new Date()): Promise<PayResult> {
    return this.db.tx(actor, async (c): Promise<PayResult> => {
      const invoice = await this.lockInvoice(c, p.invoiceId);
      if (invoice.buyer_account_id !== p.accountId) return { paid: false, reason: 'not_payable' };
      if (invoice.status === 'paid') {
        const prior = await c.query<{ id: string }>(`SELECT id FROM payment.payment WHERE invoice_id = $1 AND status = 'succeeded'`, [invoice.id]);
        const col = await c.query<{ id: string }>('SELECT id FROM logistics.collection WHERE invoice_id = $1', [invoice.id]);
        return { paid: true, paymentId: prior.rows[0]!.id, collectionId: col.rows[0]!.id, gatePassToken: null, alreadyPaid: true };
      }
      if (invoice.status !== 'issued' && invoice.status !== 'overdue') return { paid: false, reason: 'not_payable' };

      for (const holdId of await this.auctionDepositHolds(c, p.accountId, invoice.auction_id)) await releaseHoldById(c, holdId);
      const w = await wallet(c, p.accountId, invoice.currency);
      if (w.availableMinor < invoice.total_minor) {
        throw new InsufficientFunds(invoice.total_minor - w.availableMinor, w.availableMinor, invoice.total_minor);
      }

      const paymentId = randomUUID();
      const journalId = await postJournal(c, invoicePayment({ invoiceId: invoice.id, buyerId: p.accountId, currency: invoice.currency, amountMinor: invoice.total_minor, paymentId }));
      await c.query(
        `INSERT INTO payment.payment (id, account_id, purpose, invoice_id, method, gateway, currency, amount_minor, status, client_idempotency_key, journal_id, confirmed_at)
         VALUES ($1, $2, 'invoice', $3, 'wallet', 'internal', $4, $5, 'succeeded', $6, $7, now())`,
        [paymentId, p.accountId, invoice.id, invoice.currency, big(invoice.total_minor), p.clientKey, journalId],
      );
      await c.query(`UPDATE settlement.invoice SET status = 'paid', paid_at = now() WHERE id = $1`, [invoice.id]);

      const snapshot = await this.rulebook.snapshot(invoice.rule_version_id, c);
      const lots = await c.query<{ lot_id: string; seller_account_id: string; is_vehicle: boolean; hammer: bigint }>(
        `SELECT l.id AS lot_id, l.seller_account_id, l.is_vehicle, il.amount_minor AS hammer
           FROM settlement.invoice_line il JOIN catalogue.lot l ON l.id = il.lot_id
          WHERE il.invoice_id = $1 AND il.line_type = 'hammer'`,
        [invoice.id],
      );
      for (const lot of lots.rows) {
        // Commission is recognised once the buyer has paid. Not yet published → payout waits (Q3).
        const commissionMinor = await this.commissionFor(c, lot.lot_id, lot.hammer, snapshot);
        if (commissionMinor !== null && commissionMinor > 0n) {
          await postJournal(c, commission({ invoiceId: invoice.id, lotId: lot.lot_id, sellerId: lot.seller_account_id, currency: invoice.currency, amountMinor: commissionMinor }));
        }
        await c.query(`UPDATE catalogue.lot SET state = 'paid' WHERE id = $1`, [lot.lot_id]);
        if (lot.is_vehicle) {
          // Vehicles wait for police, ZIMRA and CVR steps before release (blueprint module 8).
          await c.query(`UPDATE catalogue.lot SET state = 'title_hold' WHERE id = $1`, [lot.lot_id]);
          const deadline = new Date(now.getTime() + snapshot.get('vehicle.title_deadline_days') * 86_400_000);
          const tc = await c.query<{ id: string }>(
            'INSERT INTO logistics.title_case (lot_id, buyer_account_id, deadline_at) VALUES ($1, $2, $3) RETURNING id',
            [lot.lot_id, p.accountId, deadline],
          );
          const steps: Array<[string, number]> = [['zrp_clearance', 1], ['zimra_clearance', 2], ['cvr_change_of_ownership', 3]];
          for (const [step, sort] of steps) {
            await c.query('INSERT INTO logistics.title_step (title_case_id, step, sort, owner_party, due_at) VALUES ($1, $2, $3, $4, $5)', [tc.rows[0]!.id, step, sort, 'abc', deadline]);
          }
        }
      }

      const token = newGatePassToken();
      const col = await c.query<{ id: string }>(
        `INSERT INTO logistics.collection (invoice_id, method, qr_token_hmac, status, storage_clock_from) VALUES ($1, 'pickup', $2, 'ready', now()) RETURNING id`,
        [invoice.id, hashGatePass(token, this.options.gatePassSecret)],
      );
      for (const lot of lots.rows) await c.query('INSERT INTO logistics.collection_lot (collection_id, lot_id) VALUES ($1, $2)', [col.rows[0]!.id, lot.lot_id]);
      await outbox(c, 'invoice.paid', 'invoice', invoice.id, { paymentId, method: 'wallet' });
      await outbox(c, 'collection.ready', 'collection', col.rows[0]!.id, { invoiceId: invoice.id });
      return { paid: true, paymentId, collectionId: col.rows[0]!.id, gatePassToken: token, alreadyPaid: false };
    }).catch((e): PayResult => {
      if (e instanceof InsufficientFunds) {
        return { paid: false as const, reason: 'insufficient_funds' as const, shortfallMinor: e.shortfall, availableMinor: e.available, totalMinor: e.total };
      }
      throw e;
    });
  }

  private async commissionFor(c: Client, lotId: string, hammer: bigint, snapshot: RuleSnapshot): Promise<bigint | null> {
    const pricing = await lotPricing(c, lotId);
    try {
      const proceeds = sellerProceeds({ lot: pricing, hammerMinor: hammer, snapshot });
      return -proceeds.lines.find((l) => l.type === 'commission')!.amountMinor;
    } catch (e) {
      if (e instanceof QuoteError && e.code === 'COMMISSION_NOT_SET') return null;
      throw e;
    }
  }

  /** Staff scan the QR pass at the gate. Vehicles are refused until their title case is complete. */
  async releaseAtGate(staff: Actor & { type: 'staff' }, token: string, now: Date = new Date()): Promise<ReleaseResult> {
    try {
      return await this.db.tx(staff, async (c) => {
        const col = await c.query<{ id: string; status: string; invoice_id: string }>(
          'SELECT id, status, invoice_id FROM logistics.collection WHERE qr_token_hmac = $1 FOR UPDATE',
          [hashGatePass(token, this.options.gatePassSecret)],
        );
        const collection = col.rows[0];
        if (!collection) return { released: false, reason: 'invalid_pass' } as const;
        if (collection.status !== 'ready' && collection.status !== 'scheduled') return { released: false, reason: 'not_ready' } as const;

        const invoice = await this.lockInvoice(c, collection.invoice_id);
        const snapshot = await this.rulebook.snapshot(invoice.rule_version_id, c);
        const lots = await c.query<{ lot_id: string; seller_account_id: string; hammer: bigint }>(
          `SELECT cl.lot_id, l.seller_account_id, il.amount_minor AS hammer
             FROM logistics.collection_lot cl
             JOIN catalogue.lot l ON l.id = cl.lot_id
             JOIN settlement.invoice_line il ON il.lot_id = cl.lot_id AND il.invoice_id = $2 AND il.line_type = 'hammer'
            WHERE cl.collection_id = $1`,
          [collection.id, invoice.id],
        );
        for (const lot of lots.rows) await c.query(`UPDATE catalogue.lot SET state = 'released' WHERE id = $1`, [lot.lot_id]);
        await c.query(`UPDATE logistics.collection SET status = 'released', released_at = now(), released_by = $2 WHERE id = $1`, [collection.id, staff.id]);
        await outbox(c, 'collection.released', 'collection', collection.id, {});

        // Payouts: one per seller and currency, due after the claim window (rule payout.processing_hours).
        const bySeller = new Map<string, Array<{ lotId: string; hammer: bigint }>>();
        for (const l of lots.rows) bySeller.set(l.seller_account_id, [...(bySeller.get(l.seller_account_id) ?? []), { lotId: l.lot_id, hammer: l.hammer }]);
        const payouts: string[] = [];
        const blocked: Array<{ sellerId: string; reason: string }> = [];
        for (const [sellerId, sellerLots] of bySeller) {
          const lines: Array<{ lotId: string; type: 'hammer' | 'commission'; amount: bigint }> = [];
          let missingCommission = false;
          for (const l of sellerLots) {
            const fee = await this.commissionFor(c, l.lotId, l.hammer, snapshot);
            if (fee === null) missingCommission = true;
            lines.push({ lotId: l.lotId, type: 'hammer', amount: l.hammer });
            if (fee) lines.push({ lotId: l.lotId, type: 'commission', amount: -fee });
          }
          if (missingCommission) {
            blocked.push({ sellerId, reason: 'commission_not_published' });
            await outbox(c, 'payout.blocked', 'invoice', invoice.id, { sellerId, reason: 'commission_not_published' });
            continue;
          }
          const gross = lines.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n);
          const deductions = -lines.filter((l) => l.amount < 0n).reduce((a, l) => a + l.amount, 0n);
          const destination = await c.query<{ id: string }>(
            `SELECT id FROM payout.destination WHERE account_id = $1 AND currency = $2 AND active AND cooling_off_until <= $3 ORDER BY created_at DESC LIMIT 1`,
            [sellerId, invoice.currency, now],
          );
          const p = await c.query<{ id: string }>(
            `INSERT INTO payout.payout (seller_account_id, currency, status, due_date, gross_minor, deductions_minor, net_minor, destination_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [sellerId, invoice.currency, destination.rows[0] ? 'scheduled' : 'held', payoutDueAt(now, snapshot), big(gross), big(deductions), big(gross - deductions), destination.rows[0]?.id ?? null],
          );
          for (const l of lines) {
            await c.query(
              `INSERT INTO payout.payout_line (payout_id, lot_id, invoice_id, line_type, description, amount_minor) VALUES ($1, $2, $3, $4, $5, $6)`,
              [p.rows[0]!.id, l.lotId, invoice.id, l.type, l.type === 'hammer' ? 'Hammer price' : 'Commission', big(l.amount)],
            );
          }
          await outbox(c, 'payout.scheduled', 'payout', p.rows[0]!.id, { sellerId, netMinor: gross - deductions });
          payouts.push(p.rows[0]!.id);
        }
        return { released: true, collectionId: collection.id, payouts, payoutsBlocked: blocked } as const;
      });
    } catch (e) {
      if ((e as Error).message?.includes('title case is not complete')) return { released: false, reason: 'title_incomplete' };
      throw e;
    }
  }

  /** Finance marks a scheduled payout as sent (bank transfer or mobile money), posting it to the ledger. */
  async markPayoutPaid(staff: Actor & { type: 'staff' }, payoutId: string, reference: string): Promise<void> {
    await this.db.tx(staff, async (c) => {
      const r = await c.query<{ seller_account_id: string; currency: Currency; net_minor: bigint; status: string }>(
        'SELECT seller_account_id, currency, net_minor, status FROM payout.payout WHERE id = $1 FOR UPDATE',
        [payoutId],
      );
      const p = r.rows[0];
      if (!p) throw new Error(`Payout ${payoutId} not found`);
      if (p.status === 'paid') return;
      if (p.status !== 'scheduled' && p.status !== 'approved') throw new Error(`Payout ${payoutId} is ${p.status}`);
      const journalId = await postJournal(c, payout({ payoutId, sellerId: p.seller_account_id, currency: p.currency, amountMinor: p.net_minor, via: 'trust_bank' }));
      await c.query(
        `UPDATE payout.payout SET status = 'paid', paid_at = now(), journal_id = $2, gateway = 'bank', gateway_reference = $3, approved_by = $4 WHERE id = $1`,
        [payoutId, journalId, reference, staff.id],
      );
      await c.query(
        `UPDATE catalogue.lot SET state = 'paid_out' WHERE id IN (SELECT lot_id FROM payout.payout_line WHERE payout_id = $1) AND state = 'released'`,
        [payoutId],
      );
      await outbox(c, 'payout.paid', 'payout', payoutId, { reference });
    });
  }

  /** Queues payment reminders that are due (rule settlement.reminder_offsets_hours), once each. */
  async queueDueReminders(now: Date = new Date()): Promise<number> {
    return this.db.tx(SYSTEM_SETTLEMENT, async (c) => {
      const open = await c.query<InvoiceRow>(`SELECT * FROM settlement.invoice WHERE status = 'issued' AND due_at > $1`, [now]);
      let queued = 0;
      for (const inv of open.rows) {
        const snapshot = await this.rulebook.snapshot(inv.rule_version_id, c);
        for (const r of reminderTimes(inv.issued_at, snapshot)) {
          if (r.at > now) continue;
          const exists = await c.query(
            `SELECT 1 FROM core.outbox WHERE topic = 'invoice.reminder' AND aggregate_id = $1 AND payload->>'offsetHours' = $2`,
            [inv.id, String(r.offsetHours)],
          );
          if (exists.rowCount) continue;
          await outbox(c, 'invoice.reminder', 'invoice', inv.id, { offsetHours: r.offsetHours, dueAt: inv.due_at, totalMinor: inv.total_minor });
          queued++;
        }
      }
      return queued;
    });
  }

  /**
   * The default ladder (blueprint module 7): warning, deposit forfeit, relist fee,
   * tier drop, each when its time comes. Safe to run as often as wanted.
   */
  async runDefaultLadder(now: Date = new Date()): Promise<Array<{ invoiceId: string; applied: LadderStep[] }>> {
    const overdue = await this.db.query<{ id: string }>(`SELECT id FROM settlement.invoice WHERE status IN ('issued', 'overdue') AND due_at <= $1`, [now]);
    const results: Array<{ invoiceId: string; applied: LadderStep[] }> = [];
    for (const { id } of overdue.rows) {
      const applied = await this.db.tx(SYSTEM_SETTLEMENT, (c) => this.ladderForInvoice(c, id, now));
      if (applied.length) results.push({ invoiceId: id, applied });
    }
    return results;
  }

  private async ladderForInvoice(c: Client, invoiceId: string, now: Date): Promise<LadderStep[]> {
    const invoice = await this.lockInvoice(c, invoiceId);
    if (invoice.status !== 'issued' && invoice.status !== 'overdue') return [];
    const snapshot = await this.rulebook.snapshot(invoice.rule_version_id, c);
    const lotIds = (await c.query<{ lot_id: string }>(`SELECT DISTINCT lot_id FROM settlement.invoice_line WHERE invoice_id = $1 AND lot_id IS NOT NULL`, [invoiceId])).rows.map((r) => r.lot_id);

    let caseId = (await c.query<{ id: string }>('SELECT id FROM settlement.default_case WHERE invoice_id = $1', [invoiceId])).rows[0]?.id;
    if (!caseId) {
      caseId = (await c.query<{ id: string }>('INSERT INTO settlement.default_case (invoice_id) VALUES ($1) RETURNING id', [invoiceId])).rows[0]!.id;
      await c.query(`UPDATE settlement.invoice SET status = 'overdue' WHERE id = $1`, [invoiceId]);
      await c.query(`UPDATE catalogue.lot SET state = 'payment_overdue' WHERE id = ANY($1::uuid[]) AND state = 'invoiced'`, [lotIds]);
      invoice.status = 'overdue';
    }
    const done = new Set(
      (await c.query<{ step: LadderStep }>('SELECT step FROM settlement.default_step WHERE default_case_id = $1', [caseId])).rows.map((r) => r.step),
    );
    const steps = dueLadderSteps(invoice.due_at, now, done, snapshot);
    for (const step of steps) {
      let journalId: string | null = null;
      if (step === 'warning') {
        await outbox(c, 'default.warning', 'invoice', invoiceId, { buyerId: invoice.buyer_account_id });
      } else if (step === 'deposit_forfeit') {
        const holds = await this.auctionDepositHolds(c, invoice.buyer_account_id, invoice.auction_id);
        const sellers = (await c.query<{ seller_account_id: string }>('SELECT DISTINCT seller_account_id FROM catalogue.lot WHERE id = ANY($1::uuid[])', [lotIds])).rows;
        const shareBp = snapshot.get('settlement.forfeit_seller_share_bp');
        for (const holdId of holds) {
          const amount = (await c.query<{ amount_minor: bigint }>('SELECT amount_minor FROM ledger.hold WHERE id = $1', [holdId])).rows[0]!.amount_minor;
          const share = sellers.length === 1 && shareBp > 0 ? (amount * BigInt(shareBp)) / 10_000n : 0n;
          journalId = (await forfeitHoldById(c, holdId, share > 0n ? { sellerId: sellers[0]!.seller_account_id, shareMinor: share } : undefined)) ?? journalId;
        }
        // Cancel the invoice and offer the lots again.
        const credit = await this.creditInvoice(c, invoice);
        journalId ??= credit;
        await c.query(`UPDATE catalogue.lot SET state = 'listed' WHERE id = ANY($1::uuid[]) AND state = 'payment_overdue'`, [lotIds]);
        await outbox(c, 'lot.relist_required', 'invoice', invoiceId, { lotIds });
      } else if (step === 'relist_fee') {
        const hammer = (await c.query<{ h: bigint }>(`SELECT coalesce(sum(amount_minor), 0)::bigint AS h FROM settlement.invoice_line WHERE invoice_id = $1 AND line_type = 'hammer'`, [invoiceId])).rows[0]!.h;
        const fee = relistFeeAmount(hammer, invoice.currency, snapshot);
        const w = await wallet(c, invoice.buyer_account_id, invoice.currency);
        journalId = await postJournal(c, relistFee({ invoiceId, buyerId: invoice.buyer_account_id, currency: invoice.currency, amountMinor: fee, fromWallet: w.availableMinor >= fee }));
      } else if (step === 'tier_drop') {
        await c.query(`UPDATE identity.account SET tier = 'restricted' WHERE id = $1 AND tier IN ('verified', 'trusted')`, [invoice.buyer_account_id]);
        await outbox(c, 'account.restricted', 'account', invoice.buyer_account_id, { invoiceId });
      }
      await c.query('INSERT INTO settlement.default_step (default_case_id, step, journal_id) VALUES ($1, $2, $3)', [caseId, step, journalId]);
      done.add(step);
    }
    if (snapshot.get('settlement.default_ladder').every((s) => done.has(s.step))) {
      await c.query(`UPDATE settlement.default_case SET status = 'completed', closed_at = now() WHERE id = $1 AND status = 'open'`, [caseId]);
    }
    return steps;
  }

  /** Reverses an unpaid invoice's issue journal and marks it defaulted. */
  private async creditInvoice(c: Client, invoice: InvoiceRow): Promise<string> {
    const lines = await c.query<{ line_type: InvoiceLineForLedger['type']; amount_minor: bigint; seller_account_id: string | null }>(
      `SELECT il.line_type, il.amount_minor, l.seller_account_id
         FROM settlement.invoice_line il LEFT JOIN catalogue.lot l ON l.id = il.lot_id
        WHERE il.invoice_id = $1 ORDER BY il.sort, il.id`,
      [invoice.id],
    );
    const issued = invoiceIssued({
      invoiceId: invoice.id,
      buyerId: invoice.buyer_account_id,
      currency: invoice.currency,
      lines: lines.rows.map((l) => ({ type: l.line_type, amountMinor: l.amount_minor, ...(l.seller_account_id ? { sellerId: l.seller_account_id } : {}) })),
    });
    const journalId = await postJournal(c, invoiceCredit(issued, invoice.id));
    await c.query(`UPDATE settlement.invoice SET status = 'defaulted' WHERE id = $1`, [invoice.id]);
    return journalId;
  }
}

class InsufficientFunds extends Error {
  constructor(
    readonly shortfall: bigint,
    readonly available: bigint,
    readonly total: bigint,
  ) {
    super('insufficient funds');
  }
}
