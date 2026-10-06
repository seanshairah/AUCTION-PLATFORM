import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { OVERRIDE_KINDS, requirePermission, type AdminServices, type OverrideKind, type StaffMember } from '@abc/admin';
import { parse, present, StaffErrorFilter, Uuid } from './http';
import { CurrentStaff, StaffGuard } from './staff.guard';
import { ADMIN } from './tokens';

const ListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'executed', 'expired']).optional(),
  kind: z.enum(OVERRIDE_KINDS as [OverrideKind, ...OverrideKind[]]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const CreateBody = z.object({
  kind: z.enum(OVERRIDE_KINDS as [OverrideKind, ...OverrideKind[]]),
  reason: z.string().max(1000),
  clientKey: z.string().min(8).max(100).optional(),
  payload: z.record(z.string(), z.unknown()),
});
const ApproveBody = z.object({ note: z.string().max(1000).optional() });
const RejectBody = z.object({ note: z.string().max(1000) });

/**
 * Staff override requests (docs/18 §4): limit changes, tier changes, tax rate
 * activation, default waivers and reconciliation write-offs share one workflow.
 */
@Controller('staff/overrides')
@UseGuards(StaffGuard)
@UseFilters(StaffErrorFilter)
export class OverridesController {
  constructor(@Inject(ADMIN) private readonly admin: AdminServices) {}

  @Get()
  async list(@Query() query: unknown, @CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'override.view');
    return present(await this.admin.overrides.list(parse(ListQuery, query)));
  }

  @Get(':id')
  async one(@Param('id') id: string, @CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'override.view');
    const view = await this.admin.overrides.get(parse(Uuid, id));
    if (!view) throw new NotFoundException({ code: 'not_found', message: 'We could not find that override request.' });
    return present(view);
  }

  @Post()
  async create(@Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(CreateBody, body);
    return present(await this.admin.overrides.request(staff, { kind: b.kind, reason: b.reason, payload: b.payload, ...(b.clientKey ? { clientKey: b.clientKey } : {}) }));
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(ApproveBody, body);
    return present(await this.admin.overrides.approve(staff, parse(Uuid, id), b.note));
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(RejectBody, body);
    return present(await this.admin.overrides.reject(staff, parse(Uuid, id), b.note));
  }
}
