import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, DB_TESTS_ENABLED, loadPublishedRuleSetForTests, readRuleSetDocument, RulebookStore, type TestDatabase } from '@abc/db';
import { LogisticsService } from '@abc/logistics';
import { addPayoutDestination, createPaidInvoices, type PaidPurchase } from '@abc/logistics/testing';
import type { RuleRecord } from '@abc/rules';
import { SettlementService } from '@abc/settlement';
import { createApp } from './app';
import { seedDemo, type DemoSeedResult } from './demo/seed';
import { gatePassSecretFromEnv } from './logistics/tokens';
import { configFromEnv } from './tokens';

const DOC = readRuleSetDocument();
const g = (key: string, value: unknown): RuleRecord => ({ key, scope: { type: 'global', ref: '*' }, value, provenance: 'assumption', source: 'TEST ONLY' });
const OVERRIDES = [
  g('commission.schedule', { basis: 'flat_band', bands: { USD: [{ from: 0, rateBp: 1000 }], ZWG: null }, minimumPerLot: { USD: 0, ZWG: null } }),
  g('delivery.rate_card', { USD: { Harare: { small: 500, medium: 1_500, large: 4_000 } }, ZWG: {} }),
];

describe.skipIf(!DB_TESTS_ENABLED)('logistics API against PostgreSQL', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let seed: DemoSeedResult;
  let farai: PaidPurchase;
  let rudo: PaidPurchase;
  const config = { ...configFromEnv({ APP_ENV: 'test' }), demoSignIn: true };
  const http = () => request(app.getHttpServer());

  async function signIn(key: string): Promise<string> {
    const res = await http().post('/session/demo').send({ accountId: seed.accounts[key] }).expect(201);
    return String(res.headers['set-cookie']).split(';')[0]!;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true, overrides: OVERRIDES });
    seed = await seedDemo(t.db, { hours: 24, env: {} });
    await addPayoutDestination(t.db, seed.accounts.seller!);
    const paid = await createPaidInvoices(t.db, {
      staffId: seed.accounts.staff!, sellerId: seed.accounts.seller!, gatePassSecret: gatePassSecretFromEnv({}),
      purchases: [
        { buyerId: seed.accounts.farai!, lots: [{ title: 'Office chair', category: 'furniture', startingBidMinor: 8_000n }] },
        { buyerId: seed.accounts.rudo!, lots: [{ title: 'Laptop', startingBidMinor: 26_000n }, { title: 'Docking station', startingBidMinor: 4_000n }] },
      ],
    });
    farai = paid[0]!;
    rudo = paid[1]!;
    const rulebook = new RulebookStore(t.db);
    await new LogisticsService(t.db, rulebook, new SettlementService(t.db, rulebook, { gatePassSecret: gatePassSecretFromEnv({}) })).ensureSlots();
    app = await createApp(t.db, config);
    await app.listen(0, '127.0.0.1'); // one listening server, so requests can be built while another is in flight
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('my purchases needs a session, and shows the invoice, collection, gate pass and storage clock', async () => {
    await http().get('/me/purchases').expect(401);
    const cookie = await signIn('farai');
    const res = await http().get('/me/purchases').set('Cookie', cookie).expect(200);
    const p = res.body.find((x: { invoiceId: string }) => x.invoiceId === farai.invoiceId);
    expect(p).toMatchObject({ status: 'paid', total: { text: 'US$104.40' }, collection: { status: 'ready', gatePass: 'valid', branch: 'HRE', method: 'pickup' } });
    expect(p.lots[0].lines.map((l: { type: string; amount: { text: string } }) => [l.type, l.amount.text])).toEqual([['hammer', 'US$80.00'], ['purchasers_levy', 'US$12.00'], ['vat', 'US$12.40']]);
    expect(p.collection.storage).toMatchObject({ enabled: false, accrued: { text: 'US$0.00' }, days: 0 });
    expect(Date.parse(p.collection.storage.collectBy) - Date.parse(p.collection.storage.clockFrom)).toBe(48 * 3_600_000);
  });

  it('collection slots from branch hours; book, rebook, someone else’s collection is not found', async () => {
    const slots = await http().get('/branches/hre/collection-slots').expect(200);
    expect(slots.body.branch).toBe('HRE');
    expect(slots.body.slots[0]).toMatchObject({ capacity: 6, available: 6 });
    await http().get('/branches/XXX/collection-slots').expect(404);
    const cookie = await signIn('farai');
    const first = await http().post(`/collections/${farai.collectionId}/slot`).set('Cookie', cookie).send({ slotId: slots.body.slots[0].id, clientKey: 'api-slot-1' }).expect(201);
    expect(first.body).toMatchObject({ booked: true, rebooked: false });
    const again = await http().post(`/collections/${farai.collectionId}/slot`).set('Cookie', cookie).send({ slotId: slots.body.slots[0].id, clientKey: 'api-slot-1' }).expect(201);
    expect(again.body).toMatchObject({ booked: true, repeated: true, bookingId: first.body.bookingId });
    const moved = await http().post(`/collections/${farai.collectionId}/slot`).set('Cookie', cookie).send({ slotId: slots.body.slots[1].id }).expect(201);
    expect(moved.body).toMatchObject({ booked: true, rebooked: true });
    await http().post(`/collections/${farai.collectionId}/slot`).set('Cookie', cookie).send({ slotId: 'nope' }).expect(400);
    await http().post(`/collections/${farai.collectionId}/slot`).set('Cookie', await signIn('rudo')).send({ slotId: slots.body.slots[0].id }).expect(404);
    const mine = await http().get('/me/purchases').set('Cookie', cookie).expect(200);
    expect(mine.body.find((x: { invoiceId: string }) => x.invoiceId === farai.invoiceId).collection).toMatchObject({ status: 'scheduled', slot: { id: slots.body.slots[1].id } });
  });

  it('delivery: the quote is quoteLot’s, the booking re-checks it and charges the wallet once', async () => {
    const cookie = await signIn('rudo');
    const q = await http().post(`/collections/${rudo.collectionId}/delivery-quote`).set('Cookie', cookie).send({ town: 'Harare', sizeClass: 'medium' }).expect(201);
    expect(q.body).toMatchObject({ ok: true, quote: { total: { text: 'US$15.00' }, lines: [{ type: 'delivery', amount: { minor: '1500' } }] } });
    const none = await http().post(`/collections/${rudo.collectionId}/delivery-quote`).set('Cookie', cookie).send({ town: 'Gweru', sizeClass: 'medium' }).expect(201);
    expect(none.body).toMatchObject({ ok: false, reason: 'delivery_unavailable' });

    const body = { town: 'Harare', sizeClass: 'medium', address: { line1: '5 Enterprise Rd', suburb: 'Highlands', phone: '+263772345678' }, quotedTotalMinor: '1000', clientKey: 'api-delivery-1' };
    const stale = await http().post(`/collections/${rudo.collectionId}/delivery`).set('Cookie', cookie).send(body).expect(201);
    expect(stale.body).toMatchObject({ booked: false, reason: 'price_changed', quote: { total: { minor: '1500' } } });
    const booked = await http().post(`/collections/${rudo.collectionId}/delivery`).set('Cookie', cookie).send({ ...body, quotedTotalMinor: '1500' }).expect(201);
    expect(booked.body).toMatchObject({ booked: true, charge: { text: 'US$15.00' }, partner: { name: 'Swift Parcels Harare (demo)' }, repeated: false });
    const repeat = await http().post(`/collections/${rudo.collectionId}/delivery`).set('Cookie', cookie).send({ ...body, quotedTotalMinor: '1500' }).expect(201);
    expect(repeat.body).toMatchObject({ booked: true, repeated: true, deliveryId: booked.body.deliveryId });
    await http().post(`/collections/${rudo.collectionId}/delivery`).set('Cookie', cookie).send({ ...body, address: { line1: 'x' } }).expect(400);
  });

  it('staff endpoints need a staff role', async () => {
    await http().post('/staff/gate/release').send({ token: farai.gatePassToken }).expect(401);
    await http().post('/staff/gate/release').set('Cookie', await signIn('farai')).send({ token: farai.gatePassToken }).expect(403);
  });

  it('staff release at the gate with the QR pass, hand the delivery to the courier and record proof', async () => {
    const staff = await signIn('staff');
    const released = await http().post('/staff/gate/release').set('Cookie', staff).send({ token: farai.gatePassToken }).expect(201);
    expect(released.body).toMatchObject({ released: true, payouts: [expect.any(String)] });
    const again = await http().post('/staff/gate/release').set('Cookie', staff).send({ token: farai.gatePassToken }).expect(201);
    expect(again.body).toMatchObject({ released: false, reason: 'not_ready', message: expect.stringContaining('already been released') });

    const rudoView = (await http().get('/me/purchases').set('Cookie', await signIn('rudo')).expect(200)).body.find((x: { invoiceId: string }) => x.invoiceId === rudo.invoiceId);
    const deliveryId = rudoView.collection.delivery.id;
    expect(rudoView.collection).toMatchObject({ method: 'delivery', status: 'scheduled', delivery: { status: 'booked', charge: { text: 'US$15.00' } } });
    expect((await http().post(`/staff/deliveries/${deliveryId}/hand-over`).set('Cookie', staff).expect(201)).body).toMatchObject({ released: true });
    expect((await http().post(`/staff/deliveries/${deliveryId}/status`).set('Cookie', staff).send({ status: 'delivered' }).expect(201)).body).toMatchObject({ updated: false, reason: 'proof_required' });
    expect((await http().post(`/staff/deliveries/${deliveryId}/status`).set('Cookie', staff).send({ status: 'delivered', proofObjectKey: 'proof/rudo-signed.jpg' }).expect(201)).body).toEqual({ updated: true, status: 'delivered' });
    await http().post('/staff/deliveries/00000000-0000-0000-0000-000000000000/status').set('Cookie', staff).send({ status: 'in_transit' }).expect(404);

    const after = (await http().get('/me/purchases').set('Cookie', await signIn('rudo')).expect(200)).body.find((x: { invoiceId: string }) => x.invoiceId === rudo.invoiceId);
    expect(after.collection).toMatchObject({ status: 'delivered', gatePass: 'used', delivery: { status: 'delivered' } });
  });
});
