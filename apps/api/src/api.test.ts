import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, DB_TESTS_ENABLED, type TestDatabase } from '@abc/db';
import { createApp } from './app';
import { seedDemo, type DemoSeedResult } from './demo/seed';
import { mintSession, verifySession } from './session';
import { configFromEnv } from './tokens';

describe('sessions', () => {
  it('accepts its own tokens and refuses tampered or expired ones', () => {
    const id = '5a0f8c2e-0000-4000-8000-000000000001';
    const t = mintSession(id, 'secret', 1_000_000);
    expect(verifySession(t, 'secret', 1_000_000)).toEqual({ id });
    expect(verifySession(t, 'other-secret', 1_000_000)).toBeNull();
    expect(verifySession(t.replace(id, '5a0f8c2e-0000-4000-8000-000000000002'), 'secret', 1_000_000)).toBeNull();
    expect(verifySession(t, 'secret', 1_000_000 + 13 * 3600 * 1000)).toBeNull();
  });

  it('refuses demo sign-in and weak secrets in production', () => {
    expect(() => configFromEnv({ APP_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), GATE_PASS_SECRET: 'g', DEMO_SIGN_IN: '1' })).toThrow(/DEMO_SIGN_IN/);
    expect(() => configFromEnv({ APP_ENV: 'production', SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(configFromEnv({ APP_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), GATE_PASS_SECRET: 'g' }).secureCookies).toBe(true);
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('API against PostgreSQL with the demo data', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let seed: DemoSeedResult;
  const config = { ...configFromEnv({ APP_ENV: 'test' }), demoSignIn: true };

  async function signIn(key: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/session/demo').send({ accountId: seed.accounts[key] }).expect(201);
    return String(res.headers['set-cookie']).split(';')[0]!;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    seed = await seedDemo(t.db, { hours: 24, env: {} });
    app = await createApp(t.db, config);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('the demo seed goes through the real gates: published reports, deposits, limits', () => {
    expect(seed.created).toBe(true);
    expect(seed.lots).toBe(10);
    expect(seed.bids).toBe(10);
    expect(seed.notes).toEqual(expect.arrayContaining([expect.stringContaining('-demo'), expect.stringContaining('1 invoice(s) issued')]));
  });

  it('refuses to seed in production', async () => {
    await expect(seedDemo(t.db, { env: { APP_ENV: 'production' } })).rejects.toThrow(/production/);
  });

  it('lists live lots with the all-in price at the next minimum bid', async () => {
    const res = await request(app.getHttpServer()).get('/lots?category=vehicles&sort=most_bids').expect(200);
    expect(res.body.total).toBe(10);
    const hilux = res.body.lots.find((l: { title: string }) => l.title.includes('Hilux'));
    expect(hilux).toMatchObject({ bids: 3, bidders: 2, reserveStatus: 'not_met', currency: 'USD', photoCount: 38 });
    // ZW-registered used vehicle: hammer plus 15 % purchaser's levy, no VAT (initial rule set, Q9).
    expect(BigInt(hilux.allInAtNextMinimum.minor)).toBe((BigInt(hilux.nextMinimum.minor) * 115n) / 100n);
    const filtered = await request(app.getHttpServer()).get('/lots?bodyStyle=pickup&transmission=manual').expect(200);
    expect(filtered.body.lots.length).toBeGreaterThan(0);
    expect(filtered.body.lots.every((l: { vehicle: { bodyStyle: string } }) => l.vehicle.bodyStyle === 'pickup')).toBe(true);
    await request(app.getHttpServer()).get('/lots?yearFrom=abc').expect(400);
  });

  it('a lot page shows the inspection, anonymised history and the rules that apply', async () => {
    const list = await request(app.getHttpServer()).get('/lots?q=Hilux').expect(200);
    const res = await request(app.getHttpServer()).get(`/lots/${list.body.lots[0].ref}`).expect(200);
    expect(res.body.inspection).toMatchObject({ checklistVersion: 'vehicle-v1', photoCount: 38, identityVerified: true });
    expect(res.body.history.map((h: { bidder: string }) => h.bidder)).toEqual(expect.arrayContaining(['Bidder 1', 'Bidder 2']));
    expect(JSON.stringify(res.body)).not.toMatch(/max_amount|maxMinor|reserve_minor/);
    expect(res.body.rules).toMatchObject({ softCloseSeconds: 600, depositMinimum: { text: 'US$3,000.00' } });
    expect(res.body.breakdown.total).toEqual(res.body.allInAtNextMinimum);
    await request(app.getHttpServer()).get('/lots/NOPE-1').expect(404);
  });

  it('commit preview, then a bid the server re-checks against the quoted total', async () => {
    const cookie = await signIn('farai');
    const list = await request(app.getHttpServer()).get('/lots?q=Polo').expect(200);
    const ref = list.body.lots[0].ref;
    const preview = await request(app.getHttpServer()).post(`/lots/${ref}/preview`).set('Cookie', cookie).send({ typed: '7000' }).expect(201);
    expect(preview.body).toMatchObject({ status: 'ok', registered: true, total: { text: 'US$8,050.00' } });

    const stale = await request(app.getHttpServer()).post(`/lots/${ref}/bids`).set('Cookie', cookie)
      .send({ maxMinor: '710000', quotedTotalMinor: preview.body.total.minor, quotedRuleVersionId: preview.body.ruleVersionId }).expect(201);
    expect(stale.body).toMatchObject({ accepted: false, reason: 'price_changed', serverTotal: { text: 'US$8,165.00' } });

    const body = { maxMinor: '700000', quotedTotalMinor: preview.body.total.minor, quotedRuleVersionId: preview.body.ruleVersionId, clientRequestId: 'test-polo-1' };
    const ok = await request(app.getHttpServer()).post(`/lots/${ref}/bids`).set('Cookie', cookie).send(body).expect(201);
    expect(ok.body).toMatchObject({ accepted: true, repeated: false, receipt: { youAreLeading: true } });
    const again = await request(app.getHttpServer()).post(`/lots/${ref}/bids`).set('Cookie', cookie).send(body).expect(201);
    expect(again.body).toMatchObject({ accepted: true, repeated: true });

    const mine = await request(app.getHttpServer()).get('/me/bids').set('Cookie', cookie).expect(200);
    expect(mine.body).toEqual(expect.arrayContaining([expect.objectContaining({ ref, status: 'leading', yourMax: expect.objectContaining({ text: 'US$7,000.00' }) })]));
  });

  it('bidding needs a session; demo sign-in only for demo accounts', async () => {
    await request(app.getHttpServer()).post('/lots/x/bids').send({}).expect(401);
    await request(app.getHttpServer()).post('/session/demo').send({ accountId: '00000000-0000-0000-0000-000000000001' }).expect(403);
    await request(app.getHttpServer()).get('/me').set('Cookie', 'abc_session=forged.123.abc').expect(401);
  });

  it('wallet shows available and held money from the ledger', async () => {
    const cookie = await signIn('tendai');
    const res = await request(app.getHttpServer()).get('/me/wallet').set('Cookie', cookie).expect(200);
    expect(res.body.balances).toEqual([{ currency: 'USD', available: expect.objectContaining({ text: 'US$4,000.00' }), held: expect.objectContaining({ text: 'US$11,000.00' }) }]);
    expect(res.body.holds.map((h: { description: string }) => h.description).sort()).toEqual(['Deposit: Vehicles: Bulawayo (demo, closed)', 'Deposit: Vehicles: Harare (demo)']);
  });

  it('serves the public rulebook from the published rule set', async () => {
    const res = await request(app.getHttpServer()).get('/rules').expect(200);
    expect(res.body.versionLabel).toMatch(/-demo$/);
    expect(res.body.sections.length).toBeGreaterThan(3);
  });
});
