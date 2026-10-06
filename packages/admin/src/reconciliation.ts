import type { Currency } from '@abc/domain';
import { type Client, type Db, type RulebookStore } from '@abc/db';
import { postJournal, reconciliationWriteOff } from '@abc/ledger';
import { RuleMissingError, type MoneyByCurrency } from '@abc/rules';
import type { OverrideHandler } from './overrides';
import { AdminError, requirePermission, requireReason, staffActor, type StaffMember } from './permissions';

/**
 * The finance reconciliation queue (docs/09 §9, docs/18 §6). Every unmatched or
 * mismatched line from a daily run waits here until finance resolves it:
 *
 *   matched_manually   the money is in the System under another reference (no money moves)
 *   gateway_error      the statement line is wrong, confirmed with the gateway (no money moves)
 *   within_tolerance   an amount difference within payments.reconciliation_tolerance (no money moves)
 *   written_off        a shortfall the gateway will never settle: a ledger journal from gateway
 *                      clearing to the write-off expense account, always with a second person (A61)
 *
 * Resolutions are final and need a note (database-enforced).
 */

export type Resolution = 'matched_manually' | 'gateway_error' | 'within_tolerance';

export interface ReconciliationQueueItem {
  itemId: string;
  runId: string;
  source: string;
  currency: Currency;
  statementDate: string;
  outcome: string;
  externalReference: string | null;
  statementAmountMinor: bigint | null;
  payment: { id: string; amountMinor: bigint; currency: Currency; gateway: string; accountId: string; failureReason: string | null } | null;
  /** Statement minus System, where both have an amount. */
  differenceMinor: bigint | null;
  withinTolerance: boolean;
  /** What the System credited and the gateway never settled; a write-off candidate. */
  shortfallMinor: bigint | null;
  pendingWriteOff: string | null;
}

interface ItemRow {
  id: string;
  run_id: string;
  source: string;
  currency: Currency;
  statement_date: Date;
  outcome: string;
  external_reference: string | null;
  statement_amount_minor: bigint | null;
  payment_id: string | null;
  p_amount: bigint | null;
  p_currency: Currency | null;
  p_gateway: string | null;
  p_account: string | null;
  p_failure: string | null;
  resolved_at: Date | null;
  pending_write_off: string | null;
}

const SELECT_ITEMS = `
  SELECT i.id::text AS id, i.run_id, r.source, r.currency, r.statement_date, i.outcome, i.external_reference, i.statement_amount_minor,
         i.payment_id, p.amount_minor AS p_amount, p.currency AS p_currency, p.gateway AS p_gateway, p.account_id AS p_account,
         p.failure_reason AS p_failure, i.resolved_at,
         (SELECT o.id FROM audit.override_request o WHERE o.action_type = 'ledger_adjustment' AND o.entity_type = 'payment.reconciliation_item'
             AND o.entity_id = i.id::text AND o.status = 'pending' LIMIT 1) AS pending_write_off
    FROM payment.reconciliation_item i
    JOIN payment.reconciliation_run r ON r.id = i.run_id
    LEFT JOIN payment.payment p ON p.id = i.payment_id`;

function shortfall(row: Pick<ItemRow, 'outcome' | 'statement_amount_minor' | 'p_amount'>): bigint | null {
  if (row.p_amount === null) return null;
  if (row.outcome === 'missing_at_source') return row.p_amount;
  if (row.outcome === 'amount_mismatch' && row.statement_amount_minor !== null && row.statement_amount_minor < row.p_amount) {
    return row.p_amount - row.statement_amount_minor;
  }
  return null;
}

function toItem(row: ItemRow, tolerance: MoneyByCurrency | null): ReconciliationQueueItem {
  const diff = row.statement_amount_minor !== null && row.p_amount !== null ? row.statement_amount_minor - row.p_amount : null;
  const tol = tolerance?.[row.currency];
  const within = row.outcome === 'amount_mismatch' && diff !== null && tol !== null && tol !== undefined && (diff < 0n ? -diff : diff) <= BigInt(tol);
  return {
    itemId: row.id,
    runId: row.run_id,
    source: row.source,
    currency: row.currency,
    statementDate: row.statement_date.toISOString().slice(0, 10),
    outcome: row.outcome,
    externalReference: row.external_reference,
    statementAmountMinor: row.statement_amount_minor,
    payment: row.payment_id
      ? { id: row.payment_id, amountMinor: row.p_amount!, currency: row.p_currency!, gateway: row.p_gateway!, accountId: row.p_account!, failureReason: row.p_failure }
      : null,
    differenceMinor: diff,
    withinTolerance: within,
    shortfallMinor: shortfall(row),
    pendingWriteOff: row.pending_write_off,
  };
}

export class ReconciliationQueue {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
  ) {}

  private async tolerance(c?: Client): Promise<MoneyByCurrency | null> {
    try {
      const snapshot = await this.rulebook.snapshot(await this.rulebook.activeVersionId(new Date(), c), c);
      return snapshot.get('payments.reconciliation_tolerance');
    } catch (e) {
      if (e instanceof RuleMissingError || (e instanceof Error && /No published rule set/.test(e.message))) return null;
      throw e;
    }
  }

  /** Unresolved exceptions, oldest statement first. */
  async queue(): Promise<ReconciliationQueueItem[]> {
    const tolerance = await this.tolerance();
    const r = await this.db.query<ItemRow>(`${SELECT_ITEMS} WHERE i.outcome <> 'matched' AND i.resolved_at IS NULL ORDER BY r.statement_date, i.id`);
    return r.rows.map((row) => toItem(row, tolerance));
  }

  /** Finance resolves an exception without moving money. Repeating the same resolution is a no-op. */
  async resolve(staff: StaffMember, itemId: string, input: { resolution: Resolution; note: string; paymentId?: string }): Promise<ReconciliationQueueItem & { resolution: string }> {
    requirePermission(staff, 'reconciliation.resolve');
    const note = requireReason(input.note, 'a note');
    if (!['matched_manually', 'gateway_error', 'within_tolerance'].includes(input.resolution)) {
      throw new AdminError('invalid', 'Resolve as matched_manually, gateway_error or within_tolerance. Write-offs need a second person.');
    }
    if (!/^\d+$/.test(itemId)) throw new AdminError('invalid', 'That is not a reconciliation item.');
    return this.db.tx(staffActor(staff, note), async (c) => {
      const row = (await c.query<ItemRow & { resolution: string | null }>(`${SELECT_ITEMS.replace('i.resolved_at,', 'i.resolved_at, i.resolution,')} WHERE i.id = $1 FOR UPDATE OF i`, [itemId])).rows[0];
      if (!row) throw new AdminError('not_found', 'We could not find that reconciliation item.');
      const tolerance = await this.tolerance(c);
      if (row.resolved_at) {
        if (row.resolution === input.resolution) return { ...toItem(row, tolerance), resolution: input.resolution };
        throw new AdminError('conflict', `This item was already resolved as ${row.resolution}.`);
      }
      if (row.outcome === 'matched') throw new AdminError('conflict', 'This item matched; there is nothing to resolve.');
      const item = toItem(row, tolerance);
      let paymentId = row.payment_id;
      if (input.resolution === 'within_tolerance' && !item.withinTolerance) {
        throw new AdminError('conflict', 'The difference is larger than the reconciliation tolerance, so it needs a full resolution.');
      }
      if (input.resolution === 'matched_manually') {
        if (!input.paymentId || !/^[0-9a-f-]{36}$/.test(input.paymentId)) throw new AdminError('invalid', 'Name the payment this statement line belongs to.');
        const p = await c.query<{ amount_minor: bigint; currency: Currency; status: string }>('SELECT amount_minor, currency, status FROM payment.payment WHERE id = $1', [input.paymentId]);
        const pay = p.rows[0];
        if (!pay) throw new AdminError('not_found', 'We could not find that payment.');
        if (pay.currency !== row.currency) throw new AdminError('conflict', 'That payment is in a different currency; currencies are never matched across.');
        if (row.statement_amount_minor !== null && pay.amount_minor !== row.statement_amount_minor) {
          throw new AdminError('conflict', 'That payment is for a different amount than the statement line.');
        }
        paymentId = input.paymentId;
      }
      await c.query(
        `UPDATE payment.reconciliation_item SET resolution = $2, resolution_note = $3, resolved_by = $4, resolved_at = now(), payment_id = $5 WHERE id = $1`,
        [itemId, input.resolution, note, staff.id, paymentId],
      );
      await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('reconciliation.resolved', 'reconciliation_item', $1, $2::jsonb)`, [
        itemId,
        JSON.stringify({ resolution: input.resolution, by: staff.id }),
      ]);
      return { ...item, payment: item.payment, resolution: input.resolution };
    });
  }
}

/** Writing off a reconciliation shortfall: a ledger adjustment that always needs a second finance person. */
export const reconciliationWriteOffHandler: OverrideHandler = {
  kind: 'reconciliation_write_off',
  requestPermission: 'reconciliation.write_off.request',
  approvePermission: 'reconciliation.write_off.approve',
  async prepare(c, _staff, input) {
    const itemId = String(input.itemId ?? '');
    if (!/^\d+$/.test(itemId)) throw new AdminError('invalid', 'Name the reconciliation item to write off.');
    const row = (await c.query<ItemRow>(`${SELECT_ITEMS} WHERE i.id = $1`, [itemId])).rows[0];
    if (!row) throw new AdminError('not_found', 'We could not find that reconciliation item.');
    if (row.resolved_at) throw new AdminError('conflict', 'This item is already resolved.');
    const amount = shortfall(row);
    if (amount === null || amount <= 0n || !row.p_gateway) {
      throw new AdminError('conflict', 'Only a shortfall (money the System credited that the gateway never settled) can be written off. Match or credit the payer instead.');
    }
    return {
      actionType: 'ledger_adjustment', entityType: 'payment.reconciliation_item', entityId: itemId, currency: row.currency, amountMinor: amount,
      payload: { itemId, gateway: row.p_gateway, currency: row.currency, amountMinor: amount.toString() }, alwaysTwoPerson: true, dedupeKey: 'write_off',
      summary: `Write off a ${row.currency} shortfall of ${amount.toString()} minor units from ${row.p_gateway} (statement ${row.statement_date.toISOString().slice(0, 10)})`,
    };
  },
  async execute(c, request, by) {
    const p = request.payload as unknown as { itemId: string; gateway: string; currency: Currency; amountMinor: string };
    const journalId = await postJournal(c, reconciliationWriteOff({ itemId: p.itemId, gateway: p.gateway, currency: p.currency, amountMinor: BigInt(p.amountMinor) }));
    await c.query(
      `UPDATE payment.reconciliation_item SET resolution = 'written_off', resolution_note = $2, resolved_by = $3, resolved_at = now(),
              override_request_id = $4, journal_id = $5
        WHERE id = $1`,
      [p.itemId, request.reason, by.id, request.id, journalId],
    );
    return { itemId: p.itemId, journalId };
  },
};
