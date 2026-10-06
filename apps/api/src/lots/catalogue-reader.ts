import type { Db, RulebookStore } from '@abc/db';
import type { Currency } from '@abc/domain';
import { publicHistory, type LoggedBid } from '@abc/engine';
import { quoteLot, type LotPricing, type Quote } from '@abc/quote';
import { ladderFor, minimumNextBid, renderRulebook, type RuleSnapshot, type TaxRateRecord } from '@abc/rules';
import { lotStructuredData } from '@abc/catalogue';
import { CHECKLISTS } from '@abc/vehicles';
import { maybeMoney, moneyJson, type MoneyJson } from '../http';

/**
 * Read models for the catalogue screens. Every price shown comes from quoteLot
 * with the auction's pinned rule version: the same function and the same rules
 * the commit screen, the bid check and the invoice use (architecture rule R2).
 */

/**
 * Where a stored object is served from. Production points MEDIA_BASE_URL at the object
 * store's CDN; development serves the demo photo set from the web app's /media route.
 */
export function mediaUrl(objectKey: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.MEDIA_BASE_URL ?? '/media').replace(/\/$/, '');
  return `${base}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
}

export interface AuctionSummary {
  id: string;
  code: string;
  title: string;
  branch: { code: string; name: string; city: string };
  status: string;
  opensAt: string;
  firstCloseAt: string;
  lastCloseAt: string | null;
  staggerSeconds: number;
  depositRequired: boolean;
  lots: number;
  liveLots: number;
  bids: number;
  cover: string | null;
}

export interface LotFilters {
  q?: string;
  category?: 'vehicles' | 'other';
  make?: string;
  model?: string;
  yearFrom?: number;
  yearTo?: number;
  bodyStyle?: string;
  transmission?: string;
  fuel?: string;
  drive?: string;
  branch?: string;
  maxPriceMinor?: bigint;
  noReserve?: boolean;
  endingWithinHours?: number;
  sort?: 'ending_soon' | 'newest' | 'price_low' | 'price_high' | 'most_bids';
}

interface LotRow {
  auction_lot_id: string;
  lot_id: string;
  lot_ref: string;
  title: string;
  description: string;
  category_code: string;
  category_name: string;
  is_vehicle: boolean;
  tax_class: string;
  item_state: string;
  item_state_label: string;
  condition: string;
  condition_label: string;
  condition_notes: string | null;
  location_branch: string;
  branch_name: string;
  currency: Currency;
  starting_bid_minor: bigint;
  reserve_minor: bigint | null;
  current_price_minor: bigint | null;
  current_end_at: Date;
  scheduled_end_at: Date;
  extension_count: number;
  result: string;
  leading_account_id: string | null;
  auction_id: string;
  auction_code: string;
  auction_title: string;
  rule_version_id: string | null;
  deposit_required: boolean;
  make: string | null;
  model: string | null;
  year: number | null;
  odometer_km: number | null;
  transmission: string | null;
  fuel: string | null;
  body_style: string | null;
  drive: string | null;
  colour: string | null;
  zimbabwe_registered: boolean | null;
  documents_status: string | null;
  inspection_summary: string | null;
  bid_count: bigint;
  bidder_count: bigint;
  photo_count: bigint;
  cover_key: string | null;
  created_at: Date;
}

const LOT_SELECT = `
SELECT al.id AS auction_lot_id, l.id AS lot_id, l.lot_ref, l.title, l.description, l.category_code, c.name AS category_name,
       l.is_vehicle, l.tax_class, l.item_state, ist.label AS item_state_label, l.condition, ct.label AS condition_label, l.condition_notes,
       l.location_branch, b.name AS branch_name, al.currency, al.starting_bid_minor, al.reserve_minor, al.current_price_minor,
       al.current_end_at, al.scheduled_end_at, al.extension_count, al.result, al.leading_account_id,
       a.id AS auction_id, a.code AS auction_code, a.title AS auction_title, a.rule_version_id, a.deposit_required,
       v.make, v.model, v.year, v.odometer_km, v.transmission, v.fuel, v.body_style, v.drive, v.colour, v.zimbabwe_registered, v.documents_status,
       ir.summary AS inspection_summary,
       (SELECT count(*) FROM bidding.bid x WHERE x.auction_lot_id = al.id AND x.outcome_at_placement <> 'rejected') AS bid_count,
       (SELECT count(DISTINCT x.account_id) FROM bidding.bid x WHERE x.auction_lot_id = al.id AND x.outcome_at_placement <> 'rejected') AS bidder_count,
       (SELECT count(*) FROM catalogue.lot_media m WHERE m.lot_id = l.id AND m.kind = 'photo') AS photo_count,
       (SELECT m.object_key FROM catalogue.lot_media m WHERE m.lot_id = l.id AND m.kind = 'photo' ORDER BY m.sort LIMIT 1) AS cover_key,
       l.created_at
  FROM auction.auction_lot al
  JOIN auction.auction a ON a.id = al.auction_id
  JOIN catalogue.lot l ON l.id = al.lot_id
  JOIN catalogue.category c ON c.code = l.category_code
  JOIN catalogue.item_state_term ist ON ist.code = l.item_state
  JOIN catalogue.condition_term ct ON ct.code = l.condition
  JOIN core.branch b ON b.code = l.location_branch
  LEFT JOIN catalogue.vehicle v ON v.lot_id = l.id
  LEFT JOIN LATERAL (
    SELECT summary FROM catalogue.inspection_report r
     WHERE r.lot_id = l.id AND r.published_at IS NOT NULL ORDER BY r.published_at DESC LIMIT 1
  ) ir ON true`;

const SORTS: Record<NonNullable<LotFilters['sort']>, string> = {
  ending_soon: 'al.current_end_at ASC',
  newest: 'l.created_at DESC',
  price_low: 'coalesce(al.current_price_minor, al.starting_bid_minor) ASC',
  price_high: 'coalesce(al.current_price_minor, al.starting_bid_minor) DESC',
  most_bids: 'bid_count DESC, al.current_end_at ASC',
};

export interface LotCard {
  id: string;
  ref: string;
  title: string;
  category: { code: string; name: string };
  isVehicle: boolean;
  vehicle: {
    make: string;
    model: string;
    year: number | null;
    odometerKm: number | null;
    transmission: string | null;
    fuel: string | null;
    bodyStyle: string | null;
    drive: string | null;
    colour: string | null;
    zimbabweRegistered: boolean;
  } | null;
  branch: { code: string; name: string };
  auction: { id: string; code: string; title: string; depositRequired: boolean };
  currency: Currency;
  startingBid: MoneyJson;
  currentPrice: MoneyJson | null;
  nextMinimum: MoneyJson;
  /** What the buyer pays in total if they win at the next minimum bid. */
  allInAtNextMinimum: MoneyJson | null;
  bids: number;
  bidders: number;
  endsAt: string;
  extended: boolean;
  reserveStatus: 'no_reserve' | 'met' | 'not_met';
  inspectionSummary: string | null;
  photoCount: number;
  /** The first photo (the standard set starts with the front), or null when there is none. */
  cover: string | null;
  viewer: { leading: boolean; watching: boolean } | null;
}

export class CatalogueReader {
  private categoryParents: Map<string, string | null> | null = null;

  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
  ) {}

  private async categoryPath(code: string): Promise<string[]> {
    if (!this.categoryParents) {
      const r = await this.db.query<{ code: string; parent_code: string | null }>('SELECT code, parent_code FROM catalogue.category');
      this.categoryParents = new Map(r.rows.map((x) => [x.code, x.parent_code]));
    }
    const path: string[] = [];
    for (let c: string | null | undefined = code; c; c = this.categoryParents.get(c)) path.unshift(c);
    return path;
  }

  async pricing(row: Pick<LotRow, 'currency' | 'tax_class' | 'category_code' | 'is_vehicle'>): Promise<LotPricing> {
    return { currency: row.currency, taxClass: row.tax_class, categoryPath: await this.categoryPath(row.category_code), isVehicle: row.is_vehicle };
  }

  /** Quote at a hammer price, or null when the lot cannot be priced (bidding is then paused for it). */
  quoteOrNull(pricing: LotPricing, hammerMinor: bigint, snapshot: RuleSnapshot, taxRates: readonly TaxRateRecord[], at: Date): Quote | null {
    try {
      return quoteLot({ lot: pricing, hammerMinor, snapshot, taxRates, at });
    } catch {
      return null;
    }
  }

  /** Lot ids on this person's watch list (catalogue.watch). */
  private async watched(viewerId: string | null): Promise<Set<string>> {
    if (!viewerId) return new Set();
    const r = await this.db.query<{ lot_id: string }>('SELECT lot_id FROM catalogue.watch WHERE account_id = $1', [viewerId]);
    return new Set(r.rows.map((x) => x.lot_id));
  }

  private async card(row: LotRow, taxRates: readonly TaxRateRecord[], viewerId: string | null, at: Date, watched: ReadonlySet<string> = new Set()): Promise<LotCard> {
    const pricing = await this.pricing(row);
    let nextMinimum = row.starting_bid_minor;
    let allIn: Quote | null = null;
    if (row.rule_version_id) {
      const snapshot = await this.rulebook.snapshot(row.rule_version_id);
      try {
        nextMinimum = minimumNextBid({ startingBidMinor: row.starting_bid_minor, currentPriceMinor: row.current_price_minor }, ladderFor(snapshot, row.currency, { categoryPath: pricing.categoryPath }));
      } catch {
        // No increment ladder for this currency yet (ZiG, Q4): the lot cannot be bid on.
      }
      allIn = this.quoteOrNull(pricing, nextMinimum, snapshot, taxRates, at);
    }
    return {
      id: row.auction_lot_id,
      ref: row.lot_ref,
      title: row.title,
      category: { code: row.category_code, name: row.category_name },
      isVehicle: row.is_vehicle,
      vehicle: row.make
        ? {
            make: row.make,
            model: row.model!,
            year: row.year,
            odometerKm: row.odometer_km,
            transmission: row.transmission,
            fuel: row.fuel,
            bodyStyle: row.body_style,
            drive: row.drive,
            colour: row.colour,
            zimbabweRegistered: Boolean(row.zimbabwe_registered),
          }
        : null,
      branch: { code: row.location_branch, name: row.branch_name },
      auction: { id: row.auction_id, code: row.auction_code, title: row.auction_title, depositRequired: row.deposit_required },
      currency: row.currency,
      startingBid: moneyJson(row.starting_bid_minor, row.currency),
      currentPrice: maybeMoney(row.current_price_minor, row.currency),
      nextMinimum: moneyJson(nextMinimum, row.currency),
      allInAtNextMinimum: allIn ? moneyJson(allIn.totalMinor, row.currency) : null,
      bids: Number(row.bid_count),
      bidders: Number(row.bidder_count),
      endsAt: row.current_end_at.toISOString(),
      extended: row.extension_count > 0,
      reserveStatus: row.reserve_minor === null ? 'no_reserve' : (row.current_price_minor ?? -1n) >= row.reserve_minor ? 'met' : 'not_met',
      inspectionSummary: row.inspection_summary,
      photoCount: Number(row.photo_count),
      cover: row.cover_key ? mediaUrl(row.cover_key) : null,
      viewer: viewerId ? { leading: row.leading_account_id === viewerId, watching: watched.has(row.lot_id) } : null,
    };
  }

  async liveLots(filters: LotFilters, viewerId: string | null, at = new Date()): Promise<{ lots: LotCard[]; total: number }> {
    const where = [`a.status = 'open'`, `al.result = 'pending'`, `l.state = 'live'`];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (filters.q) where.push(`(l.title ILIKE ${p(`%${filters.q}%`)} OR l.lot_ref ILIKE ${p(`%${filters.q}%`)})`);
    if (filters.category === 'vehicles') where.push('l.is_vehicle');
    if (filters.category === 'other') where.push('NOT l.is_vehicle');
    if (filters.make) where.push(`v.make = ${p(filters.make)}`);
    if (filters.model) where.push(`v.model = ${p(filters.model)}`);
    if (filters.yearFrom) where.push(`v.year >= ${p(filters.yearFrom)}`);
    if (filters.yearTo) where.push(`v.year <= ${p(filters.yearTo)}`);
    if (filters.bodyStyle) where.push(`v.body_style = ${p(filters.bodyStyle)}`);
    if (filters.transmission) where.push(`v.transmission = ${p(filters.transmission)}`);
    if (filters.fuel) where.push(`v.fuel = ${p(filters.fuel)}`);
    if (filters.drive) where.push(`v.drive = ${p(filters.drive)}`);
    if (filters.branch) where.push(`l.location_branch = ${p(filters.branch)}`);
    if (filters.maxPriceMinor !== undefined) where.push(`coalesce(al.current_price_minor, al.starting_bid_minor) <= ${p(filters.maxPriceMinor.toString())}`);
    if (filters.noReserve) where.push('al.reserve_minor IS NULL');
    if (filters.endingWithinHours) where.push(`al.current_end_at <= ${p(new Date(at.getTime() + filters.endingWithinHours * 3_600_000))}`);
    const order = SORTS[filters.sort ?? 'ending_soon'];
    const r = await this.db.query<LotRow>(`${LOT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`, params);
    const [taxRates, watched] = await Promise.all([this.rulebook.taxRates(), this.watched(viewerId)]);
    const lots = [];
    for (const row of r.rows) lots.push(await this.card(row, taxRates, viewerId, at, watched));
    return { lots, total: lots.length };
  }

  /** The lots someone saved, live ones first (soonest closing), then closed ones (most recent first). */
  async watchedLots(viewerId: string, at = new Date()): Promise<Array<LotCard & { result: string }>> {
    const r = await this.db.query<LotRow>(
      `${LOT_SELECT}
        WHERE al.id = l.current_auction_lot_id AND l.id IN (SELECT lot_id FROM catalogue.watch WHERE account_id = $1)
        ORDER BY (al.result = 'pending') DESC, CASE WHEN al.result = 'pending' THEN al.current_end_at END ASC, al.current_end_at DESC
        LIMIT 200`,
      [viewerId],
    );
    const [taxRates, watched] = await Promise.all([this.rulebook.taxRates(), this.watched(viewerId)]);
    const out = [];
    for (const row of r.rows) out.push({ ...(await this.card(row, taxRates, viewerId, at, watched)), result: row.result });
    return out;
  }

  /** Values to filter by, with how many live lots have each. */
  async facets(): Promise<Record<string, Array<{ value: string; count: number }>>> {
    const r = await this.db.query<{ facet: string; value: string; count: bigint }>(
      `WITH live AS (
         SELECT l.id, l.location_branch, l.is_vehicle FROM auction.auction_lot al
           JOIN auction.auction a ON a.id = al.auction_id JOIN catalogue.lot l ON l.id = al.lot_id
          WHERE a.status = 'open' AND al.result = 'pending' AND l.state = 'live')
       SELECT 'make' AS facet, v.make AS value, count(*) FROM live JOIN catalogue.vehicle v ON v.lot_id = live.id GROUP BY v.make
       UNION ALL SELECT 'model', v.make || ' ' || v.model, count(*) FROM live JOIN catalogue.vehicle v ON v.lot_id = live.id GROUP BY v.make, v.model
       UNION ALL SELECT 'year', v.year::text, count(*) FROM live JOIN catalogue.vehicle v ON v.lot_id = live.id WHERE v.year IS NOT NULL GROUP BY v.year
       UNION ALL SELECT 'bodyStyle', v.body_style, count(*) FROM live JOIN catalogue.vehicle v ON v.lot_id = live.id WHERE v.body_style IS NOT NULL GROUP BY v.body_style
       UNION ALL SELECT 'transmission', v.transmission, count(*) FROM live JOIN catalogue.vehicle v ON v.lot_id = live.id WHERE v.transmission IS NOT NULL GROUP BY v.transmission
       UNION ALL SELECT 'fuel', v.fuel, count(*) FROM live JOIN catalogue.vehicle v ON v.lot_id = live.id WHERE v.fuel IS NOT NULL GROUP BY v.fuel
       UNION ALL SELECT 'drive', v.drive, count(*) FROM live JOIN catalogue.vehicle v ON v.lot_id = live.id WHERE v.drive IS NOT NULL GROUP BY v.drive
       UNION ALL SELECT 'branch', live.location_branch, count(*) FROM live GROUP BY live.location_branch
       UNION ALL SELECT 'category', CASE WHEN live.is_vehicle THEN 'vehicles' ELSE 'other' END, count(*) FROM live GROUP BY live.is_vehicle`,
    );
    const out: Record<string, Array<{ value: string; count: number }>> = {};
    for (const row of r.rows) (out[row.facet] ??= []).push({ value: row.value, count: Number(row.count) });
    for (const list of Object.values(out)) list.sort((a, b) => a.value.localeCompare(b.value, 'en', { numeric: true }));
    return out;
  }

  async lotRow(idOrRef: string): Promise<LotRow | null> {
    const byId = /^[0-9a-f-]{36}$/.test(idOrRef);
    const r = await this.db.query<LotRow>(`${LOT_SELECT} WHERE ${byId ? 'al.id = $1' : 'l.lot_ref = $1'} ORDER BY al.scheduled_end_at DESC LIMIT 1`, [idOrRef]);
    return r.rows[0] ?? null;
  }

  async lotDetail(idOrRef: string, viewerId: string | null, at = new Date()) {
    const row = await this.lotRow(idOrRef);
    if (!row) return null;
    const [taxRates, watched] = await Promise.all([this.rulebook.taxRates(), this.watched(viewerId)]);
    const card = await this.card(row, taxRates, viewerId, at, watched);
    const pricing = await this.pricing(row);

    const [bids, inspection, media, partners, registration] = await Promise.all([
      this.db.query<{ sequence_no: bigint; account_id: string; origin: 'bidder' | 'proxy'; amount_minor: bigint; max_amount_minor: bigint | null; outcome_at_placement: LoggedBid['outcome']; server_received_at: Date }>(
        `SELECT sequence_no, account_id, origin, amount_minor, max_amount_minor, outcome_at_placement, server_received_at
           FROM bidding.bid WHERE auction_lot_id = $1 ORDER BY sequence_no`,
        [row.auction_lot_id],
      ),
      this.db.query<{ id: string; checklist_version: string; inspected_at: Date; published_at: Date; odometer_km: number | null; photo_count: number; has_video: boolean; summary: string; items: Record<string, { answer: string; note?: string }>; chassis_verified: boolean; engine_verified: boolean }>(
        `SELECT id, checklist_version, inspected_at, published_at, odometer_km, photo_count, has_video, summary, items, chassis_verified, engine_verified
           FROM catalogue.inspection_report WHERE lot_id = $1 AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1`,
        [row.lot_id],
      ),
      this.db.query<{ kind: string; role: string; object_key: string }>('SELECT kind, role, object_key FROM catalogue.lot_media WHERE lot_id = $1 ORDER BY sort', [row.lot_id]),
      row.is_vehicle
        ? this.db.query<{ name: string; phone_e164: string; notes: string | null }>(
            `SELECT name, phone_e164, notes FROM logistics.partner WHERE kind = 'towing' AND active AND $1 = ANY (branches) ORDER BY name`,
            [row.location_branch],
          )
        : Promise.resolve({ rows: [] as Array<{ name: string; phone_e164: string; notes: string | null }> }),
      viewerId
        ? this.db.query<{ status: string }>('SELECT status FROM registration.registration WHERE account_id = $1 AND auction_id = $2', [viewerId, row.auction_id])
        : Promise.resolve({ rows: [] as Array<{ status: string }> }),
    ]);

    const logged: LoggedBid[] = bids.rows.map((b) => ({
      seq: b.sequence_no,
      accountId: b.account_id,
      origin: b.origin,
      amountMinor: b.amount_minor,
      outcome: b.outcome_at_placement,
      at: b.server_received_at,
    }));
    const viewerMax = viewerId
      ? bids.rows.filter((b) => b.account_id === viewerId && b.origin === 'bidder' && b.outcome_at_placement !== 'rejected').reduce<bigint | null>((m, b) => (b.max_amount_minor !== null && (m === null || b.max_amount_minor > m) ? b.max_amount_minor : m), null)
      : null;

    let breakdown: Quote | null = null;
    let rules: { versionLabel: string; softCloseSeconds: number; claimWindowHours: number | null; payWindowHours: number | null; collectWindowHours: number | null; depositMinimum: MoneyJson | null } | null = null;
    if (row.rule_version_id) {
      const snapshot = await this.rulebook.snapshot(row.rule_version_id);
      breakdown = this.quoteOrNull(pricing, BigInt(card.nextMinimum.minor), snapshot, taxRates, at);
      const ctx = { categoryPath: pricing.categoryPath, currency: row.currency };
      const safe = <T>(fn: () => T): T | null => {
        try {
          return fn();
        } catch {
          return null;
        }
      };
      const deposit = safe(() => (snapshot.get('deposit.minimum', ctx) as Partial<Record<Currency, number | null>>)[row.currency] ?? null);
      rules = {
        versionLabel: snapshot.label,
        softCloseSeconds: snapshot.get('bidding.soft_close_seconds', ctx),
        claimWindowHours: safe(() => snapshot.get('dispute.claim_window_hours_after_release', ctx)),
        payWindowHours: safe(() => snapshot.get('settlement.pay_window_hours', ctx)),
        collectWindowHours: safe(() => snapshot.get('settlement.collect_window_hours', ctx)),
        depositMinimum: row.deposit_required && deposit !== null ? moneyJson(BigInt(deposit), row.currency) : null,
      };
    }

    const report = inspection.rows[0];
    const webUrl = (process.env.PUBLIC_WEB_URL ?? '').replace(/\/$/, '');
    const absolute = (u: string) => (u.startsWith('http') ? u : `${webUrl}${u}`);
    const jsonLd = lotStructuredData({
      lotRef: row.lot_ref,
      title: row.title,
      description: row.description,
      itemState: row.item_state,
      condition: row.condition,
      categoryName: row.category_name,
      currency: row.currency,
      priceMinor: row.current_price_minor ?? row.starting_bid_minor,
      endAt: row.current_end_at,
      status: row.result === 'pending' ? 'live' : 'closed',
      url: `${webUrl}/lots/${encodeURIComponent(row.lot_ref)}`,
      imageUrls: media.rows.filter((m) => m.kind === 'photo').slice(0, 6).map((m) => absolute(mediaUrl(m.object_key))),
      branchCity: row.branch_name.replace('ABC Auctions ', ''),
    });
    const checklist = report ? CHECKLISTS[report.checklist_version] ?? [] : [];
    return {
      ...card,
      description: row.description,
      itemState: { code: row.item_state, label: row.item_state_label },
      condition: { code: row.condition, label: row.condition_label, notes: row.condition_notes },
      documentsStatus: row.documents_status,
      scheduledEndAt: row.scheduled_end_at.toISOString(),
      closed: row.result !== 'pending',
      result: row.result,
      media: media.rows.map((m) => ({ kind: m.kind, role: m.role, url: mediaUrl(m.object_key) })),
      inspection: report
        ? {
            publishedAt: report.published_at.toISOString(),
            inspectedAt: report.inspected_at.toISOString(),
            checklistVersion: report.checklist_version,
            summary: report.summary,
            odometerKm: report.odometer_km,
            photoCount: report.photo_count,
            hasVideo: report.has_video,
            identityVerified: report.chassis_verified && report.engine_verified,
            sections: [...new Set(checklist.map((i) => i.section))].map((section) => ({
              section,
              items: checklist
                .filter((i) => i.section === section)
                .map((i) => ({ id: i.id, label: i.label, material: i.material, answer: report.items[i.id]?.answer ?? 'missing', note: report.items[i.id]?.note ?? null })),
            })),
          }
        : null,
      history: publicHistory(logged, viewerId ?? undefined).map((h) => ({ seq: h.seq.toString(), bidder: h.bidder, amount: moneyJson(h.amountMinor, row.currency), auto: h.auto, at: h.at.toISOString() })),
      breakdown: breakdown
        ? { atHammer: card.nextMinimum, lines: breakdown.lines.map((l) => ({ type: l.type, description: l.description, amount: moneyJson(l.amountMinor, row.currency) })), total: moneyJson(breakdown.totalMinor, row.currency), ruleVersionId: breakdown.ruleVersionId }
        : null,
      rules,
      towingPartners: partners.rows.map((p) => ({ name: p.name, phone: p.phone_e164, notes: p.notes })),
      jsonLd,
      viewer: viewerId
        ? { leading: row.leading_account_id === viewerId, watching: watched.has(row.lot_id), yourMax: maybeMoney(viewerMax, row.currency), registration: registration.rows[0]?.status ?? null }
        : null,
    };
  }

  /** Auctions open or about to open, soonest closing first: the event pages and the home page. */
  async auctions(): Promise<AuctionSummary[]> {
    const r = await this.db.query<{
      id: string; code: string; title: string; branch_code: string; branch_name: string; city: string; status: string; opens_at: Date;
      first_close_at: Date; last_close_at: Date | null; stagger_seconds: number; deposit_required: boolean; lots: bigint; live_lots: bigint; bids: bigint; cover_key: string | null;
    }>(
      `SELECT a.id, a.code, a.title, a.branch_code, b.name AS branch_name, b.city, a.status, a.opens_at, a.first_close_at, a.stagger_seconds, a.deposit_required,
              (SELECT max(al.current_end_at) FROM auction.auction_lot al WHERE al.auction_id = a.id) AS last_close_at,
              (SELECT count(*) FROM auction.auction_lot al WHERE al.auction_id = a.id) AS lots,
              (SELECT count(*) FROM auction.auction_lot al WHERE al.auction_id = a.id AND al.result = 'pending') AS live_lots,
              (SELECT count(*) FROM bidding.bid x JOIN auction.auction_lot al ON al.id = x.auction_lot_id
                WHERE al.auction_id = a.id AND x.outcome_at_placement <> 'rejected') AS bids,
              (SELECT m.object_key FROM auction.auction_lot al JOIN catalogue.lot_media m ON m.lot_id = al.lot_id
                WHERE al.auction_id = a.id AND m.kind = 'photo' ORDER BY al.lot_number, m.sort LIMIT 1) AS cover_key
         FROM auction.auction a JOIN core.branch b ON b.code = a.branch_code
        WHERE a.status IN ('scheduled', 'open')
        ORDER BY a.first_close_at`,
    );
    return r.rows.map((a) => ({
      id: a.id,
      code: a.code,
      title: a.title,
      branch: { code: a.branch_code, name: a.branch_name, city: a.city },
      status: a.status,
      opensAt: a.opens_at.toISOString(),
      firstCloseAt: a.first_close_at.toISOString(),
      lastCloseAt: a.last_close_at?.toISOString() ?? null,
      staggerSeconds: a.stagger_seconds,
      depositRequired: a.deposit_required,
      lots: Number(a.lots),
      liveLots: Number(a.live_lots),
      bids: Number(a.bids),
      cover: a.cover_key ? mediaUrl(a.cover_key) : null,
    }));
  }

  /** The figures a lot page refreshes while open: cheap enough to poll every few seconds. */
  async live(idOrRef: string, viewerId: string | null) {
    const byId = /^[0-9a-f-]{36}$/.test(idOrRef);
    const r = await this.db.query<{ currency: Currency; current_price_minor: bigint | null; starting_bid_minor: bigint; reserve_minor: bigint | null; current_end_at: Date; extension_count: number; result: string; leading_account_id: string | null; bids: bigint; bidders: bigint }>(
      `SELECT al.currency, al.current_price_minor, al.starting_bid_minor, al.reserve_minor, al.current_end_at, al.extension_count, al.result, al.leading_account_id,
              (SELECT count(*) FROM bidding.bid x WHERE x.auction_lot_id = al.id AND x.outcome_at_placement <> 'rejected') AS bids,
              (SELECT count(DISTINCT x.account_id) FROM bidding.bid x WHERE x.auction_lot_id = al.id AND x.outcome_at_placement <> 'rejected') AS bidders
         FROM auction.auction_lot al JOIN catalogue.lot l ON l.id = al.lot_id
        WHERE ${byId ? 'al.id = $1' : 'l.lot_ref = $1'}
        ORDER BY al.scheduled_end_at DESC LIMIT 1`,
      [idOrRef],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      currentPrice: maybeMoney(x.current_price_minor, x.currency),
      bids: Number(x.bids),
      bidders: Number(x.bidders),
      endsAt: x.current_end_at.toISOString(),
      extended: x.extension_count > 0,
      closed: x.result !== 'pending',
      reserveStatus: x.reserve_minor === null ? 'no_reserve' : (x.current_price_minor ?? -1n) >= x.reserve_minor ? 'met' : 'not_met',
      leading: viewerId ? x.leading_account_id === viewerId : null,
      serverTime: new Date().toISOString(),
    };
  }

  async publicRules(at = new Date()) {
    const versionId = await this.rulebook.activeVersionId(at);
    return renderRulebook(await this.rulebook.snapshot(versionId));
  }
}
