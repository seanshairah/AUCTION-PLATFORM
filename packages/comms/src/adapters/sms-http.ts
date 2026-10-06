import { createHmac, timingSafeEqual } from 'node:crypto';
import { ChannelError, header, renderFor, type DeliveryStatus, type MessageChannel, type OutboundMessage, type TemplateLookup } from '../channel';

/**
 * Generic HTTP SMS adapter for an SMS aggregator.
 *
 * UNVERIFIED (A44): no aggregator has been chosen, so this adapter speaks a
 * configurable JSON-over-HTTPS shape that most aggregators can be mapped to: a POST
 * with the number, sender id, text and our reference, answered with the provider's
 * message id; and a delivery-report callback signed with HMAC-SHA256 of the raw body.
 * Field names and status words are configuration. It has not been run against any
 * provider. Messages are always one GSM-7 segment (160 characters, docs/16 §3).
 */

export interface HttpSmsConfig {
  url: string;
  /** Sender id shown on the phone, as registered with the networks. */
  from: string;
  /** Extra request headers, e.g. { Authorization: 'Bearer …' }. */
  headers?: Record<string, string>;
  /** Request field names. Defaults: to, from, text, reference. */
  fields?: Partial<Record<'to' | 'from' | 'text' | 'reference', string>>;
  /** Response field holding the provider's message id. Default: id (dots for nesting, e.g. data.id). */
  idField?: string;
  /** Strip the + from numbers. Default false. */
  stripPlus?: boolean;
  /** Delivery reports: header carrying hex HMAC-SHA256 of the raw body, and its key. */
  statusSignatureHeader?: string;
  statusSecret: string;
  /** Delivery-report field names. Defaults: id, status, reason. */
  statusFields?: Partial<Record<'id' | 'status' | 'reason', string>>;
  /** Provider status word → our status. Defaults cover common words. */
  statusMap?: Record<string, DeliveryStatus['status']>;
  /** Give up on a request after this long (default 15 s), well inside the dispatcher's lease. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_STATUS: Record<string, DeliveryStatus['status']> = {
  sent: 'sent', submitted: 'sent', accepted: 'sent', enroute: 'sent', buffered: 'sent',
  delivered: 'delivered', delivrd: 'delivered', success: 'delivered',
  failed: 'failed', undelivered: 'failed', undeliv: 'failed', rejected: 'failed', rejectd: 'failed', expired: 'failed', expird: 'failed',
};

function pick(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export class HttpSmsChannel implements MessageChannel {
  readonly channel = 'sms' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly templates: TemplateLookup,
    private readonly config: HttpSmsConfig,
  ) {
    this.fetchImpl = config.fetch ?? fetch;
  }

  requestBody(msg: OutboundMessage): Record<string, string> {
    const phone = msg.recipient.phoneE164;
    if (!phone) throw new ChannelError('no phone number', true);
    let text: string;
    try {
      text = renderFor(this.templates, 'sms', msg).text;
    } catch (e) {
      if (e instanceof ChannelError) throw e;
      throw new ChannelError((e as Error).message, true);
    }
    const f = this.config.fields ?? {};
    return {
      [f.to ?? 'to']: this.config.stripPlus ? phone.replace(/^\+/, '') : phone,
      [f.from ?? 'from']: this.config.from,
      [f.text ?? 'text']: text,
      [f.reference ?? 'reference']: msg.messageId,
    };
  }

  async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    const body = this.requestBody(msg);
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.config.headers ?? {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new ChannelError(`SMS provider unreachable: ${(e as Error).message}`, false);
    }
    const json = await res.json().catch(() => ({}));
    const id = pick(json, this.config.idField ?? 'id');
    if (res.ok && (typeof id === 'string' || typeof id === 'number')) return { providerMessageId: String(id) };
    throw new ChannelError(`SMS provider ${res.status}`, !(res.status >= 500 || res.status === 429 || res.ok));
  }

  parseStatusWebhook(headers: Record<string, string>, rawBody: Buffer): DeliveryStatus | null {
    const given = header(headers, this.config.statusSignatureHeader ?? 'x-signature');
    const expected = createHmac('sha256', this.config.statusSecret).update(rawBody).digest('hex');
    if (!given || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
    let b: unknown;
    try {
      b = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const f = this.config.statusFields ?? {};
    const id = pick(b, f.id ?? 'id');
    const word = String(pick(b, f.status ?? 'status') ?? '').toLowerCase();
    const status = (this.config.statusMap ?? DEFAULT_STATUS)[word];
    if ((typeof id !== 'string' && typeof id !== 'number') || !status) return null;
    const reason = pick(b, f.reason ?? 'reason');
    return { providerMessageId: String(id), status, at: new Date(), ...(status === 'failed' ? { failureReason: typeof reason === 'string' ? reason : word } : {}) };
  }
}
