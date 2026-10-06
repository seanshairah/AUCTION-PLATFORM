import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRuleSetDocument } from '@abc/db';
import { renderRulebook, RuleSnapshot } from '@abc/rules';
import {
  ChannelError,
  CHANNELS,
  fallbackOrder,
  FakeChannel,
  formatLocalDateTime,
  gsmLength,
  gsmSafe,
  HttpSmsChannel,
  isGsm7,
  metaTemplateBody,
  MissingParamError,
  placeholders,
  quietHoursEnd,
  render,
  renderFor,
  renderSms,
  sendAfter,
  TEMPLATE_LIBRARY,
  TEMPLATE_SQL_BEGIN,
  TEMPLATE_SQL_END,
  TemplateCatalogue,
  templateDefinition,
  templateParams,
  templateRows,
  templatesSql,
  WhatsAppCloudChannel,
  type OutboundMessage,
} from './index';

const DOC = readRuleSetDocument();
const rules = new RuleSnapshot('v', DOC.label, DOC.rules);
const catalogue = TemplateCatalogue.fromRows(templateRows());
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function msg(templateKey: string, params: Record<string, string>, over: Partial<OutboundMessage['recipient']> = {}): OutboundMessage {
  return {
    messageId: '6f1c2c3e-0000-4000-8000-000000000001',
    recipient: { accountId: '6f1c2c3e-0000-4000-8000-0000000000aa', phoneE164: '+263771234567', email: 'farai@example.test', displayName: 'Farai', ...over },
    templateKey,
    templateVersion: 1,
    locale: 'en-ZW',
    params,
  };
}

describe('template rendering', () => {
  it('fills placeholders and refuses to leave one blank', () => {
    expect(render('Invoice {{invoice}} for {{ total }}', { invoice: 'A-1', total: 'US$5.00' })).toBe('Invoice A-1 for US$5.00');
    expect(() => render('Invoice {{invoice}} is due {{due}}', { invoice: 'A-1' }, 'invoice_issued')).toThrow(MissingParamError);
    expect(() => render('Invoice {{invoice}}', { invoice: '  ' })).toThrow(/missing invoice/);
    expect(placeholders('{{a}} {{b}} {{a}}')).toEqual(['a', 'b']);
  });

  it('turns named placeholders into the numbered ones Meta approves, in order', () => {
    expect(metaTemplateBody('{{lot}} is {{price}}; bid on {{lot}} at {{link}}')).toBe('{{1}} is {{2}}; bid on {{1}} at {{3}}');
  });
});

describe('SMS', () => {
  it('knows the GSM-7 character set and counts extension characters twice', () => {
    expect(isGsm7('Pay US$5.00 by Thu 8 Oct, 14:30. €')).toBe(true);
    expect(isGsm7('Café’s')).toBe(false);
    expect(gsmLength('a{b}')).toBe(6);
    expect(gsmSafe('“Toyota” – Mōto Café… 3×')).toBe('"Toyota" - Moto Café... 3x');
  });

  it('shortens a long lot title to fit 160 characters, never the link', () => {
    const t = templateDefinition('outbid');
    const long = 'Toyota Land Cruiser 200 Series V8 4.5 D-4D VX-R Station Wagon with Full Service History and Tow Bar';
    const text = renderSms(t.text, { lot: long, price: 'US$124,500.00', link: 'https://abc.example/lots/HRE-26-4F2A9C01' });
    expect(gsmLength(text)).toBeLessThanOrEqual(160);
    expect(text).toContain('...');
    expect(text.endsWith('https://abc.example/lots/HRE-26-4F2A9C01')).toBe(true);
  });
});

describe('the template library', () => {
  it('covers every outbox topic a person should hear about, on every channel', () => {
    const keys = TEMPLATE_LIBRARY.map((t) => t.key);
    for (const k of ['outbid', 'ending_soon_leading', 'ending_soon_watching', 'won', 'lost', 'invoice_issued', 'payment_reminder', 'payment_reminder_final',
      'payment_received', 'gate_pass_ready', 'default_warning', 'deposit_forfeited', 'title_step_overdue', 'title_complete', 'payout_scheduled',
      'payout_paid', 'payout_blocked', 'registration_approved', 'registration_review', 'otp_code', 'consignment_received']) {
      expect(keys, k).toContain(k);
    }
    for (const t of TEMPLATE_LIBRARY.filter((x) => x.policy !== null && x.key !== 'otp_code')) expect(t.channels).toEqual(CHANNELS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every SMS fits one GSM-7 segment with realistic values, and every channel renders', () => {
    for (const t of TEMPLATE_LIBRARY) {
      expect(Object.keys(t.example).sort(), t.key).toEqual(templateParams(t).sort());
      for (const ch of t.channels) {
        const r = renderFor(catalogue, ch, msg(t.key, t.example));
        if (ch === 'sms') {
          expect(isGsm7(r.text), t.key).toBe(true);
          expect(gsmLength(r.text), `${t.key}: ${r.text}`).toBeLessThanOrEqual(160);
        }
        if (ch === 'email') expect(r.subject, t.key).toBeTruthy();
      }
    }
  });

  it('uses plain words: no exclamation marks, no "please be advised", "Dear valued customer" or the like', () => {
    for (const t of TEMPLATE_LIBRARY) {
      const all = `${t.text} ${t.subject} ${t.email}`;
      expect(all, t.key).not.toMatch(/!|be advised|valued customer|kindly|hereby|exciting/i);
    }
  });

  it('db/seed.sql holds exactly the generated library (and migration 0002 the same rows)', () => {
    const block = (file: string) => {
      const s = readFileSync(`${ROOT}${file}`, 'utf8');
      return s.slice(s.indexOf(TEMPLATE_SQL_BEGIN), s.indexOf(TEMPLATE_SQL_END) + TEMPLATE_SQL_END.length);
    };
    expect(block('db/seed.sql')).toBe(templatesSql());
    expect(block('db/migrations/0002_comms_identity.sql')).toBe(templatesSql());
  });

  it('names WhatsApp templates per version; a chat reply is a session message', () => {
    const rows = templateRows();
    expect(rows.find((r) => r.key === 'outbid' && r.channel === 'whatsapp')?.providerTemplateName).toBe('abc_outbid_v1');
    expect(rows.find((r) => r.key === 'chat_reply')?.providerTemplateName).toBeNull();
    expect(rows.filter((r) => r.channel === 'sms').every((r) => r.subject === null)).toBe(true);
  });
});

describe('channel policy', () => {
  it('takes the fallback order from the rulebook', () => {
    expect(fallbackOrder(templateDefinition('outbid'), rules)).toEqual(['whatsapp', 'push', 'sms']);
    expect(fallbackOrder(templateDefinition('otp_code'), rules, 'phone')).toEqual(['whatsapp', 'sms']);
    expect(fallbackOrder(templateDefinition('otp_code'), rules, 'email')).toEqual(['email']);
    expect(fallbackOrder(templateDefinition('chat_reply'), rules)).toEqual(['whatsapp']);
  });

  it('quiet hours run 21:00 to 07:00 Harare time and hold noisy channels until they end', () => {
    const q = rules.get('comms.quiet_hours');
    const night = new Date('2026-11-20T20:30:00Z'); // 22:30 in Harare (UTC+2)
    expect(quietHoursEnd(night, q)?.toISOString()).toBe('2026-11-21T05:00:00.000Z');
    expect(quietHoursEnd(new Date('2026-11-21T05:00:00Z'), q)).toBeNull();
    expect(quietHoursEnd(new Date('2026-11-20T12:00:00Z'), q)).toBeNull();
    const outbid = templateDefinition('outbid');
    expect(sendAfter(night, 'whatsapp', outbid, q, new Date('2026-11-22T10:00:00Z')).toISOString()).toBe('2026-11-21T05:00:00.000Z');
    // A lot that closes before 07:00 cannot wait.
    expect(sendAfter(night, 'whatsapp', outbid, q, new Date('2026-11-20T21:30:00Z'))).toBe(night);
    // Silent channels and sign-in codes never wait.
    expect(sendAfter(night, 'email', templateDefinition('won'), q, null)).toBe(night);
    expect(sendAfter(night, 'sms', templateDefinition('otp_code'), q, null)).toBe(night);
  });

  it('writes times in Harare time', () => {
    expect(formatLocalDateTime(new Date('2026-10-08T12:30:00Z'), 'Africa/Harare')).toBe('Thu 8 Oct, 14:30');
  });

  it('the public rulebook explains fallbacks, quiet hours, defaults and sign-in codes in plain words', () => {
    const book = renderRulebook(rules).sections.flatMap((s) => s.rules);
    const text = (k: string) => book.find((r) => r.key === k)?.text;
    expect(text('comms.quiet_hours')).toMatch(/^Between 21:00 and 07:00 \(Harare time\)/);
    expect(text('comms.preference_defaults')).toMatch(/News and offers are off unless you switch them on/);
    expect(text('identity.otp_expiry_seconds')).toBe('A sign-in code works once and expires after 10 minutes.');
    expect(text('identity.otp_rate_limits')).toBeUndefined();
  });

  it('the rulebook refuses marketing on by default and a transactional category with no channel', () => {
    const defaults = rules.get('comms.preference_defaults');
    expect(() => new RuleSnapshot('x', 'x', [{ key: 'comms.preference_defaults', scope: { type: 'global', ref: '*' }, value: { ...defaults, marketing: ['email'] }, provenance: 'proposed', source: '' }])).toThrow();
    expect(() => new RuleSnapshot('x', 'x', [{ key: 'comms.preference_defaults', scope: { type: 'global', ref: '*' }, value: { ...defaults, payments: [] }, provenance: 'proposed', source: '' }])).toThrow();
  });
});

describe('WhatsApp Cloud API adapter (unverified, A43)', () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchStub = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC123' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const wa = new WhatsAppCloudChannel(catalogue, { phoneNumberId: '1234567890', accessToken: 'token', appSecret: 'app-secret', verifyToken: 'verify-me', fetch: fetchStub });

  it('sends a template message with the parameters in placeholder order', async () => {
    const t = templateDefinition('outbid');
    expect(await wa.send(msg('outbid', t.example))).toEqual({ providerMessageId: 'wamid.ABC123' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(calls[0]!.body).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '263771234567', type: 'template',
      template: { name: 'abc_outbid_v1', language: { code: 'en' }, components: [{ type: 'body', parameters: [
        { type: 'text', text: t.example.lot }, { type: 'text', text: t.example.price }, { type: 'text', text: t.example.link },
      ] }] },
    });
  });

  it('sends the sign-in code as an authentication template and chat replies as plain text', () => {
    const otp = wa.requestBody(msg('otp_code', { code: '482913', minutes: '10' })) as { template: { components: unknown[] } };
    expect(otp.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
    ]);
    expect(wa.requestBody(msg('chat_reply', { text: 'Hello' }))).toMatchObject({ type: 'text', text: { body: 'Hello' } });
  });

  it('treats rate limits as temporary and a bad number as permanent', async () => {
    const failing = (status: number, code: number) =>
      new WhatsAppCloudChannel(catalogue, { phoneNumberId: '1', accessToken: 't', appSecret: 's', verifyToken: 'v',
        fetch: (async () => new Response(JSON.stringify({ error: { code, message: 'x' } }), { status })) as unknown as typeof fetch });
    await expect(failing(400, 130429).send(msg('outbid', templateDefinition('outbid').example))).rejects.toMatchObject({ permanent: false });
    await expect(failing(400, 131026).send(msg('outbid', templateDefinition('outbid').example))).rejects.toMatchObject({ permanent: true });
    await expect(wa.send(msg('outbid', templateDefinition('outbid').example, { phoneE164: null }))).rejects.toBeInstanceOf(ChannelError);
  });

  it('verifies X-Hub-Signature-256 and reads statuses and inbound messages', () => {
    const body = Buffer.from(JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        statuses: [{ id: 'wamid.ABC123', status: 'delivered', timestamp: '1792000000', recipient_id: '263771234567' },
                   { id: 'wamid.X', status: 'failed', timestamp: '1792000001', errors: [{ code: 131026, title: 'Message undeliverable' }] }],
        messages: [{ from: '263771234567', id: 'wamid.IN1', timestamp: '1792000002', type: 'text', text: { body: 'SELL' } },
                   { from: '263771234567', id: 'wamid.IN2', timestamp: '1792000003', type: 'image', image: { id: 'MEDIA1' } }],
      } }] }],
    }));
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    const parsed = wa.parseWebhook({ 'X-Hub-Signature-256': sig }, body)!;
    expect(parsed.statuses).toEqual([
      { providerMessageId: 'wamid.ABC123', status: 'delivered', at: new Date(1792000000_000) },
      { providerMessageId: 'wamid.X', status: 'failed', at: new Date(1792000001_000), failureReason: '131026: Message undeliverable' },
    ]);
    expect(parsed.inbound).toEqual([
      { providerMessageId: 'wamid.IN1', from: '+263771234567', kind: 'text', text: 'SELL', at: new Date(1792000002_000) },
      { providerMessageId: 'wamid.IN2', from: '+263771234567', kind: 'image', imageIds: ['MEDIA1'], at: new Date(1792000003_000) },
    ]);
    expect(wa.parseStatusWebhook({ 'x-hub-signature-256': sig }, body)?.status).toBe('delivered');
    expect(wa.parseWebhook({ 'x-hub-signature-256': 'sha256=00' }, body)).toBeNull();
    expect(wa.parseWebhook({ 'x-hub-signature-256': sig }, Buffer.concat([body, Buffer.from(' ')]))).toBeNull();
  });

  it('answers the subscription handshake only with the right verify token', () => {
    expect(wa.verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1158201444' })).toBe('1158201444');
    expect(wa.verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' })).toBeNull();
  });
});

describe('generic HTTP SMS adapter (unverified, A44)', () => {
  it('posts the configured fields and reads signed delivery reports', async () => {
    let sent: Record<string, string> | undefined;
    const sms = new HttpSmsChannel(catalogue, {
      url: 'https://sms.example/send', from: 'ABCAuction', statusSecret: 'dlr-secret', idField: 'data.id', fields: { text: 'message' },
      fetch: (async (_u: string, init: { body: string }) => {
        sent = JSON.parse(init.body);
        return new Response(JSON.stringify({ data: { id: 'sms-77' } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await sms.send(msg('payment_received', { amount: 'US$10.00', invoice: 'A-1' }))).toEqual({ providerMessageId: 'sms-77' });
    expect(sent).toEqual({ to: '+263771234567', from: 'ABCAuction', message: 'ABC Auctions: We have received US$10.00 for invoice A-1. Thank you.', reference: '6f1c2c3e-0000-4000-8000-000000000001' });
    const dlr = Buffer.from(JSON.stringify({ id: 'sms-77', status: 'DELIVRD' }));
    const sig = createHmac('sha256', 'dlr-secret').update(dlr).digest('hex');
    expect(sms.parseStatusWebhook({ 'x-signature': sig }, dlr)).toMatchObject({ providerMessageId: 'sms-77', status: 'delivered' });
    expect(sms.parseStatusWebhook({ 'x-signature': 'bad' }, dlr)).toBeNull();
  });
});

describe('fake channel', () => {
  it('renders like a real channel and can be told to fail', async () => {
    const fake = new FakeChannel('sms', catalogue).failNext('transient');
    await expect(fake.send(msg('payment_received', { amount: 'US$10.00', invoice: 'A-1' }))).rejects.toMatchObject({ permanent: false });
    await fake.send(msg('payment_received', { amount: 'US$10.00', invoice: 'A-1' }));
    expect(fake.lastTo('+263771234567')?.text).toBe('ABC Auctions: We have received US$10.00 for invoice A-1. Thank you.');
  });
});
