import { randomUUID } from 'node:crypto';
import type { Currency } from '@abc/domain';
import { run, type Client, type Queryable, type RulebookStore } from '@abc/db';
import { createHold, releaseHoldById } from '@abc/ledger';
import { quoteLot, type LotPricing } from '@abc/quote';
import type { RuleSnapshot, TaxRateRecord, Tier } from '@abc/rules';
import {
  capacity,
  computeLimit,
  decideRegistration,
  exposure,
  type AccountStatus,
  type LeadingLot,
  type LimitResult,
  type RegistrationDecision,
  type VerificationLevel,
} from './limits';

/**
 * Registration and limits service (docs/10-registration-limits.md). Reads
 * accounts, holds, invoices and leading bids; writes registrations and deposit
 * holds. Money only moves through the ledger store.
 */

interface AccountRow {
  id: string;
  tier: Tier;
  verification_level: VerificationLevel;
  status: AccountStatus;
}

async function account(q: Queryable, accountId: string): Promise<AccountRow> {
  const r = await run<AccountRow>(q, 'SELECT id, tier, verification_level, status FROM identity.account WHERE id = $1', [accountId]);
  if (!r.rows[0]) throw new Error(`Account ${accountId} not found`);
  return r.rows[0];
}

/** Category codes from root to leaf. */
export async function categoryPath(q: Queryable, code: string): Promise<string[]> {
  const r = await run<{ code: string }>(
    q,
    `WITH RECURSIVE up(code, parent_code, depth) AS (
       SELECT code, parent_code, 0 FROM catalogue.category WHERE code = $1
       UNION ALL
       SELECT c.code, c.parent_code, up.depth + 1 FROM catalogue.category c JOIN up ON c.code = up.parent_code)
     SELECT code FROM up ORDER BY depth DESC`,
    [code],
  );
  return r.rows.map((x) => x.code);
}

export async function lotPricing(q: Queryable, lotId: string): Promise<LotPricing> {
  const r = await run<{ settlement_currency: Currency; tax_class: string; category_code: string; is_vehicle: boolean }>(
    q,
    'SELECT settlement_currency, tax_class, category_code, is_vehicle FROM catalogue.lot WHERE id = $1',
    [lotId],
  );
  const l = r.rows[0];
  if (!l) throw new Error(`Lot ${lotId} not found`);
  return { currency: l.settlement_currency, taxClass: l.tax_class, categoryPath: await categoryPath(q, l.category_code), isVehicle: l.is_vehicle };
}

/** Seller of a lot, or any account sharing a link signal with that seller (blueprint §8 shill control). */
export async function isLinkedToSellerOfLot(q: Queryable, accountId: string, lotId: string): Promise<boolean> {
  const r = await run<{ linked: boolean }>(
    q,
    `SELECT EXISTS (SELECT 1 FROM catalogue.lot WHERE id = $2 AND seller_account_id = $1)
         OR EXISTS (SELECT 1 FROM identity.link_signal b
                      JOIN identity.link_signal s ON s.signal_type = b.signal_type AND s.signal_hmac = b.signal_hmac
                      JOIN catalogue.lot l ON l.seller_account_id = s.account_id
                     WHERE b.account_id = $1 AND l.id = $2 AND s.account_id <> $1) AS linked`,
    [accountId, lotId],
  );
  return r.rows[0]!.linked;
}

async function linkedToAnySellerInAuction(q: Queryable, accountId: string, auctionId: string): Promise<boolean> {
  const r = await run<{ linked: boolean }>(
    q,
    `SELECT EXISTS (
       SELECT 1 FROM auction.auction_lot al
        WHERE al.auction_id = $2
          AND (EXISTS (SELECT 1 FROM catalogue.lot l WHERE l.id = al.lot_id AND l.seller_account_id = $1)
               OR EXISTS (SELECT 1 FROM identity.link_signal b
                            JOIN identity.link_signal s ON s.signal_type = b.signal_type AND s.signal_hmac = b.signal_hmac
                            JOIN catalogue.lot l ON l.seller_account_id = s.account_id
                           WHERE b.account_id = $1 AND l.id = al.lot_id AND s.account_id <> $1))) AS linked`,
    [accountId, auctionId],
  );
  return r.rows[0]!.linked;
}

export interface JoinRequest {
  accountId: string;
  auctionId: string;
  /** Deposit to hold now, per currency (required for deposit auctions). */
  deposit?: Partial<Record<Currency, bigint>>;
  openRiskFlag?: boolean;
}

export interface JoinResult {
  registrationId: string;
  decision: RegistrationDecision;
  limits: Partial<Record<Currency, LimitResult>>;
  alreadyRegistered: boolean;
}

export class RegistrationService {
  constructor(private readonly rulebook: RulebookStore) {}

  private async auctionInfo(c: Client, auctionId: string) {
    const a = await c.query<{ deposit_required: boolean; rule_version_id: string | null }>(
      'SELECT deposit_required, rule_version_id FROM auction.auction WHERE id = $1',
      [auctionId],
    );
    if (!a.rows[0]) throw new Error(`Auction ${auctionId} not found`);
    const lots = await c.query<{ currency: Currency; category_code: string }>(
      `SELECT DISTINCT al.currency, l.category_code FROM auction.auction_lot al JOIN catalogue.lot l ON l.id = al.lot_id WHERE al.auction_id = $1`,
      [auctionId],
    );
    return { ...a.rows[0], lots: lots.rows };
  }

  private async snapshotFor(c: Client, ruleVersionId: string | null): Promise<RuleSnapshot> {
    return this.rulebook.snapshot(ruleVersionId ?? (await this.rulebook.activeVersionId(new Date(), c)), c);
  }

  /** Highest minimum deposit across the auction's categories, per currency used in it. */
  private async minimumDeposits(c: Client, snapshot: RuleSnapshot, lots: Array<{ currency: Currency; category_code: string }>) {
    const result: Partial<Record<Currency, bigint | null>> = {};
    for (const lot of lots) {
      const path = await categoryPath(c, lot.category_code);
      const min = snapshot.get('deposit.minimum', { categoryPath: path })[lot.currency];
      const current = result[lot.currency];
      if (min === null) result[lot.currency] = current ?? null;
      else if (current === undefined || current === null || BigInt(min) > current) result[lot.currency] = BigInt(min);
    }
    return result;
  }

  /** One tap to join an auction. Idempotent per account and auction. */
  async join(c: Client, req: JoinRequest): Promise<JoinResult> {
    const existing = await c.query<{ id: string; status: string; flag_reasons: string[]; limit_snapshot: unknown }>(
      'SELECT id, status, flag_reasons FROM registration.registration WHERE account_id = $1 AND auction_id = $2',
      [req.accountId, req.auctionId],
    );
    if (existing.rows[0]) {
      const e = existing.rows[0];
      const decision = (e.status === 'approved'
        ? { status: 'approved', reasons: [] }
        : { status: e.status, reasons: e.flag_reasons }) as RegistrationDecision;
      return { registrationId: e.id, decision, limits: {}, alreadyRegistered: true };
    }

    const acct = await account(c, req.accountId);
    const auction = await this.auctionInfo(c, req.auctionId);
    const snapshot = await this.snapshotFor(c, auction.rule_version_id);
    const kyc = await c.query<{ pending: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM identity.kyc_document WHERE account_id = $1 AND status = 'submitted') AS pending`,
      [req.accountId],
    );

    const decision = decideRegistration({
      snapshot,
      tier: acct.tier,
      verificationLevel: acct.verification_level,
      accountStatus: acct.status,
      depositRequired: auction.deposit_required,
      minimumDeposit: await this.minimumDeposits(c, snapshot, auction.lots),
      depositOffered: req.deposit ?? {},
      linkedToSeller: await linkedToAnySellerInAuction(c, req.accountId, req.auctionId),
      openRiskFlag: req.openRiskFlag ?? false,
      kycPending: kyc.rows[0]!.pending,
    });
    if (decision.status === 'rejected') return { registrationId: '', decision, limits: {}, alreadyRegistered: false };

    const registrationId = randomUUID();
    let firstHoldId: string | null = null;
    for (const [currency, amount] of Object.entries(req.deposit ?? {}) as Array<[Currency, bigint]>) {
      if (amount <= 0n) continue;
      const hold = await createHold(c, { accountId: req.accountId, currency, amountMinor: amount, referenceType: 'registration', referenceId: registrationId });
      firstHoldId ??= hold.id;
    }

    const limits: Partial<Record<Currency, LimitResult>> = {};
    for (const currency of new Set(auction.lots.map((l) => l.currency))) {
      limits[currency] = await this.limit(c, req.accountId, currency, auction.deposit_required, snapshot);
    }

    await c.query(
      `INSERT INTO registration.registration (id, account_id, auction_id, status, decided_by_type, decided_at, flag_reasons, limit_snapshot, deposit_hold_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        registrationId,
        req.accountId,
        req.auctionId,
        decision.status,
        decision.status === 'approved' ? 'system' : null,
        decision.status === 'approved' ? new Date() : null,
        decision.reasons,
        JSON.stringify(limits, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
        firstHoldId,
      ],
    );
    // The bidder hears "registered" or "being checked" (communications, docs/16 §4).
    await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('registration.decided', 'registration', $1, $2::jsonb)`, [
      registrationId,
      JSON.stringify({ accountId: req.accountId, auctionId: req.auctionId, status: decision.status }),
    ]);
    return { registrationId, decision, limits, alreadyRegistered: false };
  }

  /** The bidder's limit in one currency, from the ledger and their payment history. */
  async limit(q: Client, accountId: string, currency: Currency, depositRequired: boolean, snapshot: RuleSnapshot): Promise<LimitResult> {
    const acct = await account(q, accountId);
    const figures = await q.query<{ held: bigint; paid: bigint; override: bigint | null }>(
      `SELECT
         (SELECT coalesce(sum(amount_minor), 0)::bigint FROM ledger.hold
           WHERE account_id = $1 AND currency = $2 AND status = 'active') AS held,
         (SELECT coalesce(sum(total_minor), 0)::bigint FROM settlement.invoice
           WHERE buyer_account_id = $1 AND currency = $2 AND status = 'paid' AND paid_at > now() - interval '12 months') AS paid,
         (SELECT limit_minor FROM registration.limit_override
           WHERE account_id = $1 AND currency = $2 AND valid_until > now() ORDER BY created_at DESC LIMIT 1) AS override`,
      [accountId, currency],
    );
    const f = figures.rows[0]!;
    return computeLimit({
      snapshot,
      currency,
      tier: acct.tier,
      verificationLevel: acct.verification_level,
      accountStatus: acct.status,
      depositRequired,
      heldDepositMinor: f.held,
      paidInFull12mMinor: f.paid,
      overrideMinor: f.override,
    });
  }

  /**
   * Room left to bid, all-in, for a bid on `auctionLotId`. Exposure counts every
   * live lot the bidder leads (at their maximum, all-in) and every unpaid invoice;
   * the lot being bid on is left out because the new maximum replaces it.
   */
  async capacityFor(
    c: Client,
    p: { accountId: string; auctionLotId: string; currency: Currency; depositRequired: boolean; snapshot: RuleSnapshot; taxRates: readonly TaxRateRecord[]; at: Date },
  ): Promise<{ limit: LimitResult; exposureMinor: bigint; capacityMinor: bigint }> {
    const limit = await this.limit(c, p.accountId, p.currency, p.depositRequired, p.snapshot);
    const leadingRows = await c.query<{ auction_lot_id: string; lot_id: string; price: bigint; max: bigint }>(
      `SELECT al.id AS auction_lot_id, al.lot_id, al.current_price_minor AS price,
              coalesce(parent.max_amount_minor, b.max_amount_minor) AS max
         FROM auction.auction_lot al
         JOIN bidding.bid b ON b.id = al.leading_bid_id
         LEFT JOIN bidding.bid parent ON parent.id = b.parent_bid_id
        WHERE al.leading_account_id = $1 AND al.currency = $2 AND al.result = 'pending'`,
      [p.accountId, p.currency],
    );
    const leading: LeadingLot[] = [];
    for (const row of leadingRows.rows) {
      const lot = await lotPricing(c, row.lot_id);
      const q = (hammer: bigint) => quoteLot({ lot, hammerMinor: hammer, snapshot: p.snapshot, taxRates: p.taxRates, at: p.at }).totalMinor;
      leading.push({ auctionLotId: row.auction_lot_id, allInAtMaxMinor: q(row.max), allInAtCurrentMinor: q(row.price) });
    }
    const unpaid = await c.query<{ total: bigint }>(
      `SELECT coalesce(sum(total_minor), 0)::bigint AS total FROM settlement.invoice
        WHERE buyer_account_id = $1 AND currency = $2 AND status IN ('issued', 'overdue')`,
      [p.accountId, p.currency],
    );
    const exposureMinor = exposure(p.snapshot, leading, unpaid.rows[0]!.total, p.auctionLotId);
    return { limit, exposureMinor, capacityMinor: capacity(limit.limitMinor, exposureMinor) };
  }

  /**
   * A staff decision on a registration in the review queue (docs/10 §3, docs/18 §5).
   * Approval records the limit at the time of the decision; refusal returns any deposit
   * held for it. The note is required by the database for staff decisions. Deciding
   * again with the same outcome returns the first decision (R4).
   */
  async decideReview(
    c: Client,
    p: { registrationId: string; staffId: string; decision: 'approved' | 'rejected'; note: string },
  ): Promise<{ status: 'approved' | 'rejected'; alreadyDecided: boolean; limits: Partial<Record<Currency, LimitResult>> }> {
    const r = await c.query<{ id: string; account_id: string; auction_id: string; status: string }>(
      'SELECT id, account_id, auction_id, status FROM registration.registration WHERE id = $1 FOR UPDATE',
      [p.registrationId],
    );
    const reg = r.rows[0];
    if (!reg) throw new Error(`Registration ${p.registrationId} not found`);
    if (reg.status === p.decision) return { status: p.decision, alreadyDecided: true, limits: {} };
    if (reg.status !== 'pending_review') throw new Error(`Registration ${p.registrationId} is already ${reg.status}`);

    const limits: Partial<Record<Currency, LimitResult>> = {};
    if (p.decision === 'approved') {
      const auction = await this.auctionInfo(c, reg.auction_id);
      const snapshot = await this.snapshotFor(c, auction.rule_version_id);
      for (const currency of new Set(auction.lots.map((l) => l.currency))) {
        limits[currency] = await this.limit(c, reg.account_id, currency, auction.deposit_required, snapshot);
      }
    } else {
      const holds = await c.query<{ id: string }>(
        `SELECT id FROM ledger.hold WHERE reference_type = 'registration' AND reference_id = $1 AND status = 'active'`,
        [reg.id],
      );
      for (const h of holds.rows) await releaseHoldById(c, h.id);
    }
    await c.query(
      `UPDATE registration.registration
          SET status = $2, decided_by_type = 'staff', decided_by = $3, decided_at = now(), decision_note = $4,
              limit_snapshot = CASE WHEN $2 = 'approved' THEN $5::jsonb ELSE limit_snapshot END
        WHERE id = $1`,
      [reg.id, p.decision, p.staffId, p.note, JSON.stringify(limits, (_, v) => (typeof v === 'bigint' ? v.toString() : v))],
    );
    await c.query('INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4::jsonb)', [
      `registration.${p.decision}`,
      'registration',
      reg.id,
      JSON.stringify({ accountId: reg.account_id, auctionId: reg.auction_id, decidedBy: 'staff' }),
    ]);
    return { status: p.decision, alreadyDecided: false, limits };
  }

  /** Adds to a registration's deposit (e.g. after "Add a deposit to bid higher"). */
  async addDeposit(c: Client, registrationId: string, currency: Currency, amountMinor: bigint): Promise<string> {
    const r = await c.query<{ account_id: string }>('SELECT account_id FROM registration.registration WHERE id = $1', [registrationId]);
    if (!r.rows[0]) throw new Error(`Registration ${registrationId} not found`);
    const hold = await createHold(c, { accountId: r.rows[0].account_id, currency, amountMinor, referenceType: 'registration', referenceId: registrationId });
    return hold.id;
  }
}

