import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { loadStaff, type StaffMember } from '@abc/admin';
import type { Db } from '@abc/db';
import type { RequestWithAccount } from '../session';
import { DB } from '../tokens';

/**
 * Staff routes: the session (session.ts) must belong to an account holding at least
 * one role in identity.staff_role. Each action then checks its own permission in the
 * admin package (docs/18 §3), so a role can see the console without being able to act.
 */
export type RequestWithStaff = RequestWithAccount & { staff?: StaffMember };

@Injectable()
export class StaffGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithStaff>();
    if (!req.account) throw new UnauthorizedException({ code: 'sign_in_required', message: 'Sign in to continue.' });
    const staff = await loadStaff(this.db, req.account.id);
    if (!staff) throw new ForbiddenException({ code: 'staff_only', message: 'This page is for ABC staff.' });
    req.staff = staff;
    return true;
  }
}

/** The signed-in staff member (set by StaffGuard). */
export const CurrentStaff = createParamDecorator((_: unknown, ctx: ExecutionContext): StaffMember => {
  const staff = ctx.switchToHttp().getRequest<RequestWithStaff>().staff;
  if (!staff) throw new ForbiddenException({ code: 'staff_only', message: 'This page is for ABC staff.' });
  return staff;
});
