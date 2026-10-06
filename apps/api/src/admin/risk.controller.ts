import { Body, Controller, Get, Inject, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { requirePermission, type AdminServices, type StaffMember } from '@abc/admin';
import { parse, present, StaffErrorFilter, Uuid } from './http';
import { CurrentStaff, StaffGuard } from './staff.guard';
import { ADMIN } from './tokens';

const DecisionBody = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().max(1000) });

/**
 * The risk console (docs/18 §5). Restricting an account or lifting a restriction is a
 * `tier_change` override; a limit change is a `limit_change` override.
 */
@Controller('staff/risk')
@UseGuards(StaffGuard)
@UseFilters(StaffErrorFilter)
export class RiskController {
  constructor(@Inject(ADMIN) private readonly admin: AdminServices) {}

  @Get('registrations')
  async pending(@CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'risk.view');
    return present(await this.admin.risk.pendingRegistrations());
  }

  @Post('registrations/:id/decision')
  async decide(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(DecisionBody, body);
    return present(await this.admin.risk.decideRegistration(staff, parse(Uuid, id), b.decision, b.reason));
  }

  @Get('link-clusters')
  async clusters(@CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'risk.view');
    return present(await this.admin.risk.linkClusters());
  }

  @Get('anomalies')
  async anomalies(@CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'risk.view');
    return present(await this.admin.risk.anomalies());
  }

  @Get('restricted')
  async restricted(@CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'risk.view');
    return present(await this.admin.risk.restrictedAccounts());
  }
}
