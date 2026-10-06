import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BiddingService } from '@abc/bidding';
import {
  createAccount,
  createAuction,
  createTestDatabase,
  DB_TESTS_ENABLED,
  loadPublishedRuleSetForTests,
  readRuleSetDocument,
  RulebookStore,
  SYSTEM,
  type Actor,
  type TestDatabase,
} from '@abc/db';
import { balance, reconcileLedger, wallet } from '@abc/ledger';
import { RegistrationService } from '@abc/limits';
import { FakeGateway, PaymentService } from '@abc/payments';
import { quoteLot } from '@abc/quote';
import { SettlementService } from '@abc/settlement';
import {
  AdminError,
  can,
  createAdminServices,
  loadStaff,
  needsSecondApproval,
  opsDashboard,
  PERMISSIONS,
  requirePermission,
  warningId,
  type AdminServices,
  type StaffMember,
  type StaffRole,
} from './index';

const DOC = readRuleSetDocument();
const HOUR = 3_600_000;
const COMMISSION = {
  key: 'commission.schedule',
  scope: { type: 'global' as const, ref: '*' },
  value: { basis: 'flat_band', bands: { USD: [{ from: 0, rateBp: 1000 }], ZWG: null }, minimumPerLot: { USD: 0, ZWG: null } },
  provenance: 'assumption' as const,
  source: 'TEST ONLY: illustrative commission pending Q3',
};

describe('staff permissions (pure)', () => {
  it('every permission names at least one role; the auditor reads but never changes anything', () => {
    for (const roles of Object.values(PERMISSIONS)) expect(roles.length).toBeGreaterThan(0);
    const auditor = { roles: ['auditor' as StaffRole] };
    expect(can(auditor, 'risk.view')).toBe(true);
    expect(can(auditor, 'analytics.view')).toBe(true);
    for (const p of Object.keys(PERMISSIONS) as Array<keyof typeof PERMISSIONS>) {
      if (/request|approve|decide|resolve|schedule|freeze|record/.test(p)) expect(can(auditor, p)).toBe(false);
    }
  });

  it('refuses with a plain sentence naming the roles that can', () => {
    expect(() => requirePermission({ roles: ['cashier'] }, 'reconciliation.resolve')).toThrow(/needs one of: finance/);
    expect(can({ roles: ['ops'] }, 'auction.schedule')).toBe(true);
  });

  it('two people above the threshold, always for kinds without an amount, and when the currency has no threshold', () => {
    const threshold = { USD: 50_000, ZWG: null };
    expect(needsSecondApproval({ alwaysTwoPerson: false, currency: 'USD', amountMinor: 50_000n }, threshold)).toBe(false);
    expect(needsSecondApproval({ alwaysTwoPerson: false, currency: 'USD', amountMinor: 50_001n }, threshold)).toBe(true);
    expect(needsSecondApproval({ alwaysTwoPerson: false, currency: 'ZWG', amountMinor: 1n }, threshold)).toBe(true);
    expect(needsSecondApproval({ alwaysTwoPerson: true, currency: null, amountMinor: null }, threshold)).toBe(true);
    expect(needsSecondApproval({ alwaysTwoPerson: false, currency: null, amountMinor: null }, threshold)).toBe(false);
  });

  it('a warning keeps the same name for the same sentence', () => {
    const w = { code: 'provenance_assumption', key: 'override.two_person_threshold', message: 'x' };
    expect(warningId(w)).toBe(warningId({ ...w }));
    expect(warningId(w)).not.toBe(warningId({ ...w, message: 'y' }));
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('admin and operations services against PostgreSQL', () => {
  let t: TestDatabase;
  let rulebook: RulebookStore;
  let registrations: RegistrationService;
  let bidding: BiddingService;
  let settlement: SettlementService;
  let payments: PaymentService;
  let paynow: FakeGateway;
  let admin: AdminServices;
  const staff: Record<string, StaffMember> = {};
  let seller: string;
  let initialVersion: string;

  const as = (id: string): Actor => ({ type: 'account', id, name: 'Bidder' });

  async function staffMember(key: string, roles: StaffRole[], grantor: string): Promise<StaffMember> {
    const id = await createAccount(t.db, { name: `Staff ${key}`, verification: 'full' });
    for (const role of roles) {
      await t.db.tx(SYSTEM, (c) => c.query('INSERT INTO identity.staff_role (account_id, role, granted_by) VALUES ($1, $2, $3)', [id, role, grantor]));
    }
    return (await loadStaff(t.db, id))!;
  }

  async function ecocashTopUp(accountId: string, amountMinor: bigint): Promise<string> {
    const start = await payments.startTopUp(as(accountId), { accountId, currency: 'USD', amountMinor, method: 'ecocash', clientKey: randomUUID() });
    const ref = (await t.db.query<{ gateway_reference: string }>('SELECT gateway_reference FROM payment.payment WHERE id = $1', [start.paymentId])).rows[0]!.gateway_reference;
    const cb = paynow.payerResponds(ref, true);
    await payments.handleCallback('paynow', cb.headers, cb.body);
    return ref;
  }

  async function bid(accountId: string, auctionLotId: string, maxMinor: bigint) {
    const versionId = (await t.db.query<{ rule_version_id: string }>(
      'SELECT a.rule_version_id FROM auction.auction a JOIN auction.auction_lot al ON al.auction_id = a.id WHERE al.id = $1',
      [auctionLotId],
    )).rows[0]!.rule_version_id;
    const snapshot = await rulebook.snapshot(versionId);
    const pricing = { currency: 'USD' as const, taxClass: 'goods_standard', categoryPath: ['it'], isVehicle: false };
    const total = quoteLot({ lot: pricing, hammerMinor: maxMinor, snapshot, taxRates: await rulebook.taxRates(), at: new Date() }).totalMinor;
    return bidding.placeBid(as(accountId), { accountId, auctionLotId, maxMinor, clientRequestId: randomUUID(), quotedTotalMinor: total, quotedRuleVersionId: versionId, channel: 'web' });
  }

  async function expectAdminError(p: Promise<unknown>, code: AdminError['code'], message?: RegExp) {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(AdminError);
    expect((e as AdminError).code).toBe(code);
    if (message) expect((e as AdminError).message).toMatch(message);
  }

  /** A won, unpaid invoice: the buyer deposits, wins at US$700 and does not pay. */
  async function unpaidInvoice(buyer: string, topUp: bigint, deposit: bigint) {
    await ecocashTopUp(buyer, topUp);
    const end = new Date(Date.now() + 2 * HOUR);
    const a = await createAuction(t.db, { createdBy: staff.ops!.id, depositRequired: true, lots: [{ sellerId: seller, startingBidMinor: 70_000n, endsAt: end }] });
    await bidding.openAuction(SYSTEM, a.auctionId);
    await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: buyer, auctionId: a.auctionId, deposit: { USD: deposit } }));
    expect(await bid(buyer, a.lots[0]!.auctionLotId, 80_000n)).toMatchObject({ accepted: true });
    await bidding.closeDueLots(new Date(end.getTime() + 1_000));
    const issuedAt = new Date();
    const invoiceId = (await settlement.settleClosedAuction(a.auctionId, issuedAt))[0]!.invoiceId;
    const caseId = async () => (await t.db.query<{ id: string }>('SELECT id FROM settlement.default_case WHERE invoice_id = $1', [invoiceId])).rows[0]!.id;
    return { invoiceId, issuedAt, lotId: a.lots[0]!.lotId, caseId };
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    initialVersion = await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true, overrides: [COMMISSION] });
    rulebook = new RulebookStore(t.db);
    registrations = new RegistrationService(rulebook);
    bidding = new BiddingService(t.db, rulebook, registrations);
    settlement = new SettlementService(t.db, rulebook, { gatePassSecret: 'gate-pass-secret' });
    paynow = new FakeGateway('paynow', 'paynow-secret');
    payments = new PaymentService(t.db, rulebook, [paynow]);
    admin = createAdminServices(t.db, rulebook, { registrations, bidding });
    const grantor = await createAccount(t.db, { name: 'Grantor' });
    for (const [key, roles] of Object.entries({
      ops: ['ops'], risk1: ['risk'], risk2: ['risk'], fin1: ['finance'], fin2: ['finance'], admin: ['admin'], auditor: ['auditor'], support: ['support'],
    } as Record<string, StaffRole[]>)) {
      staff[key] = await staffMember(key, roles, grantor);
    }
    seller = await createAccount(t.db, { name: 'Seller', verification: 'full' });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('loads staff with their roles, and nobody else', async () => {
    expect(staff.risk1!.roles).toEqual(['risk']);
    expect(await loadStaff(t.db, seller)).toBeNull();
  });

  describe('override requests', () => {
    let buyer: string;
    beforeAll(async () => {
      buyer = await createAccount(t.db, { name: 'Override buyer', verification: 'full' });
    });

    it('below the threshold, one person raises and the override applies at once', async () => {
      const out = await admin.overrides.request(staff.risk1!, {
        kind: 'limit_change', reason: 'Known buyer; limit for a single lot', payload: { accountId: buyer, currency: 'USD', limitMinor: '40000', validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() },
      });
      expect(out.request).toMatchObject({ status: 'executed', requiresSecondApproval: false, approvedBy: null, amountMinor: 40_000n });
      expect(out.result).toMatchObject({ limitOverrideId: expect.any(String) });
      const snapshot = await rulebook.snapshot(initialVersion);
      expect((await t.db.tx(SYSTEM, (c) => registrations.limit(c, buyer, 'USD', false, snapshot))).limitMinor).toBe(40_000n);
    });

    it('above the threshold it waits for a second person with the right role, never the requester', async () => {
      const out = await admin.overrides.request(staff.risk1!, {
        kind: 'limit_change', reason: 'Bank guarantee of US$5,000 received', clientKey: 'limit-1',
        payload: { accountId: buyer, currency: 'USD', limitMinor: '500000', validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() },
      });
      expect(out.request).toMatchObject({ status: 'pending', requiresSecondApproval: true, expiresAt: expect.any(Date) });
      expect((await admin.overrides.request(staff.risk1!, { kind: 'limit_change', reason: 'Bank guarantee of US$5,000 received', clientKey: 'limit-1', payload: {} })).repeated).toBe(true);
      await expectAdminError(admin.overrides.approve(staff.risk1!, out.request.id), 'forbidden', /raised this request/);
      await expectAdminError(admin.overrides.approve(staff.ops!, out.request.id), 'forbidden', /needs one of/);
      const approved = await admin.overrides.approve(staff.fin1!, out.request.id, 'Guarantee checked with the bank');
      expect(approved.request).toMatchObject({ status: 'executed', approvedBy: { id: staff.fin1!.id } });
      await expectAdminError(admin.overrides.approve(staff.fin2!, out.request.id), 'conflict');
      const snapshot = await rulebook.snapshot(initialVersion);
      expect((await t.db.tx(SYSTEM, (c) => registrations.limit(c, buyer, 'USD', false, snapshot))).limitMinor).toBe(500_000n);
    });

    it('a request can be rejected with a reason, and lapses if nobody approves it in time', async () => {
      const zig = await admin.overrides.request(staff.risk1!, {
        kind: 'limit_change', reason: 'ZiG limit for a corporate buyer',
        payload: { accountId: buyer, currency: 'ZWG', limitMinor: '100', validUntil: new Date(Date.now() + 86_400_000).toISOString() },
      });
      expect(zig.request.status).toBe('pending'); // no ZiG threshold is set, so even a small amount needs two people
      expect((await admin.overrides.reject(staff.risk2!, zig.request.id, 'Corporate documents missing')).status).toBe('rejected');

      const old = new Date(Date.now() - 4 * 86_400_000);
      const stale = await admin.overrides.request(staff.risk1!, { kind: 'tier_change', reason: 'Restrict after chargeback pattern', payload: { accountId: buyer, toTier: 'restricted' } }, old);
      expect(stale.request.expiresAt!.getTime()).toBe(old.getTime() + 72 * HOUR);
      await expectAdminError(admin.overrides.approve(staff.risk2!, stale.request.id), 'conflict', /lapsed/);
      expect((await admin.overrides.view(t.db, stale.request.id))!.status).toBe('expired');
    });

    it('a tier change has no amount but always needs a second person', async () => {
      const out = await admin.overrides.request(staff.risk1!, { kind: 'tier_change', reason: 'Linked to a barred account by device', payload: { accountId: buyer, toTier: 'restricted' } });
      expect(out.request.status).toBe('pending');
      const done = await admin.overrides.approve(staff.risk2!, out.request.id);
      expect(done.result).toMatchObject({ tier: 'restricted', restrictedUntil: expect.any(Date) });
      const restricted = await admin.risk.restrictedAccounts();
      expect(restricted.find((r) => r.id === buyer)).toMatchObject({ tier: 'restricted', reason: expect.stringContaining('Approved') });
      expect(await admin.overrides.expireLapsed(new Date(Date.now() + 100 * HOUR))).toBe(0);
    });
  });

  describe('rule set publication', () => {
    let draftId: string;

    beforeAll(async () => {
      draftId = await t.db.tx({ type: 'staff', id: staff.ops!.id, name: 'Ops author', reason: 'draft rule set' }, async (c) => {
        const v = await c.query<{ id: string }>(
          `INSERT INTO rulebook.rule_set_version (label, effective_from, status, authored_by) VALUES ('2026.12-r1', now() + interval '1 day', 'draft', $1) RETURNING id`,
          [staff.ops!.id],
        );
        const rules = [...DOC.rules.filter((r) => r.key !== 'commission.schedule'), COMMISSION].map((r) =>
          r.key === 'bidding.stagger_seconds' ? { ...r, value: 90, source: 'Ops proposal: 90 seconds between closes' } : r,
        );
        for (const r of rules) {
          await c.query(
            `INSERT INTO rulebook.rule_value (version_id, rule_key, scope_type, scope_ref, value, provenance, source_note) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            [v.rows[0]!.id, r.key, r.scope.type, r.scope.ref, JSON.stringify(r.value), r.provenance, r.source],
          );
        }
        return v.rows[0]!.id;
      });
    });

    it('validates the draft and names every warning; only what changed decides the approver\'s roles', async () => {
      const v = await admin.rulebook.validation(draftId);
      expect(v.errors).toEqual([]);
      expect(v.warnings.length).toBeGreaterThan(10);
      expect(v.changedKeys).toEqual(['bidding.stagger_seconds']);
      expect(v.approverRoles).toEqual(['ops']);
      expect((await admin.rulebook.versions()).find((x) => x.id === draftId)).toMatchObject({ status: 'draft', inForce: false });
    });

    it('the author cannot acknowledge; a second person without the owning role cannot either', async () => {
      const w = (await admin.rulebook.validation(draftId)).warnings[0]!;
      await expectAdminError(admin.rulebook.acknowledge(staff.ops!, draftId, w.id, 'Placeholder accepted pending ABC'), 'forbidden', /second person/);
      await expectAdminError(admin.rulebook.acknowledge(staff.fin1!, draftId, w.id, 'Placeholder accepted pending ABC'), 'forbidden', /owned by ops/);
      await expectAdminError(admin.rulebook.acknowledge(staff.admin!, draftId, w.id, 'short'), 'invalid');
    });

    it('publishing needs every warning acknowledged by the approver, then takes effect and retires the old version', async () => {
      const v = await admin.rulebook.validation(draftId);
      for (const w of v.warnings.slice(1)) await admin.rulebook.acknowledge(staff.admin!, draftId, w.id, 'Placeholder accepted pending ABC decision');
      await expectAdminError(admin.rulebook.approveAndPublish(staff.admin!, draftId, new Date()), 'conflict', /1 still open/);
      await expectAdminError(admin.rulebook.approveAndPublish(staff.admin!, draftId, new Date(Date.now() - 86_400_000)), 'invalid', /past/);
      const acked = await admin.rulebook.acknowledge(staff.admin!, draftId, v.warnings[0]!.id, 'Placeholder accepted pending ABC decision');
      expect(acked.acknowledgements).toEqual([expect.objectContaining({ by: staff.admin!.id, reason: 'Placeholder accepted pending ABC decision' })]);
      const published = await admin.rulebook.approveAndPublish(staff.admin!, draftId, new Date());
      expect(published).toMatchObject({ status: 'published', approvedBy: staff.admin!.id, inForce: true, retired: [initialVersion] });
      expect(await rulebook.activeVersionId(new Date())).toBe(draftId);
      await expectAdminError(admin.rulebook.acknowledge(staff.admin!, draftId, v.warnings[0]!.id, 'Too late to acknowledge'), 'conflict');
    });

    it('finance activates a tax rate only with a second finance approver (Q9)', async () => {
      const rateId = await t.db.tx(SYSTEM, async (c) =>
        (await c.query<{ id: string }>(
          `INSERT INTO rulebook.tax_rate (tax_code, tax_class, currency, rate_bp, base, effective_from, active, provenance, source_note)
           VALUES ('purchasers_levy', 'goods_standard', 'ZWG', 1500, 'hammer', '2026-01-01', false, 'benchmark', 'ZiG levy placeholder') RETURNING id`,
        )).rows[0]!.id,
      );
      await expectAdminError(admin.overrides.request(staff.risk1!, { kind: 'tax_rate_activation', reason: 'Finance confirmed the ZiG levy', payload: { taxRateId: rateId } }), 'forbidden');
      const req = await admin.overrides.request(staff.fin1!, { kind: 'tax_rate_activation', reason: 'Finance confirmed the ZiG levy', payload: { taxRateId: rateId } });
      expect(req.request.status).toBe('pending');
      await expectAdminError(admin.overrides.approve(staff.admin!, req.request.id), 'forbidden');
      await admin.overrides.approve(staff.fin2!, req.request.id);
      const rate = await t.db.query<{ active: boolean; approved_by: string }>('SELECT active, approved_by FROM rulebook.tax_rate WHERE id = $1', [rateId]);
      expect(rate.rows[0]).toEqual({ active: true, approved_by: staff.fin2!.id });
      expect((await admin.rulebook.taxRateList()).find((r) => r.id === rateId)).toMatchObject({ active: true, approvedBy: staff.fin2!.id });
    });
  });

  describe('risk console', () => {
    let linked: string;
    let x: string;
    let y: string;
    let z: string;
    let registrationId: string;

    beforeAll(async () => {
      linked = await createAccount(t.db, { name: 'Linked buyer', verification: 'full' });
      [x, y, z] = [
        await createAccount(t.db, { name: 'Bidder X', verification: 'full' }),
        await createAccount(t.db, { name: 'Bidder Y', verification: 'full' }),
        await createAccount(t.db, { name: 'Bidder Z', verification: 'full' }),
      ];
      await t.db.tx(SYSTEM, async (c) => {
        for (const id of [seller, linked]) await c.query(`INSERT INTO identity.link_signal (account_id, signal_type, signal_hmac) VALUES ($1, 'device', '\\x0101')`, [id]);
        for (const id of [x, y, z]) await c.query(`INSERT INTO identity.link_signal (account_id, signal_type, signal_hmac) VALUES ($1, 'device', '\\x0202')`, [id]);
      });
    });

    it('a registration linked to the seller waits in the queue with its reasons and the linked accounts', async () => {
      const a = await createAuction(t.db, { createdBy: staff.ops!.id, lots: [{ sellerId: seller, startingBidMinor: 1_000n, endsAt: new Date(Date.now() + 5 * HOUR) }] });
      await bidding.openAuction(SYSTEM, a.auctionId);
      const j = await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: linked, auctionId: a.auctionId }));
      expect(j.decision).toEqual({ status: 'pending_review', reasons: ['linked_to_seller'] });
      registrationId = j.registrationId;
      const queue = await admin.risk.pendingRegistrations();
      expect(queue).toEqual([
        expect.objectContaining({
          registrationId, reasons: ['linked_to_seller'], targetMinutes: 5,
          linkedAccounts: [expect.objectContaining({ id: seller, sharedSignals: ['device'], isSellerInAuction: true })],
        }),
      ]);
    });

    it('risk staff decide with a reason; others cannot; deciding twice returns the first decision', async () => {
      await expectAdminError(admin.risk.decideRegistration(staff.ops!, registrationId, 'approved', 'Family phone, checked by call'), 'forbidden');
      await expectAdminError(admin.risk.decideRegistration(staff.risk1!, registrationId, 'approved', 'ok'), 'invalid');
      const d = await admin.risk.decideRegistration(staff.risk1!, registrationId, 'approved', 'Family phone, checked by call');
      expect(d).toMatchObject({ status: 'approved', alreadyDecided: false, limits: { USD: expect.objectContaining({ limitMinor: 50_000n }) } });
      expect(await admin.risk.decideRegistration(staff.risk1!, registrationId, 'approved', 'Family phone, checked by call')).toMatchObject({ alreadyDecided: true });
      await expectAdminError(admin.risk.decideRegistration(staff.risk1!, registrationId, 'rejected', 'Changed my mind about it'), 'conflict');
      const row = await t.db.query<{ decided_by: string; decision_note: string }>('SELECT decided_by, decision_note FROM registration.registration WHERE id = $1', [registrationId]);
      expect(row.rows[0]).toEqual({ decided_by: staff.risk1!.id, decision_note: 'Family phone, checked by call' });
      expect(await admin.risk.pendingRegistrations()).toEqual([]);
    });

    it('clusters accounts that share a signal', async () => {
      const clusters = await admin.risk.linkClusters();
      expect(clusters.map((c) => c.accounts.map((a) => a.id).sort())).toEqual(expect.arrayContaining([[seller, linked].sort(), [x, y, z].sort()]));
      expect(clusters.find((c) => c.size === 2)).toMatchObject({ signalTypes: ['device'], accounts: expect.arrayContaining([expect.objectContaining({ id: seller, isSeller: true })]) });
    });

    it('flags a bidder who keeps bidding on one seller\'s lots and never wins, and accounts bidding from one device', async () => {
      const end = new Date(Date.now() + HOUR);
      const a = await createAuction(t.db, {
        createdBy: staff.ops!.id,
        lots: [0, 1, 2].map(() => ({ sellerId: seller, startingBidMinor: 1_000n, endsAt: end })),
      });
      await bidding.openAuction(SYSTEM, a.auctionId);
      for (const who of [x, y, z]) await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: who, auctionId: a.auctionId }));
      expect(await bid(z, a.lots[0]!.auctionLotId, 1_200n)).toMatchObject({ accepted: true });
      for (const l of a.lots) expect(await bid(x, l.auctionLotId, 2_000n)).toMatchObject({ accepted: true });
      for (const l of a.lots) expect(await bid(y, l.auctionLotId, 3_000n)).toMatchObject({ accepted: true });
      await bidding.closeDueLots(new Date(end.getTime() + 1_000));

      const found = await admin.risk.anomalies();
      expect(found.thresholds.bidUp).toEqual({ windowDays: 90, minLots: 3, maxWins: 0 });
      expect(found.bidUp).toEqual([expect.objectContaining({ bidder: expect.objectContaining({ id: x }), seller: expect.objectContaining({ id: seller }), lotsBid: 3, lotsWon: 0, linkedToSeller: false })]);
      expect(found.sharedSignals).toEqual([
        expect.objectContaining({ signalType: 'device', accounts: expect.arrayContaining([expect.objectContaining({ id: x }), expect.objectContaining({ id: y }), expect.objectContaining({ id: z })]) }),
      ]);
    });
  });

  describe('default ladder appeals and waivers', () => {
    it('waivers granted before the steps run prevent them; the ladder never applies them', async () => {
      const buyer = await createAccount(t.db, { name: 'Appealing buyer', verification: 'full' });
      const inv = await unpaidInvoice(buyer, 60_000n, 50_000n);
      const due = new Date(inv.issuedAt.getTime() + 48 * HOUR);
      expect(await settlement.runDefaultLadder(due)).toEqual([{ invoiceId: inv.invoiceId, applied: ['warning'] }]);
      const dash = await opsDashboard(t.db, { now: new Date(due.getTime() + HOUR) });
      expect(dash.unpaidInvoices).toEqual(expect.arrayContaining([expect.objectContaining({ bucket: 'overdue_under_24h', currency: 'USD', count: 1, totalMinor: 91_350n })]));

      const caseId = await inv.caseId();
      const appeal = await admin.defaults.appeal({ type: 'account', id: buyer, name: 'Buyer' }, caseId, ['deposit_forfeit', 'relist_fee', 'tier_drop'], 'EcoCash was down for the whole of the due date');
      expect((await admin.defaults.appeal({ type: 'account', id: buyer, name: 'Buyer' }, caseId, ['relist_fee'], 'Second attempt at the same appeal')).repeated).toBe(true);
      await expectAdminError(admin.defaults.appeal({ type: 'account', id: seller, name: 'Not the buyer' }, caseId, ['relist_fee'], 'Someone else trying to appeal'), 'not_found');

      // US$500 deposit is at (not above) the US$500 threshold: one person is enough.
      const forfeit = await admin.overrides.request(staff.risk1!, { kind: 'default_waiver', reason: 'Gateway outage confirmed by Paynow', payload: { caseId, step: 'deposit_forfeit', appealId: appeal.appealId } });
      expect(forfeit.request).toMatchObject({ status: 'executed', actionType: 'deposit_forfeit_waiver', amountMinor: 50_000n });
      expect(forfeit.result).toMatchObject({ effect: 'prevented', journalIds: [] });
      const fee = await admin.overrides.request(staff.risk1!, { kind: 'default_waiver', reason: 'Gateway outage confirmed by Paynow', payload: { caseId, step: 'relist_fee', appealId: appeal.appealId } });
      expect(fee.request).toMatchObject({ status: 'executed', actionType: 'fee_waiver', amountMinor: 7_000n });

      const later = new Date(inv.issuedAt.getTime() + 72 * HOUR);
      expect(await settlement.runDefaultLadder(later)).toEqual([{ invoiceId: inv.invoiceId, applied: ['tier_drop'] }]);
      expect(await settlement.runDefaultLadder(new Date(later.getTime() + 24 * HOUR))).toEqual([]);
      expect(await wallet(t.db, buyer, 'USD')).toEqual({ currency: 'USD', availableMinor: 60_000n, heldMinor: 0n }); // deposit back, no fee
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'forfeiture_income' }, 'USD')).toBe(0n);
      const invoice = await t.db.query<{ status: string }>('SELECT status FROM settlement.invoice WHERE id = $1', [inv.invoiceId]);
      expect(invoice.rows[0]!.status).toBe('defaulted'); // the invoice is still cancelled and the lot relisted (A62)
      const lot = await t.db.query<{ state: string }>('SELECT state FROM catalogue.lot WHERE id = $1', [inv.lotId]);
      expect(lot.rows[0]!.state).toBe('listed');

      // The tier drop ran; waiving it reverses it, and needs two people even without an amount.
      const tier = await admin.overrides.request(staff.risk1!, { kind: 'default_waiver', reason: 'Gateway outage confirmed by Paynow', payload: { caseId, step: 'tier_drop' } });
      expect(tier.request.status).toBe('pending');
      const done = await admin.overrides.approve(staff.risk2!, tier.request.id);
      expect(done.result).toMatchObject({ effect: 'reversed' });
      const acct = await t.db.query<{ tier: string }>('SELECT tier FROM identity.account WHERE id = $1', [buyer]);
      expect(acct.rows[0]!.tier).toBe('verified');
      const view = await admin.defaults.case(caseId);
      expect(view).toMatchObject({ status: 'waived', stepsApplied: ['warning', 'tier_drop'] });
      expect(view.waivers.map((w) => [w.step, w.effect])).toEqual([['deposit_forfeit', 'prevented'], ['relist_fee', 'prevented'], ['tier_drop', 'reversed']]);
      await expectAdminError(admin.overrides.request(staff.risk1!, { kind: 'default_waiver', reason: 'Trying to waive it twice over', payload: { caseId, step: 'relist_fee' } }), 'conflict');

      await expectAdminError(admin.defaults.decideAppeal(staff.support!, appeal.appealId, 'upheld', 'Outage confirmed'), 'forbidden');
      expect(await admin.defaults.decideAppeal(staff.risk2!, appeal.appealId, 'upheld', 'Outage confirmed by Paynow for the due date')).toMatchObject({ status: 'upheld' });
      expect((await admin.defaults.buyerCases(buyer))[0]!.appeals[0]).toMatchObject({ status: 'upheld' });
    });

    it('waivers granted after the steps ran reverse them through ledger journals, with a second person above the threshold', async () => {
      const buyer = await createAccount(t.db, { name: 'Late appeal buyer', verification: 'full' });
      const inv = await unpaidInvoice(buyer, 150_000n, 100_000n);
      await settlement.runDefaultLadder(new Date(inv.issuedAt.getTime() + 48 * HOUR));
      await settlement.runDefaultLadder(new Date(inv.issuedAt.getTime() + 72 * HOUR));
      expect(await wallet(t.db, buyer, 'USD')).toEqual({ currency: 'USD', availableMinor: 50_000n - 7_000n, heldMinor: 0n });
      const forfeitIncome = await balance(t.db, { owner: { type: 'platform' }, purpose: 'forfeiture_income' }, 'USD');
      const feeIncome = await balance(t.db, { owner: { type: 'platform' }, purpose: 'fee_income', sub: 'relist_fee' }, 'USD');
      const caseId = await inv.caseId();

      const forfeit = await admin.overrides.request(staff.fin1!, { kind: 'default_waiver', reason: 'Buyer was in hospital; records seen', payload: { caseId, step: 'deposit_forfeit' } });
      expect(forfeit.request).toMatchObject({ status: 'pending', amountMinor: 100_000n });
      await expectAdminError(admin.overrides.approve(staff.fin1!, forfeit.request.id), 'forbidden');
      const done = await admin.overrides.approve(staff.risk2!, forfeit.request.id);
      expect(done.result).toMatchObject({ effect: 'reversed', journalIds: [expect.any(String), expect.any(String)] });
      const fee = await admin.overrides.request(staff.risk1!, { kind: 'default_waiver', reason: 'Buyer was in hospital; records seen', payload: { caseId, step: 'relist_fee' } });
      expect(fee.result).toMatchObject({ effect: 'reversed', journalIds: [expect.any(String)] });

      expect(await wallet(t.db, buyer, 'USD')).toEqual({ currency: 'USD', availableMinor: 150_000n, heldMinor: 0n });
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'forfeiture_income' }, 'USD')).toBe(forfeitIncome - 100_000n);
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'fee_income', sub: 'relist_fee' }, 'USD')).toBe(feeIncome - 7_000n);
      const kinds = await t.db.query<{ kind: string }>(
        `SELECT j.kind FROM ledger.journal j WHERE j.id = ANY((SELECT array_agg(x) FROM settlement.default_waiver w, unnest(w.journal_ids) x WHERE w.default_case_id = $1)::uuid[]) ORDER BY j.created_at`,
        [caseId],
      );
      expect(kinds.rows.map((k) => k.kind)).toEqual(['reversal', 'hold_release', 'reversal']);
      expect((await admin.defaults.case(caseId)).status).toBe('completed'); // the tier drop stands
      expect(await reconcileLedger(t.db)).toEqual([]);
    });
  });

  describe('reconciliation queue', () => {
    it('lists exceptions, resolves them with notes, and writes off a shortfall only with a second person', async () => {
      const payer = await createAccount(t.db, { name: 'Payer', verification: 'full' });
      const refs = [await ecocashTopUp(payer, 5_000n), await ecocashTopUp(payer, 5_000n)];
      const fake = paynow as unknown as { payments: Map<string, { status: string; amountMinor: bigint }> };
      fake.payments.get(refs[0]!)!.status = 'cancelled'; // the gateway never settled it
      fake.payments.get(refs[1]!)!.amountMinor = 4_990n; // the gateway settled ten cents less
      paynow.injectUnknownPaid('USD', 2_000n);
      await payments.reconcileDay('paynow', 'USD', new Date().toISOString().slice(0, 10));

      const queue = await admin.reconciliation.queue();
      const missingAtSource = queue.find((q) => q.outcome === 'missing_at_source' && q.payment?.amountMinor === 5_000n && q.externalReference === refs[0])!;
      const mismatch = queue.find((q) => q.outcome === 'amount_mismatch')!;
      const unknown = queue.find((q) => q.outcome === 'missing_in_system' && q.statementAmountMinor === 2_000n)!;
      expect(mismatch).toMatchObject({ differenceMinor: -10n, withinTolerance: false, shortfallMinor: 10n });
      expect(missingAtSource.shortfallMinor).toBe(5_000n);

      await expectAdminError(admin.reconciliation.resolve(staff.fin1!, mismatch.itemId, { resolution: 'within_tolerance', note: 'Rounding at the gateway' }), 'conflict', /tolerance/);
      await expectAdminError(admin.reconciliation.resolve(staff.ops!, unknown.itemId, { resolution: 'gateway_error', note: 'Gateway test transaction' }), 'forbidden');
      const resolved = await admin.reconciliation.resolve(staff.fin1!, unknown.itemId, { resolution: 'gateway_error', note: 'Paynow confirmed a test transaction' });
      expect(resolved.resolution).toBe('gateway_error');
      expect((await admin.reconciliation.resolve(staff.fin1!, unknown.itemId, { resolution: 'gateway_error', note: 'Paynow confirmed a test transaction' })).resolution).toBe('gateway_error');
      await expectAdminError(admin.reconciliation.resolve(staff.fin1!, unknown.itemId, { resolution: 'matched_manually', note: 'Second thoughts about it', paymentId: randomUUID() }), 'conflict');

      await expectAdminError(admin.overrides.request(staff.fin1!, { kind: 'reconciliation_write_off', reason: 'Nothing to write off here', payload: { itemId: unknown.itemId } }), 'conflict');
      const clearingBefore = await balance(t.db, { owner: { type: 'gateway', id: 'paynow' }, purpose: 'gateway_clearing' }, 'USD');
      const wo = await admin.overrides.request(staff.fin1!, { kind: 'reconciliation_write_off', reason: 'Paynow will not settle this payment', payload: { itemId: missingAtSource.itemId } });
      expect(wo.request).toMatchObject({ status: 'pending', actionType: 'ledger_adjustment', amountMinor: 5_000n });
      await expectAdminError(admin.overrides.approve(staff.fin1!, wo.request.id), 'forbidden');
      const approved = await admin.overrides.approve(staff.fin2!, wo.request.id);
      expect(approved.result).toMatchObject({ journalId: expect.any(String) });
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'write_off' }, 'USD')).toBe(5_000n);
      expect(await balance(t.db, { owner: { type: 'gateway', id: 'paynow' }, purpose: 'gateway_clearing' }, 'USD')).toBe(clearingBefore - 5_000n);
      const left = await admin.reconciliation.queue();
      expect(left.map((q) => q.itemId)).toEqual([mismatch.itemId]);
    });
  });

  describe('auction scheduling', () => {
    async function draftLot(photos: number, title: string): Promise<string> {
      return t.db.tx({ type: 'staff', id: staff.ops!.id, name: 'Ops', reason: 'intake' }, async (c) => {
        const consignment = randomUUID();
        await c.query(`INSERT INTO seller.consignment (id, seller_account_id, consignment_type, intake_channel) VALUES ($1, $2, 'commission', 'branch')`, [consignment, seller]);
        const lot = await c.query<{ id: string }>(
          `INSERT INTO catalogue.lot (lot_ref, consignment_id, seller_account_id, category_code, is_vehicle, title, description, item_state, condition,
                                      location_branch, settlement_currency, tax_class, starting_bid_minor)
           VALUES ($1, $2, $3, 'it', false, $4, 'Dell Latitude laptop, 16 GB memory, charger included, tested.', 'used', 'working', 'HRE', 'USD', 'goods_standard', 5000)
           RETURNING id`,
          [`SCHED-${randomUUID().slice(0, 8)}`, consignment, seller, title],
        );
        const roles = ['overall', 'label', 'detail', 'detail'];
        for (let k = 0; k < photos; k++) {
          await c.query(`INSERT INTO catalogue.lot_media (lot_id, kind, role, object_key, sort) VALUES ($1, 'photo', $2, $3, $4)`, [lot.rows[0]!.id, roles[k] ?? 'detail', `test/${randomUUID()}.jpg`, k]);
        }
        return lot.rows[0]!.id;
      });
    }

    it('creates an auction once per code, attaches only ready lots with staggered ends, and opens it', async () => {
      const firstClose = new Date(Date.now() + 3 * HOUR);
      const input = { code: 'HRE-TEST-SCHED', title: 'Laptops and IT (test)', branch: 'HRE', opensAt: new Date(), firstCloseAt: firstClose };
      await expectAdminError(admin.auctions.create(staff.auditor!, input), 'forbidden');
      await expectAdminError(admin.auctions.create(staff.ops!, { ...input, softCloseSeconds: 45 }), 'invalid', /test values/);
      const created = await admin.auctions.create(staff.ops!, input);
      expect(created).toMatchObject({ created: true, staggerSeconds: 90 }); // the published rule set's stagger
      expect(await admin.auctions.create(staff.ops!, input)).toMatchObject({ created: false, auctionId: created.auctionId });

      const ready1 = await draftLot(4, 'Dell Latitude 5420');
      const notReady = await draftLot(1, 'HP ProBook');
      const ready2 = await draftLot(4, 'Lenovo ThinkPad T14');
      await expectAdminError(admin.auctions.open(staff.ops!, created.auctionId), 'conflict', /at least one lot/);
      const attached = await admin.auctions.attachLots(staff.ops!, created.auctionId, [ready1, notReady, ready2]);
      expect(attached.map((a) => [a.attached, a.lotNumber ?? null])).toEqual([[true, 1], [false, null], [true, 2]]);
      expect(attached[1]!.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['too_few_photos']));
      expect(attached[0]!.scheduledEndAt!.getTime()).toBe(firstClose.getTime());
      expect(attached[2]!.scheduledEndAt!.getTime()).toBe(firstClose.getTime() + 90_000);
      expect((await admin.auctions.attachLots(staff.ops!, created.auctionId, [ready1]))[0]).toMatchObject({ attached: true, alreadyAttached: true });

      const opened = await admin.auctions.open(staff.ops!, created.auctionId);
      expect(opened).toMatchObject({ lots: 2, alreadyOpen: false, ruleVersionId: await rulebook.activeVersionId(new Date()) });
      expect((await admin.auctions.open(staff.ops!, created.auctionId)).alreadyOpen).toBe(true);
      const states = await t.db.query<{ state: string }>('SELECT state FROM catalogue.lot WHERE id = ANY($1::uuid[]) ORDER BY state', [[ready1, notReady, ready2]]);
      expect(states.rows.map((s) => s.state)).toEqual(['draft', 'live', 'live']);

      const dash = await opsDashboard(t.db, { now: firstClose, branch: 'HRE' });
      expect(dash.closingToday.map((l) => l.title)).toContain('Dell Latitude 5420');
      expect((await opsDashboard(t.db, { now: firstClose, branch: 'BYO' })).closingToday).toEqual([]);
    });
  });
});
