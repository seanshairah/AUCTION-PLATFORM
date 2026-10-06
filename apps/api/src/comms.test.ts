import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, DB_TESTS_ENABLED, type TestDatabase } from '@abc/db';
import { createApp } from './app';
import { COMMS, type CommsRuntime } from './comms';
import { buildCommsRuntime } from './comms/runtime';
import { seedDemo, type DemoSeedResult } from './demo/seed';
import { configFromEnv } from './tokens';

const WA_SECRET = 'test-whatsapp-app-secret';
const SMS_SECRET = 'test-sms-status-secret';

describe('communications wiring', () => {
  it('refuses to start in production without the sign-in secrets, and registers no fake channels there', () => {
    const fakeDb = {} as never;
    expect(() => buildCommsRuntime(fakeDb, {} as never, { APP_ENV: 'production' })).toThrow(/OTP_SECRET/);
    const prod = buildCommsRuntime(fakeDb, {} as never, { APP_ENV: 'production', OTP_SECRET: 'o'.repeat(40), LINK_SIGNAL_SECRET: 's'.repeat(40) }, () => undefined);
    expect(prod.fakes).toEqual({});
    expect(prod.channels.has('whatsapp')).toBe(false);
    expect(prod.channels.has('email')).toBe(false);
    expect(prod.channels.has('in_app')).toBe(true);
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('communications and one-time-code sign-in through the API', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let seed: DemoSeedResult;
  let comms: CommsRuntime;
  const config = { ...configFromEnv({ APP_ENV: 'test' }), demoSignIn: true };
  const server = () => app.getHttpServer();
  const codeIn = (text: string | undefined) => /code is (\d{6})/.exec(text ?? '')?.[1] ?? '';

  beforeAll(async () => {
    process.env.WHATSAPP_APP_SECRET = WA_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
    process.env.SMS_STATUS_SECRET = SMS_SECRET;
    t = await createTestDatabase();
    seed = await seedDemo(t.db, { hours: 24, env: {} });
    app = await createApp(t.db, config);
    await app.init();
    comms = app.get(COMMS);
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
    delete process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    delete process.env.SMS_STATUS_SECRET;
  });

  it('signs up by phone: code by WhatsApp, details asked for once, then the session cookie', async () => {
    const start = await request(server()).post('/auth/otp/start').send({ contact: '077 123 4999' }).expect(201);
    expect(start.body).toMatchObject({ sentTo: '+26377••••999', via: 'whatsapp_or_sms', resent: false });
    const code = codeIn(comms.fakes.whatsapp!.lastTo('+263771234999')?.text);
    expect(code).toMatch(/^\d{6}$/);

    const wrong = await request(server()).post('/auth/otp/verify').send({ challengeId: start.body.challengeId, code: code === '000000' ? '111111' : '000000' }).expect(400);
    expect(wrong.body).toMatchObject({ code: 'wrong_code', attemptsLeft: 4 });
    const needs = await request(server()).post('/auth/otp/verify').send({ challengeId: start.body.challengeId, code }).expect(400);
    expect(needs.body.code).toBe('details_required');

    const ok = await request(server()).post('/auth/otp/verify')
      .send({ challengeId: start.body.challengeId, code, displayName: 'Tatenda N.', consent: { whatsapp: true, sms: true, email: true, push: false }, device: { fingerprint: 'web-fp-0123456789', platform: 'web' } })
      .expect(201);
    expect(ok.body).toMatchObject({ name: 'Tatenda N.', created: true, verificationLevel: 'none', tier: 'guest', newDevice: true });
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    expect(cookie).toMatch(/^abc_session=[0-9a-f-]{36}\.\d+\./);
    const me = await request(server()).get('/me').set('Cookie', cookie).expect(200);
    expect(me.body).toMatchObject({ name: 'Tatenda N.' });

    // A second contact, by email, makes the account partial (email and phone verified).
    const add = await request(server()).post('/auth/otp/start').set('Cookie', cookie).send({ contact: 'tatenda@example.test', purpose: 'add_contact' }).expect(201);
    expect(add.body.via).toBe('email');
    const emailCode = codeIn(comms.emailLog!.outbox.find((e) => e.to === 'tatenda@example.test')?.text);
    const linked = await request(server()).post('/auth/otp/verify').set('Cookie', cookie).send({ challengeId: add.body.challengeId, code: emailCode }).expect(201);
    expect(linked.body).toMatchObject({ created: false, verificationLevel: 'partial', tier: 'verified' });
    await request(server()).post('/auth/otp/start').send({ contact: 'someone@example.test', purpose: 'add_contact' }).expect(401);
  });

  it('refuses bad contacts, too-early resends and reused codes in plain words', async () => {
    expect((await request(server()).post('/auth/otp/start').send({ contact: 'hello' }).expect(400)).body.code).toBe('invalid_contact');
    expect((await request(server()).post('/auth/otp/start').send({ contact: '0242 123 456' }).expect(400)).body.code).toBe('not_a_mobile');
    await request(server()).post('/auth/otp/start').send({ contact: '0771 234 998' }).expect(201);
    const again = await request(server()).post('/auth/otp/start').send({ contact: '+263771234998' }).expect(429);
    expect(again.body).toMatchObject({ code: 'resend_too_soon', retryAfterSeconds: expect.any(Number) });
    await request(server()).post('/auth/otp/verify').send({ challengeId: '00000000-0000-4000-8000-000000000000', code: '123456' }).expect(404);
    await request(server()).post('/auth/otp/verify').send({ challengeId: 'nope', code: '123456' }).expect(400);
  });

  it('demo sign-in still works alongside', async () => {
    await request(server()).post('/session/demo').send({ accountId: seed.accounts.farai }).expect(201);
  });

  it('preferences: read, change, and never switch off every channel for payments', async () => {
    const login = await request(server()).post('/session/demo').send({ accountId: seed.accounts.rudo }).expect(201);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    await request(server()).get('/me/preferences').expect(401);
    const view = await request(server()).get('/me/preferences').set('Cookie', cookie).expect(200);
    expect(view.body.categories.find((c: { category: string }) => c.category === 'marketing').channels.email).toEqual({ enabled: false, consented: true }); // demo people consent to email; marketing stays off by default
    const off = ['whatsapp', 'push', 'sms', 'email'].map((channel) => ({ category: 'payments', channel, enabled: false }));
    expect((await request(server()).put('/me/preferences').set('Cookie', cookie).send({ changes: off }).expect(400)).body.code).toBe('needs_a_channel');
    const ok = await request(server()).put('/me/preferences').set('Cookie', cookie).send({ changes: [{ category: 'outbid', channel: 'sms', enabled: false }] }).expect(200);
    expect(ok.body.categories.find((c: { category: string }) => c.category === 'outbid').channels.sms.enabled).toBe(false);
    await request(server()).put('/me/preferences').set('Cookie', cookie).send({ changes: [{ category: 'staff_tasks', channel: 'sms', enabled: false }] }).expect(400);
  });

  it('the notification feed shows what the demo bidders were told, and marks items read', async () => {
    await comms.dispatcher.run();
    const login = await request(server()).post('/session/demo').send({ accountId: seed.accounts.tendai }).expect(201);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const feed = await request(server()).get('/me/notifications').set('Cookie', cookie).expect(200);
    expect(feed.body.unread).toBeGreaterThan(0);
    expect(feed.body.items.map((i: { kind: string }) => i.kind)).toContain('registration_approved');
    const first = feed.body.items[0];
    expect(first).toMatchObject({ read: false, text: expect.stringMatching(/^ABC Auctions: /), at: expect.any(String) });
    await request(server()).post(`/me/notifications/${first.id}/read`).set('Cookie', cookie).expect(201);
    expect((await request(server()).get('/me/notifications').set('Cookie', cookie).expect(200)).body.unread).toBe(feed.body.unread - 1);
    await request(server()).post('/me/notifications/00000000-0000-4000-8000-000000000000/read').set('Cookie', cookie).expect(404);
    await request(server()).get('/me/notifications?limit=0').set('Cookie', cookie).expect(400);
  });

  it('WhatsApp webhook: handshake, signature check, delivery statuses and seller intake by chat', async () => {
    const hs = await request(server()).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': '8675309' }).expect(200);
    expect(hs.text).toBe('8675309');
    await request(server()).get('/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }).expect(403);

    const sent = comms.fakes.whatsapp!.sent[0]!;
    const payload = (value: unknown) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value }] }] });
    const post = (body: string, secret = WA_SECRET) =>
      request(server()).post('/webhooks/whatsapp').set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`).send(body);

    const statusBody = payload({ statuses: [{ id: sent.providerMessageId, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }] });
    await post(statusBody, 'not-the-secret').expect(401);
    expect((await post(statusBody).expect(200)).body).toMatchObject({ ok: true, statuses: 1 });
    const row = await t.db.query<{ status: string }>('SELECT status FROM comms.message WHERE id = $1', [sent.messageId]);
    expect(row.rows[0]!.status).toBe('delivered');

    // The demo seller consigns by chat: SELL starts the intake conversation.
    const sellBody = payload({ messages: [{ from: '263770000201', id: 'wamid.sell-1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'SELL' } }] });
    expect((await post(sellBody).expect(200)).body).toMatchObject({ inbound: 1 });
    expect(comms.fakes.whatsapp!.lastTo('+263770000201')?.text).toMatch(/^Welcome to ABC Auctions selling\./);
    expect((await post(sellBody).expect(200)).body).toMatchObject({ inbound: 0 }); // Meta retried: handled once
  });

  it('SMS delivery reports are signed and update the message', async () => {
    const bad = JSON.stringify({ id: 'x', status: 'DELIVRD' });
    await request(server()).post('/webhooks/sms-status').set('Content-Type', 'application/json').set('X-Signature', 'nope').send(bad).expect(401);
    const body = JSON.stringify({ id: 'unknown-sms-id', status: 'DELIVRD' });
    const res = await request(server()).post('/webhooks/sms-status').set('Content-Type', 'application/json')
      .set('X-Signature', createHmac('sha256', SMS_SECRET).update(body).digest('hex')).send(body).expect(200);
    expect(res.body).toEqual({ ok: true, result: 'unknown' });
  });
});
