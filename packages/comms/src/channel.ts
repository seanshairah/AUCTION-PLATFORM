import { run, type Queryable } from '@abc/db';
import { DEFAULT_LOCALE, type Channel, type TemplateCategory } from './library';
import { render, renderSms } from './render';

/**
 * The MessageChannel abstraction (docs/01 §7.2): each provider sits behind this
 * interface, so a provider can be swapped or doubled without touching the dispatcher.
 */

export interface Recipient {
  accountId: string | null;
  phoneE164: string | null;
  email: string | null;
  displayName: string | null;
}

export interface OutboundMessage {
  messageId: string;
  recipient: Recipient;
  templateKey: string;
  templateVersion: number;
  locale: string;
  params: Record<string, string>;
}

export interface DeliveryStatus {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  at: Date;
  failureReason?: string;
}

export interface MessageChannel {
  channel: Channel;
  send(msg: OutboundMessage): Promise<{ providerMessageId: string }>;
  parseStatusWebhook(headers: Record<string, string>, rawBody: Buffer): DeliveryStatus | null;
}

/**
 * A send that did not go through. `permanent` failures (no such number, template
 * rejected, message too long) move straight to the next channel; others are retried.
 */
export class ChannelError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

// --- Templates as stored -----------------------------------------------------------------

export interface StoredTemplate {
  key: string;
  version: number;
  channel: Channel;
  locale: string;
  category: TemplateCategory;
  subject: string | null;
  body: string;
  providerTemplateName: string | null;
  status: 'draft' | 'approved' | 'retired';
}

export interface TemplateLookup {
  get(key: string, version: number, channel: Channel, locale: string): StoredTemplate | undefined;
}

/**
 * The approved templates in comms.template. Adapters hold one catalogue and the
 * dispatcher refreshes it before sending (approved rows never change, so a stale
 * copy can only miss a template added since, never show different words).
 */
export class TemplateCatalogue implements TemplateLookup {
  private rows = new Map<string, StoredTemplate>();
  private loadedAt = 0;

  static async load(q: Queryable): Promise<TemplateCatalogue> {
    const cat = new TemplateCatalogue();
    await cat.refresh(q);
    return cat;
  }

  /** Reloads from the database, at most once per `maxAgeMs`. */
  async refresh(q: Queryable, maxAgeMs = 0): Promise<void> {
    if (this.loadedAt && Date.now() - this.loadedAt < maxAgeMs) return;
    const r = await run<{ key: string; version: number; channel: Channel; locale: string; category: TemplateCategory; subject: string | null; body: string; provider_template_name: string | null; status: StoredTemplate['status'] }>(
      q,
      `SELECT key, version, channel, locale, category, subject, body, provider_template_name, status FROM comms.template WHERE status <> 'draft'`,
    );
    const rows = new Map<string, StoredTemplate>();
    for (const t of r.rows) {
      rows.set(TemplateCatalogue.id(t.key, t.version, t.channel, t.locale), {
        key: t.key, version: t.version, channel: t.channel, locale: t.locale, category: t.category,
        subject: t.subject, body: t.body, providerTemplateName: t.provider_template_name, status: t.status,
      });
    }
    this.rows = rows;
    this.loadedAt = Date.now();
  }

  static fromRows(rows: ReadonlyArray<Omit<StoredTemplate, 'status'> & { status?: StoredTemplate['status'] }>): TemplateCatalogue {
    const cat = new TemplateCatalogue();
    for (const t of rows) cat.rows.set(TemplateCatalogue.id(t.key, t.version, t.channel, t.locale), { status: 'approved', ...t });
    cat.loadedAt = Date.now();
    return cat;
  }

  get size(): number {
    return this.rows.size;
  }

  private static id(key: string, version: number, channel: string, locale: string): string {
    return `${key}|${version}|${channel}|${locale}`;
  }

  get(key: string, version: number, channel: Channel, locale: string): StoredTemplate | undefined {
    return this.rows.get(TemplateCatalogue.id(key, version, channel, locale)) ?? this.rows.get(TemplateCatalogue.id(key, version, channel, DEFAULT_LOCALE));
  }
}

export interface RenderedMessage {
  subject: string | null;
  text: string;
  template: StoredTemplate;
}

/** Renders a message for a channel from its stored template. SMS is made GSM-safe and fitted to 160. */
export function renderFor(templates: TemplateLookup, channel: Channel, msg: Pick<OutboundMessage, 'templateKey' | 'templateVersion' | 'locale' | 'params'>): RenderedMessage {
  const template = templates.get(msg.templateKey, msg.templateVersion, channel, msg.locale);
  if (!template || template.status !== 'approved') {
    throw new ChannelError(`No approved ${channel} template ${msg.templateKey} v${msg.templateVersion}`, true);
  }
  const text = channel === 'sms' ? renderSms(template.body, msg.params, msg.templateKey) : render(template.body, msg.params, msg.templateKey);
  return { subject: template.subject === null ? null : render(template.subject, msg.params, msg.templateKey), text, template };
}

/** Lower-cased header lookup: Node gives lower-case names, but callers may not. */
export function header(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  return undefined;
}

// --- The registry ------------------------------------------------------------------------

interface Registered {
  provider: string;
  adapter: MessageChannel;
}

/** Which provider carries each channel. A channel with no provider is skipped in the fallback order. */
export class ChannelRegistry {
  private readonly byChannel = new Map<Channel, Registered>();

  register(provider: string, adapter: MessageChannel): this {
    this.byChannel.set(adapter.channel, { provider, adapter });
    return this;
  }

  get(channel: Channel): Registered | undefined {
    return this.byChannel.get(channel);
  }

  has(channel: Channel): boolean {
    return this.byChannel.has(channel);
  }

  byProvider(provider: string): Registered | undefined {
    return [...this.byChannel.values()].find((r) => r.provider === provider);
  }
}
