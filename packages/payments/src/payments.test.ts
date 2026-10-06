import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccount,
  createTestDatabase,
  DB_TESTS_ENABLED,
  loadPublishedRuleSetForTests,
  readRuleSetDocument,
  RulebookStore,
  type TestDatabase,
} from '@abc/db';
import { balance, reconcileLedger, wallet } from '@abc/ledger';
import type { PaymentRouting } from '@abc/rules';
import {
  canTransition,
  FakeGateway,
  mapPaynowStatus,
  methodsFor,
  NoRouteError,
  parseUrlEncoded,
  PaymentService,
  PaynowGateway,
  paynowHash,
  reconcile,
  route,
} from './index';

const DOC = readRuleSetDocument();
const ROUTING = DOC.rules.find((r) => r.key === 'payments.routing')!.value as PaymentRouting;

describe('routing', () => {
  const paynow = new FakeGateway('paynow', 's1');
  const contipay = new FakeGateway('contipay', 's2');
  const gateways = new Map([
    ['paynow', paynow],
    ['contipay', contipay],
  ]);

  it('orders gateways as the routing rule lists them', () => {
    expect(route({ currency: 'USD', method: 'ecocash', amountMinor: 5_000n }, ROUTING, gateways).map((g) => g.id)).toEqual(['paynow', 'contipay']);
  });

  it('skips an unhealthy gateway', () => {
    paynow.healthy = false;
    expect(route({ currency: 'USD', method: 'ecocash', amountMinor: 5_000n }, ROUTING, gateways).map((g) => g.id)).toEqual(['contipay']);
    paynow.healthy = true;
  });

  it('offers InnBucks in USD only, and bank transfer nowhere yet (blueprint §7)', () => {
    expect(() => route({ currency: 'ZWG', method: 'innbucks', amountMinor: 5_000n }, ROUTING, gateways)).toThrow(NoRouteError);
    expect(methodsFor('USD', ROUTING)).toContain('innbucks');
    expect(methodsFor('ZWG', ROUTING)).not.toContain('innbucks');
    expect(methodsFor('USD', ROUTING)).not.toContain('bank_transfer');
  });

  it('respects gateway amount limits', () => {
    const small = new FakeGateway('paynow', 's', FakeGateway.allMethods(10_000n));
    expect(() => route({ currency: 'USD', method: 'innbucks', amountMinor: 50_000n }, ROUTING, new Map([['paynow', small]]))).toThrow(NoRouteError);
  });

  it('allows only forward status changes; a late confirmation after expiry still credits', () => {
    expect(canTransition('pending', 'succeeded')).toBe(true);
    expect(canTransition('succeeded', 'pending')).toBe(false);
    expect(canTransition('failed', 'succeeded')).toBe(false);
    expect(canTransition('expired', 'succeeded')).toBe(true);
  });
});

describe('reconciliation (pure)', () => {
  it('matches, and reports every kind of difference', () => {
    const items = reconcile(
      [
        { gatewayReference: 'a', amountMinor: 100n, currency: 'USD' },
        { gatewayReference: 'b', amountMinor: 250n, currency: 'USD' },
        { gatewayReference: 'c', amountMinor: 300n, currency: 'USD' },
      ],
      [
        { paymentId: 'p1', gatewayReference: 'a', amountMinor: 100n, currency: 'USD' },
        { paymentId: 'p2', gatewayReference: 'b', amountMinor: 200n, currency: 'USD' },
        { paymentId: 'p4', gatewayReference: 'd', amountMinor: 400n, currency: 'USD' },
      ],
    );
    expect(items.map((i) => [i.externalReference, i.outcome])).toEqual([
      ['a', 'matched'],
      ['b', 'amount_mismatch'],
      ['c', 'missing_in_system'],
      ['d', 'missing_at_source'],
    ]);
  });
});

describe('Paynow adapter (UNVERIFIED against the sandbox, A32)', () => {
  const KEY = 'integration-key';
  function reply(fields: Array<[string, string]>, key = KEY): string {
    return new URLSearchParams([...fields, ['hash', paynowHash(fields, key)]]).toString();
  }

  it('hashes values in order plus the integration key, upper-case SHA-512', () => {
    const h = paynowHash([['id', '1'], ['reference', 'r'], ['hash', 'ignored']], KEY);
    expect(h).toMatch(/^[0-9A-F]{128}$/);
    expect(h).toBe(paynowHash([['id', '1'], ['reference', 'r']], KEY));
    expect(h).not.toBe(paynowHash([['reference', 'r'], ['id', '1']], KEY));
  });

  it('sends a signed mobile-money request and reads the signed reply', async () => {
    let sent = '';
    let url = '';
    const gw = new PaynowGateway({
      integrations: { USD: { id: '1234', key: KEY } },
      resultUrl: 'https://abc.test/callbacks/paynow',
      returnUrl: 'https://abc.test/wallet',
      fetch: (async (u: string, init: RequestInit) => {
        url = u;
        sent = String(init.body);
        return new Response(reply([['status', 'Ok'], ['pollurl', 'https://paynow.test/poll/abc'], ['instructions', 'Dial *151#']]));
      }) as typeof fetch,
    });
    const r = await gw.initiate({ paymentId: 'pay-1', currency: 'USD', amountMinor: 1_250n, method: 'ecocash', payerPhone: '0771111111' });
    expect(url).toMatch(/remotetransaction$/);
    const fields = parseUrlEncoded(sent);
    expect(Object.fromEntries(fields)).toMatchObject({ id: '1234', reference: 'pay-1', amount: '12.50', phone: '0771111111', method: 'ecocash' });
    expect(fields.at(-1)![1]).toBe(paynowHash(fields, KEY));
    expect(r).toMatchObject({ gatewayReference: 'https://paynow.test/poll/abc', approval: 'phone_prompt', instructions: 'Dial *151#' });
  });

  it('treats an error reply as a decline (safe to fail over) and a bad hash as an error (not safe)', async () => {
    const declining = new PaynowGateway({
      integrations: { USD: { id: '1', key: KEY } }, resultUrl: 'x', returnUrl: 'x',
      fetch: (async () => new Response('status=Error&error=Insufficient+balance')) as unknown as typeof fetch,
    });
    await expect(declining.initiate({ paymentId: 'p', currency: 'USD', amountMinor: 100n, method: 'ecocash' })).rejects.toMatchObject({ name: 'GatewayDeclinedError' });
    const forged = new PaynowGateway({
      integrations: { USD: { id: '1', key: KEY } }, resultUrl: 'x', returnUrl: 'x',
      fetch: (async () => new Response(reply([['status', 'Ok'], ['pollurl', 'u']], 'wrong-key'))) as unknown as typeof fetch,
    });
    await expect(forged.initiate({ paymentId: 'p', currency: 'USD', amountMinor: 100n, method: 'ecocash' })).rejects.toThrow(/hash/);
  });

  it('refuses a currency with no integration before contacting Paynow', async () => {
    const gw = new PaynowGateway({ integrations: { USD: { id: '1', key: KEY } }, resultUrl: 'x', returnUrl: 'x', fetch: (async () => { throw new Error('should not be called'); }) as unknown as typeof fetch });
    await expect(gw.initiate({ paymentId: 'p', currency: 'ZWG', amountMinor: 100n, method: 'ecocash' })).rejects.toMatchObject({ name: 'GatewayDeclinedError' });
  });

  it('verifies callbacks and maps statuses', () => {
    const gw = new PaynowGateway({ integrations: { USD: { id: '1', key: KEY } }, resultUrl: 'x', returnUrl: 'x' });
    const body = reply([['reference', 'pay-1'], ['paynowreference', '999'], ['amount', '12.50'], ['status', 'Paid'], ['pollurl', 'https://paynow.test/poll/abc']]);
    expect(gw.verifyCallback({}, body)).toEqual({ merchantReference: 'pay-1', gatewayReference: 'https://paynow.test/poll/abc', status: 'paid' });
    expect(gw.verifyCallback({}, body.replace('12.50', '99.50'))).toBeNull();
    expect(mapPaynowStatus('Awaiting Delivery')).toBe('paid');
    expect(mapPaynowStatus('Sent')).toBe('pending');
    expect(mapPaynowStatus('Cancelled')).toBe('cancelled');
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('payment service against PostgreSQL', () => {
  let t: TestDatabase;
  let paynow: FakeGateway;
  let contipay: FakeGateway;
  let service: PaymentService;
  let buyer: string;
  const actor = () => ({ type: 'account' as const, id: buyer, name: 'Buyer' });

  beforeAll(async () => {
    t = await createTestDatabase();
    await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true });
    paynow = new FakeGateway('paynow', 'paynow-secret');
    contipay = new FakeGateway('contipay', 'contipay-secret');
    service = new PaymentService(t.db, new RulebookStore(t.db), [paynow, contipay]);
    buyer = await createAccount(t.db);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('EcoCash top-up: pending until the payer approves, then credited exactly once', async () => {
    const start = await service.startTopUp(actor(), { accountId: buyer, currency: 'USD', amountMinor: 50_000n, method: 'ecocash', payerPhone: '0771111111', clientKey: 'k1' });
    expect(start).toMatchObject({ status: 'pending', gateway: 'paynow', approval: 'phone_prompt' });
    expect((await wallet(t.db, buyer, 'USD')).availableMinor).toBe(0n);

    const ref = (await t.db.query<{ gateway_reference: string }>('SELECT gateway_reference FROM payment.payment WHERE id = $1', [start.paymentId])).rows[0]!.gateway_reference;
    const cb = paynow.payerResponds(ref, true);
    expect(await service.handleCallback('paynow', cb.headers, cb.body)).toEqual({ outcome: 'applied', paymentId: start.paymentId });
    // The gateway retries its callback; nothing is credited twice.
    await service.handleCallback('paynow', cb.headers, cb.body);
    expect((await wallet(t.db, buyer, 'USD')).availableMinor).toBe(50_000n);
    expect(await balance(t.db, { owner: { type: 'gateway', id: 'paynow' }, purpose: 'gateway_clearing' }, 'USD')).toBe(50_000n);
  });

  it('a retried start request returns the same payment', async () => {
    const a = await service.startTopUp(actor(), { accountId: buyer, currency: 'USD', amountMinor: 1_000n, method: 'ecocash', clientKey: 'k2' });
    const b = await service.startTopUp(actor(), { accountId: buyer, currency: 'USD', amountMinor: 1_000n, method: 'ecocash', clientKey: 'k2' });
    expect(b.paymentId).toBe(a.paymentId);
  });

  it('fails over to the second gateway only when the first refuses before prompting', async () => {
    paynow.declineNext = true;
    const r = await service.startTopUp(actor(), { accountId: buyer, currency: 'USD', amountMinor: 2_000n, method: 'onemoney', clientKey: 'k3' });
    expect(r).toMatchObject({ status: 'pending', gateway: 'contipay' });
  });

  it('rejects a forged callback and records it', async () => {
    const r = await service.handleCallback('paynow', { 'x-signature': 'deadbeef' }, JSON.stringify({ reference: 'x', gatewayReference: 'y', status: 'paid' }));
    expect(r.outcome).toBe('rejected');
    const events = await t.db.query<{ n: bigint }>('SELECT count(*) AS n FROM payment.gateway_event WHERE signature_valid = false');
    expect(events.rows[0]!.n).toBe(1n);
  });

  it('never credits an amount different from the one the payer started', async () => {
    const start = await service.startTopUp(actor(), { accountId: buyer, currency: 'USD', amountMinor: 3_000n, method: 'ecocash', clientKey: 'k4' });
    const ref = (await t.db.query<{ gateway_reference: string }>('SELECT gateway_reference FROM payment.payment WHERE id = $1', [start.paymentId])).rows[0]!.gateway_reference;
    const before = (await wallet(t.db, buyer, 'USD')).availableMinor;
    const cb = paynow.payerResponds(ref, true, 300n);
    await service.handleCallback('paynow', cb.headers, cb.body);
    expect((await wallet(t.db, buyer, 'USD')).availableMinor).toBe(before);
    const p = await t.db.query<{ status: string; failure_reason: string }>('SELECT status, failure_reason FROM payment.payment WHERE id = $1', [start.paymentId]);
    expect(p.rows[0]).toMatchObject({ status: 'pending' });
    expect(p.rows[0]!.failure_reason).toContain('mismatch');
  });

  it('polling credits a payment whose callback never arrived, and expires stale ones', async () => {
    const start = await service.startTopUp(actor(), { accountId: buyer, currency: 'USD', amountMinor: 4_000n, method: 'ecocash', clientKey: 'k5' });
    const ref = (await t.db.query<{ gateway_reference: string }>('SELECT gateway_reference FROM payment.payment WHERE id = $1', [start.paymentId])).rows[0]!.gateway_reference;
    paynow.payerResponds(ref, true); // callback lost
    const before = (await wallet(t.db, buyer, 'USD')).availableMinor;
    await service.pollPending();
    expect((await wallet(t.db, buyer, 'USD')).availableMinor).toBe(before + 4_000n);
    const later = new Date(Date.now() + 31 * 60_000);
    const r = await service.pollPending(later);
    expect(r.expired).toBeGreaterThan(0); // the unapproved ones from earlier tests
  });

  it('branch cash is posted with its receipt number, once', async () => {
    const cashier = await createAccount(t.db, { name: 'Cashier' });
    const staff = { type: 'staff' as const, id: cashier, name: 'Cashier' };
    const id1 = await service.recordBranchCash(staff, { cashierId: cashier, branch: 'HRE', accountId: buyer, currency: 'USD', amountMinor: 20_000n, receiptNumber: 'HRE-000123' });
    const id2 = await service.recordBranchCash(staff, { cashierId: cashier, branch: 'HRE', accountId: buyer, currency: 'USD', amountMinor: 20_000n, receiptNumber: 'HRE-000123' });
    expect(id2).toBe(id1);
    expect(await balance(t.db, { owner: { type: 'branch', id: 'HRE' }, purpose: 'branch_cash' }, 'USD')).toBe(20_000n);
  });

  it('daily reconciliation matches the statement and flags money the System never recorded', async () => {
    const today = new Date().toISOString().slice(0, 10);
    paynow.injectUnknownPaid('USD', 777n);
    const { items } = await service.reconcileDay('paynow', 'USD', today);
    expect(items.filter((i) => i.outcome === 'matched').length).toBe(2);
    // The injected unknown payment, and the earlier mismatch (the gateway says US$3.00; the System credited nothing).
    const missing = items.filter((i) => i.outcome === 'missing_in_system').map((i) => i.statementAmountMinor!);
    expect(missing.sort((a, b) => (a < b ? -1 : 1))).toEqual([300n, 777n]);
  });

  it('the books still reconcile', async () => {
    expect(await reconcileLedger(t.db)).toEqual([]);
  });
});
