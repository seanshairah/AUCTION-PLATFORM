import { Body, Controller, ForbiddenException, Get, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Db } from '@abc/db';
import { CatalogueReader } from './lots/catalogue-reader';
import { mintSession, SESSION_COOKIE } from './session';
import { CATALOGUE, CONFIG, DB, type ApiConfig } from './tokens';

@Controller()
export class SystemController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CATALOGUE) private readonly catalogue: CatalogueReader,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('health')
  async health() {
    const r = await this.db.query<{ now: Date; migration: string | null }>(
      `SELECT now(), (SELECT max(id) FROM public.schema_migration) AS migration`,
    ).catch(() => this.db.query<{ now: Date; migration: string | null }>('SELECT now(), NULL::text AS migration'));
    return { ok: true, serverTime: r.rows[0]!.now.toISOString(), schema: r.rows[0]!.migration, demoSignIn: this.config.demoSignIn };
  }

  /** The public rulebook in plain language, from the active published rule set (R2). */
  @Get('rules')
  rules() {
    return this.catalogue.publicRules();
  }

  @Get('session/demo-accounts')
  async demoAccounts() {
    if (!this.config.demoSignIn) throw new ForbiddenException({ code: 'demo_sign_in_disabled', message: 'Demo sign-in is not enabled here.' });
    const r = await this.db.query<{ id: string; display_name: string; account_type: string }>(
      `SELECT a.id, a.display_name, a.account_type FROM identity.account a
        WHERE a.email LIKE '%@demo.abc-auctions.test' AND NOT EXISTS (SELECT 1 FROM identity.staff_role s WHERE s.account_id = a.id)
        ORDER BY a.account_type DESC, a.display_name`,
    );
    return r.rows.map((a) => ({ id: a.id, name: a.display_name, kind: a.account_type === 'organisation' ? 'seller' : 'bidder' }));
  }

  /** Development and staging only (A42): sign in as a demo bidder. */
  @Post('session/demo')
  async demoSignIn(@Body() body: { accountId?: string }, @Res({ passthrough: true }) res: Response) {
    if (!this.config.demoSignIn) throw new ForbiddenException({ code: 'demo_sign_in_disabled', message: 'Demo sign-in is not enabled here.' });
    const r = await this.db.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM identity.account WHERE id = $1 AND email LIKE '%@demo.abc-auctions.test'`,
      [body?.accountId ?? '00000000-0000-0000-0000-000000000000'],
    );
    const account = r.rows[0];
    if (!account) throw new ForbiddenException({ code: 'not_a_demo_account', message: 'Only demo accounts can sign in this way.' });
    res.cookie(SESSION_COOKIE, mintSession(account.id, this.config.sessionSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secureCookies,
      maxAge: 12 * 3600 * 1000,
      path: '/',
    });
    return { id: account.id, name: account.display_name };
  }

  @Post('session/sign-out')
  signOut(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}
