import { Body, Controller, Get, Inject, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { opsDashboard, requirePermission, type AdminServices, type StaffMember } from '@abc/admin';
import type { Db } from '@abc/db';
import type { Currency } from '@abc/domain';
import { moneyJson } from '../http';
import { DB } from '../tokens';
import { parse, present, StaffErrorFilter, Uuid } from './http';
import { CurrentStaff, StaffGuard } from './staff.guard';
import { ADMIN } from './tokens';

const CreateBody = z.object({
  code: z.string().min(3).max(41),
  title: z.string().max(200),
  branch: z.string().regex(/^[A-Z]{2,5}$/),
  format: z.enum(['timed_online', 'floor', 'out_of_hand']).optional(),
  opensAt: z.coerce.date(),
  firstCloseAt: z.coerce.date(),
  staggerSeconds: z.number().int().min(0).max(3600).optional(),
  softCloseSeconds: z.number().int().positive().nullable().optional(),
  depositRequired: z.boolean().optional(),
  experimentVariant: z.string().max(40).nullable().optional(),
});
const AttachBody = z.object({ lotIds: z.array(Uuid).min(1).max(500) });
const DashQuery = z.object({ branch: z.string().regex(/^[A-Z]{2,5}$/).optional() });

/** Auction scheduling and the operations dashboard (docs/18 §8–9). */
@Controller('staff')
@UseGuards(StaffGuard)
@UseFilters(StaffErrorFilter)
export class AuctionsController {
  constructor(
    @Inject(ADMIN) private readonly admin: AdminServices,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Auctions not yet closed, newest first, with lot counts (the scheduling board). */
  @Get('auctions')
  async list(@CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'dashboard.view');
    const r = await this.db.query<{ id: string; code: string; title: string; branch_code: string; status: string; opens_at: Date; first_close_at: Date; stagger_seconds: number; deposit_required: boolean; lots: string; bids: string }>(
      `SELECT a.id, a.code, a.title, a.branch_code, a.status, a.opens_at, a.first_close_at, a.stagger_seconds, a.deposit_required,
              (SELECT count(*) FROM auction.auction_lot al WHERE al.auction_id = a.id) AS lots,
              (SELECT count(*) FROM bidding.bid b JOIN auction.auction_lot al ON al.id = b.auction_lot_id WHERE al.auction_id = a.id AND b.outcome_at_placement <> 'rejected') AS bids
         FROM auction.auction a
        WHERE a.status IN ('draft', 'scheduled', 'open', 'closing') OR a.first_close_at > now() - interval '7 days'
        ORDER BY a.first_close_at DESC LIMIT 50`,
    );
    return r.rows.map((a) => ({
      id: a.id, code: a.code, title: a.title, branch: a.branch_code, status: a.status, opensAt: a.opens_at, firstCloseAt: a.first_close_at,
      staggerSeconds: a.stagger_seconds, depositRequired: a.deposit_required, lots: Number(a.lots), bids: Number(a.bids),
    }));
  }

  /** Lots that can be offered: in an offerable state and not in an auction that is still running. */
  @Get('lots/offerable')
  async offerable(@CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'auction.schedule');
    const r = await this.db.query<{ id: string; lot_ref: string; title: string; location_branch: string; state: string; settlement_currency: Currency; starting_bid_minor: bigint; seller: string; created_at: Date }>(
      `SELECT l.id, l.lot_ref, l.title, l.location_branch, l.state, l.settlement_currency, l.starting_bid_minor, a.display_name AS seller, l.created_at
         FROM catalogue.lot l JOIN identity.account a ON a.id = l.seller_account_id
        WHERE l.state IN ('draft', 'listed', 'unsold', 'reserve_not_met', 'refunded')
          AND NOT EXISTS (SELECT 1 FROM auction.auction_lot al WHERE al.id = l.current_auction_lot_id AND al.result = 'pending')
        ORDER BY l.created_at DESC LIMIT 200`,
    );
    return r.rows.map((l) => ({
      id: l.id, ref: l.lot_ref, title: l.title, branch: l.location_branch, state: l.state, seller: l.seller, createdAt: l.created_at,
      startingBid: moneyJson(BigInt(l.starting_bid_minor), l.settlement_currency),
    }));
  }

  @Post('auctions')
  async create(@Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(CreateBody, body);
    return this.admin.auctions.create(staff, {
      code: b.code, title: b.title, branch: b.branch, opensAt: b.opensAt, firstCloseAt: b.firstCloseAt,
      ...(b.format ? { format: b.format } : {}),
      ...(b.staggerSeconds !== undefined ? { staggerSeconds: b.staggerSeconds } : {}),
      ...(b.softCloseSeconds !== undefined ? { softCloseSeconds: b.softCloseSeconds } : {}),
      ...(b.depositRequired !== undefined ? { depositRequired: b.depositRequired } : {}),
      ...(b.experimentVariant !== undefined ? { experimentVariant: b.experimentVariant } : {}),
    });
  }

  @Post('auctions/:id/lots')
  async attach(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(AttachBody, body);
    return present(await this.admin.auctions.attachLots(staff, parse(Uuid, id), b.lotIds));
  }

  @Post('auctions/:id/open')
  async open(@Param('id') id: string, @CurrentStaff() staff: StaffMember) {
    return this.admin.auctions.open(staff, parse(Uuid, id));
  }

  @Get('dashboard')
  async dashboard(@Query() query: unknown, @CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'dashboard.view');
    const q = parse(DashQuery, query);
    return present(await opsDashboard(this.db, { branch: q.branch ?? null }));
  }
}
