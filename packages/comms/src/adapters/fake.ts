import { ChannelError, renderFor, type DeliveryStatus, type MessageChannel, type OutboundMessage, type TemplateLookup } from '../channel';
import type { Channel } from '../library';

/**
 * FAKE CHANNEL for tests and the demo: renders the message exactly as a real
 * adapter would, records it, and sends nothing. Failures can be scripted.
 * Its status webhook is plain JSON: { "id": "<providerMessageId>", "status": "delivered" }.
 */

export interface FakeSend {
  providerMessageId: string;
  messageId: string;
  to: string | null;
  templateKey: string;
  params: Record<string, string>;
  subject: string | null;
  text: string;
}

export class FakeChannel implements MessageChannel {
  readonly sent: FakeSend[] = [];
  private readonly script: Array<'permanent' | 'transient'> = [];
  private n = 0;
  failAlways: 'permanent' | 'transient' | null = null;

  constructor(
    readonly channel: Channel,
    private readonly templates: TemplateLookup,
  ) {}

  /** The next sends fail, in order. */
  failNext(...kinds: Array<'permanent' | 'transient'>): this {
    this.script.push(...kinds);
    return this;
  }

  async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    const failure = this.script.shift() ?? this.failAlways;
    if (failure) throw new ChannelError(`fake ${this.channel} ${failure} failure`, failure === 'permanent');
    const rendered = renderFor(this.templates, this.channel, msg);
    const to =
      this.channel === 'email' ? msg.recipient.email : this.channel === 'sms' || this.channel === 'whatsapp' ? msg.recipient.phoneE164 : msg.recipient.accountId;
    if (!to) throw new ChannelError(`no ${this.channel} address`, true);
    const providerMessageId = `fake-${this.channel}-${++this.n}-${msg.messageId.slice(0, 8)}`;
    this.sent.push({ providerMessageId, messageId: msg.messageId, to, templateKey: msg.templateKey, params: { ...msg.params }, subject: rendered.subject, text: rendered.text });
    return { providerMessageId };
  }

  parseStatusWebhook(_headers: Record<string, string>, rawBody: Buffer): DeliveryStatus | null {
    try {
      const b = JSON.parse(rawBody.toString('utf8')) as { id?: string; status?: string; reason?: string; at?: string };
      if (!b.id || !['sent', 'delivered', 'read', 'failed'].includes(b.status ?? '')) return null;
      return {
        providerMessageId: b.id,
        status: b.status as DeliveryStatus['status'],
        at: b.at ? new Date(b.at) : new Date(),
        ...(b.reason ? { failureReason: b.reason } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Last message sent to an address (phone, email or account id). */
  lastTo(to: string): FakeSend | undefined {
    return [...this.sent].reverse().find((s) => s.to === to);
  }
}
