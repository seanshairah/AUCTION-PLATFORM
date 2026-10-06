import { createHmac, timingSafeEqual } from 'node:crypto';
import { ChannelError, header, renderFor, type DeliveryStatus, type MessageChannel, type OutboundMessage, type TemplateLookup } from '../channel';
import { placeholders } from '../render';

/**
 * WhatsApp Business Cloud API adapter (Meta Graph API).
 *
 * UNVERIFIED (A43): written from Meta's public Cloud API documentation (POST
 * /{phone-number-id}/messages with template messages, webhooks signed with
 * X-Hub-Signature-256 = HMAC-SHA256 of the raw body with the app secret, the
 * hub.verify_token handshake). It has not been run against Meta from this
 * repository. Before it is registered in production it must pass a test on a real
 * WhatsApp Business number, every template in the library must be approved by
 * Meta under its provider name (abc_<key>_v<version>, body from metaTemplateBody),
 * and the sign-in code must be approved as an AUTHENTICATION template. The points
 * to verify are the language codes, the authentication-template components and
 * the error codes treated as temporary.
 */

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Meta app secret: verifies X-Hub-Signature-256 on webhooks. */
  appSecret: string;
  /** Our own token, echoed in the GET handshake when the webhook is registered. */
  verifyToken: string;
  graphVersion?: string;
  baseUrl?: string;
  /** Meta language code per locale. Default: every locale → 'en'. */
  languageCodes?: Record<string, string>;
  /** Templates registered in Meta's AUTHENTICATION category (copy-code button). */
  authenticationTemplates?: readonly string[];
  /** Give up on a request after this long (default 15 s), well inside the dispatcher's lease. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface InboundWhatsApp {
  providerMessageId: string;
  /** E.164, with the leading + Meta leaves off. */
  from: string;
  kind: 'text' | 'image' | 'other';
  text?: string;
  imageIds?: string[];
  at: Date;
}

/** Meta error codes that mean "try again later" (rate limits, temporary faults). */
const TRANSIENT_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

interface WebhookValue {
  messages?: Array<{ from: string; id: string; timestamp: string; type: string; text?: { body: string }; image?: { id: string; caption?: string } }>;
  statuses?: Array<{ id: string; status: string; timestamp: string; errors?: Array<{ code: number; title?: string; message?: string }> }>;
}

export class WhatsAppCloudChannel implements MessageChannel {
  readonly channel = 'whatsapp' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly templates: TemplateLookup,
    private readonly config: WhatsAppConfig,
  ) {
    this.fetchImpl = config.fetch ?? fetch;
  }

  private url(): string {
    return `${this.config.baseUrl ?? 'https://graph.facebook.com'}/${this.config.graphVersion ?? 'v21.0'}/${this.config.phoneNumberId}/messages`;
  }

  /** The request body Meta expects for this message (exported for tests). */
  requestBody(msg: OutboundMessage): Record<string, unknown> {
    const to = msg.recipient.phoneE164?.replace(/^\+/, '');
    if (!to) throw new ChannelError('no WhatsApp number', true);
    const rendered = renderFor(this.templates, 'whatsapp', msg);
    const name = rendered.template.providerTemplateName;
    if (!name) {
      // A reply inside the 24-hour customer-service window: plain text, no template.
      return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: rendered.text, preview_url: false } };
    }
    const language = { code: this.config.languageCodes?.[msg.locale] ?? 'en' };
    if ((this.config.authenticationTemplates ?? ['otp_code']).includes(msg.templateKey)) {
      const code = msg.params.code ?? '';
      return {
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
        template: {
          name, language,
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      };
    }
    const parameters = placeholders(rendered.template.body).map((p) => ({ type: 'text', text: msg.params[p]! }));
    return {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
      template: { name, language, components: parameters.length ? [{ type: 'body', parameters }] : [] },
    };
  }

  async send(msg: OutboundMessage): Promise<{ providerMessageId: string }> {
    const body = this.requestBody(msg);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new ChannelError(`WhatsApp unreachable: ${(e as Error).message}`, false);
    }
    const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { code?: number; message?: string } };
    if (res.ok && json.messages?.[0]?.id) return { providerMessageId: json.messages[0].id };
    const code = json.error?.code;
    const transient = res.status >= 500 || res.status === 429 || (code !== undefined && TRANSIENT_CODES.has(code));
    throw new ChannelError(`WhatsApp ${res.status}${code ? ` (${code})` : ''}: ${json.error?.message ?? 'no message id'}`, !transient);
  }

  /** X-Hub-Signature-256 check over the exact bytes received. */
  verifySignature(headers: Record<string, string>, rawBody: Buffer): boolean {
    const given = header(headers, 'x-hub-signature-256');
    if (!given?.startsWith('sha256=')) return false;
    const expected = Buffer.from(`sha256=${createHmac('sha256', this.config.appSecret).update(rawBody).digest('hex')}`);
    const g = Buffer.from(given);
    return g.length === expected.length && timingSafeEqual(g, expected);
  }

  /** The GET handshake when the webhook URL is registered: returns hub.challenge, or null to refuse. */
  verifySubscription(query: Record<string, unknown>): string | null {
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (query['hub.mode'] !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string') return null;
    const a = Buffer.from(token);
    const b = Buffer.from(this.config.verifyToken);
    return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
  }

  /** Every status and inbound message in a signed webhook; null if the signature is wrong. */
  parseWebhook(headers: Record<string, string>, rawBody: Buffer): { statuses: DeliveryStatus[]; inbound: InboundWhatsApp[] } | null {
    if (!this.verifySignature(headers, rawBody)) return null;
    let payload: { entry?: Array<{ changes?: Array<{ value?: WebhookValue }> }> };
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const statuses: DeliveryStatus[] = [];
    const inbound: InboundWhatsApp[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const s of change.value?.statuses ?? []) {
          if (!['sent', 'delivered', 'read', 'failed'].includes(s.status)) continue;
          const err = s.errors?.[0];
          statuses.push({
            providerMessageId: s.id,
            status: s.status as DeliveryStatus['status'],
            at: new Date(Number(s.timestamp) * 1000),
            ...(s.status === 'failed' ? { failureReason: err ? `${err.code}: ${err.title ?? err.message ?? 'failed'}` : 'failed' } : {}),
          });
        }
        for (const m of change.value?.messages ?? []) {
          const base = { providerMessageId: m.id, from: `+${m.from.replace(/^\+/, '')}`, at: new Date(Number(m.timestamp) * 1000) };
          if (m.type === 'text' && m.text) inbound.push({ ...base, kind: 'text', text: m.text.body });
          else if (m.type === 'image' && m.image) inbound.push({ ...base, kind: 'image', imageIds: [m.image.id], ...(m.image.caption ? { text: m.image.caption } : {}) });
          else inbound.push({ ...base, kind: 'other' });
        }
      }
    }
    return { statuses, inbound };
  }

  parseStatusWebhook(headers: Record<string, string>, rawBody: Buffer): DeliveryStatus | null {
    return this.parseWebhook(headers, rawBody)?.statuses[0] ?? null;
  }
}
