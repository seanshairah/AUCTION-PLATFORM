import { randomUUID } from 'node:crypto';
import { ChannelError, renderFor, type DeliveryStatus, type MessageChannel, type OutboundMessage, type TemplateLookup } from '../channel';

/**
 * Email without SMTP in the System: an EmailChannel renders the message and hands
 * it to an EmailTransport. A provider (an HTTPS email API) implements the transport
 * when one is chosen; until then the log transport writes each email to the log.
 */

export interface OutgoingEmail {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  readonly name: string;
  send(email: OutgoingEmail): Promise<{ id: string }>;
  /** Provider delivery events, if the provider has them. */
  parseStatusWebhook?(headers: Record<string, string>, rawBody: Buffer): DeliveryStatus | null;
}

/**
 * Writes one log line per email (recipient and subject, never the body, which may
 * hold a sign-in code) and, for tests and the demo, keeps the emails. Sends nothing.
 */
export class LogEmailTransport implements EmailTransport {
  readonly name = 'log';
  readonly outbox: OutgoingEmail[] = [];

  constructor(
    private readonly log: (line: string) => void = (l) => console.log(l),
    private readonly keep = true,
  ) {}

  async send(email: OutgoingEmail): Promise<{ id: string }> {
    if (this.keep) this.outbox.push(email);
    this.log(`email to ${email.to}: ${email.subject}`);
    return { id: `log-${randomUUID()}` };
  }
}

export class EmailChannel implements MessageChannel {
  readonly channel = 'email' as const;

  constructor(
    private readonly templates: TemplateLookup,
    private readonly transport: EmailTransport,
    private readonly from: string,
  ) {}

  async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    if (!msg.recipient.email) throw new ChannelError('no email address', true);
    const r = renderFor(this.templates, 'email', msg);
    const { id } = await this.transport.send({ messageId: msg.messageId, from: this.from, to: msg.recipient.email, subject: r.subject ?? '', text: r.text });
    return { providerMessageId: id };
  }

  parseStatusWebhook(headers: Record<string, string>, rawBody: Buffer): DeliveryStatus | null {
    return this.transport.parseStatusWebhook?.(headers, rawBody) ?? null;
  }
}
