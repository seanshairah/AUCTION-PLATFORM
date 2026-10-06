import type { Currency } from '@abc/domain';
import { big, type Actor, type Client, type Db, type RulebookStore } from '@abc/db';
import {
  closeLot,
  placeMaxBid,
  type BidReceipt,
  type CloseResult,
  type LoggedBid,
  type LotConfig,
  type LotState,
} from '@abc/engine';
import { isLinkedToSellerOfLot, lotPricing, type RegistrationService } from '@abc/limits';
import { QuoteError, quoteLot, type Quote } from '@abc/quote';
import { ladderFor, type RuleSnapshot, type AuctionFormat } from '@abc/rules';

/**
 * The bidding service (docs/07-bidding-engine.md §2 and §8): runs the server-side
 * checks, then the pure engine under the lot's row lock, and appends the engine's
 * rows to the immutable bid log in the same transaction.
 */

export type ServiceRejection =
  | 'auction_not_open'
  | 'not_registered'
  | 'registration_pending'
  | 'seller_linked'
  | 'price_unavailable'
  | 'price_changed'
  | 'over_limit';

export interface PlaceBidRequest {
  accountId: string;
  auctionLotId: string;
  maxMinor: bigint;
  clientRequestId: string;
  /** What the commit screen showed: the server re-checks both (R2). */
  quotedTotalMinor: bigint;
  quotedRuleVersionId: string;
  channel: 'web' | 'pwa' | 'android' | 'ios';
  at?: Date;
}

export type PlaceBidOutcome =
  | { accepted: true; receipt: BidReceipt; repeated: boolean }
  | {
      accepted: false;
      reason: ServiceRejection | 'lot_closed' | 'below_minimum' | 'not_above_your_max';
      minimumMinor?: bigint;
      serverQuote?: Quote;
      capacityMinor?: bigint;
      receipt?: BidReceipt;
    };

interface LotRow {
  id: string;
  auction_id: string;
  lot_id: string;
  currency: Currency;
  starting_bid_minor: bigint;
  reserve_minor: bigint | null;
  current_end_at: Date;
  extension_count: number;
  bid_seq: bigint;
  current_price_minor: bigint | null;
  leading_bid_id: string | null;
  result: string;
  auction_status: string;
  rule_version_id: string | null;
  soft_close_seconds: number | null;
  format: AuctionFormat;
  deposit_required: boolean;
}

export class BiddingService {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    private readonly registrations: RegistrationService,
  ) {}

  /** Opens a scheduled auction: pins the rule version in force now (A20) and puts its lots live. */
  async openAuction(actor: Actor, auctionId: string, now: Date = new Date()): Promise<string> {
    return this.db.tx(actor, async (c) => {
      const versionId = await this.rulebook.activeVersionId(now, c);
      const r = await c.query(`UPDATE auction.auction SET status = 'open', rule_version_id = $2 WHERE id = $1 AND status = 'scheduled'`, [auctionId, versionId]);
      if (r.rowCount !== 1) throw new Error(`Auction ${auctionId} is not scheduled`);
      await c.query(
        `UPDATE catalogue.lot SET state = 'live' WHERE id IN (SELECT lot_id FROM auction.auction_lot WHERE auction_id = $1) AND state = 'listed'`,
        [auctionId],
      );
      await this.outbox(c, 'auction.opened', 'auction', auctionId, { ruleVersionId: versionId });
      return versionId;
    });
  }

  private engineConfig(snapshot: RuleSnapshot, lot: LotRow, categoryPath: readonly string[]): LotConfig {
    const ctx = { auctionFormat: lot.format, categoryPath };
    const softClose = lot.soft_close_seconds ?? snapshot.get('bidding.soft_close_seconds', ctx);
    return {
      currency: lot.currency,
      startingBidMinor: lot.starting_bid_minor,
      reserveMinor: lot.reserve_minor,
      ladder: ladderFor(snapshot, lot.currency, { categoryPath }),
      softCloseSeconds: softClose,
      // In the soft-close test the trigger window equals the extension (docs/07 §10).
      triggerSeconds: lot.soft_close_seconds ?? snapshot.get('bidding.soft_close_trigger_seconds', ctx),
      priceJumpsToReserve: snapshot.get('bidding.price_jumps_to_reserve'),
      extendOn: snapshot.get('bidding.extend_on'),
    };
  }

  private async lotState(c: Client, lot: LotRow): Promise<LotState> {
    let leader: LotState['leader'] = null;
    if (lot.leading_bid_id) {
      const r = await c.query<{ account_id: string; max: bigint; seq: bigint }>(
        `SELECT b.account_id,
                coalesce(p.max_amount_minor, b.max_amount_minor) AS max,
                coalesce(p.sequence_no, b.sequence_no) AS seq
           FROM bidding.bid b LEFT JOIN bidding.bid p ON p.id = b.parent_bid_id
          WHERE b.id = $1`,
        [lot.leading_bid_id],
      );
      const l = r.rows[0]!;
      leader = { accountId: l.account_id, maxMinor: l.max, bidSeq: l.seq };
    }
    return { seq: lot.bid_seq, currentPriceMinor: lot.current_price_minor, leader, endAt: lot.current_end_at, extensionCount: lot.extension_count };
  }

  private async lockLot(c: Client, auctionLotId: string): Promise<LotRow> {
    const r = await c.query<LotRow>(
      `SELECT al.id, al.auction_id, al.lot_id, al.currency, al.starting_bid_minor, al.reserve_minor, al.current_end_at,
              al.extension_count, al.bid_seq, al.current_price_minor, al.leading_bid_id, al.result,
              a.status AS auction_status, a.rule_version_id, a.soft_close_seconds, a.format, a.deposit_required
         FROM auction.auction_lot al JOIN auction.auction a ON a.id = al.auction_id
        WHERE al.id = $1 FOR UPDATE OF al`,
      [auctionLotId],
    );
    if (!r.rows[0]) throw new Error(`Auction lot ${auctionLotId} not found`);
    return r.rows[0];
  }

  private async outbox(c: Client, topic: string, aggregateType: string, aggregateId: string, payload: unknown): Promise<void> {
    await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4::jsonb)`, [
      topic,
      aggregateType,
      aggregateId,
      JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ]);
  }

  private async registrationOf(c: Client, accountId: string, auctionId: string): Promise<{ id: string; status: string } | null> {
    const r = await c.query<{ id: string; status: string }>('SELECT id, status FROM registration.registration WHERE account_id = $1 AND auction_id = $2', [accountId, auctionId]);
    return r.rows[0] ?? null;
  }

  async placeBid(actor: Actor, req: PlaceBidRequest): Promise<PlaceBidOutcome> {
    const at = req.at ?? new Date();
    return this.db.tx(actor, async (c) => {
      const lot = await this.lockLot(c, req.auctionLotId);

      // Idempotency (R4), checked under the lot lock so concurrent retries serialise.
      const prior = await c.query<{ sequence_no: bigint; outcome_at_placement: 'leading' | 'outbid' | 'rejected'; reject_reason: string | null; server_received_at: Date }>(
        'SELECT sequence_no, outcome_at_placement, reject_reason, server_received_at FROM bidding.bid WHERE account_id = $1 AND client_request_id = $2',
        [req.accountId, req.clientRequestId],
      );
      if (prior.rows[0]) {
        const p = prior.rows[0];
        const state = await this.lotState(c, lot);
        const receipt: BidReceipt = {
          seq: p.sequence_no,
          serverTime: p.server_received_at,
          outcome: p.outcome_at_placement,
          currentPriceMinor: state.currentPriceMinor,
          youAreLeading: state.leader?.accountId === req.accountId,
          endAt: state.endAt,
          reserveStatus: lot.reserve_minor === null ? 'no_reserve' : (state.currentPriceMinor ?? -1n) >= lot.reserve_minor ? 'met' : 'not_met',
        };
        return p.outcome_at_placement === 'rejected'
          ? { accepted: false, reason: p.reject_reason as ServiceRejection, receipt }
          : { accepted: true, receipt, repeated: true };
      }

      if (lot.auction_status !== 'open' || lot.result !== 'pending' || !lot.rule_version_id) return { accepted: false, reason: 'auction_not_open' };
      const registration = await this.registrationOf(c, req.accountId, lot.auction_id);
      if (!registration) return { accepted: false, reason: 'not_registered' };

      const snapshot = await this.rulebook.snapshot(lot.rule_version_id, c);
      const taxRates = await this.rulebook.taxRates(c);
      const pricing = await lotPricing(c, lot.lot_id);

      // Rejections from here on are logged in the bid table with a sequence number.
      const rejectLogged = async (reason: ServiceRejection, extra: Omit<Extract<PlaceBidOutcome, { accepted: false }>, 'accepted' | 'reason'> = {}): Promise<PlaceBidOutcome> => {
        const seq = lot.bid_seq + 1n;
        await c.query(
          `INSERT INTO bidding.bid (auction_lot_id, currency, account_id, registration_id, origin, client_request_id, sequence_no,
                                    amount_minor, max_amount_minor, outcome_at_placement, reject_reason, quoted_total_minor,
                                    quoted_rule_version_id, server_received_at, channel)
           VALUES ($1, $2, $3, $4, 'bidder', $5, $6, $7, $7, 'rejected', $8, $9, $10, $11, $12)`,
          [lot.id, lot.currency, req.accountId, registration.id, req.clientRequestId, big(seq), big(req.maxMinor), reason,
           big(req.quotedTotalMinor), req.quotedRuleVersionId, at, req.channel],
        );
        await c.query('UPDATE auction.auction_lot SET bid_seq = $2 WHERE id = $1', [lot.id, big(seq)]);
        return { accepted: false, reason, ...extra };
      };

      if (registration.status !== 'approved') return rejectLogged('registration_pending');
      if (snapshot.get('bidding.seller_linked_accounts_barred') && (await isLinkedToSellerOfLot(c, req.accountId, lot.lot_id))) {
        return rejectLogged('seller_linked');
      }

      let serverQuote: Quote;
      try {
        serverQuote = quoteLot({ lot: pricing, hammerMinor: req.maxMinor, snapshot, taxRates, at });
      } catch (e) {
        if (e instanceof QuoteError) return rejectLogged('price_unavailable');
        throw e;
      }
      if (serverQuote.totalMinor !== req.quotedTotalMinor || req.quotedRuleVersionId !== lot.rule_version_id) {
        return rejectLogged('price_changed', { serverQuote });
      }

      const room = await this.registrations.capacityFor(c, {
        accountId: req.accountId,
        auctionLotId: lot.id,
        currency: lot.currency,
        depositRequired: lot.deposit_required,
        snapshot,
        taxRates,
        at,
      });
      if (serverQuote.totalMinor > room.capacityMinor) return rejectLogged('over_limit', { capacityMinor: room.capacityMinor, serverQuote });

      // The engine decides price discovery.
      const config = this.engineConfig(snapshot, lot, pricing.categoryPath);
      const state = await this.lotState(c, lot);
      const result = placeMaxBid(config, state, { accountId: req.accountId, maxMinor: req.maxMinor, at, clientRequestId: req.clientRequestId });
      await this.appendBids(c, lot, result.bids, req, registration.id);

      const leadingRow = [...result.bids].reverse().find((b) => b.outcome === 'leading');
      const leadingBidId = leadingRow
        ? (await c.query<{ id: string }>('SELECT id FROM bidding.bid WHERE auction_lot_id = $1 AND sequence_no = $2', [lot.id, big(leadingRow.seq)])).rows[0]!.id
        : lot.leading_bid_id;
      await c.query(
        `UPDATE auction.auction_lot
            SET bid_seq = $2, current_price_minor = $3, leading_bid_id = $4, leading_account_id = $5,
                current_end_at = $6, extension_count = $7
          WHERE id = $1`,
        [lot.id, big(result.state.seq), result.state.currentPriceMinor === null ? null : big(result.state.currentPriceMinor), leadingBidId,
         result.state.leader?.accountId ?? null, result.state.endAt, result.state.extensionCount],
      );
      for (const e of result.events) await this.outbox(c, `bid.${e.type}`, 'auction_lot', lot.id, e);

      if (result.receipt.outcome === 'rejected') {
        return {
          accepted: false,
          reason: result.receipt.rejectReason!,
          ...(result.receipt.minimumMinor !== undefined ? { minimumMinor: result.receipt.minimumMinor } : {}),
          receipt: result.receipt,
        };
      }
      await this.outbox(c, 'bid.accepted', 'auction_lot', lot.id, { accountId: req.accountId, seq: result.receipt.seq });
      return { accepted: true, receipt: result.receipt, repeated: false };
    });
  }

  private async appendBids(c: Client, lot: LotRow, bids: readonly LoggedBid[], req: PlaceBidRequest, bidderRegistrationId: string): Promise<void> {
    for (const b of bids) {
      const registrationId =
        b.accountId === req.accountId ? bidderRegistrationId : (await this.registrationOf(c, b.accountId, lot.auction_id))!.id;
      const parentId = b.parentSeq
        ? (await c.query<{ id: string }>('SELECT id FROM bidding.bid WHERE auction_lot_id = $1 AND sequence_no = $2', [lot.id, big(b.parentSeq)])).rows[0]!.id
        : null;
      const bidder = b.origin === 'bidder';
      await c.query(
        `INSERT INTO bidding.bid (auction_lot_id, currency, account_id, registration_id, origin, parent_bid_id, client_request_id,
                                  sequence_no, amount_minor, max_amount_minor, outcome_at_placement, reject_reason,
                                  quoted_total_minor, quoted_rule_version_id, server_received_at, channel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [lot.id, lot.currency, b.accountId, registrationId, b.origin, parentId, bidder ? req.clientRequestId : null,
         big(b.seq), big(b.amountMinor), b.maxMinor !== undefined ? big(b.maxMinor) : null, b.outcome, b.rejectReason ?? null,
         bidder ? big(req.quotedTotalMinor) : null, bidder ? req.quotedRuleVersionId : null, b.at, bidder ? req.channel : 'web'],
      );
    }
  }

  /** Closes every lot whose (possibly extended) end time has passed. */
  async closeDueLots(now: Date = new Date()): Promise<Array<{ auctionLotId: string; result: CloseResult }>> {
    const actor: Actor = { type: 'system', id: 'lot-closer', name: 'Lot closer' };
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM auction.auction_lot WHERE result = 'pending' AND current_end_at <= $1 ORDER BY current_end_at`,
      [now],
    );
    const closed: Array<{ auctionLotId: string; result: CloseResult }> = [];
    for (const { id } of due.rows) {
      const outcome = await this.db.tx(actor, async (c) => {
        const lot = await this.lockLot(c, id);
        if (lot.result !== 'pending' || lot.current_end_at > now || !lot.rule_version_id) return null; // extended at the last second
        const snapshot = await this.rulebook.snapshot(lot.rule_version_id, c);
        const pricing = await lotPricing(c, lot.lot_id);
        const result = closeLot(this.engineConfig(snapshot, lot, pricing.categoryPath), await this.lotState(c, lot), now);
        await c.query(
          `UPDATE auction.auction_lot SET result = $2, hammer_minor = $3, winner_account_id = $4, closed_at = $5 WHERE id = $1`,
          [id, result.result, result.result === 'sold' ? big(result.hammerMinor) : null, result.result === 'sold' ? result.winnerAccountId : null, now],
        );
        await c.query(`UPDATE catalogue.lot SET state = 'closed' WHERE id = $1`, [lot.lot_id]);
        if (result.result !== 'sold') await c.query(`UPDATE catalogue.lot SET state = $2 WHERE id = $1`, [lot.lot_id, result.result]);
        await this.outbox(c, 'lot.closed', 'auction_lot', id, result);
        const open = await c.query(`SELECT 1 FROM auction.auction_lot WHERE auction_id = $1 AND result = 'pending' LIMIT 1`, [lot.auction_id]);
        if (open.rowCount === 0) {
          await c.query(`UPDATE auction.auction SET status = 'closed' WHERE id = $1`, [lot.auction_id]);
          await this.outbox(c, 'auction.closed', 'auction', lot.auction_id, {});
        }
        return result;
      });
      if (outcome) closed.push({ auctionLotId: id, result: outcome });
    }
    return closed;
  }
}
