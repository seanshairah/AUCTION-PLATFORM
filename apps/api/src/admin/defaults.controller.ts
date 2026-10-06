import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { requirePermission, WAIVABLE_STEPS, type AdminServices, type StaffMember, type WaivableStep } from '@abc/admin';
import type { Db } from '@abc/db';
import { CurrentAccount, type SessionAccount } from '../session';
import { DB } from '../tokens';
import { parse, present, StaffErrorFilter, Uuid } from './http';
import { CurrentStaff, StaffGuard } from './staff.guard';
import { ADMIN } from './tokens';

const Steps = z.array(z.enum(WAIVABLE_STEPS as unknown as [WaivableStep, ...WaivableStep[]])).min(1).max(3);
const AppealBody = z.object({ steps: Steps, grounds: z.string().max(2000) });
const WaiverBody = z.object({ step: z.enum(WAIVABLE_STEPS as unknown as [WaivableStep, ...WaivableStep[]]), reason: z.string().max(1000), appealId: Uuid.optional(), clientKey: z.string().min(8).max(100).optional() });
const DecisionBody = z.object({ decision: z.enum(['upheld', 'partly_upheld', 'rejected']), note: z.string().max(1000) });
const ListQuery = z.object({ status: z.enum(['open', 'cured', 'completed', 'waived']).optional() });

/** Default cases, appeals and waivers for staff (docs/18 §7). */
@Controller('staff')
@UseGuards(StaffGuard)
@UseFilters(StaffErrorFilter)
export class DefaultsController {
  constructor(@Inject(ADMIN) private readonly admin: AdminServices) {}

  @Get('defaults')
  async cases(@Query() query: unknown, @CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'default.view');
    return present(await this.admin.defaults.cases(parse(ListQuery, query)));
  }

  @Get('defaults/:caseId')
  async one(@Param('caseId') caseId: string, @CurrentStaff() staff: StaffMember) {
    requirePermission(staff, 'default.view');
    return present(await this.admin.defaults.case(parse(Uuid, caseId)));
  }

  /** Support or risk record an appeal the buyer made by phone or at the counter. */
  @Post('defaults/:caseId/appeals')
  async appeal(@Param('caseId') caseId: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(AppealBody, body);
    return this.admin.defaults.appeal({ type: 'staff', staff }, parse(Uuid, caseId), b.steps, b.grounds);
  }

  /** Raises a waiver; below the threshold it applies at once, otherwise a second person approves it. */
  @Post('defaults/:caseId/waivers')
  async waive(@Param('caseId') caseId: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(WaiverBody, body);
    return present(await this.admin.overrides.request(staff, {
      kind: 'default_waiver', reason: b.reason, payload: { caseId: parse(Uuid, caseId), step: b.step, appealId: b.appealId ?? null },
      ...(b.clientKey ? { clientKey: b.clientKey } : {}),
    }));
  }

  @Post('appeals/:id/decision')
  async decide(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffMember) {
    const b = parse(DecisionBody, body);
    return this.admin.defaults.decideAppeal(staff, parse(Uuid, id), b.decision, b.note);
  }
}

/** The buyer's side: see your default cases and appeal a step (docs/18 §7). */
@Controller('me/defaults')
@UseFilters(StaffErrorFilter)
export class BuyerDefaultsController {
  constructor(
    @Inject(ADMIN) private readonly admin: AdminServices,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async mine(@CurrentAccount() account: SessionAccount) {
    return present(await this.admin.defaults.buyerCases(account.id));
  }

  @Post(':caseId/appeal')
  async appeal(@Param('caseId') caseId: string, @Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = parse(AppealBody, body);
    const me = await this.db.query<{ display_name: string }>('SELECT display_name FROM identity.account WHERE id = $1', [account.id]);
    if (!me.rows[0]) throw new NotFoundException({ code: 'account_not_found', message: 'Account not found.' });
    const r = await this.admin.defaults.appeal({ type: 'account', id: account.id, name: me.rows[0].display_name }, parse(Uuid, caseId), b.steps, b.grounds);
    return { ...r, message: r.repeated ? 'Your appeal is already with our team.' : 'Thank you. Your appeal is with our team, and we will message you with the decision.' };
  }
}
