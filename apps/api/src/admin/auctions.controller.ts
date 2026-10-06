import { Body, Controller, Get, Inject, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { opsDashboard, requirePermission, type AdminServices, type StaffMember } from '@abc/admin';
import type { Db } from '@abc/db';
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
