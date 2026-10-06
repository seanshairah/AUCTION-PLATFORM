import { Controller, Get, UseGuards } from '@nestjs/common';
import { can, PERMISSIONS, type Permission, type StaffMember } from '@abc/admin';
import { CurrentStaff, StaffGuard } from './staff.guard';

/**
 * The signed-in staff member, their roles and the permissions those roles hold
 * (docs/18 §3). The console uses it to show only the screens a role can open; every
 * action is still checked again on the server.
 */
@Controller('staff')
@UseGuards(StaffGuard)
export class StaffMeController {
  @Get('me')
  me(@CurrentStaff() staff: StaffMember) {
    const permissions = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(staff, p));
    return { ...staff, permissions };
  }
}
