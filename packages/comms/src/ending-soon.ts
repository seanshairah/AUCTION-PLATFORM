import type { Actor, Db, RulebookStore } from '@abc/db';

/**
 * "Ending soon" alerts (docs/16 §4): when a lot is within comms.ending_soon_minutes
 * of closing (from the auction's pinned rule set, A20), everyone who has bid on it
 * gets one `lot.ending_soon` event, saying whether they are leading. Once per lot
 * and person, however often this runs (and the message key keeps it to one message
 * even if two scanners race). A watch list does not exist yet; when the
 * catalogue adds one, watchers join the same query.
 */

const ACTOR: Actor = { type: 'system', id: 'ending-soon', name: 'Ending-soon alerts' };

export class EndingSoonAlerts {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
  ) {}

  async queue(now: Date = new Date()): Promise<number> {
    return this.db.tx(ACTOR, async (c) => {
      const lots = await c.query<{ id: string; leading_account_id: string | null; current_end_at: Date; rule_version_id: string }>(
        `SELECT al.id, al.leading_account_id, al.current_end_at, a.rule_version_id
           FROM auction.auction_lot al JOIN auction.auction a ON a.id = al.auction_id
          WHERE a.status = 'open' AND a.rule_version_id IS NOT NULL AND al.result = 'pending'
            AND al.current_end_at > $1 AND al.current_end_at <= $1 + interval '1 day'`,
        [now],
      );
      let queued = 0;
      for (const lot of lots.rows) {
        const minutes = (await this.rulebook.snapshot(lot.rule_version_id, c)).get('comms.ending_soon_minutes');
        if (lot.current_end_at.getTime() - now.getTime() > minutes * 60_000) continue;
        const r = await c.query(
          `INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload)
           SELECT 'lot.ending_soon', 'auction_lot', $1::text,
                  jsonb_build_object('accountId', b.account_id, 'leading', b.account_id IS NOT DISTINCT FROM $2::uuid, 'endAt', $3::timestamptz)
             FROM (SELECT DISTINCT account_id FROM bidding.bid
                    WHERE auction_lot_id = $4::uuid AND origin = 'bidder' AND outcome_at_placement <> 'rejected') b
            WHERE NOT EXISTS (SELECT 1 FROM core.outbox o
                               WHERE o.topic = 'lot.ending_soon' AND o.aggregate_id = $1::text AND o.payload->>'accountId' = b.account_id::text)`,
          [lot.id, lot.leading_account_id, lot.current_end_at, lot.id],
        );
        queued += r.rowCount ?? 0;
      }
      return queued;
    });
  }
}
