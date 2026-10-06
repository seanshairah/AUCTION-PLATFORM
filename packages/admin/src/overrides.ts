import type { Currency } from '@abc/domain';
import { big, run, type Client, type Db, type Queryable, type RulebookStore } from '@abc/db';
import { RuleMissingError, type MoneyByCurrency, type RuleSnapshot } from '@abc/rules';
import { AdminError, loadStaff, requirePermission, requireReason, staffActor, type Permission, type StaffMember } from './permissions';

/**
 * Generic staff override requests (docs/18-admin-operations.md §4), on top of the
 * schema's audit.override_request (R3):
 *
 *   request → (amount above the threshold, or a kind that always needs two people)
 *           → pending → a different staff member with the approving role approves → executed
 *   request → (below the threshold) → approved and executed at once, by the requester
 *
 * The approved action is applied in the same transaction as the approval, so an
 * override is never "approved but not done". A request lapses after
 * override.request_expiry_hours. The database enforces requester ≠ approver, an
 * approver above the threshold, no edits, no deletion and no approval after lapse.
 */

export type OverrideKind = 'limit_change' | 'tier_change' | 'tax_rate_activation' | 'default_waiver' | 'reconciliation_write_off';
export const OVERRIDE_KINDS: readonly OverrideKind[] = ['limit_change', 'tier_change', 'tax_rate_activation', 'default_waiver', 'reconciliation_write_off'];

export type DbActionType =
  | 'refund'
  | 'bid_void'
  | 'limit_change'
  | 'fee_waiver'
  | 'payout_detail_override'
  | 'lot_withdrawal'
  | 'tier_change'
  | 'deposit_forfeit_waiver'
  | 'ledger_adjustment'
  | 'tax_rate_activation';

export type OverrideStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired';

export interface OverrideRow {
  id: string;
  action_type: DbActionType;
  entity_type: string;
  entity_id: string;
  currency: Currency | null;
  amount_minor: bigint | null;
  reason: string;
  requested_by: string;
  requested_at: Date;
  requires_second_approval: boolean;
  status: OverrideStatus;
  approved_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  expires_at: Date | null;
  executed_at: Date | null;
  payload: Record<string, unknown> & { kind: OverrideKind };
}

export interface PreparedOverride {
  actionType: DbActionType;
  entityType: string;
  entityId: string;
  currency: Currency | null;
  amountMinor: bigint | null;
  /** What execution needs; stored with the request and never edited. */
  payload: Record<string, unknown>;
  /** Kinds with no money amount that still need a second person (A58). */
  alwaysTwoPerson: boolean;
  /** One request at a time per thing being overridden. */
  dedupeKey: string;
  summary: string;
}

export interface OverrideHandler {
  kind: OverrideKind;
  requestPermission: Permission;
  approvePermission: Permission;
  prepare(c: Client, staff: StaffMember, input: Record<string, unknown>): Promise<PreparedOverride>;
  /** Applies the approved action. `by` is whoever made it effective (approver, or requester below the threshold). */
  execute(c: Client, request: OverrideRow, by: StaffMember): Promise<Record<string, unknown>>;
}

export interface OverrideView {
  id: string;
  kind: OverrideKind;
  actionType: DbActionType;
  entityType: string;
  entityId: string;
  currency: Currency | null;
  amountMinor: bigint | null;
  reason: string;
  requestedBy: { id: string; name: string | null };
  requestedAt: Date;
  requiresSecondApproval: boolean;
  status: OverrideStatus;
  approvedBy: { id: string; name: string | null } | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date | null;
  executedAt: Date | null;
  payload: Record<string, unknown>;
}

export interface OverrideOutcome {
  request: OverrideView;
  /** True when a repeated request (same client key, or one already open for the same thing) returned the existing one. */
  repeated: boolean;
  /** The applied action's result, when it was executed by this call. */
  result?: Record<string, unknown>;
}

export interface OverridePolicy {
  threshold: MoneyByCurrency;
  expiryHours: number | null;
}

/** Reads the policy from the rule set in force now (R2). */
export async function overridePolicy(rulebook: RulebookStore, c: Client, at: Date = new Date()): Promise<OverridePolicy> {
  let snapshot: RuleSnapshot;
  try {
    snapshot = await rulebook.snapshot(await rulebook.activeVersionId(at, c), c);
  } catch {
    throw new AdminError('conflict', 'No rule set is in force, so staff overrides cannot be raised.');
  }
  const threshold = snapshot.get('override.two_person_threshold');
  let expiryHours: number | null = null;
  try {
    expiryHours = snapshot.get('override.request_expiry_hours');
  } catch (e) {
    if (!(e instanceof RuleMissingError)) throw e;
  }
  return { threshold, expiryHours };
}

/**
 * Two people are needed when the kind always needs them, or the amount is above
 * the threshold in its currency. A currency with no threshold set needs two (A58).
 */
export function needsSecondApproval(p: { alwaysTwoPerson: boolean; currency: Currency | null; amountMinor: bigint | null }, threshold: MoneyByCurrency): boolean {
  if (p.alwaysTwoPerson) return true;
  if (p.amountMinor === null || p.currency === null) return false;
  const limit = threshold[p.currency];
  return limit === null || p.amountMinor > BigInt(limit);
}

const SELECT_VIEW = `
  SELECT o.*, rq.display_name AS requested_by_name, ap.display_name AS approved_by_name
    FROM audit.override_request o
    LEFT JOIN identity.account rq ON rq.id = o.requested_by
    LEFT JOIN identity.account ap ON ap.id = o.approved_by`;

type ViewRow = OverrideRow & { requested_by_name: string | null; approved_by_name: string | null };

function toView(r: ViewRow): OverrideView {
  return {
    id: r.id,
    kind: r.payload.kind,
    actionType: r.action_type,
    entityType: r.entity_type,
    entityId: r.entity_id,
    currency: r.currency,
    amountMinor: r.amount_minor,
    reason: r.reason,
    requestedBy: { id: r.requested_by, name: r.requested_by_name },
    requestedAt: r.requested_at,
    requiresSecondApproval: r.requires_second_approval,
    status: r.status,
    approvedBy: r.approved_by ? { id: r.approved_by, name: r.approved_by_name } : null,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    expiresAt: r.expires_at,
    executedAt: r.executed_at,
    payload: r.payload,
  };
}

async function outbox(c: Client, topic: string, id: string, payload: unknown): Promise<void> {
  await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ($1, 'override_request', $2, $3::jsonb)`, [
    topic,
    id,
    JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ]);
}

export class OverrideService {
  private readonly handlers = new Map<OverrideKind, OverrideHandler>();

  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
  ) {}

  register(handler: OverrideHandler): void {
    this.handlers.set(handler.kind, handler);
  }

  private handler(kind: string): OverrideHandler {
    const h = this.handlers.get(kind as OverrideKind);
    if (!h) throw new AdminError('invalid', `Unknown override kind "${kind}". Use one of: ${[...this.handlers.keys()].join(', ')}.`);
    return h;
  }

  async view(q: Queryable, id: string): Promise<OverrideView | null> {
    const r = await run<ViewRow>(q, `${SELECT_VIEW} WHERE o.id = $1`, [id]);
    return r.rows[0] ? toView(r.rows[0]) : null;
  }

  async get(id: string): Promise<OverrideView | null> {
    return this.view(this.db, id);
  }

  async list(filter: { status?: OverrideStatus; kind?: OverrideKind; limit?: number } = {}): Promise<OverrideView[]> {
    const r = await this.db.query<ViewRow>(
      `${SELECT_VIEW}
        WHERE ($1::text IS NULL OR o.status = $1) AND ($2::text IS NULL OR o.payload->>'kind' = $2)
        ORDER BY o.requested_at DESC LIMIT $3`,
      [filter.status ?? null, filter.kind ?? null, Math.min(filter.limit ?? 100, 500)],
    );
    return r.rows.map(toView);
  }

  /** Raises an override. Below the threshold it is applied at once; otherwise it waits for a second person. */
  async request(
    staff: StaffMember,
    input: { kind: string; payload: Record<string, unknown>; reason: string; clientKey?: string },
    now: Date = new Date(),
  ): Promise<OverrideOutcome> {
    const handler = this.handler(input.kind);
    requirePermission(staff, handler.requestPermission);
    const reason = requireReason(input.reason);
    return this.db.tx(staffActor(staff, reason), async (c) => {
      if (input.clientKey) {
        const prior = await c.query<ViewRow>(`${SELECT_VIEW} WHERE o.requested_by = $1 AND o.client_key = $2`, [staff.id, input.clientKey]);
        if (prior.rows[0]) return { request: toView(prior.rows[0]), repeated: true };
      }
      const prepared = await handler.prepare(c, staff, input.payload);
      const open = await c.query<ViewRow>(
        `${SELECT_VIEW}
          WHERE o.action_type = $1 AND o.entity_type = $2 AND o.entity_id = $3 AND o.payload->>'dedupeKey' = $4
            AND o.status IN ('pending', 'approved') AND (o.expires_at IS NULL OR o.expires_at > $5)`,
        [prepared.actionType, prepared.entityType, prepared.entityId, prepared.dedupeKey, now],
      );
      if (open.rows[0]) return { request: toView(open.rows[0]), repeated: true };

      const policy = await overridePolicy(this.rulebook, c, now);
      const twoPerson = needsSecondApproval(prepared, policy.threshold);
      const expiresAt = policy.expiryHours === null ? null : new Date(now.getTime() + policy.expiryHours * 3_600_000);
      const payload = { ...prepared.payload, kind: handler.kind, dedupeKey: prepared.dedupeKey, summary: prepared.summary };
      const ins = await c.query<{ id: string }>(
        `INSERT INTO audit.override_request (action_type, entity_type, entity_id, currency, amount_minor, reason, requested_by,
                                             requires_second_approval, payload, expires_at, client_key, requested_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12) RETURNING id`,
        [
          prepared.actionType, prepared.entityType, prepared.entityId, prepared.currency,
          prepared.amountMinor === null ? null : big(prepared.amountMinor), reason, staff.id, twoPerson,
          JSON.stringify(payload), expiresAt, input.clientKey ?? null, now,
        ],
      );
      const id = ins.rows[0]!.id;
      if (twoPerson) {
        await outbox(c, 'override.requested', id, { kind: handler.kind, summary: prepared.summary });
        return { request: (await this.view(c, id))!, repeated: false };
      }
      // Below the threshold: one person's name and reason are enough (R3).
      await c.query(`UPDATE audit.override_request SET status = 'approved', decision_note = 'Below the two-person threshold' WHERE id = $1`, [id]);
      const result = await this.executeLocked(c, id, staff);
      return { request: (await this.view(c, id))!, repeated: false, result };
    });
  }

  private async executeLocked(c: Client, id: string, by: StaffMember): Promise<Record<string, unknown>> {
    const row = (await c.query<OverrideRow>('SELECT * FROM audit.override_request WHERE id = $1', [id])).rows[0]!;
    const result = await this.handler(row.payload.kind).execute(c, row, by);
    await c.query(`UPDATE audit.override_request SET status = 'executed' WHERE id = $1`, [id]);
    await outbox(c, 'override.executed', id, { kind: row.payload.kind, by: by.id });
    return result;
  }

  /** A second staff member approves; the action is applied in the same transaction. */
  async approve(staff: StaffMember, id: string, note?: string, now: Date = new Date()): Promise<OverrideOutcome> {
    const existing = await this.view(this.db, id);
    if (!existing) throw new AdminError('not_found', 'We could not find that override request.');
    const handler = this.handler(existing.kind);
    requirePermission(staff, handler.approvePermission);
    const reason = note && note.trim().length > 0 ? note.trim() : `Approved: ${existing.reason}`;
    const outcome = await this.db.tx(staffActor(staff, reason), async (c): Promise<OverrideOutcome | 'lapsed'> => {
      const row = (await c.query<OverrideRow>('SELECT * FROM audit.override_request WHERE id = $1 FOR UPDATE', [id])).rows[0]!;
      if (row.status === 'executed' && row.approved_by === staff.id) return { request: (await this.view(c, id))!, repeated: true };
      if (row.status !== 'pending') throw new AdminError('conflict', `This request is already ${row.status}.`);
      if (row.requested_by === staff.id) {
        throw new AdminError('forbidden', 'You raised this request, so you cannot approve it. Ask another staff member.');
      }
      if (row.expires_at && row.expires_at.getTime() <= now.getTime()) {
        await c.query(`UPDATE audit.override_request SET status = 'expired' WHERE id = $1`, [id]);
        return 'lapsed';
      }
      await c.query(`UPDATE audit.override_request SET status = 'approved', approved_by = $2, decision_note = $3 WHERE id = $1`, [id, staff.id, note?.trim() || null]);
      const result = await this.executeLocked(c, id, staff);
      return { request: (await this.view(c, id))!, repeated: false, result };
    });
    if (outcome === 'lapsed') throw new AdminError('conflict', 'This request lapsed before it was approved. Raise it again if it is still needed.');
    return outcome;
  }

  /** Rejects a pending request. The requester may also withdraw their own. */
  async reject(staff: StaffMember, id: string, note: string): Promise<OverrideView> {
    const existing = await this.view(this.db, id);
    if (!existing) throw new AdminError('not_found', 'We could not find that override request.');
    if (existing.requestedBy.id !== staff.id) requirePermission(staff, this.handler(existing.kind).approvePermission);
    if (typeof note !== 'string' || note.trim().length < 5) throw new AdminError('invalid', 'Say why the request is rejected (at least 5 characters).');
    return this.db.tx(staffActor(staff, note.trim()), async (c) => {
      const row = (await c.query<OverrideRow>('SELECT status FROM audit.override_request WHERE id = $1 FOR UPDATE', [id])).rows[0]!;
      if (row.status !== 'pending') throw new AdminError('conflict', `This request is already ${row.status}.`);
      await c.query(`UPDATE audit.override_request SET status = 'rejected', decision_note = $2 WHERE id = $1`, [id, note.trim()]);
      await outbox(c, 'override.rejected', id, { by: staff.id });
      return (await this.view(c, id))!;
    });
  }

  /** Marks lapsed requests expired (worker job). Returns how many. */
  async expireLapsed(now: Date = new Date()): Promise<number> {
    return this.db.tx({ type: 'system', id: 'override-expiry', name: 'Override expiry', reason: 'request lapsed (rule override.request_expiry_hours)' }, async (c) => {
      const r = await c.query(`UPDATE audit.override_request SET status = 'expired' WHERE status IN ('pending', 'approved') AND expires_at <= $1`, [now]);
      return r.rowCount ?? 0;
    });
  }
}

/** Resolves a staff member by id, for handlers that need the requester. */
export async function staffById(q: Queryable, id: string): Promise<StaffMember> {
  const s = await loadStaff(q, id);
  if (!s) throw new AdminError('forbidden', 'That account holds no staff role.');
  return s;
}
