import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, DB_TESTS_ENABLED, SYSTEM, type TestDatabase } from '@abc/db';
import { present } from './admin/http';
import { createApp } from './app';
import { seedDemo, type DemoSeedResult } from './demo/seed';
import { configFromEnv } from './tokens';

describe('staff wire format', () => {
  it('turns every <name>Minor amount into money with its currency, inherited from the nearest object that has one', () => {
    const out = present({ currency: 'USD', totalMinor: 123_450n, lines: [{ amountMinor: 100n }], at: new Date('2026-11-01T00:00:00Z'), feeMinor: null, n: 3 });
    expect(out).toEqual({
      currency: 'USD', total: { minor: '123450', currency: 'USD', text: 'US$1,234.50' }, lines: [{ amount: { minor: '100', currency: 'USD', text: 'US$1.00' } }],
      at: '2026-11-01T00:00:00.000Z', fee: null, n: 3,
    });
    expect(present([{ currency: 'ZWG', amountMinor: 5n }])).toEqual([{ currency: 'ZWG', amount: { minor: '5', currency: 'ZWG', text: expect.stringContaining('ZiG') } }]);
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('staff API (admin and operations) with the demo data', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let seed: DemoSeedResult;
  const config = { ...configFromEnv({ APP_ENV: 'test' }), demoSignIn: true };
  const cookies: Record<string, string> = {};

  const http = () => request(app.getHttpServer());

  async function staffCookie(key: string): Promise<string> {
    if (cookies[key]) return cookies[key]!;
    const res = await http().post('/session/demo-staff').send({ accountId: seed.accounts[key] }).expect(201);
    cookies[key] = String(res.headers['set-cookie']).split(';')[0]!;
    return cookies[key]!;
  }

  async function bidderCookie(key: string): Promise<string> {
    const res = await http().post('/session/demo').send({ accountId: seed.accounts[key] }).expect(201);
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

  it('demo staff sign in with the ordinary session token; bidders cannot use the staff switch', async () => {
    const list = await http().get('/session/demo-staff-accounts').expect(200);
    expect(list.body.map((a: { roles: string[] }) => a.roles)).toEqual(expect.arrayContaining([['ops'], ['finance'], ['risk']]));
    await http().post('/session/demo-staff').send({ accountId: seed.accounts.tendai }).expect(403);
    await http().post('/session/demo-staff').send({ accountId: 'nope' }).expect(400);
    const res = await http().post('/session/demo-staff').send({ accountId: seed.accounts.staff }).expect(201);
    expect(res.body).toMatchObject({ id: seed.accounts.staff, roles: ['ops'] });
    expect(String(res.headers['set-cookie'])).toMatch(/^abc_session=[0-9a-f-]{36}\.\d+\./);
  });

  it('the staff switch follows DEMO_SIGN_IN', async () => {
    const off = await createApp(t.db, { ...config, demoSignIn: false });
    await off.init();
    try {
      await request(off.getHttpServer()).post('/session/demo-staff').send({ accountId: seed.accounts.staff }).expect(403);
      await request(off.getHttpServer()).get('/session/demo-staff-accounts').expect(403);
    } finally {
      await off.close();
    }
  });

  it('staff routes need a session from an account with a staff role', async () => {
    await http().get('/staff/dashboard').expect(401);
    await http().get('/staff/dashboard').set('Cookie', await bidderCookie('tendai')).expect(403);
    const res = await http().get('/staff/dashboard?branch=HRE').set('Cookie', await staffCookie('staff')).expect(200);
    expect(res.body).toMatchObject({ branch: 'HRE', closingToday: expect.any(Array), unpaidInvoices: [], payoutsDue: [], titleCasesOverdue: [], viewings: [] });
    await http().get('/staff/dashboard?branch=harare').set('Cookie', await staffCookie('staff')).expect(400);
  });

  it('a limit override above the threshold waits for a second person with the approving role', async () => {
    const risk = await staffCookie('risk');
    const body = {
      kind: 'limit_change', reason: 'Bank guarantee received for a fleet purchase', clientKey: 'api-limit-0001',
      payload: { accountId: seed.accounts.tendai, currency: 'USD', limitMinor: '100000', validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() },
    };
    await http().post('/staff/overrides').set('Cookie', await staffCookie('staff')).send(body).expect(403);
    const created = await http().post('/staff/overrides').set('Cookie', risk).send(body).expect(201);
    expect(created.body.request).toMatchObject({ status: 'pending', kind: 'limit_change', amount: { text: 'US$1,000.00' }, requiresSecondApproval: true });
    expect((await http().post('/staff/overrides').set('Cookie', risk).send(body).expect(201)).body.repeated).toBe(true);
    const id = created.body.request.id;
    const own = await http().post(`/staff/overrides/${id}/approve`).set('Cookie', risk).send({}).expect(403);
    expect(own.body.message).toMatch(/cannot approve it/);
    await http().post(`/staff/overrides/${id}/approve`).set('Cookie', await staffCookie('staff')).send({}).expect(403);
    const ok = await http().post(`/staff/overrides/${id}/approve`).set('Cookie', await staffCookie('approver')).send({ note: 'Guarantee checked' }).expect(201);
    expect(ok.body.request).toMatchObject({ status: 'executed', approvedBy: { id: seed.accounts.approver } });
    const list = await http().get('/staff/overrides?status=executed').set('Cookie', risk).expect(200);
    expect(list.body.map((o: { id: string }) => o.id)).toContain(id);
    expect((await http().get(`/staff/overrides/${id}`).set('Cookie', risk).expect(200)).body.status).toBe('executed');
    await http().post('/staff/overrides').set('Cookie', risk).send({ ...body, kind: 'free_money' }).expect(400);
  });

  it('a rule set draft is validated, its warnings acknowledged by name, and published by a second person', async () => {
    const effectiveFrom = new Date(Date.now() + 3_600_000);
    const draftId = await t.db.tx({ ...SYSTEM, reason: 'test draft' }, async (c) => {
      const v = await c.query<{ id: string }>(
        `INSERT INTO rulebook.rule_set_version (label, effective_from, status, authored_by) VALUES ('2026.12-api', $1, 'draft', $2) RETURNING id`,
        [effectiveFrom, seed.accounts.staff],
      );
      await c.query(
        `INSERT INTO rulebook.rule_value (version_id, rule_key, scope_type, scope_ref, value, provenance, source_note)
         SELECT $1, rule_key, scope_type, scope_ref, CASE WHEN rule_key = 'payments.pending_expiry_minutes' THEN '45'::jsonb ELSE value END,
                provenance, source_note
           FROM rulebook.rule_value WHERE version_id = $2`,
        [v.rows[0]!.id, seed.ruleVersionId],
      );
      return v.rows[0]!.id;
    });
    const approver = await staffCookie('approver');
    const versions = await http().get('/staff/rule-sets').set('Cookie', approver).expect(200);
    expect(versions.body.find((v: { id: string }) => v.id === seed.ruleVersionId)).toMatchObject({ status: 'published', inForce: true });
    const q = `effectiveFrom=${encodeURIComponent(effectiveFrom.toISOString())}`;
    const v = await http().get(`/staff/rule-sets/${draftId}/validation?${q}`).set('Cookie', approver).expect(200);
    expect(v.body).toMatchObject({ errors: [], changedKeys: ['payments.pending_expiry_minutes'], approverRoles: ['finance'], readyForYou: false });
    const first = v.body.warnings[0];
    await http().post(`/staff/rule-sets/${draftId}/acknowledgements`).set('Cookie', await staffCookie('staff'))
      .send({ warningId: first.id, reason: 'Author trying to acknowledge' }).expect(403);
    await http().post(`/staff/rule-sets/${draftId}/publish`).set('Cookie', approver).send({ effectiveFrom }).expect(409);
    for (const w of v.body.warnings) {
      await http().post(`/staff/rule-sets/${draftId}/acknowledgements`).set('Cookie', approver)
        .send({ warningId: w.id, reason: 'Accepted for the demo environment', effectiveFrom }).expect(201);
    }
    expect((await http().get(`/staff/rule-sets/${draftId}/validation?${q}`).set('Cookie', approver).expect(200)).body).toMatchObject({ readyForYou: true, openForYou: 0 });
    const pub = await http().post(`/staff/rule-sets/${draftId}/publish`).set('Cookie', approver).send({ effectiveFrom }).expect(201);
    expect(pub.body).toMatchObject({ status: 'published', inForce: false, retired: [] });
    await http().get('/staff/tax-rates').set('Cookie', await staffCookie('staff')).expect(403);
    expect((await http().get('/staff/tax-rates').set('Cookie', approver).expect(200)).body.length).toBeGreaterThan(0);
  });

  it('risk console: queues, clusters, anomalies and restricted accounts for risk staff only', async () => {
    const risk = await staffCookie('risk');
    expect((await http().get('/staff/risk/registrations').set('Cookie', risk).expect(200)).body).toEqual([]);
    await http().get('/staff/risk/registrations').set('Cookie', await staffCookie('staff')).expect(403);
    expect((await http().get('/staff/risk/anomalies').set('Cookie', risk).expect(200)).body).toMatchObject({ thresholds: { bidUp: { minLots: 3 } }, bidUp: [], sharedSignals: [] });
    expect((await http().get('/staff/risk/link-clusters').set('Cookie', risk).expect(200)).body).toEqual([]);
    expect((await http().get('/staff/risk/restricted').set('Cookie', risk).expect(200)).body).toEqual([]);
    await http().post('/staff/risk/registrations/00000000-0000-4000-8000-000000000000/decision').set('Cookie', risk)
      .send({ decision: 'approved', reason: 'Checked by phone call' }).expect(404);
  });

  it('reconciliation, defaults and appeals answer with plain errors', async () => {
    const approver = await staffCookie('approver');
    expect((await http().get('/staff/reconciliation').set('Cookie', approver).expect(200)).body).toEqual([]);
    await http().post('/staff/reconciliation/1/resolve').set('Cookie', approver).send({ resolution: 'gateway_error', note: 'Gateway test transaction' }).expect(404);
    await http().post('/staff/reconciliation/abc/resolve').set('Cookie', approver).send({ resolution: 'gateway_error', note: 'Gateway test transaction' }).expect(400);
    expect((await http().get('/staff/defaults').set('Cookie', await staffCookie('risk')).expect(200)).body).toEqual([]);
    const tendai = await bidderCookie('tendai');
    expect((await http().get('/me/defaults').set('Cookie', tendai).expect(200)).body).toEqual([]);
    await http().get('/me/defaults').expect(401);
    await http().post('/me/defaults/00000000-0000-4000-8000-000000000000/appeal').set('Cookie', tendai)
      .send({ steps: ['deposit_forfeit'], grounds: 'EcoCash was down on the due date' }).expect(404);
  });

  it('ops schedule an auction once per code, attach only offerable lots, and cannot open it empty', async () => {
    const ops = await staffCookie('staff');
    const body = { code: 'HRE-API-TEST', title: 'IT equipment (API test)', branch: 'HRE', opensAt: new Date().toISOString(), firstCloseAt: new Date(Date.now() + 86_400_000).toISOString() };
    await http().post('/staff/auctions').set('Cookie', await staffCookie('risk')).send(body).expect(403);
    const created = await http().post('/staff/auctions').set('Cookie', ops).send(body).expect(201);
    expect(created.body).toMatchObject({ created: true, staggerSeconds: 60 });
    expect((await http().post('/staff/auctions').set('Cookie', ops).send(body).expect(201)).body).toMatchObject({ created: false, auctionId: created.body.auctionId });
    const live = await t.db.query<{ id: string }>(`SELECT id FROM catalogue.lot WHERE state = 'live' LIMIT 1`);
    const attach = await http().post(`/staff/auctions/${created.body.auctionId}/lots`).set('Cookie', ops).send({ lotIds: [live.rows[0]!.id] }).expect(201);
    expect(attach.body).toEqual([expect.objectContaining({ attached: false, blockers: [expect.objectContaining({ code: 'lot_not_offerable' })] })]);
    const open = await http().post(`/staff/auctions/${created.body.auctionId}/open`).set('Cookie', ops).expect(409);
    expect(open.body.message).toMatch(/at least one lot/);
  });
});
