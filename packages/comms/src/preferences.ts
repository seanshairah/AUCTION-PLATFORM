import type { Actor, Db, RulebookStore } from '@abc/db';
import { PREFERENCE_CATEGORIES, PREFERENCE_CHANNELS, PREFERENCE_LABELS, type PreferenceCategory } from '@abc/rules';
import { effectivePreferences, isTransactionalCategory, type PreferenceChannel } from './policy';

/**
 * The preference centre (docs/16 §6): per category and channel, on or off.
 * Defaults come from rule comms.preference_defaults; a person's own choices are
 * rows in comms.preference. News and offers are off by default. Messages about
 * bids, money and goods can be turned down but not off: at least one of WhatsApp,
 * app notification, SMS or email stays on. The in-app feed always has a copy.
 */

export interface PreferenceView {
  categories: Array<{
    category: PreferenceCategory;
    label: string;
    /** Cannot be switched off on every channel. */
    transactional: boolean;
    channels: Record<PreferenceChannel, { enabled: boolean; consented: boolean }>;
  }>;
}

export interface PreferenceChange {
  category: PreferenceCategory;
  channel: PreferenceChannel;
  enabled: boolean;
}

export type PreferenceUpdate = { ok: true; view: PreferenceView } | { ok: false; reason: 'needs_a_channel'; category: PreferenceCategory };

export class PreferenceService {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
  ) {}

  private async rules(now: Date) {
    return this.rulebook.snapshot(await this.rulebook.activeVersionId(now));
  }

  async get(accountId: string, now: Date = new Date()): Promise<PreferenceView> {
    const rules = await this.rules(now);
    const rows = await this.db.query<{ category: string; channel: string; enabled: boolean }>('SELECT category, channel, enabled FROM comms.preference WHERE account_id = $1', [accountId]);
    const consent = await this.db.query<{ channel: string; granted: boolean }>('SELECT channel, granted FROM identity.contact_consent WHERE account_id = $1', [accountId]);
    const granted = new Set(consent.rows.filter((r) => r.granted).map((r) => r.channel));
    const m = effectivePreferences(rules, rows.rows);
    return {
      categories: PREFERENCE_CATEGORIES.filter((c) => c !== 'staff_tasks').map((category) => ({
        category,
        label: PREFERENCE_LABELS[category],
        transactional: isTransactionalCategory(category),
        channels: Object.fromEntries(PREFERENCE_CHANNELS.map((ch) => [ch, { enabled: m[category][ch], consented: granted.has(ch) }])) as PreferenceView['categories'][number]['channels'],
      })),
    };
  }

  async update(actor: Actor, accountId: string, changes: readonly PreferenceChange[], now: Date = new Date()): Promise<PreferenceUpdate> {
    const rules = await this.rules(now);
    const result = await this.db.tx(actor, async (c): Promise<PreferenceUpdate | null> => {
      // Lock the account's rows so two simultaneous updates cannot both remove the last channel.
      await c.query('SELECT 1 FROM identity.account WHERE id = $1 FOR UPDATE', [accountId]);
      const rows = await c.query<{ category: string; channel: string; enabled: boolean }>('SELECT category, channel, enabled FROM comms.preference WHERE account_id = $1', [accountId]);
      const m = effectivePreferences(rules, rows.rows);
      for (const ch of changes) m[ch.category][ch.channel] = ch.enabled;
      for (const cat of new Set(changes.map((x) => x.category))) {
        if (isTransactionalCategory(cat) && PREFERENCE_CHANNELS.every((ch) => !m[cat][ch])) return { ok: false, reason: 'needs_a_channel', category: cat };
      }
      for (const ch of changes) {
        await c.query(
          `INSERT INTO comms.preference (account_id, category, channel, enabled, updated_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (account_id, category, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
          [accountId, ch.category, ch.channel, ch.enabled, now],
        );
      }
      return null;
    });
    return result ?? { ok: true, view: await this.get(accountId, now) };
  }
}
