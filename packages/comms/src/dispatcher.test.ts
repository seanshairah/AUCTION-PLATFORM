import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAccount, createAuction, createTestDatabase, DB_TESTS_ENABLED, loadPublishedRuleSetForTests, readRuleSetDocument, RulebookStore, SYSTEM, type TestDatabase } from '@abc/db';
import { IdentityService } from '@abc/identity';
import {
  ChannelRegistry,
  Dispatcher,
  EmailChannel,
  FakeChannel,
  InAppChannel,
  LogEmailTransport,
  NotificationFeed,
  PreferenceService,
  TemplateCatalogue,
} from './index';

/**
 * The dispatcher against PostgreSQL with fake channels and fixed times.
 * T0 is 12:00 in Harare; quiet hours (21:00–07:00) are tested explicitly.
 */

const OTP_SECRET = 'test-otp-secret-0123456789abcdef';
const T0 = new Date('2026-11-20T10:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const DAY = 86_400;

describe.skipIf(!DB_TESTS_ENABLED)('the dispatcher against PostgreSQL', () => {
  let t: TestDatabase;
  let rulebook: RulebookStore;
  let templates: TemplateCatalogue;
  let wa: FakeChannel;
  let push: FakeChannel;
  let sms: FakeChannel;
  let mail: LogEmailTransport;
  let dispatcher: Dispatcher;
  let auctionLotId: string;
  let lotEnd: Date;

  async function person(name: string, consent: Partial<Record<'whatsapp' | 'sms' | 'email' | 'push', boolean>> = { whatsapp: true, sms: true, email: true, push: true }): Promise<string> {
    const id = await createAccount(t.db, { name });
    await t.db.tx(SYSTEM, async (c) => {
      for (const [channel, granted] of Object.entries(consent)) {
        await c.query(`INSERT INTO identity.contact_consent (account_id, channel, granted, source) VALUES ($1, $2, $3, 'signup_form')`, [id, channel, granted]);
      }
    });
    return id;
  }

  async function phoneOf(id: string): Promise<string> {
    return (await t.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM identity.account WHERE id = $1', [id])).rows[0]!.phone_e164;
  }

  async function emit(topic: string, aggregateType: string, aggregateId: string, payload: unknown): Promise<string> {
    const r = await t.db.tx(SYSTEM, (c) =>
      c.query<{ id: string }>('INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4::jsonb) RETURNING id::text AS id', [topic, aggregateType, aggregateId, JSON.stringify(payload)]),
    );
    return r.rows[0]!.id;
  }

  async function messagesFor(accountId: string) {
    const r = await t.db.query<{ id: string; channel: string; status: string; template_key: string; fallback_of: string | null; failure_reason: string | null; next_attempt_at: Date; attempts: number }>(
      `SELECT id, channel, status, template_key, fallback_of, failure_reason, next_attempt_at, attempts FROM comms.message WHERE recipient_account_id = $1 ORDER BY queued_at, channel`,
      [accountId],
    );
    return r.rows;
  }

  const outbid = (accountId: string) => emit('bid.outbid', 'auction_lot', auctionLotId, { type: 'outbid', accountId, priceMinor: '24500' });

  beforeAll(async () => {
    t = await createTestDatabase();
    await loadPublishedRuleSetForTests(t.db, readRuleSetDocument(), { activateTaxRates: true });
    rulebook = new RulebookStore(t.db);
    templates = await TemplateCatalogue.load(t.db);
    const staff = await createAccount(t.db, { name: 'Staff' });
    const seller = await createAccount(t.db, { name: 'Seller' });
    lotEnd = at(2 * DAY);
    const a = await createAuction(t.db, { createdBy: staff, lots: [{ sellerId: seller, startingBidMinor: 10_000n, endsAt: lotEnd, title: 'Dell Latitude 7490 laptop' }] });
    auctionLotId = a.lots[0]!.auctionLotId;
  });
  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(() => {
    wa = new FakeChannel('whatsapp', templates);
    push = new FakeChannel('push', templates);
    sms = new FakeChannel('sms', templates);
    mail = new LogEmailTransport(() => undefined);
    const registry = new ChannelRegistry()
      .register('whatsapp-fake', wa)
      .register('push-fake', push)
      .register('sms-fake', sms)
      .register('email-log', new EmailChannel(templates, mail, 'ABC Auctions <no-reply@abcauctions.example>'))
      .register('in_app', new InAppChannel(templates));
    dispatcher = new Dispatcher(t.db, rulebook, registry, templates, { webBaseUrl: 'https://abcauctions.example', otpSecret: OTP_SECRET });
  });

  it('an outbid alert goes by WhatsApp with an in-app copy, and running again sends nothing new', async () => {
    const farai = await person('Farai');
    const outboxId = await outbid(farai);
    const report = await dispatcher.run(at(0));
    expect(report).toMatchObject({ events: 1, queued: 2, sent: 2, failed: 0 });
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0]!.to).toBe(await phoneOf(farai));
    expect(wa.sent[0]!.text).toBe('ABC Auctions: You were outbid on Dell Latitude 7490 laptop. It is now US$245.00. Bid again: https://abcauctions.example/lots/' + wa.sent[0]!.text.split('/lots/')[1]);
    expect(mail.outbox).toHaveLength(0); // alerts get no email copy
    expect((await messagesFor(farai)).map((m) => [m.channel, m.status, m.template_key])).toEqual([
      ['in_app', 'delivered', 'outbid'],
      ['whatsapp', 'sent', 'outbid'],
    ]);
    const ob = await t.db.query<{ dispatched_at: Date | null; attempts: number }>('SELECT dispatched_at, attempts FROM core.outbox WHERE id = $1', [outboxId]);
    expect(ob.rows[0]).toEqual({ dispatched_at: at(0), attempts: 1 });

    // The same event again (a retried outbox write) is still one message per channel (R4).
    await t.db.tx(SYSTEM, (c) => c.query('UPDATE core.outbox SET dispatched_at = NULL WHERE id = $1', [outboxId]));
    expect(await dispatcher.run(at(1))).toMatchObject({ events: 1, queued: 0, sent: 0 });
    expect(wa.sent).toHaveLength(1);
  });

  it('falls back at once on a permanent failure, linked by fallback_of', async () => {
    const rudo = await person('Rudo');
    wa.failNext('permanent');
    await outbid(rudo);
    const report = await dispatcher.run(at(0));
    expect(report).toMatchObject({ failed: 1, fallbacks: 1 });
    const ms = await messagesFor(rudo);
    const w = ms.find((m) => m.channel === 'whatsapp')!;
    expect(w).toMatchObject({ status: 'failed', failure_reason: 'fake whatsapp permanent failure' });
    expect(ms.find((m) => m.channel === 'push')).toMatchObject({ status: 'sent', fallback_of: w.id });
    expect(push.sent).toHaveLength(1);
  });

  it('falls back after the rulebook timeout when not delivered; a delivery report stops it', async () => {
    const a = await person('Tendai');
    const b = await person('Chipo');
    await outbid(a);
    await outbid(b);
    await dispatcher.run(at(0));
    const waOf = async (id: string) => (await messagesFor(id)).find((m) => m.channel === 'whatsapp')!;
    // Chipo's WhatsApp is delivered and read; Tendai's is never confirmed.
    const chipoMsg = await waOf(b);
    const sentRow = wa.sent.find((s) => s.messageId === chipoMsg.id)!;
    expect(await dispatcher.recordStatus('whatsapp-fake', { providerMessageId: sentRow.providerMessageId, status: 'delivered', at: at(10) }, at(10))).toBe('updated');
    expect(await dispatcher.recordStatus('whatsapp-fake', { providerMessageId: sentRow.providerMessageId, status: 'sent', at: at(11) }, at(11))).toBe('ignored');
    expect(await dispatcher.recordStatus('whatsapp-fake', { providerMessageId: sentRow.providerMessageId, status: 'read', at: at(12) }, at(12))).toBe('updated');
    expect(await dispatcher.recordStatus('whatsapp-fake', { providerMessageId: 'nope', status: 'read', at: at(12) }, at(12))).toBe('unknown');

    await dispatcher.run(at(119));
    expect((await messagesFor(a)).map((m) => m.channel)).toEqual(['in_app', 'whatsapp']);
    await dispatcher.run(at(121)); // outbid: whatsapp → push after 120 s
    expect((await messagesFor(a)).find((m) => m.channel === 'push')).toMatchObject({ status: 'sent', fallback_of: (await waOf(a)).id });
    expect((await messagesFor(b)).map((m) => [m.channel, m.status])).toEqual([['in_app', 'delivered'], ['whatsapp', 'read']]);
    // Push not delivered either: SMS next, then nothing more.
    await dispatcher.run(at(242));
    expect((await messagesFor(a)).map((m) => m.channel).sort()).toEqual(['in_app', 'push', 'sms', 'whatsapp']);
    await dispatcher.run(at(1000));
    expect(await messagesFor(a)).toHaveLength(4);
  });

  it('a failed delivery report moves to the next channel', async () => {
    const p = await person('Nyasha');
    await outbid(p);
    await dispatcher.run(at(0));
    const w = (await messagesFor(p)).find((m) => m.channel === 'whatsapp')!;
    const provider = wa.sent.find((s) => s.messageId === w.id)!.providerMessageId;
    const raw = Buffer.from(JSON.stringify({ id: provider, status: 'failed', reason: '131026: undeliverable' }));
    const status = wa.parseStatusWebhook({}, raw)!;
    expect(await dispatcher.recordStatus('whatsapp-fake', status, at(5))).toBe('updated');
    await dispatcher.run(at(5));
    const ms = await messagesFor(p);
    expect(ms.find((m) => m.channel === 'whatsapp')).toMatchObject({ status: 'failed', failure_reason: '131026: undeliverable' });
    expect(ms.find((m) => m.channel === 'push')).toMatchObject({ status: 'sent', fallback_of: w.id });
  });

  it('temporary failures are retried with backoff, then the next channel', async () => {
    const p = await person('Kuda');
    wa.failNext('transient', 'transient', 'transient');
    await outbid(p);
    const whatsapp = async () => (await messagesFor(p)).find((m) => m.channel === 'whatsapp');
    await dispatcher.run(at(0));
    expect(await whatsapp()).toMatchObject({ status: 'queued', attempts: 1, next_attempt_at: at(30) });
    await dispatcher.run(at(29));
    expect(await whatsapp()).toMatchObject({ status: 'queued', attempts: 1 });
    await dispatcher.run(at(30));
    expect(await whatsapp()).toMatchObject({ status: 'queued', attempts: 2, next_attempt_at: at(330) });
    await dispatcher.run(at(330));
    expect(await whatsapp()).toMatchObject({ status: 'failed', attempts: 3 });
    expect((await messagesFor(p)).find((m) => m.channel === 'push')?.status).toBe('sent');
  });

  it('respects consent and preferences; a person nobody can reach still has a record of why', async () => {
    const noWa = await person('No WhatsApp', { whatsapp: false, sms: true, push: true, email: true });
    const prefs = new PreferenceService(t.db, rulebook);
    const offPush = await person('Push off');
    await prefs.update({ type: 'account', id: offPush, name: 'Push off' }, offPush, [{ category: 'outbid', channel: 'whatsapp', enabled: false }, { category: 'outbid', channel: 'push', enabled: false }]);
    const nobody = await createAccount(t.db, { name: 'No consent' }); // no consent rows at all
    await outbid(noWa);
    await outbid(offPush);
    await outbid(nobody);
    await dispatcher.run(at(0));
    expect((await messagesFor(noWa)).find((m) => m.channel !== 'in_app')?.channel).toBe('push');
    expect((await messagesFor(offPush)).find((m) => m.channel !== 'in_app')?.channel).toBe('sms');
    // No consent anywhere: only the in-app feed.
    expect((await messagesFor(nobody)).map((m) => m.channel)).toEqual(['in_app']);
  });

  it('quiet hours hold alerts until 07:00 unless the lot closes first; sign-in codes go straight away', async () => {
    const night = new Date('2026-11-20T20:30:00Z'); // 22:30 in Harare
    const p = await person('Night owl');
    await outbid(p);
    await dispatcher.run(night);
    const held = (await messagesFor(p)).find((m) => m.channel === 'whatsapp')!;
    expect(held).toMatchObject({ status: 'queued', next_attempt_at: new Date('2026-11-21T05:00:00Z') });
    await dispatcher.run(new Date('2026-11-21T05:00:00Z'));
    expect((await messagesFor(p)).find((m) => m.channel === 'whatsapp')?.status).toBe('sent');

    // A lot closing at 23:00 cannot wait for the morning.
    const staff = await createAccount(t.db, { name: 'Staff 2' });
    const seller = await createAccount(t.db, { name: 'Seller 2' });
    const soon = await createAuction(t.db, { createdBy: staff, lots: [{ sellerId: seller, startingBidMinor: 1_000n, endsAt: new Date('2026-11-20T21:00:00Z'), title: 'Office chair' }] });
    const q = await person('Late bidder');
    await emit('bid.outbid', 'auction_lot', soon.lots[0]!.auctionLotId, { type: 'outbid', accountId: q, priceMinor: '1500' });
    await dispatcher.run(night);
    expect((await messagesFor(q)).find((m) => m.channel === 'whatsapp')?.status).toBe('sent');

    // A sign-in code at night goes at once.
    const identity = new IdentityService(t.db, rulebook, { otpSecret: OTP_SECRET, signalSecret: 'signal-secret-0123456789abcdef01' });
    const start = await identity.startOtp({ contact: '+263771999001' }, night);
    if (!start.ok) throw new Error('otp start failed');
    await dispatcher.run(night);
    expect(wa.lastTo('+263771999001')?.text).toMatch(/^ABC Auctions: Your sign-in code is \d{6}\. It expires in 10 minutes\./);
  });

  it('a message no longer useful is suppressed, not sent', async () => {
    const p = await person('Too late');
    await outbid(p);
    await dispatcher.run(new Date(lotEnd.getTime() + 1000));
    expect((await messagesFor(p)).find((m) => m.channel === 'whatsapp')).toMatchObject({ status: 'suppressed', failure_reason: 'expired' });
    expect(wa.sent).toHaveLength(0);
  });

  it('an event that cannot be planned is retried a bounded number of times, then left for staff', async () => {
    const id = await emit('invoice.issued', 'invoice', '00000000-0000-0000-0000-000000000000', {});
    for (let i = 0; i < 7; i++) await dispatcher.run(at(i));
    const r = await t.db.query<{ dispatched_at: Date | null; attempts: number }>('SELECT dispatched_at, attempts FROM core.outbox WHERE id = $1', [id]);
    expect(r.rows[0]).toEqual({ dispatched_at: null, attempts: 5 });
  });

  it('topics nobody needs to hear about are left for their own consumers', async () => {
    const id = await emit('bid.accepted', 'auction_lot', auctionLotId, { accountId: 'x', seq: '1' });
    await dispatcher.run(at(0));
    expect((await t.db.query('SELECT dispatched_at FROM core.outbox WHERE id = $1', [id])).rows[0]).toEqual({ dispatched_at: null });
  });

  it('the in-app feed lists rendered messages newest first and marks them read', async () => {
    const p = await person('Feed reader');
    await outbid(p);
    await dispatcher.run(at(0));
    await emit('registration.decided', 'registration', '11111111-1111-4111-8111-111111111111', { accountId: p, auctionId: '00000000-0000-0000-0000-000000000000', status: 'approved' });
    await dispatcher.run(at(60));
    const feed = new NotificationFeed(t.db, templates);
    const list = await feed.list(p);
    expect(list.unread).toBe(2);
    expect(list.items.map((i) => [i.kind, i.title])).toEqual([
      ['registration_approved', 'You are registered for the auction'],
      ['outbid', 'You have been outbid on Dell Latitude 7490 laptop'],
    ]);
    const actor = { type: 'account' as const, id: p, name: 'Feed reader' };
    expect(await feed.markRead(actor, p, list.items[1]!.id, at(70))).toBe(true);
    expect(await feed.markRead(actor, p, list.items[1]!.id, at(71))).toBe(true);
    const other = await person('Someone else');
    expect(await feed.markRead({ type: 'account', id: other, name: 'x' }, other, list.items[0]!.id)).toBe(false);
    expect((await feed.list(p)).unread).toBe(1);
  });

  it('preferences: defaults from the rulebook, marketing off, transactional keeps a channel', async () => {
    const p = await person('Prefs');
    const prefs = new PreferenceService(t.db, rulebook);
    const view = await prefs.get(p);
    const cat = (k: string) => view.categories.find((c) => c.category === k)!;
    expect(cat('marketing').channels).toMatchObject({ whatsapp: { enabled: false }, sms: { enabled: false }, email: { enabled: false }, push: { enabled: false } });
    expect(cat('ending_soon').channels.whatsapp).toEqual({ enabled: true, consented: true });
    expect(cat('payments').transactional).toBe(true);
    const actor = { type: 'account' as const, id: p, name: 'Prefs' };
    const offAll = (['whatsapp', 'push', 'sms', 'email'] as const).map((channel) => ({ category: 'payments' as const, channel, enabled: false }));
    expect(await prefs.update(actor, p, offAll)).toEqual({ ok: false, reason: 'needs_a_channel', category: 'payments' });
    expect(await prefs.update(actor, p, offAll.slice(0, 3))).toMatchObject({ ok: true });
    expect(await prefs.update(actor, p, [{ category: 'marketing', channel: 'email', enabled: true }])).toMatchObject({ ok: true });
    // The database refuses it too, whatever the application does.
    await expect(t.db.tx(actor, (c) => c.query(`INSERT INTO comms.preference (account_id, category, channel, enabled) VALUES ($1, 'payments', 'email', false)`, [p]))).rejects.toThrow(/need at least one channel/);
    const audit = await t.db.query<{ data: { category: string; channel: string } }>(`SELECT data FROM audit.event WHERE entity_type = 'comms.preference' AND entity_id = $1 ORDER BY id`, [p]);
    expect(audit.rows.map((r) => `${r.data.category}/${r.data.channel}`)).toEqual(['payments/whatsapp', 'payments/push', 'payments/sms', 'marketing/email']);
  });

  it('two dispatchers at once never send a message twice', async () => {
    const people = await Promise.all(Array.from({ length: 12 }, (_, i) => person(`Crowd ${i}`)));
    for (const p of people) await outbid(p);
    const second = new Dispatcher(t.db, rulebook, new ChannelRegistry().register('whatsapp-fake', wa).register('in_app', new InAppChannel(templates)), templates, { webBaseUrl: 'https://abcauctions.example', otpSecret: OTP_SECRET, batchSize: 3 });
    const first = new Dispatcher(t.db, rulebook, new ChannelRegistry().register('whatsapp-fake', wa).register('in_app', new InAppChannel(templates)), templates, { webBaseUrl: 'https://abcauctions.example', otpSecret: OTP_SECRET, batchSize: 3 });
    for (let i = 0; i < 6; i++) await Promise.all([first.run(at(i)), second.run(at(i)), first.run(at(i))]);
    const ids = wa.sent.map((s) => s.messageId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(12);
    const rows = await t.db.query<{ n: bigint }>(`SELECT count(*) AS n FROM comms.message WHERE recipient_account_id = ANY($1::uuid[]) AND channel = 'whatsapp' AND status = 'sent'`, [people]);
    expect(rows.rows[0]!.n).toBe(12n);
  });
});
