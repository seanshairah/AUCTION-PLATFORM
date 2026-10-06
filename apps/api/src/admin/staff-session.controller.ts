import { Body, Controller, ForbiddenException, Get, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { loadStaff } from '@abc/admin';
import type { Db } from '@abc/db';
import { DEMO_EMAIL_DOMAIN } from '../demo/seed';
import { mintSession, SESSION_COOKIE } from '../session';
import { CONFIG, DB, type ApiConfig } from '../tokens';
import { parse, Uuid } from './http';

const Body_ = z.object({ accountId: Uuid });

/**
 * Development and staging only (A42, same switch as DEMO_SIGN_IN): sign in as one of
 * the demo staff accounts from the demo seed. The session token is the ordinary one;
 * staff routes then check identity.staff_role on every request.
 */
@Controller('session')
export class StaffSessionController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  private enabled(): void {
    if (!this.config.demoSignIn) throw new ForbiddenException({ code: 'demo_sign_in_disabled', message: 'Demo sign-in is not enabled here.' });
  }

  @Get('demo-staff-accounts')
  async accounts() {
    this.enabled();
    const r = await this.db.query<{ id: string; display_name: string; roles: string[] }>(
      `SELECT a.id, a.display_name, array_agg(s.role ORDER BY s.role) AS roles
         FROM identity.account a JOIN identity.staff_role s ON s.account_id = a.id
        WHERE a.email LIKE $1 GROUP BY a.id, a.display_name ORDER BY a.display_name`,
      [`%@${DEMO_EMAIL_DOMAIN}`],
    );
    return r.rows.map((a) => ({ id: a.id, name: a.display_name, roles: a.roles }));
  }

  @Post('demo-staff')
  async signIn(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    this.enabled();
    const { accountId } = parse(Body_, body);
    const demo = await this.db.query('SELECT 1 FROM identity.account WHERE id = $1 AND email LIKE $2', [accountId, `%@${DEMO_EMAIL_DOMAIN}`]);
    const staff = demo.rowCount ? await loadStaff(this.db, accountId) : null;
    if (!staff) throw new ForbiddenException({ code: 'not_demo_staff', message: 'Only demo staff accounts can sign in this way.' });
    res.cookie(SESSION_COOKIE, mintSession(staff.id, this.config.sessionSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secureCookies,
      maxAge: 12 * 3600 * 1000,
      path: '/',
    });
    return staff;
  }
}
