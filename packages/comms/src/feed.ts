import type { Actor, Db } from '@abc/db';
import { renderFor, type TemplateCatalogue } from './channel';
import type { Channel } from './library';

/**
 * The in-app notification feed (docs/16 §8): the person's in_app messages, newest
 * first, rendered from the same templates as every other channel. Marking one read
 * moves its status from delivered to read.
 */

export interface FeedItem {
  id: string;
  kind: string;
  title: string | null;
  text: string;
  at: Date;
  read: boolean;
}

export class NotificationFeed {
  constructor(
    private readonly db: Db,
    private readonly templates: TemplateCatalogue,
  ) {}

  async list(accountId: string, p: { limit?: number; before?: Date } = {}): Promise<{ items: FeedItem[]; unread: number }> {
    await this.templates.refresh(this.db, 60_000);
    const r = await this.db.query<{ id: string; template_key: string; template_version: number; locale: string; params: Record<string, string>; status: string; sent_at: Date }>(
      `SELECT id, template_key, template_version, locale, params, status, sent_at FROM comms.message
        WHERE recipient_account_id = $1 AND channel = 'in_app' AND status IN ('delivered', 'read') AND ($2::timestamptz IS NULL OR sent_at < $2)
        ORDER BY sent_at DESC, id LIMIT $3`,
      [accountId, p.before ?? null, Math.min(Math.max(p.limit ?? 30, 1), 100)],
    );
    const unread = await this.db.query<{ n: bigint }>(
      `SELECT count(*) AS n FROM comms.message WHERE recipient_account_id = $1 AND channel = 'in_app' AND status = 'delivered'`,
      [accountId],
    );
    const items = r.rows.map((m) => {
      const rendered = renderFor(this.templates, 'in_app' as Channel, { templateKey: m.template_key, templateVersion: m.template_version, locale: m.locale, params: m.params });
      return { id: m.id, kind: m.template_key, title: rendered.subject, text: rendered.text, at: m.sent_at, read: m.status === 'read' };
    });
    return { items, unread: Number(unread.rows[0]!.n) };
  }

  /** Idempotent: an already-read item stays read. False if it is not this person's. */
  async markRead(actor: Actor, accountId: string, messageId: string, now: Date = new Date()): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/.test(messageId)) return false;
    return this.db.tx(actor, async (c) => {
      const r = await c.query<{ status: string }>(
        `SELECT status FROM comms.message WHERE id = $1 AND recipient_account_id = $2 AND channel = 'in_app' FOR UPDATE`,
        [messageId, accountId],
      );
      const m = r.rows[0];
      if (!m) return false;
      if (m.status === 'delivered') await c.query(`UPDATE comms.message SET status = 'read', read_at = $2 WHERE id = $1`, [messageId, now]);
      return m.status === 'delivered' || m.status === 'read';
    });
  }
}
