import { PREFERENCE_CATEGORIES, PREFERENCE_CHANNELS, TRANSACTIONAL_PREFERENCE_CATEGORIES, type PreferenceCategory, type RuleSnapshot, type RuleValue } from '@abc/rules';
import type { Channel, TemplateDefinition } from './library';

/**
 * Pure policy (docs/16 §5–7): which channels a message may use and in what order,
 * people's effective preferences, and quiet hours. The dispatcher applies these;
 * nothing here touches the database.
 */

export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];
export type QuietHours = RuleValue<'comms.quiet_hours'>;

/** Channels that buzz a phone. Email and the in-app feed are silent and never held. */
export const NOISY_CHANNELS: readonly Channel[] = ['whatsapp', 'sms', 'push'];

/**
 * The fallback order for a template: from rule comms.fallback, or the template's
 * fixed channels. A code for an email address can only go by email; a code for a
 * phone only by phone channels.
 */
export function fallbackOrder(def: TemplateDefinition, rules: RuleSnapshot, destination?: 'phone' | 'email'): Channel[] {
  if (destination === 'email') return def.channels.includes('email') ? ['email'] : [];
  let order: Channel[];
  if (def.policy === null) order = [...def.channels];
  else {
    const policy = rules.get('comms.fallback')[def.policy];
    order = policy ? policy.channels.filter((c) => def.channels.includes(c)) : [];
  }
  return destination === 'phone' ? order.filter((c) => c === 'whatsapp' || c === 'sms') : order;
}

export function fallbackAfterSeconds(def: TemplateDefinition, rules: RuleSnapshot): number | null {
  if (def.policy === null) return null;
  return rules.get('comms.fallback')[def.policy]?.fallbackAfterSeconds ?? null;
}

/** The email copy "for the record" (docs/01 §7.2) goes with transactional messages people can control. */
export function wantsEmailRecord(def: TemplateDefinition): boolean {
  return def.category === 'transactional' && def.preference !== null && def.channels.includes('email');
}

export type PreferenceMatrix = Record<PreferenceCategory, Record<PreferenceChannel, boolean>>;

/** Defaults from rule comms.preference_defaults, overlaid with the person's own choices. */
export function effectivePreferences(
  rules: RuleSnapshot,
  rows: ReadonlyArray<{ category: string; channel: string; enabled: boolean }>,
): PreferenceMatrix {
  const defaults = rules.get('comms.preference_defaults');
  const m = {} as PreferenceMatrix;
  for (const cat of PREFERENCE_CATEGORIES) {
    m[cat] = {} as Record<PreferenceChannel, boolean>;
    for (const ch of PREFERENCE_CHANNELS) m[cat][ch] = (defaults[cat] ?? []).includes(ch);
  }
  for (const r of rows) {
    if ((PREFERENCE_CATEGORIES as readonly string[]).includes(r.category) && (PREFERENCE_CHANNELS as readonly string[]).includes(r.channel)) {
      m[r.category as PreferenceCategory][r.channel as PreferenceChannel] = r.enabled;
    }
  }
  return m;
}

export function isTransactionalCategory(c: PreferenceCategory): boolean {
  return TRANSACTIONAL_PREFERENCE_CATEGORIES.includes(c);
}

// --- Time ---------------------------------------------------------------------------------

function localParts(at: Date, timeZone: string): { minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return { minutes: h * 60 + m };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** When quiet hours end, if `at` falls inside them; otherwise null. Handles windows over midnight. */
export function quietHoursEnd(at: Date, q: QuietHours): Date | null {
  const now = localParts(at, q.timeZone).minutes;
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  const inside = start < end ? now >= start && now < end : now >= start || now < end;
  if (!inside) return null;
  const wait = (end - now + 1440) % 1440;
  const d = new Date(at.getTime() + wait * 60_000);
  d.setUTCSeconds(0, 0);
  return d;
}

/**
 * When a message on this channel may go out: now, or the end of quiet hours.
 * Sign-in codes and chat replies (no preference category) never wait, nor do
 * silent channels, nor alerts that would be useless after quiet hours end
 * (a lot that closes before then).
 */
export function sendAfter(at: Date, channel: Channel, def: TemplateDefinition, q: QuietHours, expiresAt: Date | null): Date {
  if (!NOISY_CHANNELS.includes(channel) || def.preference === null) return at;
  const end = quietHoursEnd(at, q);
  if (!end) return at;
  if (expiresAt && expiresAt <= end) return at;
  return end;
}

/** "Thu 8 Oct, 14:30" in the given zone. */
export function formatLocalDateTime(at: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('weekday')} ${v('day')} ${v('month')}, ${v('hour')}:${v('minute')}`;
}

/** "Tue 13 Oct" for a calendar date (payout due dates). */
export function formatLocalDate(at: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(at);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('weekday')} ${v('day')} ${v('month')}`;
}
