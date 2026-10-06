import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, RulebookStore } from '@abc/db';
import type { Currency } from '@abc/domain';
import { QuoteError, sellerProceeds } from '@abc/quote';
import { CommissionNotPublishedError, type SellerService } from '@abc/seller';
import { maybeMoney, moneyJson, parseMinor } from '../http';
import type { CatalogueReader } from '../lots/catalogue-reader';
import { CurrentAccount, type SessionAccount } from '../session';
import { CATALOGUE, DB, RULEBOOK, SELLER } from '../tokens';

const NewConsignment = z.object({ type: z.enum(['commission', 'outright_purchase']).default('commission'), branch: z.enum(['HRE', 'BYO']) });
const NewLot = z.object({
  title: z.string().trim().min(4).max(120),
  description: z.string().trim().min(20).max(4000),
  category: z.string().max(40),
  itemState: z.string().max(40),
  condition: z.string().max(40),
  conditionNotes: z.string().max(1000).optional(),
  currency: z.enum(['USD', 'ZWG']).default('USD'),
  startingBidMinor: z.string(),
  reserveMinor: z.string().optional(),
  quantity: z.coerce.number().int().min(1).max(10_000).default(1),
});
const Bulk = z.object({ batchRef: z.string().trim().min(3).max(80), csv: z.string().min(10).max(2_000_000), branch: z.enum(['HRE', 'BYO']) });

/**
 * The seller portal (deliverable 13): consign, see the terms before signing, e-sign
 * the note by its hash, watch live bids against your own reserve, and see every payout
 * with its date. Any account can sell; everything is scoped to the signed-in seller.
 */
@Controller('seller')
export class SellerController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SELLER) private readonly seller: SellerService,
    @Inject(RULEBOOK) private readonly rulebook: RulebookStore,
    @Inject(CATALOGUE) private readonly catalogue: CatalogueReader,
  ) {}

  private async actor(account: SessionAccount) {
    const r = await this.db.query<{ display_name: string }>('SELECT display_name FROM identity.account WHERE id = $1', [account.id]);
    return { type: 'account' as const, id: account.id, name: r.rows[0]?.display_name ?? 'Seller' };
  }

  private async owned(account: SessionAccount, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException();
    const r = await this.db.query<{ id: string; status: string; consignment_type: string; branch_code: string; intake_channel: string; created_at: Date; signed_at: Date | null }>(
      'SELECT id, status, consignment_type, branch_code, intake_channel, created_at, signed_at FROM seller.consignment WHERE id = $1 AND seller_account_id = $2',
      [id, account.id],
    );
    if (!r.rows[0]) throw new NotFoundException({ code: 'consignment_not_found', message: 'Consignment not found.' });
    return r.rows[0];
  }

  @Get('overview')
  async overview(@CurrentAccount() account: SessionAccount) {
    const [live, statement, consignments] = await Promise.all([
      this.seller.liveLots(this.db, account.id),
      this.seller.statement(this.db, account.id),
      this.db.query<{ id: string; status: string; consignment_type: string; branch_code: string; intake_channel: string; created_at: Date; lots: bigint }>(
        `SELECT c.id, c.status, c.consignment_type, c.branch_code, c.intake_channel, c.created_at,
                (SELECT count(*) FROM catalogue.lot l WHERE l.consignment_id = c.id) AS lots
           FROM seller.consignment c WHERE c.seller_account_id = $1 ORDER BY c.created_at DESC LIMIT 50`,
        [account.id],
      ),
    ]);
    return {
      lots: live.map((l) => ({
        ref: l.lotRef,
        title: l.title,
        state: l.state,
        currentPrice: maybeMoney(l.currentPriceMinor, l.currency),
        bids: l.bids,
        bidders: l.uniqueBidders,
        reserve: maybeMoney(l.reserveMinor, l.currency),
        reserveMet: l.reserveMet,
        endsAt: l.endsAt?.toISOString() ?? null,
      })),
      payouts: statement.payouts.map((p) => ({ id: p.payoutId, status: p.status, dueDate: p.dueDate, gross: moneyJson(p.grossMinor, p.currency), deductions: moneyJson(p.deductionsMinor, p.currency), net: moneyJson(p.netMinor, p.currency) })),
      totals: statement.totals.map((t) => ({ currency: t.currency, paid: moneyJson(t.paidMinor, t.currency), upcoming: moneyJson(t.upcomingMinor, t.currency), held: moneyJson(t.heldMinor, t.currency), nextDueDate: t.nextDueDate })),
      consignments: consignments.rows.map((c) => ({ id: c.id, status: c.status, type: c.consignment_type, branch: c.branch_code, channel: c.intake_channel, createdAt: c.created_at.toISOString(), lots: Number(c.lots) })),
    };
  }

  @Get('vocabulary')
  async vocabulary() {
    const r = await this.db.query<{ kind: string; code: string; label: string }>(
      `SELECT 'category' AS kind, code, name AS label FROM catalogue.category
       UNION ALL SELECT 'state', code, label FROM catalogue.item_state_term
       UNION ALL SELECT 'condition', code, label FROM catalogue.condition_term`,
    );
    const pick = (k: string) => r.rows.filter((x) => x.kind === k).map(({ code, label }) => ({ code, label }));
    return { categories: pick('category'), itemStates: pick('state'), conditions: pick('condition') };
  }

  @Post('consignments')
  async create(@Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = NewConsignment.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ code: 'invalid_request', message: 'Choose a branch.' });
    const id = await this.seller.createConsignment(await this.actor(account), { sellerId: account.id, type: b.data.type, channel: 'portal', branch: b.data.branch });
    return { id };
  }

  @Get('consignments/:id')
  async consignment(@Param('id') id: string, @CurrentAccount() account: SessionAccount) {
    const c = await this.owned(account, id);
    const lots = await this.db.query<{ id: string; lot_ref: string; title: string; category_code: string; state: string; settlement_currency: Currency; starting_bid_minor: bigint; reserve_minor: bigint | null; condition: string }>(
      `SELECT id, lot_ref, title, category_code, state, settlement_currency, starting_bid_minor, reserve_minor, condition FROM catalogue.lot WHERE consignment_id = $1 ORDER BY created_at`,
      [id],
    );
    return {
      id: c.id, status: c.status, type: c.consignment_type, branch: c.branch_code, createdAt: c.created_at.toISOString(), signedAt: c.signed_at?.toISOString() ?? null,
      lots: lots.rows.map((l) => ({ id: l.id, ref: l.lot_ref, title: l.title, category: l.category_code, state: l.state, condition: l.condition, startingBid: moneyJson(l.starting_bid_minor, l.settlement_currency), reserve: maybeMoney(l.reserve_minor, l.settlement_currency) })),
    };
  }

  @Post('consignments/:id/lots')
  async addLot(@Param('id') id: string, @Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    await this.owned(account, id);
    const b = NewLot.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ code: 'invalid_request', message: b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const start = parseMinor(b.data.startingBidMinor);
    const reserve = b.data.reserveMinor ? parseMinor(b.data.reserveMinor) : null;
    if (!start || start <= 0n || (b.data.reserveMinor && !reserve)) throw new BadRequestException({ code: 'invalid_amount', message: 'Amounts must be whole cents.' });
    try {
      const lotId = await this.seller.addLot(await this.actor(account), id, {
        title: b.data.title, description: b.data.description, category: b.data.category, itemState: b.data.itemState, condition: b.data.condition,
        ...(b.data.conditionNotes ? { conditionNotes: b.data.conditionNotes } : {}),
        currency: b.data.currency as Currency, startingBidMinor: start, reserveMinor: reserve, estimateLowMinor: null, estimateHighMinor: null, quantity: b.data.quantity,
      });
      return { id: lotId };
    } catch (e) {
      throw new BadRequestException({ code: 'cannot_add_lot', message: e instanceof Error ? e.message : 'Could not add the lot.' });
    }
  }

  /** The consignment note exactly as it will be signed, with its SHA-256. */
  @Get('consignments/:id/note')
  async note(@Param('id') id: string, @CurrentAccount() account: SessionAccount) {
    await this.owned(account, id);
    try {
      return await this.seller.previewNote(id);
    } catch (e) {
      if (e instanceof CommissionNotPublishedError) return { text: null, sha256: null, message: 'Commission is not published yet, so this note cannot be signed (Q3).' };
      throw e;
    }
  }

  @Post('consignments/:id/sign')
  async sign(@Param('id') id: string, @Body() body: { sha256?: string }, @CurrentAccount() account: SessionAccount) {
    await this.owned(account, id);
    if (typeof body?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256)) throw new BadRequestException({ code: 'invalid_request', message: 'Send the hash of the note you read.' });
    const r = await this.seller.sign(await this.actor(account), id, {
      shownSha256: body.sha256,
      signatureReference: `in-app:${account.id}:${randomUUID()}`,
      noteObjectKey: `consignment-notes/${id}/${body.sha256}.txt`,
    });
    if (r.signed) return { signed: true, message: 'Signed. Bring the goods to the branch, or we will arrange intake.' };
    const message = { note_changed: 'The note changed since you read it. Read the new version and sign again.', no_lots: 'Add at least one lot before signing.', not_owner: 'Only the seller can sign.' }[r.reason];
    return { signed: false, reason: r.reason, message };
  }

  @Get('valuation')
  async valuation(@Query('category') category: string, @Query('currency') currency = 'USD') {
    if (!category || !['USD', 'ZWG'].includes(currency)) throw new BadRequestException({ code: 'invalid_request', message: 'Category and currency are required.' });
    const v = await this.seller.valuation(this.db, category, currency as Currency);
    const c = currency as Currency;
    return { range: v ? { low: moneyJson(v.lowMinor, c), median: moneyJson(v.medianMinor, c), high: moneyJson(v.highMinor, c), comparables: v.comparables } : null };
  }

  /** The published commission calculator: what the seller receives at a given hammer price. */
  @Get('proceeds')
  async proceeds(@Query('category') category: string, @Query('currency') currency = 'USD', @Query('hammerMinor') hammer: string) {
    const h = parseMinor(hammer);
    if (!category || h === null || !['USD', 'ZWG'].includes(currency)) throw new BadRequestException({ code: 'invalid_request', message: 'Category, currency and amount are required.' });
    const snapshot = await this.rulebook.snapshot(await this.rulebook.activeVersionId(new Date()));
    const pricing = await this.catalogue.pricing({ currency: currency as Currency, tax_class: 'goods_standard', category_code: category, is_vehicle: false });
    try {
      const p = sellerProceeds({ lot: pricing, hammerMinor: h, snapshot });
      return { lines: p.lines.map((l) => ({ type: l.type, description: l.description, amount: moneyJson(l.amountMinor, p.currency) })), net: moneyJson(p.netMinor, p.currency), ruleVersion: snapshot.label };
    } catch (e) {
      if (e instanceof QuoteError) return { lines: [], net: null, message: e.message };
      throw e;
    }
  }

  @Post('bulk')
  async bulk(@Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = Bulk.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ code: 'invalid_request', message: 'A batch reference, branch and CSV are required.' });
    const r = await this.seller.bulkUpload(await this.actor(account), { sellerId: account.id, batchRef: b.data.batchRef, csv: b.data.csv, branch: b.data.branch });
    return r;
  }
}
