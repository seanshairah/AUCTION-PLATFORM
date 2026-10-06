import 'reflect-metadata';
import {
  applyDecorators,
  createParamDecorator,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Actor, Db } from '@abc/db';
import type { RequestWithAccount } from './session';
import { DB } from './tokens';

/**
 * A minimal staff guard (deliverables 15 and 17): the signed-in session account must
 * hold one of the endpoint's staff roles in identity.staff_role. The admin console
 * (deliverable 18) may replace it with a fuller policy; this one stays small and
 * self-contained. Usage: `@StaffOnly('support', 'ops')` on a handler, then
 * `@CurrentStaff() staff: StaffSession` for the audited actor.
 */

export const STAFF_ROLES = ['ops', 'finance', 'risk', 'support', 'cashier', 'vehicle_desk', 'admin', 'auditor'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

const ROLES_KEY = 'abc:staff-roles';

export interface StaffSession {
  id: string;
  name: string;
  roles: StaffRole[];
}

type RequestWithStaff = RequestWithAccount & { staff?: StaffSession };

@Injectable()
export class StaffGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithStaff>();
    if (!req.account) throw new UnauthorizedException({ code: 'sign_in_required', message: 'Sign in to continue.' });
    const allowed: StaffRole[] = Reflect.getMetadata(ROLES_KEY, ctx.getHandler()) ?? Reflect.getMetadata(ROLES_KEY, ctx.getClass()) ?? [];
    const r = await this.db.query<{ display_name: string; roles: StaffRole[] }>(
      `SELECT a.display_name, array_agg(s.role ORDER BY s.role) AS roles
         FROM identity.staff_role s JOIN identity.account a ON a.id = s.account_id
        WHERE s.account_id = $1 AND a.status = 'active'
        GROUP BY a.display_name`,
      [req.account.id],
    );
    const row = r.rows[0];
    if (!row || !row.roles.some((role) => allowed.includes(role))) {
      throw new ForbiddenException({ code: 'staff_only', message: `This needs one of these staff roles: ${allowed.join(', ')}.` });
    }
    req.staff = { id: req.account.id, name: row.display_name, roles: row.roles };
    return true;
  }
}

/** Restricts a handler to staff holding one of these roles. */
export const StaffOnly = (...roles: StaffRole[]) => applyDecorators(SetMetadata(ROLES_KEY, roles), UseGuards(StaffGuard));

/** The staff member the guard admitted. */
export const CurrentStaff = createParamDecorator((_: unknown, ctx: ExecutionContext): StaffSession => {
  const staff = ctx.switchToHttp().getRequest<RequestWithStaff>().staff;
  if (!staff) throw new ForbiddenException({ code: 'staff_only', message: 'Staff only.' });
  return staff;
});

/** The audited actor for a staff action: name always, reason when given (R3). */
export function staffActor(s: StaffSession, reason?: string): Actor & { type: 'staff' } {
  return { type: 'staff', id: s.id, name: s.name, ...(reason ? { reason } : {}) };
}
