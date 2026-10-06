import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Param, Patch, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Db } from '@abc/db';
import { parse } from '../admin/http';
import type { CatalogueReader } from '../lots/catalogue-reader';
import { ListQuery } from '../lots/filters';
import { CurrentAccount, type SessionAccount } from '../session';
import { CATALOGUE, DB, SAVED_SEARCHES } from '../tokens';
import type { SavedSearchAlerts } from './saved-search-alerts';

const MAX_SEARCHES = 20;
const SearchBody = z.object({
  name: z.string().trim().min(2).max(60),
  query: ListQuery.omit({ sort: true }).strict(),
  alerts: z.boolean().default(true),
});
const AlertsBody = z.object({ alerts: z.boolean() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The watch list and saved searches (docs/05 §7). Personal settings: no audit trail, no approval. */
@Controller('me')
export class WatchController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CATALOGUE) private readonly catalogue: CatalogueReader,
    @Inject(SAVED_SEARCHES) private readonly alerts: SavedSearchAlerts,
  ) {}

  @Get('watch')
  watchList(@CurrentAccount() account: SessionAccount) {
    return this.catalogue.watchedLots(account.id);
  }

  @Put('watch/:ref')
  async watch(@Param('ref') ref: string, @CurrentAccount() account: SessionAccount) {
    const r = await this.db.query(
      `INSERT INTO catalogue.watch (account_id, lot_id) SELECT $1, id FROM catalogue.lot WHERE lot_ref = $2 ON CONFLICT DO NOTHING RETURNING lot_id`,
      [account.id, ref],
    );
    if (!r.rowCount) {
      const exists = await this.db.query('SELECT 1 FROM catalogue.lot WHERE lot_ref = $1', [ref]);
      if (!exists.rowCount) throw new NotFoundException({ code: 'lot_not_found', message: 'We could not find that lot.' });
    }
    return { watching: true };
  }

  @Delete('watch/:ref')
  async unwatch(@Param('ref') ref: string, @CurrentAccount() account: SessionAccount) {
    await this.db.query('DELETE FROM catalogue.watch WHERE account_id = $1 AND lot_id = (SELECT id FROM catalogue.lot WHERE lot_ref = $2)', [account.id, ref]);
    return { watching: false };
  }

  @Get('saved-searches')
  async searches(@CurrentAccount() account: SessionAccount) {
    const r = await this.db.query<{ id: string; name: string; query: Record<string, string>; alerts_on: boolean; created_at: Date; seen: string }>(
      `SELECT s.id, s.name, s.query, s.alerts_on, s.created_at, (SELECT count(*) FROM catalogue.saved_search_hit h WHERE h.saved_search_id = s.id) AS seen
         FROM catalogue.saved_search s WHERE s.account_id = $1 ORDER BY s.created_at DESC`,
      [account.id],
    );
    const out = [];
    for (const s of r.rows) {
      const lots = await this.alerts.matches(s.query);
      out.push({ id: s.id, name: s.name, query: s.query, alerts: s.alerts_on, createdAt: s.created_at.toISOString(), matches: lots.length, preview: lots.slice(0, 3).map((l) => ({ ref: l.ref, title: l.title, cover: l.cover })) });
    }
    return out;
  }

  @Put('saved-searches')
  async save(@Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = parse(SearchBody, body);
    const query = Object.fromEntries(Object.entries(b.query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
    if (!Object.keys(query).length) throw new BadRequestException({ code: 'empty_search', message: 'Choose at least one filter or search word to save.' });
    const count = await this.db.query<{ n: string }>('SELECT count(*) AS n FROM catalogue.saved_search WHERE account_id = $1', [account.id]);
    const r = await this.db.query<{ id: string; inserted: boolean }>(
      `INSERT INTO catalogue.saved_search (account_id, name, query, alerts_on) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (account_id, name) DO UPDATE SET query = EXCLUDED.query, alerts_on = EXCLUDED.alerts_on
       RETURNING id, (xmax = 0) AS inserted`,
      [account.id, b.name, JSON.stringify(query), b.alerts],
    );
    const row = r.rows[0]!;
    if (row.inserted && Number(count.rows[0]!.n) >= MAX_SEARCHES) {
      await this.db.query('DELETE FROM catalogue.saved_search WHERE id = $1', [row.id]);
      throw new ConflictException({ code: 'too_many_searches', message: `You can save up to ${MAX_SEARCHES} searches. Delete one first.` });
    }
    // Lots already on the page are not news: only lots listed from now on trigger an alert.
    const matches = await this.alerts.markSeen(row.id, query);
    return { id: row.id, name: b.name, alerts: b.alerts, matches, created: row.inserted };
  }

  @Patch('saved-searches/:id')
  async setAlerts(@Param('id') id: string, @Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = parse(AlertsBody, body);
    if (!UUID.test(id)) throw new NotFoundException();
    const r = await this.db.query('UPDATE catalogue.saved_search SET alerts_on = $3 WHERE id = $1 AND account_id = $2', [id, account.id, b.alerts]);
    if (!r.rowCount) throw new NotFoundException({ code: 'not_found', message: 'We could not find that saved search.' });
    return { id, alerts: b.alerts };
  }

  @Delete('saved-searches/:id')
  async remove(@Param('id') id: string, @CurrentAccount() account: SessionAccount) {
    if (!UUID.test(id)) throw new NotFoundException();
    await this.db.query('DELETE FROM catalogue.saved_search WHERE id = $1 AND account_id = $2', [id, account.id]);
    return { deleted: true };
  }
}
