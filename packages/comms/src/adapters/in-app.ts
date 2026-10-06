import { ChannelError, renderFor, type DeliveryStatus, type MessageChannel, type OutboundMessage, type TemplateLookup } from '../channel';

/**
 * In-app messages: the comms.message row is the notification, shown in the
 * person's feed (docs/16 §8). Nothing leaves the System, so a "send" only checks
 * that the message renders and marks it delivered.
 */
export class InAppChannel implements MessageChannel {
  readonly channel = 'in_app' as const;

  constructor(private readonly templates: TemplateLookup) {}

  async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    if (!msg.recipient.accountId) throw new ChannelError('in-app messages need an account', true);
    renderFor(this.templates, 'in_app', msg);
    return { providerMessageId: `in_app:${msg.messageId}` };
  }

  parseStatusWebhook(_headers: Record<string, string>, _rawBody: Buffer): DeliveryStatus | null {
    return null;
  }
}
