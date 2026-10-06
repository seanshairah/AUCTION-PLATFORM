import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, DB_TESTS_ENABLED, loadPublishedRuleSetForTests, readRuleSetDocument, type TestDatabase } from '@abc/db';
import { addPayoutDestination, createPaidInvoices, type PaidPurchase } from '@abc/logistics/testing';
import type { RuleRecord } from '@abc/rules';
import { createApp } from './app';
import { seedDemo, type DemoSeedResult } from './demo/seed';
import { gatePassSecretFromEnv } from './logistics/tokens';
import { configFromEnv } from './tokens';

const DOC = readRuleSetDocument();
const COMMISSION: RuleRecord = {
  key: 'commission.schedule', scope: { type: 'global', ref: '*' }, provenance: 'assumption', source: 'TEST ONLY',
  value: { basis: 'flat_band', bands: { USD: [{ from: 0, rateBp: 1000 }], ZWG: null }, minimumPerLot: { USD: 0, ZWG: null } },
};

describe.skipIf(!DB_TESTS_ENABLED)('support and disputes API against PostgreSQL', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let seed: DemoSeedResult;
  let small: PaidPurchase;
  let big: PaidPurchase;
  const config = { ...configFromEnv({ APP_ENV: 'test' }), demoSignIn: true };
  const http = () => request(app.getHttpServer());
  const cookies: Record<string, string> = {};

  async function signIn(key: string): Promise<string> {
    if (cookies[key]) return cookies[key];
    const res = await http().post('/session/demo').send({ accountId: seed.accounts[key] }).expect(201);
    return (cookies[key] = String(res.headers['set-cookie']).split(';')[0]!);
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true, overrides: [COMMISSION] });
    seed = await seedDemo(t.db, { hours: 24, env: {} });
    await addPayoutDestination(t.db, seed.accounts.seller!);
    [small, big] = await createPaidInvoices(t.db, {
      staffId: seed.accounts.staff!, sellerId: seed.accounts.seller!, gatePassSecret: gatePassSecretFromEnv({}),
      purchases: [
        { buyerId: seed.accounts.tendai!, lots: [{ title: 'Microwave', category: 'catering', startingBidMinor: 6_000n }] },
        { buyerId: seed.accounts.rudo!, lots: [{ title: 'Server rack', startingBidMinor: 80_000n }] },
      ],
    }) as [PaidPurchase, PaidPurchase];
    app = await createApp(t.db, config);
    await app.listen(0, '127.0.0.1');
    const staff = await signIn('staff');
    for (const p of [small, big]) await http().post('/staff/gate/release').set('Cookie', staff).send({ token: p.gatePassToken }).expect(201);
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('a buyer raises a claim with evidence and sees it; validation and ownership are checked', async () => {
    const tendai = await signIn('tendai');
    await http().post('/disputes').send({}).expect(401);
    await http().post('/disputes').set('Cookie', tendai).send({ lotId: small.lotIds[0], category: 'broken' }).expect(400);
    const body = { lotId: small.lotIds[0], category: 'not_as_described', description: 'Turntable does not rotate.', claimedCondition: 'partly_working', evidence: [{ kind: 'video', objectKey: 'evidence/microwave.mp4' }], clientKey: 'api-claim-1' };
    const raised = await http().post('/disputes').set('Cookie', tendai).send(body).expect(201);
    expect(raised.body).toMatchObject({ raised: true, payoutsHeld: 1 });
    await http().post('/disputes').set('Cookie', await signIn('farai')).send({ ...body, clientKey: 'api-claim-x' }).expect(404);
    const mine = await http().get('/me/disputes').set('Cookie', tendai).expect(200);
    expect(mine.body[0]).toMatchObject({ id: raised.body.disputeId, status: 'open', claimedCondition: 'partly_working', evidence: ['evidence/microwave.mp4'] });
  });

  it('staff work the queue and decide a partial refund', async () => {
    await http().get('/staff/disputes').set('Cookie', await signIn('tendai')).expect(403);
    const staff = await signIn('staff');
    const queue = await http().get('/staff/disputes').set('Cookie', staff).expect(200);
    const d = queue.body.find((x: { lotId: string }) => x.lotId === small.lotIds[0]);
    expect(d).toMatchObject({ status: 'open', lotTitle: 'Microwave' });
    expect((await http().post(`/staff/disputes/${d.id}/assign`).set('Cookie', staff).send({}).expect(201)).body).toEqual({ assigned: true });
    const decided = await http().post(`/staff/disputes/${d.id}/decision`).set('Cookie', staff)
      .send({ remedy: 'partial_refund', refundMinor: '1500', decision: 'Turntable motor faulty; partial refund agreed with the buyer.' }).expect(201);
    expect(decided.body).toMatchObject({ decided: true, status: 'partially_upheld', refund: { text: 'US$15.00' }, fundedBy: 'seller' });
    const mine = await http().get('/me/disputes').set('Cookie', await signIn('tendai')).expect(200);
    expect(mine.body[0]).toMatchObject({ status: 'partially_upheld', refund: { text: 'US$15.00' } });
  });

  it('a refund above US$500 needs a second person with a finance role', async () => {
    const rudo = await signIn('rudo');
    const raised = await http().post('/disputes').set('Cookie', rudo)
      .send({ lotId: big.lotIds[0], category: 'damaged_in_custody', description: 'Rack frame bent, damaged in storage.', evidence: [], clientKey: 'api-claim-2' }).expect(201);
    const id = raised.body.disputeId;
    const staff = await signIn('staff');
    const refused = await http().post(`/staff/disputes/${id}/decision`).set('Cookie', staff)
      .send({ remedy: 'full_refund_and_return', decision: 'Damaged in our custody; refund in full.' }).expect(201);
    expect(refused.body).toMatchObject({ decided: false, reason: 'second_approval_required', refund: '104400' });

    const req = await http().post(`/staff/disputes/${id}/refund-approval`).set('Cookie', staff)
      .send({ remedy: 'full_refund_and_return', reason: 'Damaged in our custody; refund in full.' }).expect(201);
    expect(req.body).toMatchObject({ requested: true, requiresSecondApproval: true, amount: { text: 'US$1,044.00' } });
    // The ops staff member holds no finance role, so cannot approve; the finance approver can.
    await http().post(`/staff/refund-approvals/${req.body.overrideRequestId}`).set('Cookie', staff).send({ approve: true }).expect(403);
    const approved = await http().post(`/staff/refund-approvals/${req.body.overrideRequestId}`).set('Cookie', await signIn('approver')).send({ approve: true, note: 'Photos checked' }).expect(201);
    expect(approved.body).toEqual({ ok: true });

    const decided = await http().post(`/staff/disputes/${id}/decision`).set('Cookie', staff)
      .send({ remedy: 'full_refund_and_return', decision: 'Damaged in our custody; refund in full.', overrideRequestId: req.body.overrideRequestId }).expect(201);
    expect(decided.body).toMatchObject({ decided: true, status: 'upheld', refund: { text: 'US$1,044.00' } });
    expect((await http().post(`/staff/disputes/${id}/return`).set('Cookie', staff).send({ outcome: 'withdrawn' }).expect(201)).body).toEqual({ ok: true });
    const purchases = await http().get('/me/purchases').set('Cookie', rudo).expect(200);
    expect(purchases.body.find((p: { invoiceId: string }) => p.invoiceId === big.invoiceId).lots[0]).toMatchObject({ state: 'withdrawn', dispute: { status: 'upheld' } });
  });

  it('tickets: the customer opens and replies; staff see the queue, reply, assign and log a phone call', async () => {
    const farai = await signIn('farai');
    await http().post('/tickets').set('Cookie', farai).send({ category: 'collection' }).expect(400);
    const opened = await http().post('/tickets').set('Cookie', farai).send({ category: 'delivery', subject: 'Can you deliver to Chitungwiza?', body: 'I won a fridge last week.', clientKey: 'api-ticket-1' }).expect(201);
    expect(opened.body).toMatchObject({ opened: true, ticketNumber: expect.stringMatching(/^T-\d{6}$/) });
    const id = opened.body.ticketId;
    const staff = await signIn('staff');
    const queue = await http().get('/staff/tickets').set('Cookie', staff).expect(200);
    expect(queue.body.find((x: { id: string }) => x.id === id)).toMatchObject({ channel: 'web', priority: 'normal', status: 'open', owner: null });
    await http().post(`/staff/tickets/${id}/messages`).set('Cookie', staff).send({ body: 'Check the rate card', internal: true }).expect(201);
    expect((await http().post(`/staff/tickets/${id}/messages`).set('Cookie', staff).send({ body: 'Not yet: Harare only for now.' }).expect(201)).body).toMatchObject({ added: true, status: 'pending_customer' });
    expect((await http().post(`/tickets/${id}/messages`).set('Cookie', farai).send({ body: 'OK, I will collect.' }).expect(201)).body).toMatchObject({ added: true, status: 'open' });
    await http().post(`/tickets/${id}/messages`).set('Cookie', await signIn('tendai')).send({ body: 'not mine' }).expect(404);
    const mine = await http().get('/me/tickets').set('Cookie', farai).expect(200);
    expect(mine.body[0].messages.map((m: { body: string }) => m.body)).toEqual(['I won a fridge last week.', 'Not yet: Harare only for now.', 'OK, I will collect.']);
    expect(mine.body[0].firstRespondedAt).not.toBeNull();

    expect((await http().post(`/staff/tickets/${id}/assign`).set('Cookie', staff).send({ ownerStaffId: seed.accounts.approver, priority: 'low' }).expect(201)).body).toEqual({ assigned: true });
    await http().post(`/staff/tickets/${id}/assign`).set('Cookie', staff).send({ ownerStaffId: seed.accounts.farai }).expect(400);
    const phone = await http().post('/staff/tickets').set('Cookie', staff)
      .send({ accountId: seed.accounts.tendai, channel: 'phone', category: 'payment', subject: 'EcoCash top-up missing', body: 'Paid 10:02, ref MP123.', priority: 'urgent' }).expect(201);
    const detail = await http().get(`/staff/tickets/${phone.body.ticketId}`).set('Cookie', staff).expect(200);
    expect(detail.body).toMatchObject({ channel: 'phone', priority: 'urgent', account: { id: seed.accounts.tendai } });
    expect(Date.parse(detail.body.firstResponseDueAt) - Date.parse(detail.body.createdAt)).toBe(3_600_000);
    await http().get('/staff/tickets').set('Cookie', farai).expect(403);
  });
});
