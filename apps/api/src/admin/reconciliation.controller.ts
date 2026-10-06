import { Body, Controller, Get, Inject, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { requirePermission, type AdminServices, type StaffMember } from '@abc/admin';
import { parse, present, StaffErrorFilter, Uuid } from './http';
import { CurrentStaff, StaffGuard } from './staff.guard';
import { ADMIN } from './tokens';

const ItemId = z.string().regex(/^\d{1,18}$/, 'must be a reconciliation item number');
const ResolveBody = z.object({
  resolution: z.enum(['matched_manually', 'gateway_error', 'within_tolerance']),
  note: z.string().max(1000),
  paymentId: Uuid.optional(),
});
const WriteOffBody = z.object({ reason: z.string().max(1000), clientKey: z.string().min(8).max(100).optional() });

/** The finance reconciliation queue (docs/18 §6). Write-offs go through the override workflow. */
@Controller('staff/reconciliation')
@UseGuards(StaffGuard)
@UseFilters(StaffErrorFilter)
export class ReconciliationController {
  constructor(@Inject(ADMIN) private readonly admin: AdminServices) {}

  @Get()
  async queue(@CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'reconciliation.view');
    return present(await this.admin.reconciliation.queue());
  }

  @Post(':itemId/resolve')
  async resolve(@Param('itemId') itemId: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(ResolveBody, body);
    return present(await this.admin.reconciliation.resolve(staff, parse(ItemId, itemId), { resolution: b.resolution, note: b.note, ...(b.paymentId ? { paymentId: b.paymentId } : {}) }));
  }

  /** Raises a write-off; it is applied when a second finance person approves it. */
  @Post(':itemId/write-off')
  async writeOff(@Param('itemId') itemId: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(WriteOffBody, body);
    return present(await this.admin.overrides.request(staff, {
      kind: 'reconciliation_write_off', reason: b.reason, payload: { itemId: parse(ItemId, itemId) }, ...(b.clientKey ? { clientKey: b.clientKey } : {}),
    }));
  }
}
