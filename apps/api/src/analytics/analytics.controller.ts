import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { requirePermission, type StaffMember } from '@abc/admin';
import { freezeBaseline, type Analytics } from '@abc/analytics';
import type { Db } from '@abc/db';
import { parse, present, StaffErrorFilter } from '../admin/http';
import { CurrentStaff, StaffGuard } from '../admin/staff.guard';
import { ANALYTICS } from '../admin/tokens';
import { DB } from '../tokens';

const PeriodQuery = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  branch: z.string().regex(/^[A-Z]{2,5}$/).optional(),
});
const BaselineBody = PeriodQuery.extend({ label: z.string().min(3).max(61), notes: z.string().max(1000).optional() });

/**
 * Blueprint §9 measures (docs/19). Reads go through the analytics connection (the read
 * replica when one is configured); freezing a baseline writes to the primary.
 */
@Controller('staff/analytics')
@UseGuards(StaffGuard)
@UseFilters(StaffErrorFilter)
export class AnalyticsController {
  constructor(
    @Inject(ANALYTICS) private readonly analytics: Analytics,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('measures')
  async measures(@Query() query: unknown, @CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'analytics.view');
    const q = parse(PeriodQuery, query);
    return present(await this.analytics.measures({ from: q.from, to: q.to, branch: q.branch ?? null }));
  }

  @Get('baselines')
  async baselines(@CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'analytics.view');
    return present(await this.analytics.baselines());
  }

  @Get('baselines/:label')
  async baseline(@Param('label') label: string, @CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'analytics.view');
    const b = await this.analytics.baseline(label);
    if (!b) throw new NotFoundException({ code: 'not_found', message: 'No baseline has that label.' });
    return present(b);
  }

  /** Freezes the first measurement (blueprint §9: "the first task is a baseline"). */
  @Post('baselines')
  async freeze(@Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'analytics.baseline.freeze');
    const b = parse(BaselineBody, body);
    return freezeBaseline(this.db, staff, { label: b.label, from: b.from, to: b.to, branch: b.branch ?? null, ...(b.notes ? { notes: b.notes } : {}) });
  }
}
