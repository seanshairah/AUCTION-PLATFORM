import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccount,
  createTestDatabase,
  DB_TESTS_ENABLED,
  loadPublishedRuleSetForTests,
  readRuleSetDocument,
  RulebookStore,
  SYSTEM,
  type Actor,
  type TestDatabase,
} from '@abc/db';
import { LogisticsService } from '@abc/logistics';
import { addPayoutDestination, createPaidInvoices, type PaidPurchase } from '@abc/logistics/testing';
import { balance, gatewaySettlement, postJournal, reconcileLedger, wallet } from '@abc/ledger';
import { RuleSnapshot, type RuleRecord } from '@abc/rules';
import { SettlementService } from '@abc/settlement';
import { CHECKLISTS, VehicleService, type InspectionInput } from '@abc/vehicles';
import { refundNeedsSecondApprover, refundPlan, statusForRemedy, SupportService, ticketDueDates } from './index';

const DOC = readRuleSetDocument();
const HOUR = 3_600_000;
const COMMISSION: RuleRecord = {
  key: 'commission.schedule', scope: { type: 'global', ref: '*' }, provenance: 'assumption', source: 'TEST ONLY: illustrative 10 % (Q3)',
  value: { basis: 'flat_band', bands: { USD: [{ from: 0, rateBp: 1000 }], ZWG: null }, minimumPerLot: { USD: 0, ZWG: null } },
};

describe('support rules (pure)', () => {
  const snapshot = new RuleSnapshot('v', DOC.label, DOC.rules);
  const sale = { hammerMinor: 26_000n, commissionMinor: 2_600n, otherLines: [{ type: 'purchasers_levy' as const, amountMinor: 3_900n }, { type: 'vat' as const, amountMinor: 4_030n }] };

  it('a full refund returns everything paid for the lot; the seller loses their net share', () => {
    expect(refundPlan('full_refund_and_return', sale)).toEqual({ ok: true, refundMinor: 33_930n, sellerShareMinor: 23_400n });
  });

  it('a partial refund comes from the seller’s share and cannot exceed it', () => {
    expect(refundPlan('partial_refund', sale, 5_000n)).toEqual({ ok: true, refundMinor: 5_000n, sellerShareMinor: 5_000n });
    expect(refundPlan('partial_refund', sale, 23_401n)).toEqual({ ok: false, reason: 'refund_too_large', maxMinor: 23_400n });
    expect(refundPlan('partial_refund', sale)).toEqual({ ok: false, reason: 'refund_required' });
    expect(refundPlan('repair_or_replace', sale)).toEqual({ ok: true, refundMinor: 0n, sellerShareMinor: 0n });
    expect(['none', 'partial_refund', 'full_refund_and_return', 'repair_or_replace'].map((r) => statusForRemedy(r as never))).toEqual(['rejected', 'partially_upheld', 'upheld', 'upheld']);
  });

  it('refunds above US$500 need a second approver; every ZiG refund does until finance sets a figure', () => {
    expect(refundNeedsSecondApprover(50_000n, 'USD', snapshot)).toBe(false);
    expect(refundNeedsSecondApprover(50_001n, 'USD', snapshot)).toBe(true);
    expect(refundNeedsSecondApprover(1n, 'ZWG', snapshot)).toBe(true);
  });

  it('ticket targets come from the rulebook by priority', () => {
    const at = new Date('2026-11-20T08:00:00Z');
    expect(ticketDueDates('urgent', at, snapshot).firstResponseDueAt.toISOString()).toBe('2026-11-20T09:00:00.000Z');
    expect(ticketDueDates('normal', at, snapshot).resolutionDueAt.toISOString()).toBe('2026-11-23T08:00:00.000Z');
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('disputes and tickets against PostgreSQL', () => {
  let t: TestDatabase;
  let rulebook: RulebookStore;
  let settlement: SettlementService;
  let logistics: LogisticsService;
  let vehicles: VehicleService;
  let support: SupportService;
  let agent: Actor & { type: 'staff' };
  let finance: Actor & { type: 'staff' };
  let seller: string;
  let sellerC: string;
  const SECRET = 'gate-pass-secret';
  const as = (id: string): Actor & { type: 'account' } => ({ type: 'account', id, name: 'Buyer' });
  const buy = async (sellerId: string, lots: Array<{ title: string; category?: string; startingBidMinor: bigint }>): Promise<PaidPurchase> => {
    const buyer = await createAccount(t.db, { name: 'Buyer', verification: 'full' });
    return (await createPaidInvoices(t.db, { staffId: agent.id, sellerId, gatePassSecret: SECRET, purchases: [{ buyerId: buyer, lots }] }))[0]!;
  };
  const payoutOf = async (lotId: string) =>
    (await t.db.query<{ id: string; status: string; net_minor: bigint; deductions_minor: bigint }>(
      `SELECT p.id, p.status, p.net_minor, p.deductions_minor FROM payout.payout p WHERE EXISTS (SELECT 1 FROM payout.payout_line l WHERE l.payout_id = p.id AND l.lot_id = $1 AND l.line_type = 'hammer')`,
      [lotId],
    )).rows[0]!;
  const sellerPayable = (id: string) => balance(t.db, { owner: { type: 'seller', id }, purpose: 'seller_payable' }, 'USD');

  beforeAll(async () => {
    t = await createTestDatabase();
    await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true, overrides: [COMMISSION] });
    rulebook = new RulebookStore(t.db);
    settlement = new SettlementService(t.db, rulebook, { gatePassSecret: SECRET });
    logistics = new LogisticsService(t.db, rulebook, settlement);
    vehicles = new VehicleService(t.db, rulebook);
    support = new SupportService(t.db, rulebook, vehicles);
    const a = await createAccount(t.db, { name: 'Support agent', verification: 'full' });
    const f = await createAccount(t.db, { name: 'Finance approver', verification: 'full' });
    await t.db.tx(SYSTEM, async (c) => {
      await c.query(`INSERT INTO identity.staff_role (account_id, role, granted_by) VALUES ($1, 'support', $2), ($2, 'finance', $1)`, [a, f]);
    });
    agent = { type: 'staff', id: a, name: 'Support agent' };
    finance = { type: 'staff', id: f, name: 'Finance approver' };
    seller = await createAccount(t.db, { name: 'Seller' });
    sellerC = await createAccount(t.db, { name: 'Seller C' });
    await addPayoutDestination(t.db, seller);
    await addPayoutDestination(t.db, sellerC);
  });
  afterAll(async () => {
    await t?.drop();
  });

  describe('A: a partial refund before the seller is paid', () => {
    let pu: PaidPurchase;
    let disputeId: string;

    it('claims open only after release and hold the seller’s payout', async () => {
      pu = await buy(seller, [{ title: 'Laptop', startingBidMinor: 26_000n }]);
      const claim = { lotId: pu.lotIds[0]!, category: 'not_as_described' as const, description: 'Screen has dead pixels not mentioned in the listing.', claimedCondition: 'damaged', evidence: [{ kind: 'photo' as const, objectKey: 'evidence/a-1.jpg' }], clientKey: 'claim-a' };
      expect(await support.raiseDispute(as(pu.buyerId), claim)).toMatchObject({ raised: false, reason: 'not_released' });
      expect(await logistics.releaseAtGate(agent, pu.gatePassToken)).toMatchObject({ released: true });
      expect(await payoutOf(pu.lotIds[0]!)).toMatchObject({ status: 'scheduled', net_minor: 23_400n });

      const raised = await support.raiseDispute(as(pu.buyerId), claim);
      expect(raised).toMatchObject({ raised: true, payoutsHeld: 1, repeated: false });
      disputeId = (raised as { disputeId: string }).disputeId;
      expect(await support.raiseDispute(as(pu.buyerId), claim)).toMatchObject({ raised: true, disputeId, repeated: true });
      expect(await support.raiseDispute(as(pu.buyerId), { ...claim, clientKey: 'claim-a2' })).toMatchObject({ raised: false, reason: 'already_open', disputeId });
      expect(await support.raiseDispute(as(seller), { ...claim, clientKey: 'claim-x' })).toMatchObject({ raised: false, reason: 'not_found' });

      const payout = await payoutOf(pu.lotIds[0]!);
      expect(payout.status).toBe('held');
      await expect(settlement.markPayoutPaid(finance, payout.id, 'REF-1')).rejects.toThrow(/held/);
      const mine = await support.myDisputes(pu.buyerId);
      expect(mine[0]).toMatchObject({ status: 'open', listedCondition: 'working', claimedCondition: 'damaged', evidence: ['evidence/a-1.jpg'] });
    });

    it('an agent takes it, decides a partial refund; the buyer is refunded and the payout reduced and released', async () => {
      expect(await support.assignDispute(agent, disputeId)).toEqual({ assigned: true });
      expect((await support.disputeQueue())[0]).toMatchObject({ id: disputeId, status: 'under_review', owner: { name: 'Support agent' } });
      const before = (await wallet(t.db, pu.buyerId, 'USD')).availableMinor;
      expect(await support.decideDispute(agent, disputeId, { remedy: 'partial_refund', refundMinor: 30_000n, decision: 'Too much' })).toMatchObject({ decided: false, reason: 'refund_too_large', maxMinor: 23_400n });
      const r = await support.decideDispute(agent, disputeId, { remedy: 'partial_refund', refundMinor: 5_000n, decision: 'Dead pixels confirmed at the branch; partial refund agreed.' });
      expect(r).toMatchObject({ decided: true, status: 'partially_upheld', refundMinor: 5_000n, fundedBy: 'seller', clawbackId: null });
      expect((await wallet(t.db, pu.buyerId, 'USD')).availableMinor).toBe(before + 5_000n);
      expect(await payoutOf(pu.lotIds[0]!)).toMatchObject({ status: 'scheduled', net_minor: 18_400n, deductions_minor: 7_600n });
      expect(await support.decideDispute(agent, disputeId, { remedy: 'none', decision: 'again' })).toMatchObject({ decided: false, reason: 'already_decided' });
    });
  });

  describe('B: a full refund above the threshold needs a second person', () => {
    let pu: PaidPurchase;
    let disputeId: string;

    it('is refused without an approved override, and the requester cannot approve their own', async () => {
      pu = await buy(seller, [{ title: 'Boardroom table', category: 'furniture', startingBidMinor: 60_000n }]);
      await logistics.releaseAtGate(agent, pu.gatePassToken);
      const raised = await support.raiseDispute(as(pu.buyerId), { lotId: pu.lotIds[0]!, category: 'damaged_in_custody', description: 'Table top cracked when collected.', evidence: [{ kind: 'photo', objectKey: 'evidence/b-1.jpg' }], clientKey: 'claim-b' });
      disputeId = (raised as { disputeId: string }).disputeId;
      expect(await support.decideDispute(agent, disputeId, { remedy: 'full_refund_and_return', decision: 'Cracked in our custody.' })).toMatchObject({ decided: false, reason: 'second_approval_required', refundMinor: 78_300n });
      const req = await support.requestRefundApproval(agent, disputeId, { remedy: 'full_refund_and_return', reason: 'Cracked in our custody; full refund and return' });
      expect(req).toMatchObject({ requested: true, amountMinor: 78_300n, requiresSecondApproval: true });
      const overrideId = (req as { overrideRequestId: string }).overrideRequestId;
      expect(await support.decideRefundApproval(agent, overrideId, { approve: true })).toEqual({ ok: false, reason: 'same_person' });
      expect(await support.decideDispute(agent, disputeId, { remedy: 'full_refund_and_return', decision: 'x', overrideRequestId: overrideId })).toMatchObject({ reason: 'second_approval_required' });
      expect(await support.decideRefundApproval(finance, overrideId, { approve: true, note: 'Checked the photos' })).toEqual({ ok: true });

      const payableBefore = await sellerPayable(seller);
      const r = await support.decideDispute(agent, disputeId, { remedy: 'full_refund_and_return', decision: 'Cracked in our custody; refunded in full.', overrideRequestId: overrideId });
      expect(r).toMatchObject({ decided: true, status: 'upheld', refundMinor: 78_300n, fundedBy: 'seller' });
      expect(await sellerPayable(seller)).toBe(payableBefore - 54_000n);
      expect(await payoutOf(pu.lotIds[0]!)).toMatchObject({ status: 'cancelled', net_minor: 0n });
      const o = await t.db.query<{ status: string; approved_by: string }>('SELECT status, approved_by FROM audit.override_request WHERE id = $1', [overrideId]);
      expect(o.rows[0]).toEqual({ status: 'executed', approved_by: finance.id });
      const lot = await t.db.query<{ state: string }>('SELECT state FROM catalogue.lot WHERE id = $1', [pu.lotIds[0]]);
      expect(lot.rows[0]!.state).toBe('refunded');
    });

    it('the goods go back to the seller once returned', async () => {
      expect(await support.recordReturn(agent, disputeId, 'withdrawn')).toEqual({ ok: true });
      const states = await t.db.query<{ to_state: string }>(`SELECT to_state FROM audit.event WHERE entity_type = 'catalogue.lot' AND entity_id = $1 ORDER BY id`, [pu.lotIds[0]]);
      expect(states.rows.map((s) => s.to_state).slice(-4)).toEqual(['paid', 'released', 'refunded', 'withdrawn']);
    });
  });

  describe('C: a refund after the seller was paid is clawed back from their next payout', () => {
    it('ABC fronts the refund and records a clawback', async () => {
      const pu = await buy(sellerC, [{ title: 'Projector', startingBidMinor: 10_000n }]);
      const released = await logistics.releaseAtGate(agent, pu.gatePassToken);
      // Branch cash banked to the trust account (outside the System's recipes today), so the payout can be sent.
      await t.db.tx(SYSTEM, (c) => postJournal(c, gatewaySettlement({ settlementId: 'test-banking-1', gateway: 'paynow', currency: 'USD', amountMinor: 50_000n })));
      await settlement.markPayoutPaid(finance, (released as { payouts: string[] }).payouts[0]!, 'ECO-1');
      const raised = await support.raiseDispute(as(pu.buyerId), { lotId: pu.lotIds[0]!, category: 'not_as_described', description: 'Lamp does not light.', evidence: [], clientKey: 'claim-c' });
      expect(raised).toMatchObject({ raised: true, payoutsHeld: 0 });
      const r = await support.decideDispute(agent, (raised as { disputeId: string }).disputeId, { remedy: 'full_refund_and_return', decision: 'Listed as working; does not work.' });
      expect(r).toMatchObject({ decided: true, refundMinor: 13_050n, fundedBy: 'platform', clawbackId: expect.any(String) });
      const cb = await t.db.query<{ amount_minor: bigint; recovered_minor: bigint; status: string }>('SELECT amount_minor, recovered_minor, status FROM payout.clawback WHERE seller_account_id = $1', [sellerC]);
      expect(cb.rows[0]).toEqual({ amount_minor: 9_000n, recovered_minor: 0n, status: 'open' });
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'suspense' }, 'USD')).toBe(9_000n);
      const lot = await t.db.query<{ state: string }>('SELECT state FROM catalogue.lot WHERE id = $1', [pu.lotIds[0]]);
      expect(lot.rows[0]!.state).toBe('refunded'); // from paid_out
    });

    it('the seller’s next sale repays it, and the books reconcile', async () => {
      const pu = await buy(sellerC, [{ title: 'Camera', startingBidMinor: 20_000n }]);
      await logistics.releaseAtGate(agent, pu.gatePassToken);
      expect(await payoutOf(pu.lotIds[0]!)).toMatchObject({ status: 'scheduled', net_minor: 18_000n - 9_000n });
      const cb = await t.db.query<{ status: string }>('SELECT status FROM payout.clawback WHERE seller_account_id = $1', [sellerC]);
      expect(cb.rows[0]!.status).toBe('recovered');
      expect(await balance(t.db, { owner: { type: 'platform' }, purpose: 'suspense' }, 'USD')).toBe(0n);
      expect(await reconcileLedger(t.db)).toEqual([]);
    });
  });

  describe('D: claim windows and vehicle inspection claims', () => {
    it('a claim after the window is refused', async () => {
      const pu = await buy(seller, [{ title: 'Chair', category: 'furniture', startingBidMinor: 2_000n }]);
      await logistics.releaseAtGate(agent, pu.gatePassToken);
      const late = await support.raiseDispute(as(pu.buyerId), { lotId: pu.lotIds[0]!, category: 'other', description: 'Late claim.', evidence: [], clientKey: 'claim-late' }, new Date(Date.now() + 49 * HOUR));
      expect(late).toMatchObject({ raised: false, reason: 'claim_window_closed' });
      expect(await support.raiseDispute(as(pu.buyerId), { lotId: pu.lotIds[0]!, category: 'inspection_inaccuracy', description: 'x', evidence: [], clientKey: 'claim-iv' })).toMatchObject({ raised: false, reason: 'not_a_vehicle' });
    });

    it('a vehicle claim is assessed against the published report; only a gross inaccuracy supports a refund', async () => {
      const pu = await buy(seller, [{ title: 'Toyota Hilux', category: 'vehicles', startingBidMinor: 200_000n }]);
      const lotId = pu.lotIds[0]!;
      await vehicles.setDetails(agent, lotId, { make: 'Toyota', model: 'Hilux', chassisNumber: 'AHT-123-456', engineNumber: 'ENG-9', zimbabweRegistered: true, odometerKm: 100_000, documentsStatus: 'complete' });
      const answers: InspectionInput['answers'] = {};
      for (const i of CHECKLISTS['vehicle-v1']!) answers[i.id] = { answer: 'ok' };
      const { reportId } = await vehicles.submitInspection(agent, lotId, { checklistVersion: 'vehicle-v1', answers, photoCount: 36, hasVideo: true, chassisNumberSeen: 'AHT123456', engineNumberSeen: 'ENG9', odometerKm: 100_000 });
      expect(await vehicles.publishInspection(agent, reportId)).toMatchObject({ published: true });
      await t.db.tx({ ...agent, reason: 'title steps evidenced' }, async (c) => {
        await c.query(`UPDATE logistics.title_step SET status = 'done', evidence_object_key = 'evidence/' || step || '.pdf', completed_by = $2, completed_at = now() WHERE title_case_id = (SELECT id FROM logistics.title_case WHERE lot_id = $1)`, [lotId, agent.id]);
        await c.query(`UPDATE logistics.title_case SET status = 'complete', completed_at = now() WHERE lot_id = $1`, [lotId]);
      });
      expect(await logistics.releaseAtGate(agent, pu.gatePassToken)).toMatchObject({ released: true });

      const raised = await support.raiseDispute(as(pu.buyerId), { lotId, category: 'inspection_inaccuracy', description: 'Odometer reads far higher than the report.', evidence: [{ kind: 'photo', objectKey: 'evidence/odo.jpg' }], clientKey: 'claim-v' });
      const id = (raised as { disputeId: string }).disputeId;
      expect(await support.decideDispute(agent, id, { remedy: 'partial_refund', refundMinor: 40_000n, decision: 'x' })).toMatchObject({ decided: false, reason: 'findings_required' });
      expect(await support.decideDispute(agent, id, { remedy: 'partial_refund', refundMinor: 40_000n, decision: 'x', findings: { failingItems: ['paint'] } })).toMatchObject({ decided: false, reason: 'assessment_does_not_qualify' });
      const r = await support.decideDispute(agent, id, { remedy: 'partial_refund', refundMinor: 40_000n, decision: 'Odometer 125,000 km against 100,000 km reported.', findings: { odometerKmFound: 125_000 } });
      expect(r).toMatchObject({ decided: true, status: 'partially_upheld', assessment: { qualifies: true, reportId } });
      const stored = await t.db.query<{ assessment: { qualifies: boolean; findings: { odometerKmFound: number } } }>('SELECT assessment FROM support.dispute WHERE id = $1', [id]);
      expect(stored.rows[0]!.assessment).toMatchObject({ qualifies: true, findings: { odometerKmFound: 125_000 } });
    });
  });

  describe('E: support tickets', () => {
    let buyer: string;
    let ticketId: string;

    it('a customer opens a ticket; targets come from the rulebook; retries are idempotent', async () => {
      buyer = await createAccount(t.db, { name: 'Ticket buyer', verification: 'full' });
      const now = new Date();
      const opened = await support.openTicket(as(buyer), { accountId: buyer, channel: 'web', category: 'collection', subject: 'Which gate do I use?', body: 'Collecting a laptop on Friday.', clientKey: 'tk-1' }, now);
      expect(opened).toMatchObject({ opened: true, repeated: false });
      ticketId = (opened as { ticketId: string }).ticketId;
      expect((opened as { firstResponseDueAt: Date }).firstResponseDueAt.getTime() - now.getTime()).toBe(8 * HOUR);
      expect(await support.openTicket(as(buyer), { accountId: buyer, channel: 'web', category: 'collection', subject: 'Which gate do I use?', body: 'again', clientKey: 'tk-1' })).toMatchObject({ opened: true, ticketId, repeated: true });
      expect(await support.openTicket(as(buyer), { accountId: buyer, channel: 'web', category: 'payment', subject: 'x', body: 'x', invoiceId: '00000000-0000-0000-0000-000000000000' })).toMatchObject({ opened: false, reason: 'invalid_link' });
      const ev = await t.db.query('SELECT 1 FROM core.outbox WHERE topic = $1 AND aggregate_id = $2', ['ticket.opened', ticketId]);
      expect(ev.rowCount).toBe(1);
    });

    it('an internal note is not a reply; the first public reply is recorded once; the customer reopens it', async () => {
      await support.addMessage(agent, ticketId, { body: 'Check gate rota', internal: true });
      let view = (await support.ticket(ticketId, { accountId: agent.id, staff: true }))!;
      expect(view).toMatchObject({ firstRespondedAt: null, status: 'open', owner: { id: agent.id } });
      expect(await support.addMessage(agent, ticketId, { body: 'Use the main gate on Samora Machel Ave.' })).toMatchObject({ added: true, status: 'pending_customer' });
      await support.addMessage(agent, ticketId, { body: 'Bring your QR pass.' });
      const first = await t.db.query<{ n: bigint }>(`SELECT count(*) AS n FROM core.outbox WHERE topic = 'ticket.first_reply' AND aggregate_id = $1`, [ticketId]);
      expect(first.rows[0]!.n).toBe(1n);
      expect(await support.addMessage(as(buyer), ticketId, { body: 'Thanks, and parking?', clientKey: 'm-1' })).toMatchObject({ added: true, status: 'open' });
      expect(await support.addMessage(as(buyer), ticketId, { body: 'Thanks, and parking?', clientKey: 'm-1' })).toMatchObject({ added: true, repeated: true });
      expect(await support.addMessage(as(seller), ticketId, { body: 'not mine' })).toMatchObject({ added: false, reason: 'not_found' });
      expect(await support.addMessage(agent, ticketId, { body: 'Parking at the back.', resolve: true })).toMatchObject({ status: 'resolved' });
      view = (await support.myTickets(buyer))[0]!;
      expect(view.status).toBe('resolved');
      expect(view.messages.map((m) => m.body)).not.toContain('Check gate rota');
      expect(view.messages.find((m) => m.author === 'staff')!.authorName).toBe('ABC Auctions support');
    });

    it('staff log a phone call; missed targets are flagged once', async () => {
      const opened = await support.openTicket(agent, { accountId: buyer, channel: 'phone', category: 'payment', subject: 'EcoCash payment not showing', body: 'Customer paid at 10:02, reference MP123.', priority: 'urgent' });
      const id = (opened as { ticketId: string }).ticketId;
      expect(await support.assignTicket(agent, id, { ownerStaffId: buyer })).toEqual({ assigned: false, reason: 'not_staff' });
      expect(await support.assignTicket(agent, id, { ownerStaffId: finance.id })).toEqual({ assigned: true });
      const later = new Date(Date.now() + 2 * HOUR);
      const flags = await support.flagSlaBreaches(later);
      expect(flags.firstResponse).toBe(1);
      expect((await support.flagSlaBreaches(later)).firstResponse).toBe(0);
      const queue = await support.ticketQueue();
      expect(queue[0]).toMatchObject({ id, priority: 'urgent', breached: { firstResponse: true }, owner: { id: finance.id } });
    });

    it('claims past their response and decision deadlines are flagged once each', async () => {
      const pu = await buy(seller, [{ title: 'Fridge', category: 'catering', startingBidMinor: 3_000n }]);
      await logistics.releaseAtGate(agent, pu.gatePassToken);
      const raised = await support.raiseDispute(as(pu.buyerId), { lotId: pu.lotIds[0]!, category: 'missing', description: 'Shelves missing.', evidence: [], clientKey: 'claim-sla' });
      const id = (raised as { disputeId: string }).disputeId;
      await support.flagSlaBreaches(new Date(Date.now() + 25 * HOUR));
      await support.flagSlaBreaches(new Date(Date.now() + 121 * HOUR));
      await support.flagSlaBreaches(new Date(Date.now() + 121 * HOUR));
      const ev = await t.db.query<{ topic: string }>(`SELECT topic FROM core.outbox WHERE aggregate_id = $1 AND topic LIKE 'dispute.%overdue' ORDER BY id`, [id]);
      expect(ev.rows.map((e) => e.topic)).toEqual(['dispute.response_overdue', 'dispute.decision_overdue']);
      expect((await support.disputeQueue()).find((d) => d.id === id)).toMatchObject({ status: 'open' });
    });
  });
});
