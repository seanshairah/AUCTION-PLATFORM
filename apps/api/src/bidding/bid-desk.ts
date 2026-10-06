import type { BiddingService, PlaceBidOutcome } from '@abc/bidding';
import type { Actor, Db, RulebookStore } from '@abc/db';
import { formatMinor, type Currency } from '@abc/domain';
import type { RegistrationService } from '@abc/limits';
import { commitPreview } from '@abc/quote';
import { maybeMoney, moneyJson } from '../http';
import type { CatalogueReader } from '../lots/catalogue-reader';

/**
 * The bidder's commands: the commit screen preview, placing a bid, one-tap
 * registration with a deposit, and the "my bids" and wallet views. Every check
 * that matters runs in the shared services; this layer only adapts them to HTTP.
 */

const REJECTION_TEXT: Record<string, string> = {
  auction_not_open: 'This lot is not open for bids.',
  lot_closed: 'Bidding on this lot has closed.',
  not_registered: 'Join this auction before you bid.',
  registration_pending: 'Your registration is being reviewed. We will message you when you can bid.',
  seller_linked: 'You cannot bid on this lot because your account is linked to its seller.',
  price_unavailable: 'We cannot show the full price for this lot right now, so bidding is paused.',
  price_changed: 'The total changed since you looked. Check the new total and confirm again.',
  over_limit: 'This bid is above what you can bid right now. Add a deposit to bid higher.',
  below_minimum: 'Your bid is below the lowest bid allowed now.',
  not_above_your_max: 'You are already leading with a higher maximum.',
};

export class BidDesk {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    private readonly registrations: RegistrationService,
    private readonly bidding: BiddingService,
    private readonly catalogue: CatalogueReader,
  ) {}

  private async withClient<T>(fn: (c: import('@abc/db').Client) => Promise<T>): Promise<T> {
    const c = await this.db.pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }

  /** The commit screen: total if you win, as you type (blueprint module 6). */
  async preview(lotIdOrRef: string, typed: string, accountId: string | null, at = new Date()) {
    const row = await this.catalogue.lotRow(lotIdOrRef);
    if (!row) return null;
    if (!row.rule_version_id || row.result !== 'pending') return { status: 'unavailable', message: 'This lot is not open for bids.' };
    const snapshot = await this.rulebook.snapshot(row.rule_version_id);
    const taxRates = await this.rulebook.taxRates();
    const pricing = await this.catalogue.pricing(row);

    let availableToBidMinor: bigint | undefined;
    let registered = false;
    if (accountId) {
      const reg = await this.db.query<{ status: string }>('SELECT status FROM registration.registration WHERE account_id = $1 AND auction_id = $2', [accountId, row.auction_id]);
      registered = reg.rows[0]?.status === 'approved';
      if (registered) {
        const room = await this.withClient((c) =>
          this.registrations.capacityFor(c, { accountId, auctionLotId: row.auction_lot_id, currency: row.currency, depositRequired: row.deposit_required, snapshot, taxRates, at }),
        );
        availableToBidMinor = room.capacityMinor;
      }
    }
    const p = commitPreview({
      lot: pricing,
      snapshot,
      taxRates,
      at,
      typed,
      lotState: { startingBidMinor: row.starting_bid_minor, currentPriceMinor: row.current_price_minor },
      ...(availableToBidMinor !== undefined ? { availableToBidMinor } : {}),
    });
    const c = row.currency;
    const base = { status: p.status, message: p.message, registered, availableToBid: maybeMoney(availableToBidMinor, c) };
    if (p.status === 'ok' || p.status === 'over_limit') {
      return {
        ...base,
        amount: moneyJson(p.amountMinor, c),
        lines: p.quote.lines.map((l) => ({ type: l.type, description: l.description, amount: moneyJson(l.amountMinor, c) })),
        total: moneyJson(p.quote.totalMinor, c),
        ruleVersionId: p.quote.ruleVersionId,
      };
    }
    if (p.status === 'below_minimum') return { ...base, minimum: moneyJson(p.minimumMinor, c) };
    return base;
  }

  async placeBid(
    account: { id: string; name: string },
    lotIdOrRef: string,
    req: { maxMinor: bigint; quotedTotalMinor: bigint; quotedRuleVersionId: string; clientRequestId: string },
  ) {
    const row = await this.catalogue.lotRow(lotIdOrRef);
    if (!row) return null;
    const actor: Actor = { type: 'account', id: account.id, name: account.name, requestId: req.clientRequestId };
    const out: PlaceBidOutcome = await this.bidding.placeBid(actor, {
      accountId: account.id,
      auctionLotId: row.auction_lot_id,
      maxMinor: req.maxMinor,
      clientRequestId: req.clientRequestId,
      quotedTotalMinor: req.quotedTotalMinor,
      quotedRuleVersionId: req.quotedRuleVersionId,
      channel: 'web',
    });
    const c = row.currency;
    const receipt = out.receipt
      ? {
          seq: out.receipt.seq.toString(),
          serverTime: out.receipt.serverTime.toISOString(),
          outcome: out.receipt.outcome,
          currentPrice: maybeMoney(out.receipt.currentPriceMinor, c),
          youAreLeading: out.receipt.youAreLeading,
          endsAt: out.receipt.endAt.toISOString(),
          reserveStatus: out.receipt.reserveStatus,
        }
      : null;
    if (out.accepted) {
      const message = out.receipt.youAreLeading
        ? `You are leading at ${formatMinor(out.receipt.currentPriceMinor ?? req.maxMinor, c)}. We bid for you up to ${formatMinor(req.maxMinor, c)}.`
        : `Someone else's maximum is higher. The price is now ${formatMinor(out.receipt.currentPriceMinor ?? 0n, c)}.`;
      return { accepted: true, repeated: out.repeated, message, receipt };
    }
    let message = REJECTION_TEXT[out.reason] ?? 'Your bid was not accepted.';
    if (out.reason === 'below_minimum' && out.minimumMinor !== undefined) message = `The lowest bid you can place is ${formatMinor(out.minimumMinor, c)}.`;
    if (out.reason === 'over_limit' && out.capacityMinor !== undefined) message = `You can bid up to ${formatMinor(out.capacityMinor, c)} all-in right now. Add a deposit to bid higher.`;
    return {
      accepted: false,
      reason: out.reason,
      message,
      receipt,
      serverTotal: out.serverQuote ? moneyJson(out.serverQuote.totalMinor, c) : null,
    };
  }

  /** One-tap registration; holds the deposit from the wallet when the auction needs one. */
  async join(account: { id: string; name: string }, auctionId: string, depositMinor: bigint | null) {
    const auction = await this.db.query<{ deposit_required: boolean; status: string }>('SELECT deposit_required, status FROM auction.auction WHERE id = $1', [auctionId]);
    const a = auction.rows[0];
    if (!a) return null;
    if (a.status !== 'open' && a.status !== 'scheduled') return { ok: false, message: 'This auction is not taking registrations.' };
    const actor: Actor = { type: 'account', id: account.id, name: account.name, reason: 'join auction' };
    try {
      const r = await this.db.tx(actor, (c) =>
        this.registrations.join(c, { accountId: account.id, auctionId, ...(depositMinor ? { deposit: { USD: depositMinor } } : {}) }),
      );
      return {
        ok: r.decision.status === 'approved',
        status: r.decision.status,
        alreadyRegistered: r.alreadyRegistered,
        reasons: r.decision.reasons,
        limits: Object.fromEntries(Object.entries(r.limits).map(([cur, l]) => [cur, { limit: moneyJson(l!.limitMinor, cur as Currency), notes: l!.notes }])),
        message:
          r.decision.status === 'approved'
            ? r.alreadyRegistered ? 'You are already registered for this auction.' : 'You are registered. You can bid now.'
            : 'Your registration needs a quick review. We will message you.',
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: /balance|insufficient|negative|check constraint/i.test(msg) ? 'Your wallet does not have enough for this deposit. Top up first.' : msg };
    }
  }

  async me(accountId: string) {
    const r = await this.db.query<{ id: string; display_name: string; verification_level: string; tier: string; email: string | null; phone_e164: string | null }>(
      'SELECT id, display_name, verification_level, tier, email, phone_e164 FROM identity.account WHERE id = $1',
      [accountId],
    );
    const a = r.rows[0];
    if (!a) return null;
    return { id: a.id, name: a.display_name, verification: a.verification_level, tier: a.tier, email: a.email, phone: a.phone_e164 };
  }

  async wallet(accountId: string) {
    const balances = await this.db.query<{ currency: Currency; available_minor: bigint; held_minor: bigint }>(
      'SELECT currency, available_minor, held_minor FROM ledger.v_wallet WHERE account_id = $1 ORDER BY currency',
      [accountId],
    );
    const payments = await this.db.query<{ id: string; method: string; currency: Currency; amount_minor: bigint; status: string; created_at: Date; receipt_number: string | null }>(
      `SELECT id, method, currency, amount_minor, status, created_at, receipt_number FROM payment.payment
        WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [accountId],
    );
    const holds = await this.db.query<{ id: string; currency: Currency; amount_minor: bigint; purpose: string; auction_title: string | null; created_at: Date }>(
      `SELECT h.id, h.currency, h.amount_minor, h.purpose, a.title AS auction_title, h.created_at
         FROM ledger.hold h
         LEFT JOIN registration.registration r ON r.deposit_hold_id = h.id
         LEFT JOIN auction.auction a ON a.id = r.auction_id
        WHERE h.account_id = $1 AND h.status = 'active' ORDER BY h.created_at DESC`,
      [accountId],
    );
    return {
      balances: balances.rows.map((b) => ({ currency: b.currency, available: moneyJson(b.available_minor, b.currency), held: moneyJson(b.held_minor, b.currency) })),
      holds: holds.rows.map((h) => ({
        id: h.id,
        description: h.purpose === 'auction_deposit' ? `Deposit${h.auction_title ? `: ${h.auction_title}` : ''}` : 'Standing deposit',
        amount: moneyJson(h.amount_minor, h.currency),
        since: h.created_at.toISOString(),
      })),
      payments: payments.rows.map((p) => ({ id: p.id, method: p.method, status: p.status, amount: moneyJson(p.amount_minor, p.currency), at: p.created_at.toISOString(), receipt: p.receipt_number })),
    };
  }

  /** Lots the account has bid on, newest activity first. */
  async myBids(accountId: string) {
    const r = await this.db.query<{
      auction_lot_id: string; lot_ref: string; title: string; currency: Currency; current_price_minor: bigint | null; current_end_at: Date;
      result: string; leading_account_id: string | null; winner_account_id: string | null; hammer_minor: bigint | null; my_max: bigint | null; last_bid_at: Date;
    }>(
      `SELECT al.id AS auction_lot_id, l.lot_ref, l.title, al.currency, al.current_price_minor, al.current_end_at, al.result,
              al.leading_account_id, al.winner_account_id, al.hammer_minor,
              max(b.max_amount_minor) FILTER (WHERE b.origin = 'bidder' AND b.outcome_at_placement <> 'rejected') AS my_max,
              max(b.server_received_at) AS last_bid_at
         FROM bidding.bid b
         JOIN auction.auction_lot al ON al.id = b.auction_lot_id
         JOIN catalogue.lot l ON l.id = al.lot_id
        WHERE b.account_id = $1
        GROUP BY al.id, l.lot_ref, l.title
        ORDER BY (al.result = 'pending') DESC, al.current_end_at ASC
        LIMIT 100`,
      [accountId],
    );
    return r.rows.map((x) => {
      const open = x.result === 'pending';
      const status = open ? (x.leading_account_id === accountId ? 'leading' : 'outbid') : x.winner_account_id === accountId ? 'won' : 'lost';
      return {
        id: x.auction_lot_id,
        ref: x.lot_ref,
        title: x.title,
        status,
        currentPrice: maybeMoney(open ? x.current_price_minor : x.hammer_minor ?? x.current_price_minor, x.currency),
        yourMax: maybeMoney(x.my_max, x.currency),
        endsAt: x.current_end_at.toISOString(),
        lastBidAt: x.last_bid_at.toISOString(),
      };
    });
  }
}
