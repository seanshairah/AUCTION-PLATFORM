import { randomBytes } from 'node:crypto';
import type { Currency } from '@abc/domain';
import { big, run, type Actor, type Client, type Db, type Queryable, type RulebookStore } from '@abc/db';
import { categoryPath } from '@abc/limits';
import type { RuleSnapshot } from '@abc/rules';
import {
  consignmentNote,
  statementTotals,
  validateBulkUpload,
  valuationRange,
  type LotDraft,
  type PayoutRow,
  type RowError,
  type StatementTotals,
  type ValuationRange,
} from './intake';

/**
 * Seller portal service (docs/12-seller-portal.md). Sellers create consignments,
 * add lots, sign the consignment note and follow their lots and payouts.
 * Institutions upload whole files of lots in one call.
 */

type ConsignmentType = 'commission' | 'outright_purchase' | 'advance';

export interface LiveLotView {
  lotRef: string;
  title: string;
  state: string;
  currency: Currency;
  currentPriceMinor: bigint | null;
  bids: number;
  uniqueBidders: number;
  reserveMinor: bigint | null;
  reserveMet: boolean | null;
  endsAt: Date | null;
}

export type BulkResult =
  | { ok: true; consignmentId: string; created: number; skippedExisting: number; repeatedBatch: boolean }
  | { ok: false; errors: RowError[] };

function lotRef(branch: string): string {
  return `${branch}-${new Date().getFullYear().toString().slice(2)}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export class SellerService {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
  ) {}

  private async rules(c?: Client): Promise<{ snapshot: RuleSnapshot; versionId: string }> {
    const versionId = await this.rulebook.activeVersionId(new Date(), c);
    return { snapshot: await this.rulebook.snapshot(versionId, c), versionId };
  }

  async createConsignment(
    actor: Actor,
    p: { sellerId: string; type: ConsignmentType; channel: 'portal' | 'app' | 'whatsapp' | 'branch' | 'bulk_api'; branch: string },
  ): Promise<string> {
    return this.db.tx(actor, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO seller.consignment (seller_account_id, consignment_type, intake_channel, branch_code) VALUES ($1, $2, $3, $4) RETURNING id`,
        [p.sellerId, p.type, p.channel, p.branch],
      );
      return r.rows[0]!.id;
    });
  }

  private async insertLot(c: Client, consignmentId: string, sellerId: string, branch: string, d: LotDraft): Promise<string | null> {
    const cat = await c.query<{ is_vehicle: boolean; tax_class: string }>('SELECT is_vehicle, tax_class FROM catalogue.category WHERE code = $1', [d.category]);
    if (!cat.rows[0]) throw new Error(`Unknown category ${d.category}`);
    const r = await c.query<{ id: string }>(
      `INSERT INTO catalogue.lot (lot_ref, consignment_id, seller_account_id, category_code, is_vehicle, title, description, item_state, condition,
                                  condition_notes, quantity, location_branch, settlement_currency, tax_class, starting_bid_minor, reserve_minor,
                                  estimate_low_minor, estimate_high_minor, external_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (seller_account_id, external_ref) DO NOTHING
       RETURNING id`,
      [lotRef(branch), consignmentId, sellerId, d.category, cat.rows[0].is_vehicle, d.title, d.description, d.itemState, d.condition,
       d.conditionNotes ?? null, d.quantity, branch, d.currency, cat.rows[0].tax_class, big(d.startingBidMinor),
       d.reserveMinor === null ? null : big(d.reserveMinor), d.estimateLowMinor === null ? null : big(d.estimateLowMinor),
       d.estimateHighMinor === null ? null : big(d.estimateHighMinor), d.externalRef ?? null],
    );
    return r.rows[0]?.id ?? null;
  }

  /** Adds a draft lot to a consignment that has not been signed yet. */
  async addLot(actor: Actor, consignmentId: string, draft: LotDraft): Promise<string> {
    return this.db.tx(actor, async (c) => {
      const con = await c.query<{ seller_account_id: string; branch_code: string; status: string }>(
        'SELECT seller_account_id, branch_code, status FROM seller.consignment WHERE id = $1 FOR UPDATE',
        [consignmentId],
      );
      const k = con.rows[0];
      if (!k) throw new Error(`Consignment ${consignmentId} not found`);
      if (k.status !== 'draft' && k.status !== 'submitted') throw new Error('Lots cannot be added after the consignment note is signed');
      const id = await this.insertLot(c, consignmentId, k.seller_account_id, k.branch_code, draft);
      if (!id) throw new Error(`A lot with reference ${draft.externalRef} already exists`);
      return id;
    });
  }

  /** Valuation range for a draft lot from the past-results archive (same category and currency, 12 months). */
  async valuation(q: Queryable, category: string, currency: Currency): Promise<ValuationRange | null> {
    const { snapshot } = await this.rules();
    const r = await run<{ hammer_minor: bigint }>(
      q,
      `SELECT hammer_minor FROM catalogue.v_realised_price WHERE category_code = $1 AND currency = $2 AND closed_at > now() - interval '12 months'`,
      [category, currency],
    );
    return valuationRange(r.rows.map((x) => x.hammer_minor), snapshot);
  }

  private async noteFor(c: Client, consignmentId: string, snapshot: RuleSnapshot) {
    const k = await c.query<{ display_name: string; consignment_type: ConsignmentType; branch_code: string; created_at: Date }>(
      `SELECT a.display_name, k.consignment_type, k.branch_code, k.created_at
         FROM seller.consignment k JOIN identity.account a ON a.id = k.seller_account_id WHERE k.id = $1`,
      [consignmentId],
    );
    if (!k.rows[0]) throw new Error(`Consignment ${consignmentId} not found`);
    const lots = await c.query<{ lot_ref: string; title: string; condition: string; settlement_currency: Currency; reserve_minor: bigint | null }>(
      'SELECT lot_ref, title, condition, settlement_currency, reserve_minor FROM catalogue.lot WHERE consignment_id = $1 ORDER BY created_at, lot_ref',
      [consignmentId],
    );
    return consignmentNote({
      consignmentId,
      sellerName: k.rows[0].display_name,
      consignmentType: k.rows[0].consignment_type,
      branch: k.rows[0].branch_code,
      lots: lots.rows.map((l) => ({ lotRef: l.lot_ref, title: l.title, condition: l.condition, currency: l.settlement_currency, reserveMinor: l.reserve_minor })),
      snapshot,
      date: k.rows[0].created_at,
    });
  }

  /** The note the seller reads before signing. */
  async previewNote(consignmentId: string): Promise<{ text: string; sha256: string }> {
    return this.db.tx({ type: 'system', id: 'seller-portal', name: 'Seller portal' }, async (c) => this.noteFor(c, consignmentId, (await this.rules(c)).snapshot));
  }

  /**
   * E-signs the consignment note. The seller's app sends the hash of the note it
   * showed; if the lots or terms changed since, the hashes differ and nothing is signed.
   */
  async sign(
    seller: Actor & { type: 'account' },
    consignmentId: string,
    p: { shownSha256: string; signatureReference: string; noteObjectKey: string },
  ): Promise<{ signed: true } | { signed: false; reason: 'note_changed' | 'no_lots' | 'not_owner' }> {
    return this.db.tx(seller, async (c) => {
      const k = await c.query<{ seller_account_id: string; status: string }>('SELECT seller_account_id, status FROM seller.consignment WHERE id = $1 FOR UPDATE', [consignmentId]);
      if (k.rows[0]?.seller_account_id !== seller.id) return { signed: false, reason: 'not_owner' } as const;
      if (k.rows[0].status === 'signed') return { signed: true } as const;
      const count = await c.query<{ n: bigint }>('SELECT count(*) AS n FROM catalogue.lot WHERE consignment_id = $1', [consignmentId]);
      if (count.rows[0]!.n === 0n) return { signed: false, reason: 'no_lots' } as const;
      const { snapshot, versionId } = await this.rules(c);
      const note = await this.noteFor(c, consignmentId, snapshot);
      if (note.sha256 !== p.shownSha256) return { signed: false, reason: 'note_changed' } as const;
      await c.query(
        `UPDATE seller.consignment
            SET status = 'signed', signed_at = now(), signature_reference = $2, note_object_key = $3,
                note_sha256 = decode($4, 'hex'), commission_rule_version = $5
          WHERE id = $1`,
        [consignmentId, p.signatureReference, p.noteObjectKey, note.sha256, versionId],
      );
      return { signed: true } as const;
    });
  }

  /**
   * Bulk upload for institutions (banks, insurers, customs sales). All or nothing,
   * idempotent per batch reference, and re-uploading a file never duplicates a lot
   * (unique external reference per seller).
   */
  async bulkUpload(
    actor: Actor,
    p: { sellerId: string; batchRef: string; csv: string; branch: string; type?: ConsignmentType },
  ): Promise<BulkResult> {
    return this.db.tx(actor, async (c): Promise<BulkResult> => {
      const prior = await c.query<{ consignment_id: string; created_lot_count: number }>(
        'SELECT consignment_id, created_lot_count FROM seller.bulk_batch WHERE seller_account_id = $1 AND external_batch_ref = $2',
        [p.sellerId, p.batchRef],
      );
      if (prior.rows[0]) {
        return { ok: true, consignmentId: prior.rows[0].consignment_id, created: prior.rows[0].created_lot_count, skippedExisting: 0, repeatedBatch: true };
      }
      const { snapshot } = await this.rules(c);
      const vocab = await c.query<{ kind: string; code: string }>(
        `SELECT 'category' AS kind, code FROM catalogue.category
         UNION ALL SELECT 'state', code FROM catalogue.item_state_term
         UNION ALL SELECT 'condition', code FROM catalogue.condition_term`,
      );
      const pick = (k: string) => vocab.rows.filter((v) => v.kind === k).map((v) => v.code);
      const { lots, errors } = validateBulkUpload(p.csv, { categories: pick('category'), itemStates: pick('state'), conditions: pick('condition'), snapshot });
      if (errors.length) return { ok: false, errors };

      const consignment = await c.query<{ id: string }>(
        `INSERT INTO seller.consignment (seller_account_id, consignment_type, intake_channel, branch_code) VALUES ($1, $2, 'bulk_api', $3) RETURNING id`,
        [p.sellerId, p.type ?? 'commission', p.branch],
      );
      const consignmentId = consignment.rows[0]!.id;
      let created = 0;
      for (const lot of lots) if (await this.insertLot(c, consignmentId, p.sellerId, p.branch, lot)) created++;
      await c.query(
        `INSERT INTO seller.bulk_batch (seller_account_id, external_batch_ref, consignment_id, row_count, created_lot_count) VALUES ($1, $2, $3, $4, $5)`,
        [p.sellerId, p.batchRef, consignmentId, lots.length, created],
      );
      return { ok: true, consignmentId, created, skippedExisting: lots.length - created, repeatedBatch: false };
    });
  }

  /** Live view of the seller's lots: price, bids, bidders and their own reserve (principle 8). */
  async liveLots(q: Queryable, sellerId: string): Promise<LiveLotView[]> {
    const r = await run<{
      lot_ref: string; title: string; state: string; settlement_currency: Currency; current_price_minor: bigint | null;
      bids: bigint; bidders: bigint; reserve_minor: bigint | null; reserve_met: boolean | null; current_end_at: Date | null;
    }>(
      q,
      `SELECT l.lot_ref, l.title, l.state, l.settlement_currency, al.current_price_minor,
              count(b.id) FILTER (WHERE b.outcome_at_placement <> 'rejected') AS bids,
              count(DISTINCT b.account_id) FILTER (WHERE b.outcome_at_placement <> 'rejected') AS bidders,
              l.reserve_minor, al.reserve_met, al.current_end_at
         FROM catalogue.lot l
         LEFT JOIN auction.auction_lot al ON al.id = l.current_auction_lot_id
         LEFT JOIN bidding.bid b ON b.auction_lot_id = al.id
        WHERE l.seller_account_id = $1
        GROUP BY l.id, al.id
        ORDER BY al.current_end_at NULLS LAST, l.lot_ref`,
      [sellerId],
    );
    return r.rows.map((x) => ({
      lotRef: x.lot_ref,
      title: x.title,
      state: x.state,
      currency: x.settlement_currency,
      currentPriceMinor: x.current_price_minor,
      bids: Number(x.bids),
      uniqueBidders: Number(x.bidders),
      reserveMinor: x.reserve_minor,
      reserveMet: x.reserve_met,
      endsAt: x.current_end_at,
    }));
  }

  /** Statement: every payout with its due date and status, plus totals per currency. */
  async statement(q: Queryable, sellerId: string): Promise<{ payouts: PayoutRow[]; totals: StatementTotals[] }> {
    const r = await run<{ id: string; currency: Currency; status: PayoutRow['status']; due_date: Date; gross_minor: bigint; deductions_minor: bigint; net_minor: bigint }>(
      q,
      `SELECT id, currency, status, due_date, gross_minor, deductions_minor, net_minor FROM payout.payout WHERE seller_account_id = $1 ORDER BY due_date`,
      [sellerId],
    );
    const payouts = r.rows.map((p) => ({
      payoutId: p.id,
      currency: p.currency,
      status: p.status,
      dueDate: p.due_date.toISOString().slice(0, 10),
      grossMinor: p.gross_minor,
      deductionsMinor: p.deductions_minor,
      netMinor: p.net_minor,
    }));
    return { payouts, totals: statementTotals(payouts) };
  }

  /** Category path helper re-exported for the portal's lot form. */
  categoryPath(q: Queryable, code: string): Promise<string[]> {
    return categoryPath(q, code);
  }
}
