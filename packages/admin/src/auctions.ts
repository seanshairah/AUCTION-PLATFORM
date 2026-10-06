import { randomUUID } from 'node:crypto';
import type { BiddingService } from '@abc/bidding';
import { checkListingReadiness, type Readiness, type ReadinessInput } from '@abc/catalogue';
import type { Currency } from '@abc/domain';
import { big, isUniqueViolation, run, type Client, type Db, type Queryable, type RulebookStore } from '@abc/db';
import { categoryPath } from '@abc/limits';
import type { RuleSnapshot, TaxRateRecord } from '@abc/rules';
import { AdminError, requirePermission, staffActor, type StaffMember } from './permissions';

/**
 * Auction scheduling (docs/18 §8): create an auction with staggered ends, attach lots
 * that pass listing readiness (the "all-in price on every lot" gate, docs/05 §4), then
 * open it through BiddingService.openAuction, which pins the rule set (A20).
 */

export interface CreateAuctionInput {
  code: string;
  title: string;
  branch: string;
  format?: 'timed_online' | 'floor' | 'out_of_hand';
  opensAt: Date;
  firstCloseAt: Date;
  staggerSeconds?: number;
  softCloseSeconds?: number | null;
  depositRequired?: boolean;
  experimentVariant?: string | null;
}

export interface AttachResult {
  lotId: string;
  attached: boolean;
  alreadyAttached?: boolean;
  lotNumber?: number;
  scheduledEndAt?: Date;
  blockers: Array<{ code: string; message: string }>;
  warnings: Readiness['warnings'];
}

const ATTACHABLE_STATES = ['draft', 'listed', 'unsold', 'reserve_not_met', 'refunded'];

/** Reads everything listing readiness needs about one lot. */
export async function readinessInput(q: Queryable, lotId: string, snapshot: RuleSnapshot, taxRates: readonly TaxRateRecord[], at: Date): Promise<ReadinessInput> {
  const l = await run<{
    title: string; description: string; category_code: string; item_state: string; condition: string; condition_notes: string | null;
    settlement_currency: Currency; tax_class: string; is_vehicle: boolean; starting_bid_minor: bigint; reserve_minor: bigint | null;
  }>(q, 'SELECT * FROM catalogue.lot WHERE id = $1', [lotId]);
  const lot = l.rows[0];
  if (!lot) throw new AdminError('not_found', `We could not find lot ${lotId}.`);
  const media = await run<{ kind: 'photo' | 'video' | 'document'; role: string }>(q, 'SELECT kind, role FROM catalogue.lot_media WHERE lot_id = $1', [lotId]);
  const vehicle = await run<{ chassis_number: string; zimbabwe_registered: boolean }>(q, 'SELECT chassis_number, zimbabwe_registered FROM catalogue.vehicle WHERE lot_id = $1', [lotId]);
  const inspection = await run<{ photo_count: number; has_video: boolean; chassis_verified: boolean }>(
    q,
    `SELECT photo_count, has_video, chassis_verified FROM catalogue.inspection_report
      WHERE lot_id = $1 AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1`,
    [lotId],
  );
  const vocab = await run<{ kind: string; code: string }>(q, `SELECT 'state' AS kind, code FROM catalogue.item_state_term UNION ALL SELECT 'condition', code FROM catalogue.condition_term`);
  const v = vehicle.rows[0];
  const i = inspection.rows[0];
  return {
    lot: {
      title: lot.title, description: lot.description, categoryPath: await categoryPath(q, lot.category_code), itemState: lot.item_state,
      condition: lot.condition, conditionNotes: lot.condition_notes, currency: lot.settlement_currency, taxClass: lot.tax_class,
      isVehicle: lot.is_vehicle, startingBidMinor: lot.starting_bid_minor, reserveMinor: lot.reserve_minor,
    },
    media: media.rows,
    vehicle: v ? { chassisNumber: v.chassis_number, zimbabweRegistered: v.zimbabwe_registered } : null,
    inspection: i ? { published: true, photoCount: i.photo_count, hasVideo: i.has_video, chassisVerified: i.chassis_verified } : null,
    vocabulary: {
      itemStates: vocab.rows.filter((r) => r.kind === 'state').map((r) => r.code),
      conditions: vocab.rows.filter((r) => r.kind === 'condition').map((r) => r.code),
    },
    snapshot,
    taxRates,
    at,
  };
}

export class AuctionScheduler {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    private readonly bidding: BiddingService,
  ) {}

  private async snapshot(c?: Client): Promise<RuleSnapshot> {
    try {
      return await this.rulebook.snapshot(await this.rulebook.activeVersionId(new Date(), c), c);
    } catch {
      throw new AdminError('conflict', 'No rule set is in force, so auctions cannot be scheduled yet.');
    }
  }

  /** Creates a scheduled auction. The code is the idempotency key: the same code returns the same auction (R4). */
  async create(staff: StaffMember, input: CreateAuctionInput): Promise<{ auctionId: string; code: string; created: boolean; staggerSeconds: number }> {
    requirePermission(staff, 'auction.schedule');
    if (!/^[A-Z0-9][A-Z0-9-]{2,40}$/.test(input.code)) throw new AdminError('invalid', 'Use a code of capital letters, digits and dashes, e.g. HRE-2026-11-VEH.');
    if (!input.title || input.title.trim().length < 5) throw new AdminError('invalid', 'Give the auction a title.');
    if (!(input.firstCloseAt.getTime() > input.opensAt.getTime())) throw new AdminError('invalid', 'The first lot must close after the auction opens.');
    const snapshot = await this.snapshot();
    const stagger = input.staggerSeconds ?? snapshot.get('bidding.stagger_seconds');
    if (!Number.isInteger(stagger) || stagger < 0) throw new AdminError('invalid', 'The stagger must be a whole number of seconds.');
    if (input.softCloseSeconds !== undefined && input.softCloseSeconds !== null) {
      const allowed = snapshot.get('bidding.soft_close_allowed_seconds');
      if (!allowed.includes(input.softCloseSeconds)) {
        throw new AdminError('invalid', `Soft close must be one of the rulebook's test values: ${allowed.join(', ')} seconds.`);
      }
    }
    return this.db.tx(staffActor(staff, `schedule auction ${input.code}`), async (c) => {
      const existing = await c.query<{ id: string; stagger_seconds: number }>('SELECT id, stagger_seconds FROM auction.auction WHERE code = $1', [input.code]);
      if (existing.rows[0]) return { auctionId: existing.rows[0].id, code: input.code, created: false, staggerSeconds: existing.rows[0].stagger_seconds };
      const branch = await c.query('SELECT 1 FROM core.branch WHERE code = $1', [input.branch]);
      if (!branch.rowCount) throw new AdminError('invalid', `Unknown branch ${input.branch}.`);
      const id = randomUUID();
      await c.query(
        `INSERT INTO auction.auction (id, code, title, format, branch_code, status, opens_at, first_close_at, stagger_seconds,
                                      soft_close_seconds, experiment_variant, deposit_required, created_by)
         VALUES ($1, $2, $3, $4, $5, 'scheduled', $6, $7, $8, $9, $10, $11, $12)`,
        [id, input.code, input.title.trim(), input.format ?? 'timed_online', input.branch, input.opensAt, input.firstCloseAt, stagger,
         input.softCloseSeconds ?? null, input.experimentVariant ?? null, input.depositRequired ?? false, staff.id],
      );
      await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('auction.scheduled', 'auction', $1, $2::jsonb)`, [
        id,
        JSON.stringify({ code: input.code, opensAt: input.opensAt, firstCloseAt: input.firstCloseAt, staggerSeconds: stagger }),
      ]);
      return { auctionId: id, code: input.code, created: true, staggerSeconds: stagger };
    });
  }

  /**
   * Attaches lots in the order given. Each must pass listing readiness against the rule
   * set in force; lots that fail are reported with their blockers and not attached.
   * Ends are staggered: lot n closes at first close + (n − 1) × stagger.
   */
  async attachLots(staff: StaffMember, auctionId: string, lotIds: readonly string[], now: Date = new Date()): Promise<AttachResult[]> {
    requirePermission(staff, 'auction.schedule');
    if (lotIds.length === 0 || lotIds.some((id) => !/^[0-9a-f-]{36}$/.test(id))) throw new AdminError('invalid', 'Give one or more lot references.');
    const snapshot = await this.snapshot();
    const taxRates = await this.rulebook.taxRates();
    const results: AttachResult[] = [];
    for (const lotId of lotIds) {
      const result = await this.db.tx(staffActor(staff, 'attach lot to auction'), async (c): Promise<AttachResult> => {
        const a = await c.query<{ status: string; first_close_at: Date; stagger_seconds: number }>(
          'SELECT status, first_close_at, stagger_seconds FROM auction.auction WHERE id = $1 FOR UPDATE',
          [auctionId],
        );
        const auction = a.rows[0];
        if (!auction) throw new AdminError('not_found', 'We could not find that auction.');
        if (auction.status !== 'scheduled' && auction.status !== 'draft') throw new AdminError('conflict', `Lots can only be added before the auction opens; it is ${auction.status}.`);
        const already = await c.query<{ lot_number: number; scheduled_end_at: Date }>('SELECT lot_number, scheduled_end_at FROM auction.auction_lot WHERE auction_id = $1 AND lot_id = $2', [auctionId, lotId]);
        if (already.rows[0]) {
          return { lotId, attached: true, alreadyAttached: true, lotNumber: already.rows[0].lot_number, scheduledEndAt: already.rows[0].scheduled_end_at, blockers: [], warnings: [] };
        }
        const l = await c.query<{ state: string; settlement_currency: Currency; starting_bid_minor: bigint; reserve_minor: bigint | null; current_auction_lot_id: string | null }>(
          'SELECT state, settlement_currency, starting_bid_minor, reserve_minor, current_auction_lot_id FROM catalogue.lot WHERE id = $1 FOR UPDATE',
          [lotId],
        );
        const lot = l.rows[0];
        if (!lot) throw new AdminError('not_found', `We could not find lot ${lotId}.`);
        if (!ATTACHABLE_STATES.includes(lot.state)) {
          return { lotId, attached: false, blockers: [{ code: 'lot_not_offerable', message: `The lot is ${lot.state.replaceAll('_', ' ')}, so it cannot be offered.` }], warnings: [] };
        }
        if (lot.current_auction_lot_id) {
          const busy = await c.query(`SELECT 1 FROM auction.auction_lot WHERE id = $1 AND result = 'pending'`, [lot.current_auction_lot_id]);
          if (busy.rowCount) {
            return { lotId, attached: false, blockers: [{ code: 'lot_in_other_auction', message: 'The lot is already in another auction that has not closed.' }], warnings: [] };
          }
        }
        const readiness = checkListingReadiness(await readinessInput(c, lotId, snapshot, taxRates, now));
        if (!readiness.ready) return { lotId, attached: false, blockers: readiness.blockers, warnings: readiness.warnings };

        const n = (await c.query<{ n: number }>('SELECT coalesce(max(lot_number), 0) + 1 AS n FROM auction.auction_lot WHERE auction_id = $1', [auctionId])).rows[0]!.n;
        const endsAt = new Date(auction.first_close_at.getTime() + (n - 1) * auction.stagger_seconds * 1000);
        const auctionLotId = randomUUID();
        if (lot.state !== 'listed') await c.query(`UPDATE catalogue.lot SET state = 'listed' WHERE id = $1`, [lotId]);
        await c.query(
          `INSERT INTO auction.auction_lot (id, auction_id, lot_id, currency, lot_number, starting_bid_minor, reserve_minor, scheduled_end_at, current_end_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
          [auctionLotId, auctionId, lotId, lot.settlement_currency, n, big(lot.starting_bid_minor), lot.reserve_minor === null ? null : big(lot.reserve_minor), endsAt],
        );
        await c.query('UPDATE catalogue.lot SET current_auction_lot_id = $2 WHERE id = $1', [lotId, auctionLotId]);
        await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('lot.listed', 'lot', $1, $2::jsonb)`, [
          lotId,
          JSON.stringify({ auctionId, auctionLotId, lotNumber: n }),
        ]);
        return { lotId, attached: true, lotNumber: n, scheduledEndAt: endsAt, blockers: [], warnings: readiness.warnings };
      }).catch((e) => {
        if (isUniqueViolation(e)) return { lotId, attached: false, blockers: [{ code: 'concurrent_change', message: 'Another change to this auction happened at the same time. Try again.' }], warnings: [] };
        throw e;
      });
      results.push(result);
    }
    return results;
  }

  /** Opens the auction: lots go live and the rule set in force is pinned for its whole life. */
  async open(staff: StaffMember, auctionId: string, now: Date = new Date()): Promise<{ auctionId: string; ruleVersionId: string; lots: number; alreadyOpen: boolean }> {
    requirePermission(staff, 'auction.schedule');
    const a = await this.db.query<{ status: string; rule_version_id: string | null; lots: bigint }>(
      `SELECT status, rule_version_id, (SELECT count(*) FROM auction.auction_lot WHERE auction_id = a.id) AS lots FROM auction.auction a WHERE id = $1`,
      [auctionId],
    );
    const row = a.rows[0];
    if (!row) throw new AdminError('not_found', 'We could not find that auction.');
    if (row.status === 'open' && row.rule_version_id) return { auctionId, ruleVersionId: row.rule_version_id, lots: Number(row.lots), alreadyOpen: true };
    if (row.status !== 'scheduled') throw new AdminError('conflict', `The auction is ${row.status}; only a scheduled auction opens.`);
    if (Number(row.lots) === 0) throw new AdminError('conflict', 'Add at least one lot before opening the auction.');
    const ruleVersionId = await this.bidding.openAuction(staffActor(staff, 'open auction'), auctionId, now);
    return { auctionId, ruleVersionId, lots: Number(row.lots), alreadyOpen: false };
  }
}
