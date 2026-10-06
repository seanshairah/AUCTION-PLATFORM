import type { Currency } from '@abc/domain';
import { big, isUniqueViolation, run, type Actor, type Client, type Db, type Queryable, type RulebookStore } from '@abc/db';
import { fullRefundAndReturn, postJournal, refundToWallet } from '@abc/ledger';
import type { RuleSnapshot } from '@abc/rules';
import { deductRefundFromPayout, holdLotPayouts, lotPayoutState, recordClawback, releaseDisputeHolds } from '@abc/settlement';
import type { ClaimFindings, VehicleService } from '@abc/vehicles';
import {
  claimWindowClosesAt,
  defaultPriority,
  disputeDeadlines,
  refundNeedsSecondApprover,
  refundPlan,
  statusForRemedy,
  ticketDueDates,
  type DisputeCategory,
  type LotSale,
  type Remedy,
  type TicketCategory,
  type TicketChannel,
  type TicketPriority,
} from './support';

/**
 * Support and disputes service (docs/17-support-disputes.md). Disputes: a buyer's
 * claim within the claim window, payouts held while it is open, a staff decision with
 * a remedy, refunds through the ledger, clawbacks, and two-person approval above the
 * rulebook threshold. Tickets: one queue for every channel, with owners, targets and
 * SLA breach flags. Every write runs in db.tx with the actor (R3).
 */

type Account = Actor & { type: 'account' };
type Staff = Actor & { type: 'staff' };
const SYSTEM_SUPPORT: Actor = { type: 'system', id: 'support', name: 'Support' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function outbox(c: Client, topic: string, aggregateType: string, aggregateId: string, payload: unknown): Promise<void> {
  await c.query('INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4::jsonb)', [
    topic,
    aggregateType,
    aggregateId,
    JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ]);
}

export type RaiseDisputeResult =
  | { raised: true; disputeId: string; responseDueAt: Date; decisionDueAt: Date; payoutsHeld: number; repeated: boolean }
  | { raised: false; reason: 'not_found' | 'not_released' | 'claim_window_closed' | 'already_open' | 'not_a_vehicle' | 'unknown_condition'; message: string; disputeId?: string };

export type DecideResult =
  | { decided: true; status: 'upheld' | 'partially_upheld' | 'rejected'; remedy: Remedy; refundMinor: bigint; currency: Currency; fundedBy: 'seller' | 'platform' | null; clawbackId: string | null; assessment: Assessment | null }
  | {
      decided: false;
      reason: 'not_found' | 'already_decided' | 'findings_required' | 'assessment_does_not_qualify' | 'refund_required' | 'refund_too_large' | 'second_approval_required' | 'no_inspection_report';
      message: string;
      maxMinor?: bigint;
      refundMinor?: bigint;
    };

export interface Assessment {
  qualifies: boolean;
  reasons: string[];
  reportId: string;
  findings: ClaimFindings;
}

interface DisputeRow {
  id: string;
  lot_id: string;
  invoice_id: string;
  raised_by: string;
  category: DisputeCategory;
  status: string;
  owner_staff_id: string | null;
  remedy: Remedy | null;
  refund_minor: bigint | null;
  currency: Currency;
  rule_version_id: string;
  is_vehicle: boolean;
  seller_account_id: string;
  lot_ref: string;
  lot_state: string;
}

const DISPUTE_SQL = `
  SELECT d.id, d.lot_id, d.invoice_id, d.raised_by, d.category, d.status, d.owner_staff_id, d.remedy, d.refund_minor,
         i.currency, i.rule_version_id, l.is_vehicle, l.seller_account_id, l.lot_ref, l.state AS lot_state
    FROM support.dispute d JOIN settlement.invoice i ON i.id = d.invoice_id JOIN catalogue.lot l ON l.id = d.lot_id
   WHERE d.id = $1`;

export class SupportService {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    private readonly vehicles: VehicleService,
  ) {}

  private async activeSnapshot(at: Date, c?: Client): Promise<RuleSnapshot> {
    return this.rulebook.snapshot(await this.rulebook.activeVersionId(at, c), c);
  }

  private async dispute(q: Queryable, id: string, lock = false): Promise<DisputeRow | null> {
    if (!UUID.test(id)) return null;
    const r = await run<DisputeRow>(q, DISPUTE_SQL + (lock ? ' FOR UPDATE OF d' : ''), [id]);
    return r.rows[0] ?? null;
  }

  private async isStaff(q: Queryable, accountId: string): Promise<boolean> {
    if (!UUID.test(accountId)) return false;
    return Boolean((await run(q, 'SELECT 1 FROM identity.staff_role WHERE account_id = $1', [accountId])).rowCount);
  }

  // --- Disputes: raising --------------------------------------------------------------------

  /**
   * A buyer claims against a lot they bought, within the claim window after release
   * (after delivery, for delivered goods). Every unpaid payout containing the lot is
   * held until the claim is decided. Idempotent on the client key.
   */
  async raiseDispute(
    account: Account,
    p: {
      lotId: string;
      category: DisputeCategory;
      description: string;
      claimedCondition?: string;
      evidence: Array<{ kind: 'photo' | 'video' | 'document'; objectKey: string }>;
      clientKey: string;
    },
    now: Date = new Date(),
  ): Promise<RaiseDisputeResult> {
    try {
      return await this.db.tx(account, async (c): Promise<RaiseDisputeResult> => {
        const prior = await c.query<{ id: string; response_due_at: Date; decision_due_at: Date }>(
          'SELECT id, response_due_at, decision_due_at FROM support.dispute WHERE raised_by = $1 AND client_key = $2',
          [account.id, p.clientKey],
        );
        if (prior.rows[0]) {
          const d = prior.rows[0];
          return { raised: true, disputeId: d.id, responseDueAt: d.response_due_at, decisionDueAt: d.decision_due_at, payoutsHeld: 0, repeated: true };
        }
        if (!UUID.test(p.lotId)) return { raised: false, reason: 'not_found', message: 'We could not find that purchase.' };
        const bought = (await c.query<{ lot_id: string; condition: string; is_vehicle: boolean; state: string; invoice_id: string; rule_version_id: string; released_at: Date | null; delivered_at: Date | null }>(
          `SELECT l.id AS lot_id, l.condition, l.is_vehicle, l.state, i.id AS invoice_id, i.rule_version_id, c.released_at,
                  (SELECT max(d.delivered_at) FROM logistics.delivery d WHERE d.collection_id = c.id AND d.status = 'delivered') AS delivered_at
             FROM logistics.collection_lot cl
             JOIN logistics.collection c ON c.id = cl.collection_id
             JOIN settlement.invoice i ON i.id = c.invoice_id
             JOIN catalogue.lot l ON l.id = cl.lot_id
            WHERE cl.lot_id = $1 AND i.buyer_account_id = $2 AND i.status = 'paid'
            ORDER BY c.released_at DESC NULLS LAST LIMIT 1
            FOR UPDATE OF l`,
          [p.lotId, account.id],
        )).rows[0];
        if (!bought) return { raised: false, reason: 'not_found', message: 'We could not find that purchase.' };
        if (!bought.released_at || !['released', 'paid_out'].includes(bought.state)) {
          return { raised: false, reason: 'not_released', message: 'Check your goods with our staff when you collect them. Claims can be made here once the goods are released to you.' };
        }
        const snapshot = await this.rulebook.snapshot(bought.rule_version_id, c);
        const closes = claimWindowClosesAt(bought.delivered_at ?? bought.released_at, snapshot);
        if (now.getTime() > closes.getTime()) {
          return { raised: false, reason: 'claim_window_closed', message: `The claim window closed on ${closes.toISOString()}. Open a support ticket if you need help.` };
        }
        if (p.category === 'inspection_inaccuracy' && !bought.is_vehicle) {
          return { raised: false, reason: 'not_a_vehicle', message: 'Inspection claims apply to vehicles with an inspection report. Choose "not as described" instead.' };
        }
        if (p.claimedCondition) {
          const known = await c.query('SELECT 1 FROM catalogue.condition_term WHERE code = $1', [p.claimedCondition]);
          if (!known.rowCount) return { raised: false, reason: 'unknown_condition', message: 'Choose a condition from the list.' };
        }
        const open = await c.query<{ id: string }>(`SELECT id FROM support.dispute WHERE lot_id = $1 AND status IN ('open', 'under_review')`, [p.lotId]);
        if (open.rows[0]) return { raised: false, reason: 'already_open', message: 'A claim for this lot is already open.', disputeId: open.rows[0].id };

        const due = disputeDeadlines(now, snapshot);
        const d = await c.query<{ id: string }>(
          `INSERT INTO support.dispute (lot_id, invoice_id, raised_by, category, listed_condition, claimed_condition, description,
                                        response_due_at, decision_due_at, client_key, raised_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [p.lotId, bought.invoice_id, account.id, p.category, bought.condition, p.claimedCondition ?? null, p.description,
           due.responseDueAt, due.decisionDueAt, p.clientKey, now],
        );
        const disputeId = d.rows[0]!.id;
        for (const e of p.evidence) {
          await c.query(
            'INSERT INTO support.dispute_evidence (dispute_id, kind, object_key, uploaded_by) VALUES ($1, $2, $3, $4) ON CONFLICT (object_key) DO NOTHING',
            [disputeId, e.kind, e.objectKey, account.id],
          );
        }
        const held = await holdLotPayouts(c, { lotId: p.lotId, disputeId });
        await outbox(c, 'dispute.raised', 'dispute', disputeId, { lotId: p.lotId, category: p.category, payoutsHeld: held.length });
        return { raised: true, disputeId, responseDueAt: due.responseDueAt, decisionDueAt: due.decisionDueAt, payoutsHeld: held.length, repeated: false };
      });
    } catch (e) {
      if (isUniqueViolation(e)) return this.raiseDispute(account, p, now); // a concurrent retry or claim won; answer from its row
      throw e;
    }
  }

  /** Staff take ownership: the claim gets a named owner and moves under review. */
  async assignDispute(staff: Staff, disputeId: string, ownerStaffId: string = staff.id): Promise<{ assigned: boolean; reason?: 'not_found' | 'not_staff' | 'already_decided' }> {
    return this.db.tx(staff, async (c) => {
      const d = await this.dispute(c, disputeId, true);
      if (!d) return { assigned: false, reason: 'not_found' as const };
      if (!['open', 'under_review'].includes(d.status)) return { assigned: false, reason: 'already_decided' as const };
      if (!(await this.isStaff(c, ownerStaffId))) return { assigned: false, reason: 'not_staff' as const };
      await c.query(`UPDATE support.dispute SET owner_staff_id = $2, status = 'under_review' WHERE id = $1`, [disputeId, ownerStaffId]);
      await outbox(c, 'dispute.assigned', 'dispute', disputeId, { ownerStaffId });
      return { assigned: true };
    });
  }

  // --- Disputes: money -----------------------------------------------------------------------

  private async lotSale(c: Client, d: Pick<DisputeRow, 'invoice_id' | 'lot_id'>): Promise<LotSale> {
    const lines = await c.query<{ line_type: string; amount_minor: bigint }>(
      'SELECT line_type, amount_minor FROM settlement.invoice_line WHERE invoice_id = $1 AND lot_id = $2 ORDER BY sort, id',
      [d.invoice_id, d.lot_id],
    );
    const commission = await c.query<{ amount: bigint }>(
      `SELECT coalesce(-sum(p.amount_minor), 0)::bigint AS amount
         FROM ledger.journal j JOIN ledger.posting p ON p.journal_id = j.id JOIN ledger.book_account b ON b.id = p.book_account_id
        WHERE j.idempotency_key = $1 AND b.purpose = 'commission_income'`,
      [`commission:${d.invoice_id}:${d.lot_id}`],
    );
    return {
      hammerMinor: lines.rows.filter((l) => l.line_type === 'hammer').reduce((a, l) => a + l.amount_minor, 0n),
      commissionMinor: commission.rows[0]!.amount,
      otherLines: lines.rows
        .filter((l) => l.line_type !== 'hammer' && l.amount_minor !== 0n)
        .map((l) => ({ type: l.line_type as LotSale['otherLines'][number]['type'], amountMinor: l.amount_minor })),
    };
  }

  /**
   * Asks for a second staff member's approval of a refund (R3, A55). The amount is
   * worked out the way the decision will work it out, so the approver sees the figure
   * that will move.
   */
  async requestRefundApproval(
    staff: Staff,
    disputeId: string,
    p: { remedy: 'partial_refund' | 'full_refund_and_return'; refundMinor?: bigint; reason: string },
  ): Promise<{ requested: true; overrideRequestId: string; amountMinor: bigint; currency: Currency; requiresSecondApproval: boolean } | { requested: false; reason: string; message: string }> {
    return this.db.tx(staff, async (c) => {
      const d = await this.dispute(c, disputeId, true);
      if (!d) return { requested: false, reason: 'not_found', message: 'We could not find that claim.' };
      if (!['open', 'under_review'].includes(d.status)) return { requested: false, reason: 'already_decided', message: 'This claim has been decided.' };
      if (p.reason.trim().length < 10) return { requested: false, reason: 'reason_required', message: 'Give a reason of at least 10 characters.' };
      const plan = refundPlan(p.remedy, await this.lotSale(c, d), p.refundMinor);
      if (!plan.ok) return { requested: false, reason: plan.reason, message: plan.reason === 'refund_too_large' ? 'A partial refund cannot exceed the seller’s share of the sale.' : 'Enter the refund amount.' };
      const snapshot = await this.rulebook.snapshot(d.rule_version_id, c);
      const requiresSecondApproval = refundNeedsSecondApprover(plan.refundMinor, d.currency, snapshot);
      const r = await c.query<{ id: string }>(
        `INSERT INTO audit.override_request (action_type, entity_type, entity_id, currency, amount_minor, reason, requested_by, requires_second_approval)
         VALUES ('refund', 'support.dispute', $1, $2, $3, $4, $5, $6) RETURNING id`,
        [disputeId, d.currency, big(plan.refundMinor), p.reason.trim(), staff.id, requiresSecondApproval],
      );
      await outbox(c, 'override.requested', 'override_request', r.rows[0]!.id, { disputeId, amountMinor: plan.refundMinor, currency: d.currency });
      return { requested: true, overrideRequestId: r.rows[0]!.id, amountMinor: plan.refundMinor, currency: d.currency, requiresSecondApproval };
    });
  }

  /** The second person approves or rejects a refund request. The database refuses the requester as approver. */
  async decideRefundApproval(staff: Staff, overrideRequestId: string, p: { approve: boolean; note?: string }): Promise<{ ok: boolean; reason?: 'not_found' | 'not_pending' | 'same_person' }> {
    return this.db.tx(staff, async (c) => {
      if (!UUID.test(overrideRequestId)) return { ok: false, reason: 'not_found' as const };
      const o = (await c.query<{ status: string; requested_by: string }>(
        `SELECT status, requested_by FROM audit.override_request WHERE id = $1 AND action_type = 'refund' AND entity_type = 'support.dispute' FOR UPDATE`,
        [overrideRequestId],
      )).rows[0];
      if (!o) return { ok: false, reason: 'not_found' as const };
      if (o.status !== 'pending') return { ok: false, reason: 'not_pending' as const };
      if (o.requested_by === staff.id) return { ok: false, reason: 'same_person' as const };
      await c.query(
        `UPDATE audit.override_request SET status = $2, approved_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
        [overrideRequestId, p.approve ? 'approved' : 'rejected', p.approve ? staff.id : null, p.note ?? null],
      );
      return { ok: true };
    });
  }

  /**
   * Decides a claim. Refunds go to the buyer's wallet through the ledger: from the
   * seller's unpaid proceeds (the payout for the lot is reduced), or, if the seller has
   * already been paid, fronted by ABC and clawed back from the seller's next payouts.
   * A full refund returns the lot to the seller. Vehicle inspection claims are assessed
   * against the published report, and the assessment is kept with the decision.
   */
  async decideDispute(
    staff: Staff,
    disputeId: string,
    p: { remedy: Remedy; decision: string; refundMinor?: bigint; findings?: ClaimFindings; overrideRequestId?: string },
    now: Date = new Date(),
  ): Promise<DecideResult> {
    const pre = await this.dispute(this.db, disputeId);
    if (!pre) return { decided: false, reason: 'not_found', message: 'We could not find that claim.' };
    let assessment: Assessment | null = null;
    if (pre.category === 'inspection_inaccuracy' && pre.is_vehicle) {
      if (!p.findings) return { decided: false, reason: 'findings_required', message: 'Record what staff found on the vehicle (numbers, odometer, failing items).' };
      const a = await this.vehicles.assessClaim(pre.lot_id, p.findings);
      if (!a) return { decided: false, reason: 'no_inspection_report', message: 'This vehicle has no published inspection report to assess against.' };
      assessment = { ...a, findings: p.findings };
      if ((p.remedy === 'partial_refund' || p.remedy === 'full_refund_and_return') && !a.qualifies) {
        return { decided: false, reason: 'assessment_does_not_qualify', message: 'The findings are not a gross inaccuracy against the inspection report, so they do not support a refund.' };
      }
    }

    return this.db.tx(staff, async (c): Promise<DecideResult> => {
      const d = await this.dispute(c, disputeId, true);
      if (!d) return { decided: false, reason: 'not_found', message: 'We could not find that claim.' };
      if (!['open', 'under_review'].includes(d.status)) return { decided: false, reason: 'already_decided', message: 'This claim has already been decided.' };
      const sale = await this.lotSale(c, d);
      const plan = refundPlan(p.remedy, sale, p.refundMinor);
      if (!plan.ok) {
        return plan.reason === 'refund_too_large'
          ? { decided: false, reason: 'refund_too_large', message: 'A partial refund cannot exceed the seller’s share of the sale.', ...(plan.maxMinor !== undefined ? { maxMinor: plan.maxMinor } : {}) }
          : { decided: false, reason: 'refund_required', message: 'Enter the refund amount.' };
      }
      const snapshot = await this.rulebook.snapshot(d.rule_version_id, c);
      let overrideId: string | null = null;
      if (plan.refundMinor > 0n && refundNeedsSecondApprover(plan.refundMinor, d.currency, snapshot)) {
        const ok = p.overrideRequestId && UUID.test(p.overrideRequestId)
          ? (await c.query(
              `SELECT 1 FROM audit.override_request WHERE id = $1 AND action_type = 'refund' AND entity_type = 'support.dispute' AND entity_id = $2
                  AND amount_minor = $3 AND currency = $4 AND status = 'approved' FOR UPDATE`,
              [p.overrideRequestId, disputeId, big(plan.refundMinor), d.currency],
            )).rowCount
          : 0;
        if (!ok) {
          return { decided: false, reason: 'second_approval_required', message: 'This refund is above the limit one person can approve. Ask a second staff member to approve it first.', refundMinor: plan.refundMinor };
        }
        overrideId = p.overrideRequestId!;
      }

      // Money first: the refund journal, then the seller's side (payout reduced or clawback).
      let journalId: string | null = null;
      let fundedBy: 'seller' | 'platform' | null = null;
      let clawbackId: string | null = null;
      if (plan.refundMinor > 0n) {
        const payout = await lotPayoutState(c, d.lot_id);
        fundedBy = payout.kind === 'paid' ? 'platform' : 'seller';
        journalId = p.remedy === 'full_refund_and_return'
          ? await postJournal(c, fullRefundAndReturn({
              disputeId, buyerId: d.raised_by, sellerId: d.seller_account_id, currency: d.currency,
              hammerMinor: sale.hammerMinor, commissionMinor: sale.commissionMinor, otherLines: sale.otherLines, fundedBy,
            }))
          : await postJournal(c, refundToWallet({
              disputeId, buyerId: d.raised_by, currency: d.currency, amountMinor: plan.refundMinor,
              fundedBy: fundedBy === 'platform' ? 'platform' : { sellerId: d.seller_account_id },
            }));
        if (payout.kind === 'unpaid' && plan.sellerShareMinor > 0n) {
          await deductRefundFromPayout(c, { payoutId: payout.payoutId, lotId: d.lot_id, invoiceId: d.invoice_id, disputeId, amountMinor: plan.sellerShareMinor });
        } else if (payout.kind === 'paid' && plan.sellerShareMinor > 0n) {
          clawbackId = await recordClawback(c, { disputeId, sellerId: d.seller_account_id, currency: d.currency, amountMinor: plan.sellerShareMinor });
        }
      }

      const status = statusForRemedy(p.remedy);
      await c.query(
        `UPDATE support.dispute SET status = $2, remedy = $3, refund_minor = $4, decision = $5, decided_by = $6, decided_at = $7,
                assessment = $8::jsonb, override_request_id = $9, refund_journal_id = $10, owner_staff_id = coalesce(owner_staff_id, $6)
          WHERE id = $1`,
        [disputeId, status, p.remedy, plan.refundMinor > 0n ? big(plan.refundMinor) : null, p.decision, staff.id, now,
         assessment ? JSON.stringify(assessment) : null, overrideId, journalId],
      );
      if (overrideId) await c.query(`UPDATE audit.override_request SET status = 'executed' WHERE id = $1`, [overrideId]);
      if (p.remedy === 'full_refund_and_return') await c.query(`UPDATE catalogue.lot SET state = 'refunded' WHERE id = $1`, [d.lot_id]);
      await releaseDisputeHolds(c, disputeId, now);
      await outbox(c, 'dispute.decided', 'dispute', disputeId, { status, remedy: p.remedy, refundMinor: plan.refundMinor, fundedBy, clawbackId });
      return { decided: true, status, remedy: p.remedy, refundMinor: plan.refundMinor, currency: d.currency, fundedBy, clawbackId, assessment };
    });
  }

  /** The goods are back at the branch after a full refund: returned to the seller (withdrawn) or offered again (listed). */
  async recordReturn(staff: Staff, disputeId: string, outcome: 'withdrawn' | 'listed'): Promise<{ ok: boolean; reason?: 'not_found' | 'not_a_return' }> {
    return this.db.tx(staff, async (c) => {
      const d = await this.dispute(c, disputeId, true);
      if (!d) return { ok: false, reason: 'not_found' as const };
      if (d.remedy !== 'full_refund_and_return' || d.lot_state !== 'refunded') return { ok: false, reason: 'not_a_return' as const };
      await c.query('UPDATE catalogue.lot SET state = $2 WHERE id = $1', [d.lot_id, outcome]);
      await c.query('UPDATE support.dispute SET return_outcome = $2 WHERE id = $1', [disputeId, outcome]);
      await outbox(c, 'dispute.goods_returned', 'dispute', disputeId, { outcome });
      return { ok: true };
    });
  }

  // --- Disputes: reading -----------------------------------------------------------------------

  async myDisputes(accountId: string): Promise<DisputeView[]> {
    return this.disputeViews('d.raised_by = $1', [accountId]);
  }

  /** The staff queue: open claims first, by response deadline. */
  async disputeQueue(p: { status?: 'open' | 'under_review' | 'decided' | 'all' } = {}): Promise<DisputeView[]> {
    const where = p.status === 'all' ? 'true'
      : p.status === 'decided' ? `d.status NOT IN ('open', 'under_review')`
      : p.status ? 'd.status = $1' : `d.status IN ('open', 'under_review')`;
    return this.disputeViews(where, p.status && !['all', 'decided'].includes(p.status) ? [p.status] : []);
  }

  private async disputeViews(where: string, params: unknown[]): Promise<DisputeView[]> {
    const r = await this.db.query<{
      id: string; lot_id: string; lot_ref: string; title: string; invoice_id: string; category: string; status: string; listed_condition: string; claimed_condition: string | null;
      description: string; owner_staff_id: string | null; owner_name: string | null; response_due_at: Date; decision_due_at: Date | null; remedy: string | null;
      refund_minor: bigint | null; decision: string | null; decided_at: Date | null; raised_at: Date; currency: Currency; assessment: Assessment | null; evidence: string[] | null;
    }>(
      `SELECT d.id, d.lot_id, l.lot_ref, l.title, d.invoice_id, d.category, d.status, d.listed_condition, d.claimed_condition, d.description,
              d.owner_staff_id, o.display_name AS owner_name, d.response_due_at, d.decision_due_at, d.remedy, d.refund_minor, d.decision, d.decided_at,
              d.raised_at, i.currency, d.assessment,
              (SELECT array_agg(e.object_key ORDER BY e.uploaded_at) FROM support.dispute_evidence e WHERE e.dispute_id = d.id) AS evidence
         FROM support.dispute d JOIN catalogue.lot l ON l.id = d.lot_id JOIN settlement.invoice i ON i.id = d.invoice_id
         LEFT JOIN identity.account o ON o.id = d.owner_staff_id
        WHERE ${where}
        ORDER BY (d.status IN ('open', 'under_review')) DESC, d.response_due_at`,
      params,
    );
    const now = Date.now();
    return r.rows.map((d) => ({
      id: d.id, lotId: d.lot_id, lotRef: d.lot_ref, lotTitle: d.title, invoiceId: d.invoice_id, category: d.category, status: d.status,
      listedCondition: d.listed_condition, claimedCondition: d.claimed_condition, description: d.description,
      owner: d.owner_staff_id ? { id: d.owner_staff_id, name: d.owner_name ?? '' } : null,
      responseDueAt: d.response_due_at, decisionDueAt: d.decision_due_at,
      overdue: ['open', 'under_review'].includes(d.status) && ((d.status === 'open' && d.response_due_at.getTime() < now) || (d.decision_due_at !== null && d.decision_due_at.getTime() < now)),
      remedy: d.remedy, refundMinor: d.refund_minor, currency: d.currency, decision: d.decision, decidedAt: d.decided_at, raisedAt: d.raised_at,
      assessment: d.assessment, evidence: d.evidence ?? [],
    }));
  }

  // --- Tickets ---------------------------------------------------------------------------------

  /**
   * Opens a support ticket. Customers open their own (web, WhatsApp); staff open one for
   * a customer on the phone or at a branch. Targets come from support.ticket_targets.
   */
  async openTicket(
    actor: Account | Staff,
    p: {
      accountId: string; channel: TicketChannel; category: TicketCategory; subject: string; body: string;
      priority?: TicketPriority; lotId?: string; invoiceId?: string; disputeId?: string; clientKey?: string;
    },
    now: Date = new Date(),
  ): Promise<{ opened: true; ticketId: string; ticketNumber: string; firstResponseDueAt: Date; resolutionDueAt: Date; repeated: boolean } | { opened: false; reason: 'not_found' | 'invalid_link'; message: string }> {
    try {
      return await this.db.tx(actor, async (c) => {
        if (p.clientKey) {
          const prior = (await c.query<{ id: string; ticket_number: string; first_response_due_at: Date; resolution_due_at: Date }>(
            'SELECT id, ticket_number, first_response_due_at, resolution_due_at FROM support.ticket WHERE opened_by = $1 AND client_key = $2',
            [actor.id, p.clientKey],
          )).rows[0];
          if (prior) return { opened: true as const, ticketId: prior.id, ticketNumber: prior.ticket_number, firstResponseDueAt: prior.first_response_due_at, resolutionDueAt: prior.resolution_due_at, repeated: true };
        }
        if (!UUID.test(p.accountId) || !(await c.query('SELECT 1 FROM identity.account WHERE id = $1', [p.accountId])).rowCount) {
          return { opened: false as const, reason: 'not_found' as const, message: 'We could not find that customer.' };
        }
        for (const id of [p.lotId, p.invoiceId, p.disputeId]) if (id !== undefined && !UUID.test(id)) return { opened: false as const, reason: 'invalid_link' as const, message: 'That link is not valid.' };
        if (p.invoiceId && !(await c.query('SELECT 1 FROM settlement.invoice WHERE id = $1 AND buyer_account_id = $2', [p.invoiceId, p.accountId])).rowCount) {
          return { opened: false as const, reason: 'invalid_link' as const, message: 'That invoice is not on this account.' };
        }
        if (p.lotId && !(await c.query(
          `SELECT 1 FROM catalogue.lot l WHERE l.id = $1 AND (l.seller_account_id = $2 OR EXISTS (
              SELECT 1 FROM settlement.invoice_line il JOIN settlement.invoice i ON i.id = il.invoice_id WHERE il.lot_id = l.id AND i.buyer_account_id = $2)
           OR EXISTS (SELECT 1 FROM auction.auction_lot al WHERE al.lot_id = l.id))`,
          [p.lotId, p.accountId],
        )).rowCount) {
          return { opened: false as const, reason: 'invalid_link' as const, message: 'We could not find that lot.' };
        }
        if (p.disputeId && !(await c.query('SELECT 1 FROM support.dispute WHERE id = $1 AND raised_by = $2', [p.disputeId, p.accountId])).rowCount) {
          return { opened: false as const, reason: 'invalid_link' as const, message: 'That claim is not on this account.' };
        }
        const priority = actor.type === 'staff' && p.priority ? p.priority : defaultPriority(p.category);
        const due = ticketDueDates(priority, now, await this.activeSnapshot(now, c));
        const t = (await c.query<{ id: string; ticket_number: string }>(
          `INSERT INTO support.ticket (account_id, opened_by, channel, category, subject, priority, lot_id, invoice_id, dispute_id, client_key,
                                       first_response_due_at, resolution_due_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id, ticket_number`,
          [p.accountId, actor.id, p.channel, p.category, p.subject.trim(), priority, p.lotId ?? null, p.invoiceId ?? null, p.disputeId ?? null,
           p.clientKey ?? null, due.firstResponseDueAt, due.resolutionDueAt, now],
        )).rows[0]!;
        await c.query(
          'INSERT INTO support.ticket_message (ticket_id, author_account_id, author_kind, body, created_at) VALUES ($1, $2, $3, $4, $5)',
          [t.id, actor.id, actor.type === 'staff' ? 'staff' : 'customer', p.body, now],
        );
        await outbox(c, 'ticket.opened', 'ticket', t.id, { accountId: p.accountId, channel: p.channel, category: p.category, priority, lotId: p.lotId ?? null, invoiceId: p.invoiceId ?? null });
        return { opened: true as const, ticketId: t.id, ticketNumber: t.ticket_number, firstResponseDueAt: due.firstResponseDueAt, resolutionDueAt: due.resolutionDueAt, repeated: false };
      });
    } catch (e) {
      if (isUniqueViolation(e) && p.clientKey) return this.openTicket(actor, p, now);
      throw e;
    }
  }

  /**
   * Adds a message. The first public staff reply records the first response
   * (event ticket.first_reply). A customer message on a resolved ticket reopens it.
   */
  async addMessage(
    actor: Account | Staff,
    ticketId: string,
    p: { body: string; internal?: boolean; resolve?: boolean; clientKey?: string },
    now: Date = new Date(),
  ): Promise<{ added: true; messageId: string; status: string; repeated: boolean } | { added: false; reason: 'not_found' | 'closed'; message: string }> {
    const asStaff = actor.type === 'staff';
    try {
      return await this.db.tx(actor, async (c) => {
        if (!UUID.test(ticketId)) return { added: false as const, reason: 'not_found' as const, message: 'We could not find that ticket.' };
        const t = (await c.query<{ id: string; account_id: string; status: string; owner_staff_id: string | null; first_responded_at: Date | null; created_at: Date; first_response_due_at: Date }>(
          'SELECT id, account_id, status, owner_staff_id, first_responded_at, created_at, first_response_due_at FROM support.ticket WHERE id = $1 FOR UPDATE',
          [ticketId],
        )).rows[0];
        if (!t || (!asStaff && t.account_id !== actor.id)) return { added: false as const, reason: 'not_found' as const, message: 'We could not find that ticket.' };
        if (p.clientKey) {
          const prior = (await c.query<{ id: string }>('SELECT id FROM support.ticket_message WHERE ticket_id = $1 AND author_account_id = $2 AND client_key = $3', [ticketId, actor.id, p.clientKey])).rows[0];
          if (prior) return { added: true as const, messageId: String(prior.id), status: t.status, repeated: true };
        }
        if (t.status === 'closed') return { added: false as const, reason: 'closed' as const, message: 'This ticket is closed. Open a new one and we will pick it up.' };
        const internal = asStaff && Boolean(p.internal);
        const m = (await c.query<{ id: string }>(
          'INSERT INTO support.ticket_message (ticket_id, author_account_id, author_kind, body, internal, client_key, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
          [ticketId, actor.id, asStaff ? 'staff' : 'customer', p.body, internal, p.clientKey ?? null, now],
        )).rows[0]!;
        let status = t.status;
        if (asStaff && !internal) {
          if (!t.first_responded_at) {
            await c.query('UPDATE support.ticket SET first_responded_at = $2 WHERE id = $1', [ticketId, now]);
            await outbox(c, 'ticket.first_reply', 'ticket', ticketId, {
              minutesToFirstReply: Math.round((now.getTime() - t.created_at.getTime()) / 60_000),
              withinTarget: now.getTime() <= t.first_response_due_at.getTime(),
            });
          }
          status = p.resolve ? 'resolved' : 'pending_customer';
        } else if (!asStaff) {
          status = 'open';
        }
        if (asStaff && !t.owner_staff_id) await c.query('UPDATE support.ticket SET owner_staff_id = $2 WHERE id = $1', [ticketId, actor.id]);
        if (status !== t.status) {
          await c.query('UPDATE support.ticket SET status = $2, resolved_at = $3 WHERE id = $1', [ticketId, status, status === 'resolved' ? now : null]);
          if (status === 'resolved') await outbox(c, 'ticket.resolved', 'ticket', ticketId, { minutesToResolve: Math.round((now.getTime() - t.created_at.getTime()) / 60_000) });
        }
        return { added: true as const, messageId: String(m.id), status, repeated: false };
      });
    } catch (e) {
      if (isUniqueViolation(e) && p.clientKey) return this.addMessage(actor, ticketId, p, now);
      throw e;
    }
  }

  /** Assigns an owner and, optionally, a new priority (targets are recalculated from when the ticket was opened). */
  async assignTicket(staff: Staff, ticketId: string, p: { ownerStaffId: string; priority?: TicketPriority }): Promise<{ assigned: boolean; reason?: 'not_found' | 'not_staff' }> {
    return this.db.tx(staff, async (c) => {
      if (!UUID.test(ticketId)) return { assigned: false, reason: 'not_found' as const };
      const t = (await c.query<{ created_at: Date; priority: TicketPriority }>('SELECT created_at, priority FROM support.ticket WHERE id = $1 FOR UPDATE', [ticketId])).rows[0];
      if (!t) return { assigned: false, reason: 'not_found' as const };
      if (!(await this.isStaff(c, p.ownerStaffId))) return { assigned: false, reason: 'not_staff' as const };
      await c.query('UPDATE support.ticket SET owner_staff_id = $2 WHERE id = $1', [ticketId, p.ownerStaffId]);
      if (p.priority && p.priority !== t.priority) {
        const due = ticketDueDates(p.priority, t.created_at, await this.activeSnapshot(t.created_at, c));
        await c.query('UPDATE support.ticket SET priority = $2, first_response_due_at = $3, resolution_due_at = $4 WHERE id = $1', [ticketId, p.priority, due.firstResponseDueAt, due.resolutionDueAt]);
      }
      await outbox(c, 'ticket.assigned', 'ticket', ticketId, { ownerStaffId: p.ownerStaffId, priority: p.priority ?? t.priority });
      return { assigned: true };
    });
  }

  async myTickets(accountId: string): Promise<TicketView[]> {
    return this.ticketViews('t.account_id = $1', [accountId], false);
  }

  async ticket(ticketId: string, viewer: { accountId: string; staff: boolean }): Promise<TicketView | null> {
    if (!UUID.test(ticketId)) return null;
    const rows = await this.ticketViews(viewer.staff ? 't.id = $1' : 't.id = $1 AND t.account_id = $2', viewer.staff ? [ticketId] : [ticketId, viewer.accountId], viewer.staff);
    return rows[0] ?? null;
  }

  /** The staff queue: breached and soonest-due first. */
  async ticketQueue(p: { status?: 'open' | 'pending_customer' | 'resolved' | 'closed' | 'active'; ownerStaffId?: string } = {}): Promise<TicketView[]> {
    const params: unknown[] = [];
    const conds: string[] = [];
    if (!p.status || p.status === 'active') conds.push(`t.status IN ('open', 'pending_customer')`);
    else {
      params.push(p.status);
      conds.push(`t.status = $${params.length}`);
    }
    if (p.ownerStaffId) {
      params.push(p.ownerStaffId);
      conds.push(`t.owner_staff_id = $${params.length}`);
    }
    return this.ticketViews(conds.join(' AND '), params, true);
  }

  private async ticketViews(where: string, params: unknown[], staffView: boolean): Promise<TicketView[]> {
    const r = await this.db.query<{
      id: string; ticket_number: string; account_id: string; account_name: string; channel: string; category: string; subject: string; priority: string; status: string;
      owner_staff_id: string | null; owner_name: string | null; lot_id: string | null; invoice_id: string | null; dispute_id: string | null;
      first_response_due_at: Date; resolution_due_at: Date; first_responded_at: Date | null; resolved_at: Date | null;
      first_response_breached_at: Date | null; resolution_breached_at: Date | null; created_at: Date;
    }>(
      `SELECT t.*, a.display_name AS account_name, o.display_name AS owner_name
         FROM support.ticket t JOIN identity.account a ON a.id = t.account_id LEFT JOIN identity.account o ON o.id = t.owner_staff_id
        WHERE ${where}
        ORDER BY (t.first_response_breached_at IS NOT NULL OR t.resolution_breached_at IS NOT NULL) DESC, t.first_response_due_at`,
      params,
    );
    if (!r.rowCount) return [];
    const msgs = await this.db.query<{ id: string; ticket_id: string; author_kind: string; author_name: string; body: string; internal: boolean; created_at: Date }>(
      `SELECT m.id, m.ticket_id, m.author_kind, a.display_name AS author_name, m.body, m.internal, m.created_at
         FROM support.ticket_message m JOIN identity.account a ON a.id = m.author_account_id
        WHERE m.ticket_id = ANY($1::uuid[]) ${staffView ? '' : 'AND NOT m.internal'} ORDER BY m.id`,
      [r.rows.map((t) => t.id)],
    );
    return r.rows.map((t) => ({
      id: t.id, number: t.ticket_number, account: { id: t.account_id, name: t.account_name }, channel: t.channel, category: t.category, subject: t.subject,
      priority: t.priority, status: t.status, owner: t.owner_staff_id ? { id: t.owner_staff_id, name: t.owner_name ?? '' } : null,
      lotId: t.lot_id, invoiceId: t.invoice_id, disputeId: t.dispute_id,
      firstResponseDueAt: t.first_response_due_at, resolutionDueAt: t.resolution_due_at, firstRespondedAt: t.first_responded_at, resolvedAt: t.resolved_at,
      breached: { firstResponse: t.first_response_breached_at !== null, resolution: t.resolution_breached_at !== null },
      createdAt: t.created_at,
      messages: msgs.rows.filter((m) => m.ticket_id === t.id).map((m) => ({
        id: String(m.id), author: m.author_kind, authorName: staffView || m.author_kind === 'customer' ? m.author_name : 'ABC Auctions support', body: m.body, internal: m.internal, at: m.created_at,
      })),
    }));
  }

  // --- SLA breach detection (worker) -------------------------------------------------------------

  /**
   * Flags tickets that missed their first-response or resolution target, and claims
   * that missed their response or decision deadline. Each flag is raised once.
   */
  async flagSlaBreaches(now: Date = new Date()): Promise<{ firstResponse: number; resolution: number; disputes: number }> {
    return this.db.tx(SYSTEM_SUPPORT, async (c) => {
      const first = await c.query<{ id: string; owner_staff_id: string | null }>(
        `UPDATE support.ticket SET first_response_breached_at = $1
          WHERE first_responded_at IS NULL AND first_response_due_at < $1 AND first_response_breached_at IS NULL AND status IN ('open', 'pending_customer')
          RETURNING id, owner_staff_id`,
        [now],
      );
      for (const t of first.rows) await outbox(c, 'ticket.sla_breached', 'ticket', t.id, { target: 'first_response', ownerStaffId: t.owner_staff_id });
      const resolution = await c.query<{ id: string; owner_staff_id: string | null }>(
        `UPDATE support.ticket SET resolution_breached_at = $1
          WHERE status IN ('open', 'pending_customer') AND resolution_due_at < $1 AND resolution_breached_at IS NULL
          RETURNING id, owner_staff_id`,
        [now],
      );
      for (const t of resolution.rows) await outbox(c, 'ticket.sla_breached', 'ticket', t.id, { target: 'resolution', ownerStaffId: t.owner_staff_id });

      let disputes = 0;
      const overdue = await c.query<{ id: string; kind: string }>(
        `SELECT d.id, 'response' AS kind FROM support.dispute d WHERE d.status = 'open' AND d.response_due_at < $1
         UNION ALL
         SELECT d.id, 'decision' FROM support.dispute d WHERE d.status IN ('open', 'under_review') AND d.decision_due_at < $1`,
        [now],
      );
      for (const d of overdue.rows) {
        const topic = `dispute.${d.kind}_overdue`;
        if ((await c.query('SELECT 1 FROM core.outbox WHERE topic = $1 AND aggregate_id = $2', [topic, d.id])).rowCount) continue;
        await outbox(c, topic, 'dispute', d.id, {});
        disputes++;
      }
      return { firstResponse: first.rowCount ?? 0, resolution: resolution.rowCount ?? 0, disputes };
    });
  }
}

export interface DisputeView {
  id: string;
  lotId: string;
  lotRef: string;
  lotTitle: string;
  invoiceId: string;
  category: string;
  status: string;
  listedCondition: string;
  claimedCondition: string | null;
  description: string;
  owner: { id: string; name: string } | null;
  responseDueAt: Date;
  decisionDueAt: Date | null;
  overdue: boolean;
  remedy: string | null;
  refundMinor: bigint | null;
  currency: Currency;
  decision: string | null;
  decidedAt: Date | null;
  raisedAt: Date;
  assessment: Assessment | null;
  evidence: string[];
}

export interface TicketView {
  id: string;
  number: string;
  account: { id: string; name: string };
  channel: string;
  category: string;
  subject: string;
  priority: string;
  status: string;
  owner: { id: string; name: string } | null;
  lotId: string | null;
  invoiceId: string | null;
  disputeId: string | null;
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
  firstRespondedAt: Date | null;
  resolvedAt: Date | null;
  breached: { firstResponse: boolean; resolution: boolean };
  createdAt: Date;
  messages: Array<{ id: string; author: string; authorName: string; body: string; internal: boolean; at: Date }>;
}
