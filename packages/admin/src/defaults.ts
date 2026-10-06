import type { Currency } from '@abc/domain';
import { run, type Actor, type Client, type Db, type Queryable, type RulebookStore } from '@abc/db';
import { postJournal, returnForfeitedDeposit, reverseJournalById } from '@abc/ledger';
import { relistFeeAmount } from '@abc/settlement';
import type { OverrideHandler } from './overrides';
import { AdminError, requirePermission, requireReason, staffActor, type StaffMember } from './permissions';

/**
 * Appeals against the default ladder and waivers of its steps (docs/11 §9, docs/18 §7).
 *
 * A buyer (or support, on their behalf) appeals one or more steps with grounds. Risk or
 * finance staff waive a step with a reason through an override: two people above the
 * threshold, and always two for a tier drop (no money amount, A58). A waiver either
 * PREVENTS a step that has not run (the ladder skips it; the database refuses to apply it)
 * or REVERSES one that has: reversal journals put the money back, and a tier drop is
 * undone. Waiving the forfeit returns the deposit, but the unpaid invoice stays cancelled
 * and the lot stays relisted (A62).
 */

export const WAIVABLE_STEPS = ['deposit_forfeit', 'relist_fee', 'tier_drop'] as const;
export type WaivableStep = (typeof WAIVABLE_STEPS)[number];

const ACTION_FOR_STEP = { deposit_forfeit: 'deposit_forfeit_waiver', relist_fee: 'fee_waiver', tier_drop: 'tier_change' } as const;

export interface DefaultCaseView {
  caseId: string;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  invoice: { id: string; number: string; currency: Currency; totalMinor: bigint; status: string; dueAt: Date };
  buyer: { id: string; name: string };
  stepsApplied: string[];
  waivers: Array<{ step: string; effect: string; at: string; journalIds: string[] }>;
  appeals: Array<{ id: string; steps: string[]; grounds: string; status: string; raisedVia: string; raisedAt: string; decisionNote: string | null }>;
  pendingWaivers: Array<{ overrideId: string; step: string }>;
}

interface CaseRow {
  case_id: string;
  case_status: string;
  opened_at: Date;
  closed_at: Date | null;
  invoice_id: string;
  invoice_number: string;
  currency: Currency;
  total_minor: bigint;
  invoice_status: string;
  due_at: Date;
  buyer_id: string;
  buyer_name: string;
  auction_id: string;
  rule_version_id: string;
  steps: string[] | null;
  waivers: DefaultCaseView['waivers'] | null;
  appeals: DefaultCaseView['appeals'] | null;
  pending: DefaultCaseView['pendingWaivers'] | null;
}

const SELECT_CASES = `
  SELECT dc.id AS case_id, dc.status AS case_status, dc.opened_at, dc.closed_at,
         i.id AS invoice_id, i.invoice_number, i.currency, i.total_minor, i.status AS invoice_status, i.due_at,
         i.buyer_account_id AS buyer_id, a.display_name AS buyer_name, i.auction_id, i.rule_version_id,
         (SELECT array_agg(s.step ORDER BY s.applied_at) FROM settlement.default_step s WHERE s.default_case_id = dc.id) AS steps,
         (SELECT json_agg(json_build_object('step', w.step, 'effect', w.effect, 'at', w.waived_at, 'journalIds', w.journal_ids) ORDER BY w.waived_at)
            FROM settlement.default_waiver w WHERE w.default_case_id = dc.id) AS waivers,
         (SELECT json_agg(json_build_object('id', ap.id, 'steps', ap.steps, 'grounds', ap.grounds, 'status', ap.status,
                                            'raisedVia', ap.raised_via, 'raisedAt', ap.raised_at, 'decisionNote', ap.decision_note) ORDER BY ap.raised_at)
            FROM settlement.default_appeal ap WHERE ap.default_case_id = dc.id) AS appeals,
         (SELECT json_agg(json_build_object('overrideId', o.id, 'step', o.payload->>'step'))
            FROM audit.override_request o WHERE o.entity_type = 'settlement.default_case' AND o.entity_id = dc.id::text AND o.status = 'pending') AS pending
    FROM settlement.default_case dc
    JOIN settlement.invoice i ON i.id = dc.invoice_id
    JOIN identity.account a ON a.id = i.buyer_account_id`;

function toCase(r: CaseRow): DefaultCaseView {
  return {
    caseId: r.case_id,
    status: r.case_status,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    invoice: { id: r.invoice_id, number: r.invoice_number, currency: r.currency, totalMinor: r.total_minor, status: r.invoice_status, dueAt: r.due_at },
    buyer: { id: r.buyer_id, name: r.buyer_name },
    stepsApplied: r.steps ?? [],
    waivers: r.waivers ?? [],
    appeals: r.appeals ?? [],
    pendingWaivers: r.pending ?? [],
  };
}

async function caseRow(q: Queryable, caseId: string): Promise<CaseRow> {
  if (!/^[0-9a-f-]{36}$/.test(caseId)) throw new AdminError('invalid', 'That is not a default case reference.');
  const r = await run<CaseRow>(q, `${SELECT_CASES} WHERE dc.id = $1`, [caseId]);
  if (!r.rows[0]) throw new AdminError('not_found', 'We could not find that default case.');
  return r.rows[0];
}

/** Deposit holds placed for this buyer's registration in the invoice's auction, with their status. */
async function auctionHolds(c: Queryable, buyerId: string, auctionId: string): Promise<Array<{ id: string; amount_minor: bigint; status: string; closed_journal_id: string | null }>> {
  const r = await run<{ id: string; amount_minor: bigint; status: string; closed_journal_id: string | null }>(
    c,
    `SELECT h.id, h.amount_minor, h.status, h.closed_journal_id
       FROM registration.registration r
       JOIN ledger.hold h ON h.reference_type = 'registration' AND h.reference_id = r.id::text
      WHERE r.account_id = $1 AND r.auction_id = $2
      ORDER BY h.created_at`,
    [buyerId, auctionId],
  );
  return r.rows;
}

async function appliedStep(c: Queryable, caseId: string, step: WaivableStep): Promise<{ journal_id: string | null } | null> {
  const r = await run<{ journal_id: string | null }>(c, 'SELECT journal_id FROM settlement.default_step WHERE default_case_id = $1 AND step = $2', [caseId, step]);
  return r.rows[0] ?? null;
}

export class DefaultAppeals {
  constructor(private readonly db: Db) {}

  async cases(filter: { status?: string } = {}): Promise<DefaultCaseView[]> {
    const r = await this.db.query<CaseRow>(`${SELECT_CASES} WHERE ($1::text IS NULL OR dc.status = $1) ORDER BY dc.opened_at DESC LIMIT 200`, [filter.status ?? null]);
    return r.rows.map(toCase);
  }

  async case(caseId: string): Promise<DefaultCaseView> {
    return toCase(await caseRow(this.db, caseId));
  }

  /** The buyer's own default cases, for the appeal screen. */
  async buyerCases(accountId: string): Promise<DefaultCaseView[]> {
    const r = await this.db.query<CaseRow>(`${SELECT_CASES} WHERE i.buyer_account_id = $1 ORDER BY dc.opened_at DESC`, [accountId]);
    return r.rows.map(toCase);
  }

  /**
   * An appeal against one or more steps. The buyer appeals their own case; support or
   * risk staff may record one on the buyer's behalf. One open appeal per case: a repeat
   * returns the open one (R4).
   */
  async appeal(
    by: { type: 'account'; id: string; name: string } | { type: 'staff'; staff: StaffMember },
    caseId: string,
    steps: readonly string[],
    groundsInput: string,
  ): Promise<{ appealId: string; repeated: boolean }> {
    const grounds = requireReason(groundsInput, 'the grounds for the appeal');
    const wanted = [...new Set(steps)];
    if (wanted.length === 0 || wanted.some((s) => !(WAIVABLE_STEPS as readonly string[]).includes(s))) {
      throw new AdminError('invalid', 'Appeal one or more of: deposit_forfeit, relist_fee, tier_drop.');
    }
    const row = await caseRow(this.db, caseId);
    let actor: Actor;
    let raisedBy: string;
    if (by.type === 'account') {
      if (row.buyer_id !== by.id) throw new AdminError('not_found', 'We could not find that default case.');
      actor = { type: 'account', id: by.id, name: by.name, reason: grounds };
      raisedBy = by.id;
    } else {
      requirePermission(by.staff, 'default.appeal.record');
      actor = staffActor(by.staff, grounds);
      raisedBy = by.staff.id;
    }
    return this.db.tx(actor, async (c) => {
      const open = await c.query<{ id: string }>(`SELECT id FROM settlement.default_appeal WHERE default_case_id = $1 AND status = 'open'`, [caseId]);
      if (open.rows[0]) return { appealId: open.rows[0].id, repeated: true };
      const ins = await c.query<{ id: string }>(
        `INSERT INTO settlement.default_appeal (default_case_id, raised_by, raised_via, steps, grounds) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [caseId, raisedBy, by.type === 'account' ? 'buyer' : 'staff', wanted, grounds],
      );
      await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('default.appealed', 'default_case', $1, $2::jsonb)`, [
        caseId,
        JSON.stringify({ appealId: ins.rows[0]!.id, steps: wanted }),
      ]);
      return { appealId: ins.rows[0]!.id, repeated: false };
    });
  }

  /** Risk decides an appeal. Waivers themselves go through the override workflow. */
  async decideAppeal(staff: StaffMember, appealId: string, decision: 'upheld' | 'partly_upheld' | 'rejected', noteInput: string) {
    requirePermission(staff, 'default.appeal.decide');
    if (!['upheld', 'partly_upheld', 'rejected'].includes(decision)) throw new AdminError('invalid', 'Decide upheld, partly_upheld or rejected.');
    const note = requireReason(noteInput, 'a note');
    if (!/^[0-9a-f-]{36}$/.test(appealId)) throw new AdminError('invalid', 'That is not an appeal reference.');
    return this.db.tx(staffActor(staff, note), async (c) => {
      const r = await c.query<{ status: string; default_case_id: string }>('SELECT status, default_case_id FROM settlement.default_appeal WHERE id = $1 FOR UPDATE', [appealId]);
      const a = r.rows[0];
      if (!a) throw new AdminError('not_found', 'We could not find that appeal.');
      if (a.status === decision) return { appealId, status: decision, repeated: true };
      if (a.status !== 'open') throw new AdminError('conflict', `This appeal is already ${a.status}.`);
      await c.query(`UPDATE settlement.default_appeal SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`, [appealId, decision, staff.id, note]);
      await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('default.appeal_decided', 'default_case', $1, $2::jsonb)`, [
        a.default_case_id,
        JSON.stringify({ appealId, decision }),
      ]);
      return { appealId, status: decision, repeated: false };
    });
  }
}

/** Money at stake in a step: what moved (if applied) or what would move (if not). */
async function stepAmount(c: Client, rulebook: RulebookStore, row: CaseRow, step: WaivableStep, applied: { journal_id: string | null } | null): Promise<bigint | null> {
  if (step === 'tier_drop') return null;
  if (step === 'deposit_forfeit') {
    const holds = await auctionHolds(c, row.buyer_id, row.auction_id);
    const wanted = applied ? 'forfeited' : 'active';
    return holds.filter((h) => h.status === wanted).reduce((a, h) => a + h.amount_minor, 0n);
  }
  if (applied?.journal_id) {
    const r = await c.query<{ amount: bigint }>('SELECT coalesce(sum(amount_minor) FILTER (WHERE amount_minor > 0), 0)::bigint AS amount FROM ledger.posting WHERE journal_id = $1', [applied.journal_id]);
    return r.rows[0]!.amount;
  }
  const hammer = await c.query<{ h: bigint }>(`SELECT coalesce(sum(amount_minor), 0)::bigint AS h FROM settlement.invoice_line WHERE invoice_id = $1 AND line_type = 'hammer'`, [row.invoice_id]);
  return relistFeeAmount(hammer.rows[0]!.h, row.currency, await rulebook.snapshot(row.rule_version_id, c));
}

export function defaultWaiverHandler(rulebook: RulebookStore): OverrideHandler {
  return {
    kind: 'default_waiver',
    requestPermission: 'default.waiver.request',
    approvePermission: 'default.waiver.approve',
    async prepare(c, _staff, input) {
      const row = await caseRow(c, String(input.caseId ?? ''));
      const step = input.step as WaivableStep;
      if (!(WAIVABLE_STEPS as readonly string[]).includes(step)) throw new AdminError('invalid', 'Waive one of: deposit_forfeit, relist_fee, tier_drop.');
      const waived = await c.query('SELECT 1 FROM settlement.default_waiver WHERE default_case_id = $1 AND step = $2', [row.case_id, step]);
      if (waived.rowCount) throw new AdminError('conflict', 'That step is already waived.');
      let appealId: string | null = null;
      if (input.appealId !== undefined && input.appealId !== null) {
        appealId = String(input.appealId);
        const ap = await c.query('SELECT 1 FROM settlement.default_appeal WHERE id = $1 AND default_case_id = $2', [/^[0-9a-f-]{36}$/.test(appealId) ? appealId : null, row.case_id]);
        if (!ap.rowCount) throw new AdminError('not_found', 'That appeal is not on this default case.');
      }
      const applied = await appliedStep(c, row.case_id, step);
      const amount = await stepAmount(c, rulebook, row, step, applied);
      return {
        actionType: ACTION_FOR_STEP[step], entityType: 'settlement.default_case', entityId: row.case_id,
        currency: amount === null ? null : row.currency, amountMinor: amount,
        payload: { caseId: row.case_id, step, appealId, invoiceId: row.invoice_id },
        alwaysTwoPerson: step === 'tier_drop', dedupeKey: `waive:${step}`,
        summary: `${applied ? 'Reverse' : 'Prevent'} the ${step.replace('_', ' ')} on invoice ${row.invoice_number} for ${row.buyer_name}`,
      };
    },
    async execute(c, request, by) {
      const p = request.payload as unknown as { caseId: string; step: WaivableStep; appealId: string | null; invoiceId: string };
      // Serialise with the default ladder, which locks the invoice the same way.
      await c.query('SELECT id FROM settlement.invoice WHERE id = $1 FOR UPDATE', [p.invoiceId]);
      const row = await caseRow(c, p.caseId);
      const applied = await appliedStep(c, p.caseId, p.step);
      const journalIds: string[] = [];
      const why = `waiver of ${p.step} on appeal (override ${request.id})`;
      if (applied && p.step === 'deposit_forfeit') {
        for (const h of (await auctionHolds(c, row.buyer_id, row.auction_id)).filter((x) => x.status === 'forfeited' && x.closed_journal_id)) {
          journalIds.push(await reverseJournalById(c, h.closed_journal_id!, why));
          journalIds.push(await postJournal(c, returnForfeitedDeposit({ holdId: h.id, accountId: row.buyer_id, currency: row.currency, amountMinor: h.amount_minor })));
        }
      } else if (applied && p.step === 'relist_fee' && applied.journal_id) {
        try {
          await c.query('SAVEPOINT relist_fee_reversal');
          // A fee charged to the receivable and since paid would overdraw it; the account check refuses.
          journalIds.push(await reverseJournalById(c, applied.journal_id, why));
          await c.query('RELEASE SAVEPOINT relist_fee_reversal');
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT relist_fee_reversal');
          if (/check constraint|balance/i.test(String((e as Error).message))) {
            throw new AdminError('conflict', 'The relisting fee has already been settled from the buyer\'s balance, so it cannot be reversed here. Refund it instead.');
          }
          throw e;
        }
      } else if (applied && p.step === 'tier_drop') {
        const prior = await c.query<{ from_state: string | null }>(
          `SELECT from_state FROM audit.event WHERE entity_type = 'identity.account' AND entity_id = $1 AND action = 'tier_change' AND to_state = 'restricted'
            ORDER BY id DESC LIMIT 1`,
          [row.buyer_id],
        );
        const back = prior.rows[0]?.from_state === 'trusted' ? 'trusted' : 'verified';
        await c.query(`UPDATE identity.account SET tier = $2, restricted_until = NULL WHERE id = $1 AND tier = 'restricted'`, [row.buyer_id, back]);
      }
      const effect = applied ? 'reversed' : 'prevented';
      const ins = await c.query<{ id: string }>(
        `INSERT INTO settlement.default_waiver (default_case_id, appeal_id, step, effect, override_request_id, journal_ids, reason, waived_by)
         VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8) RETURNING id`,
        [p.caseId, p.appealId, p.step, effect, request.id, journalIds, request.reason, by.id],
      );
      // Every step that could be waived is waived: the case closes as waived.
      const ladder = (await rulebook.snapshot(row.rule_version_id, c)).get('settlement.default_ladder').map((s) => s.step).filter((s) => s !== 'warning');
      const waivedSteps = (await c.query<{ step: string }>('SELECT step FROM settlement.default_waiver WHERE default_case_id = $1', [p.caseId])).rows.map((r) => r.step);
      if (ladder.every((s) => waivedSteps.includes(s))) {
        await c.query(`UPDATE settlement.default_case SET status = 'waived', closed_at = coalesce(closed_at, now()) WHERE id = $1 AND status <> 'waived'`, [p.caseId]);
      }
      await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('default.step_waived', 'default_case', $1, $2::jsonb)`, [
        p.caseId,
        JSON.stringify({ step: p.step, effect, journalIds }),
      ]);
      return { waiverId: ins.rows[0]!.id, step: p.step, effect, journalIds };
    },
  };
}
