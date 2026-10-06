import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, DB_TESTS_ENABLED, type TestDatabase } from '@abc/db';
import { createApp } from './app';
import { seedDemo, type DemoSeedResult } from './demo/seed';
import { configFromEnv } from './tokens';

describe.skipIf(!DB_TESTS_ENABLED)('analytics API with the demo data', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let seed: DemoSeedResult;
  const config = { ...configFromEnv({ APP_ENV: 'test' }), demoSignIn: true };
  const http = () => request(app.getHttpServer());
  const from = new Date(Date.now() - 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();

  async function staffCookie(key: string): Promise<string> {
    const res = await http().post('/session/demo-staff').send({ accountId: seed.accounts[key] }).expect(201);
    return String(res.headers['set-cookie']).split(';')[0]!;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    seed = await seedDemo(t.db, { hours: 24, env: {} });
    app = await createApp(t.db, config);
    await app.listen(0); // one listening server: requests built while another is in flight share it
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('serves the blueprint §9 measures for a period and branch, money per currency', async () => {
    const res = await http().get(`/staff/analytics/measures?from=${from}&to=${to}&branch=HRE`).set('Cookie', await staffCookie('staff')).expect(200);
    expect(res.body.period).toEqual({ from, to, branch: 'HRE' });
    // The demo: three bidders joined one auction and bid; ten inspected vehicles; deposits paid in cash at the counter.
    expect(res.body.registrationToFirstBid).toMatchObject({ cohort: 3, completed: 3 });
    expect(res.body.inspectionCoverage).toEqual({ vehicleLots: 10, withReport: 10, share: 1 });
    expect(res.body.inAppPayments).toEqual([expect.objectContaining({ currency: 'USD', depositCount: 3, depositInAppCount: 0, depositShare: 0 })]);
    expect(res.body.inAppPayments[0].deposits).toEqual({ minor: '4500000', currency: 'USD', text: 'US$45,000.00' }); // three US$15,000 branch-cash top-ups
    // The demo seed opens one ticket, so support is measured; it is not linked to a Harare sale.
    expect(res.body.support).toMatchObject({ instrumented: true, tickets: 0 });
    expect(res.body.sellThrough).toMatchObject({ offered: 0, rate: null }); // nothing has closed yet
    const byo = await http().get(`/staff/analytics/measures?from=${from}&to=${to}&branch=BYO`).set('Cookie', await staffCookie('staff')).expect(200);
    expect(byo.body.registrationToFirstBid.cohort).toBe(2); // Tendai and Rudo in the closed Bulawayo demo auction
  });

  it('refuses a bad period, and anyone without the analytics role', async () => {
    const ops = await staffCookie('staff');
    await http().get(`/staff/analytics/measures?from=${to}&to=${from}`).set('Cookie', ops).expect(400);
    await http().get('/staff/analytics/measures?from=yesterday&to=today').set('Cookie', ops).expect(400);
    await http().get(`/staff/analytics/measures?from=${from}&to=${to}`).expect(401);
  });

  it('freezes the baseline once (finance or admin), and keeps it', async () => {
    const body = { label: 'baseline-demo', from, to, notes: 'First measurement of the demo environment' };
    await http().post('/staff/analytics/baselines').set('Cookie', await staffCookie('staff')).send(body).expect(403);
    const finance = await staffCookie('approver');
    const first = await http().post('/staff/analytics/baselines').set('Cookie', finance).send(body).expect(201);
    expect(first.body).toMatchObject({ label: 'baseline-demo', created: true, measures: { inspectionCoverage: { share: 1 } } });
    expect((await http().post('/staff/analytics/baselines').set('Cookie', finance).send(body).expect(201)).body.created).toBe(false);
    await http().post('/staff/analytics/baselines').set('Cookie', finance).send({ ...body, to: new Date(Date.now() + 2 * 86_400_000).toISOString() }).expect(409);
    const list = await http().get('/staff/analytics/baselines').set('Cookie', finance).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ label: 'baseline-demo', frozenBy: seed.accounts.approver })]);
    expect((await http().get('/staff/analytics/baselines/baseline-demo').set('Cookie', finance).expect(200)).body.measures.registrationToFirstBid.cohort).toBe(5); // 3 Harare registrations + 2 for the closed Bulawayo auction
    await http().get('/staff/analytics/baselines/nope').set('Cookie', finance).expect(404);
  });
});
