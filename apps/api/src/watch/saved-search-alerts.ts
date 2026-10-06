import type { Db } from '@abc/db';
import type { CatalogueReader } from '../lots/catalogue-reader';
import { filtersFrom, ListQuery } from '../lots/filters';

/**
 * Saved-search alerts (docs/05 §7, docs/16 §4). Each run looks at every search with
 * alerts on, finds live lots it matches that it has not told its owner about, records
 * them in catalogue.saved_search_hit and raises one `saved_search.matched` event for
 * the batch. A lot is named at most once per search, however often this runs (R4):
 * the hit row and the event are written in the same transaction.
 */
export class SavedSearchAlerts {
  constructor(
    private readonly db: Db,
    private readonly catalogue: CatalogueReader,
    private readonly webBaseUrl: string,
  ) {}

  /** Lots the search matches now (the docket's own filter, so an alert never disagrees with the page). */
  async matches(query: Record<string, unknown>) {
    const q = ListQuery.safeParse(query);
    if (!q.success) return [];
    return (await this.catalogue.liveLots(filtersFrom({ ...q.data, sort: 'newest' }), null)).lots;
  }

  /** Marks what a search matches today as already seen, so a new search only alerts on new lots. */
  async markSeen(searchId: string, query: Record<string, unknown>): Promise<number> {
    const lots = await this.matches(query);
    if (!lots.length) return 0;
    await this.db.query(
      `INSERT INTO catalogue.saved_search_hit (saved_search_id, lot_id)
       SELECT $1, l.id FROM catalogue.lot l WHERE l.lot_ref = ANY($2::text[]) ON CONFLICT DO NOTHING`,
      [searchId, lots.map((l) => l.ref)],
    );
    return lots.length;
  }

  async run(): Promise<number> {
    const searches = await this.db.query<{ id: string; account_id: string; name: string; query: Record<string, unknown> }>(
      'SELECT id, account_id, name, query FROM catalogue.saved_search WHERE alerts_on ORDER BY created_at',
    );
    let raised = 0;
    for (const s of searches.rows) {
      const lots = await this.matches(s.query);
      if (!lots.length) continue;
      const fresh = await this.db.tx({ type: 'system', id: 'saved-search-alerts', name: 'Saved-search alerts', reason: 'saved search matched new lots' }, async (c) => {
        const ins = await c.query<{ lot_ref: string }>(
          `INSERT INTO catalogue.saved_search_hit (saved_search_id, lot_id)
           SELECT $1, l.id FROM catalogue.lot l WHERE l.lot_ref = ANY($2::text[])
           ON CONFLICT DO NOTHING RETURNING (SELECT lot_ref FROM catalogue.lot WHERE id = lot_id)`,
          [s.id, lots.map((l) => l.ref)],
        );
        const refs = new Set(ins.rows.map((r) => r.lot_ref));
        const found = lots.filter((l) => refs.has(l.ref));
        if (!found.length) return 0;
        const first = found[0]!;
        const qs = new URLSearchParams(Object.entries(s.query).filter(([, v]) => typeof v === 'string' && v !== '') as Array<[string, string]>).toString();
        await c.query(
          `INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('saved_search.matched', 'saved_search', $1, $2::jsonb)`,
          [s.id, JSON.stringify({
            accountId: s.account_id, search: s.name, count: found.length, lotTitle: first.title,
            priceMinor: (first.currentPrice ?? first.startingBid).minor, currency: first.currency,
            link: `${this.webBaseUrl}/auctions${qs ? `?${qs}` : ''}`, lots: found.map((l) => l.ref),
          })],
        );
        return found.length;
      });
      if (fresh) raised++;
    }
    return raised;
  }
}
