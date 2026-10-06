import { Body, Controller, Get, Inject, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { requirePermission, type AdminServices, type StaffMember } from '@abc/admin';
import { parse, present, StaffErrorFilter, Uuid } from './http';
import { CurrentStaff, StaffGuard } from './staff.guard';
import { ADMIN } from './tokens';

const When = z.object({ effectiveFrom: z.coerce.date().optional() });
const AckBody = z.object({ warningId: z.string().min(3).max(200), reason: z.string().max(1000), effectiveFrom: z.coerce.date().optional() });
const PublishBody = z.object({ effectiveFrom: z.coerce.date() });

/**
 * Rule set publication (docs/03 §6, docs/18 §4): drafts, their validation with each
 * warning named, acknowledgement by the second person, and approve-and-publish.
 * Tax rates are listed here; activating one is a `tax_rate_activation` override.
 */
@Controller('staff')
@UseGuards(StaffGuard)
@UseFilters(StaffErrorFilter)
export class RulebookController {
  constructor(@Inject(ADMIN) private readonly admin: AdminServices) {}

  @Get('rule-sets')
  async versions(@CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'rulebook.view');
    return present(await this.admin.rulebook.versions());
  }

  @Get('rule-sets/:id/validation')
  async validation(@Param('id') id: string, @Query() query: unknown, @CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'rulebook.view');
    const q = parse(When, query);
    const v = await this.admin.rulebook.validation(parse(Uuid, id), q.effectiveFrom ? { effectiveFrom: q.effectiveFrom } : {});
    const open = v.warnings.filter((w) => !w.acknowledgements.some((a) => a.by === staff.id)).length;
    return present({ ...v, readyForYou: v.errors.length === 0 && open === 0 && v.authoredBy !== staff.id, openForYou: open });
  }

  @Post('rule-sets/:id/acknowledgements')
  async acknowledge(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(AckBody, body);
    return present(await this.admin.rulebook.acknowledge(staff, parse(Uuid, id), b.warningId, b.reason, b.effectiveFrom));
  }

  @Post('rule-sets/:id/publish')
  async publish(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(PublishBody, body);
    return present(await this.admin.rulebook.approveAndPublish(staff, parse(Uuid, id), b.effectiveFrom));
  }

  @Get('tax-rates')
  async taxRates(@CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'tax_rate.view');
    return present(await this.admin.rulebook.taxRateList());
  }
}
