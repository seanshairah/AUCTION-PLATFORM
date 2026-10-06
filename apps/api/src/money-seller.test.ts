import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, DB_TESTS_ENABLED, type TestDatabase } from '@abc/db';
import { createApp } from './app';
import { seedDemo, type DemoSeedResult } from './demo/seed';
import { configFromEnv } from './tokens';

describe.skipIf(!DB_TESTS_ENABLED)('wallet top-ups, invoice payment, seller portal and viewings', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let seed: DemoSeedResult;
  const http = () => request(app.getHttpServer());

  async function signIn(key: string): Promise<string> {
    const res = await http().post('/session/demo').send({ accountId: seed.accounts[key] }).expect(201);
    return String(res.headers['set-cookie']).split(';')[0]!;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    seed = await seedDemo(t.db, { hours: 24, env: {} });
    app = await createApp(t.db, { ...configFromEnv({ APP_ENV: 'test' }), demoSignIn: true, fakeGateways: true });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('a mobile-money top-up lands in the wallet only after the gateway confirms it, once', async () => {
    const cookie = await signIn('rudo');
    const before = (await http().get('/me/wallet').set('Cookie', cookie)).body.balances[0].available.minor as string;
    const start = await http().post('/me/top-ups').set('Cookie', cookie).send({ amountMinor: '50000', method: 'ecocash', phone: '+263771234567', clientKey: 'topup-rudo-1' }).expect(201);
    expect(start.body).toMatchObject({ status: 'pending', approval: 'phone_prompt', simulated: true });
    expect((await http().get(`/me/top-ups/${start.body.paymentId}`).set('Cookie', cookie)).body.status).toBe('pending');
    const again = await http().post('/me/top-ups').set('Cookie', cookie).send({ amountMinor: '50000', method: 'ecocash', clientKey: 'topup-rudo-1' }).expect(201);
    expect(again.body.paymentId).toBe(start.body.paymentId);

    await http().post(`/dev/fake-gateway/payments/${start.body.paymentId}/approve`).set('Cookie', cookie).send({}).expect(201);
    expect((await http().get(`/me/top-ups/${start.body.paymentId}`).set('Cookie', cookie)).body.status).toBe('succeeded');
    const after = (await http().get('/me/wallet').set('Cookie', cookie)).body.balances[0].available.minor as string;
    expect(BigInt(after) - BigInt(before)).toBe(50000n);
    await http().post('/webhooks/payments/paynow').set('x-signature', 'forged').send('{"reference":"x"}').expect(201);
  });

  it('the buyer pays the closed-auction invoice in one tap and gets a gate pass; the deposit counts', async () => {
    const cookie = await signIn('tendai');
    const inv = await t.db.query<{ id: string; total_minor: bigint }>(`SELECT id, total_minor FROM settlement.invoice WHERE buyer_account_id = $1`, [seed.accounts.tendai]);
    expect(inv.rows).toHaveLength(1);
    expect(inv.rows[0]!.total_minor).toBe(327_750n); // hammer US$2,850 (Rudo's US$2,800 maximum plus one US$50 increment) + 15 % levy
    const paid = await http().post(`/me/invoices/${inv.rows[0]!.id}/pay`).set('Cookie', cookie).send({ clientKey: 'pay-tendai-1' }).expect(201);
    expect(paid.body).toMatchObject({ paid: true, alreadyPaid: false });
    expect(paid.body.gatePassToken.length).toBeGreaterThan(20);
    const repeat = await http().post(`/me/invoices/${inv.rows[0]!.id}/pay`).set('Cookie', cookie).send({ clientKey: 'pay-tendai-1' }).expect(201);
    expect(repeat.body).toMatchObject({ paid: true, alreadyPaid: true });
    const other = await signIn('rudo');
    await http().post(`/me/invoices/${inv.rows[0]!.id}/pay`).set('Cookie', other).send({}).expect(404);
  });

  it('a seller consigns, reads the note, signs it by its hash, and a stale hash is refused', async () => {
    const cookie = await signIn('seller');
    const overview = await http().get('/seller/overview').set('Cookie', cookie).expect(200);
    expect(overview.body.lots.length).toBeGreaterThanOrEqual(10);
    expect(overview.body.lots[0]).toHaveProperty('reserveMet');

    const { body: { id } } = await http().post('/seller/consignments').set('Cookie', cookie).send({ branch: 'HRE' }).expect(201);
    await http().post(`/seller/consignments/${id}/lots`).set('Cookie', cookie).send({
      title: 'Honda EU22i generator', description: 'Inverter generator, 2.2 kW, serviced in August, runs smoothly.', category: 'general', itemState: 'used', condition: 'working',
      startingBidMinor: '30000', reserveMinor: '45000',
    }).expect(201);
    const note = await http().get(`/seller/consignments/${id}/note`).set('Cookie', cookie).expect(200);
    expect(note.body.text).toContain('Honda EU22i generator');
    await http().post(`/seller/consignments/${id}/sign`).set('Cookie', cookie).send({ sha256: 'f'.repeat(64) }).expect(201).expect((r) => expect(r.body).toMatchObject({ signed: false, reason: 'note_changed' }));
    await http().post(`/seller/consignments/${id}/sign`).set('Cookie', cookie).send({ sha256: note.body.sha256 }).expect(201).expect((r) => expect(r.body.signed).toBe(true));
    await http().post(`/seller/consignments/${id}/lots`).set('Cookie', cookie).send({
      title: 'Another lot', description: 'Added after signing, which must be refused.', category: 'general', itemState: 'used', condition: 'working', startingBidMinor: '1000',
    }).expect(400);

    const proceeds = await http().get('/seller/proceeds?category=general&currency=USD&hammerMinor=100000').set('Cookie', cookie).expect(200);
    expect(proceeds.body.net.text).toBe('US$900.00'); // demo commission 10 % (A41)
    const bidder = await signIn('farai');
    await http().get(`/seller/consignments/${id}`).set('Cookie', bidder).expect(404);
  });

  it('viewing slots are listed per lot and booked with capacity', async () => {
    const cookie = await signIn('farai');
    const lots = await http().get('/lots?q=Hilux').expect(200);
    const slots = await http().get(`/lots/${lots.body.lots[0].ref}/viewings`).set('Cookie', cookie).expect(200);
    expect(slots.body).toHaveLength(8);
    const booked = await http().post(`/viewings/${slots.body[0].id}/book`).set('Cookie', cookie).expect(201);
    expect(booked.body).toMatchObject({ booked: true });
    const twice = await http().post(`/viewings/${slots.body[0].id}/book`).set('Cookie', cookie).expect(201);
    expect(twice.body).toMatchObject({ booked: false, reason: 'already_booked' });
    const after = await http().get(`/lots/${lots.body.lots[0].ref}/viewings`).set('Cookie', cookie).expect(200);
    expect(after.body[0]).toMatchObject({ remaining: slots.body[0].remaining - 1, bookingId: booked.body.bookingId });
  });
});
