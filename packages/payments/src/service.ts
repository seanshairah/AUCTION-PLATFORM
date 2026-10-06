import { createHash } from 'node:crypto';
import type { Currency } from '@abc/domain';
import { big, type Actor, type Client, type Db, type RulebookStore } from '@abc/db';
import { branchCash, postJournal, topUp } from '@abc/ledger';
import type { PaymentMethod } from '@abc/rules';
import { canTransition, GatewayDeclinedError, route, type PaymentGateway, type StatusResult } from './gateway';
import { reconcile, type ReconItem } from './reconcile';

/**
 * Payments service (docs/09-payments.md). Every payment from outside lands in the
 * payer's wallet as a top-up; invoices are then paid from the wallet in one tap
 * (deliverable 12). That keeps a single path for money in, whatever the rail.
 */

export interface StartTopUp {
  accountId: string;
  currency: Currency;
  amountMinor: bigint;
  method: PaymentMethod;
  payerPhone?: string;
  /** Client idempotency key: a retried request returns the same payment. */
  clientKey: string;
}

export interface StartResult {
  paymentId: string;
  status: 'pending' | 'failed' | 'unknown';
  gateway: string | null;
  approval?: 'phone_prompt' | 'redirect';
  redirectUrl?: string;
  message: string;
}

interface PaymentRow {
  id: string;
  account_id: string;
  currency: Currency;
  amount_minor: bigint;
  status: string;
  gateway: string;
  gateway_reference: string | null;
  created_at: Date;
}

export class PaymentService {
  private readonly gateways: Map<string, PaymentGateway>;

  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    gateways: readonly PaymentGateway[],
  ) {
    this.gateways = new Map(gateways.map((g) => [g.id, g]));
  }

  private async rules() {
    return this.rulebook.snapshot(await this.rulebook.activeVersionId(new Date()));
  }

  /** Starts a wallet top-up on the first gateway that accepts it. */
  async startTopUp(actor: Actor, req: StartTopUp): Promise<StartResult> {
    if (req.amountMinor <= 0n) throw new RangeError('Amount must be positive');
    const snapshot = await this.rules();
    const candidates = route({ currency: req.currency, method: req.method, amountMinor: req.amountMinor }, snapshot.get('payments.routing'), this.gateways);

    const created = await this.db.tx(actor, async (c) => {
      const existing = await c.query<PaymentRow>('SELECT * FROM payment.payment WHERE account_id = $1 AND client_idempotency_key = $2', [req.accountId, req.clientKey]);
      if (existing.rows[0]) return { row: existing.rows[0], fresh: false };
      const r = await c.query<PaymentRow>(
        `INSERT INTO payment.payment (account_id, purpose, method, gateway, currency, amount_minor, status, client_idempotency_key)
         VALUES ($1, 'top_up', $2, $3, $4, $5, 'initiated', $6) RETURNING *`,
        [req.accountId, req.method, candidates[0]!.id, req.currency, big(req.amountMinor), req.clientKey],
      );
      return { row: r.rows[0]!, fresh: true };
    });
    const payment = created.row;
    if (!created.fresh) {
      return { paymentId: payment.id, status: payment.status === 'failed' ? 'failed' : 'pending', gateway: payment.gateway, message: 'This payment was already started.' };
    }

    const reasons: string[] = [];
    for (const gateway of candidates) {
      try {
        const result = await gateway.initiate({
          paymentId: payment.id,
          currency: req.currency,
          amountMinor: req.amountMinor,
          method: req.method,
          ...(req.payerPhone ? { payerPhone: req.payerPhone } : {}),
        });
        await this.db.tx(actor, (c) =>
          c.query(`UPDATE payment.payment SET status = 'pending', gateway = $2, gateway_reference = $3 WHERE id = $1`, [payment.id, gateway.id, result.gatewayReference]),
        );
        return {
          paymentId: payment.id,
          status: 'pending',
          gateway: gateway.id,
          approval: result.approval,
          ...(result.redirectUrl ? { redirectUrl: result.redirectUrl } : {}),
          message: result.approval === 'phone_prompt' ? 'Approve the payment on your phone.' : 'Complete the payment on the card page.',
        };
      } catch (e) {
        if (e instanceof GatewayDeclinedError) {
          reasons.push(e.message); // refused before any prompt: safe to try the next gateway
          continue;
        }
        // Unknown outcome: the payer may have been prompted. Never fail over; poll and reconcile.
        await this.db.tx(actor, (c) =>
          c.query(`UPDATE payment.payment SET gateway = $2, failure_reason = $3 WHERE id = $1`, [payment.id, gateway.id, `initiate outcome unknown: ${(e as Error).message}`]),
        );
        return { paymentId: payment.id, status: 'unknown', gateway: gateway.id, message: 'We could not confirm the payment started. Check your wallet before trying again.' };
      }
    }
    await this.db.tx(actor, (c) =>
      c.query(`UPDATE payment.payment SET status = 'failed', failure_reason = $2 WHERE id = $1`, [payment.id, reasons.join('; ')]),
    );
    return { paymentId: payment.id, status: 'failed', gateway: null, message: 'Payments by this method are not available right now. Try another method or pay at a branch.' };
  }

  /**
   * Handles a gateway callback: record it verbatim, verify the signature, then
   * confirm with a server-to-server status check before any money is credited.
   */
  async handleCallback(gatewayId: string, headers: Record<string, string>, rawBody: string): Promise<{ outcome: 'rejected' | 'unknown_payment' | 'applied'; paymentId?: string }> {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway) return { outcome: 'rejected' };
    const verified = gateway.verifyCallback(headers, rawBody);
    const actor: Actor = { type: 'gateway', id: gatewayId, name: gatewayId };
    const digest = createHash('sha256').update(rawBody).digest();
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = { raw: rawBody };
    }

    const payment = await this.db.tx(actor, async (c) => {
      const p = verified
        ? (await c.query<PaymentRow>('SELECT * FROM payment.payment WHERE id::text = $1 AND gateway = $2', [verified.merchantReference, gatewayId])).rows[0]
        : undefined;
      await c.query(
        `INSERT INTO payment.gateway_event (gateway, gateway_reference, payment_id, event_type, signature_valid, payload_sha256, payload)
         VALUES ($1, $2, $3, 'callback', $4, $5, $6::jsonb)`,
        [gatewayId, verified?.gatewayReference ?? null, p?.id ?? null, verified !== null, digest, JSON.stringify(payload)],
      );
      return p;
    });
    if (!verified) return { outcome: 'rejected' };
    if (!payment) return { outcome: 'unknown_payment' };

    const confirmed = await gateway.status(verified.gatewayReference, payment.currency);
    await this.apply(payment.id, confirmed, actor);
    return { outcome: 'applied', paymentId: payment.id };
  }

  /** Applies a confirmed gateway status. Crediting is idempotent on the payment id. */
  private async apply(paymentId: string, confirmed: StatusResult, actor: Actor): Promise<void> {
    await this.db.tx(actor, async (c) => {
      const p = (await c.query<PaymentRow>('SELECT * FROM payment.payment WHERE id = $1 FOR UPDATE', [paymentId])).rows[0]!;
      if (confirmed.status === 'paid') {
        if (p.status === 'succeeded') return;
        if (confirmed.amountMinor !== p.amount_minor || confirmed.currency !== p.currency) {
          // Never credit a different amount than the payer started; finance resolves it.
          await c.query(`UPDATE payment.payment SET failure_reason = $2 WHERE id = $1`, [paymentId, `amount or currency mismatch: gateway says ${confirmed.amountMinor} ${confirmed.currency}`]);
          return;
        }
        if (!canTransition(p.status, 'succeeded')) return;
        const journalId = await postJournal(c, topUp({ paymentId, accountId: p.account_id, currency: p.currency, amountMinor: p.amount_minor, gateway: p.gateway }));
        await c.query(
          `UPDATE payment.payment SET status = 'succeeded', journal_id = $2, confirmed_at = now(), gateway_reference = coalesce(gateway_reference, $3) WHERE id = $1`,
          [paymentId, journalId, confirmed.gatewayReference],
        );
      } else if ((confirmed.status === 'failed' || confirmed.status === 'cancelled') && canTransition(p.status, confirmed.status)) {
        await c.query(`UPDATE payment.payment SET status = $2 WHERE id = $1`, [paymentId, confirmed.status]);
      }
    });
  }

  /** Polls pending payments and expires stale ones (rule payments.pending_expiry_minutes). */
  async pollPending(now: Date = new Date()): Promise<{ checked: number; expired: number }> {
    const expiryMinutes = (await this.rules()).get('payments.pending_expiry_minutes');
    const pending = await this.db.query<PaymentRow>(`SELECT * FROM payment.payment WHERE status IN ('initiated', 'pending') AND gateway_reference IS NOT NULL`);
    let expired = 0;
    for (const p of pending.rows) {
      const gateway = this.gateways.get(p.gateway);
      const actor: Actor = { type: 'system', id: 'payment-poller', name: 'Payment poller' };
      try {
        if (gateway) await this.apply(p.id, await gateway.status(p.gateway_reference!, p.currency), actor);
      } catch {
        // Gateway unreachable: try again next run; reconciliation is the backstop.
      }
      if (now.getTime() - p.created_at.getTime() > expiryMinutes * 60_000) {
        const n = await this.db.tx(actor, (c) => c.query(`UPDATE payment.payment SET status = 'expired' WHERE id = $1 AND status IN ('initiated', 'pending')`, [p.id]));
        expired += n.rowCount ?? 0;
      }
    }
    return { checked: pending.rows.length, expired };
  }

  /** Cash at a branch counter, posted to the same ledger with its receipt number. */
  async recordBranchCash(
    cashier: Actor & { type: 'staff' },
    p: { cashierId: string; branch: string; accountId: string; currency: Currency; amountMinor: bigint; receiptNumber: string },
  ): Promise<string> {
    return this.db.tx(cashier, async (c) => {
      const existing = await c.query<{ id: string }>('SELECT id FROM payment.payment WHERE receipt_number = $1', [p.receiptNumber]);
      if (existing.rows[0]) return existing.rows[0].id;
      const id = (await c.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
      const journalId = await postJournal(c, branchCash({ paymentId: id, accountId: p.accountId, currency: p.currency, amountMinor: p.amountMinor, branch: p.branch, receiptNumber: p.receiptNumber }));
      await c.query(
        `INSERT INTO payment.payment (id, account_id, purpose, method, gateway, currency, amount_minor, status, client_idempotency_key,
                                      branch_code, receipt_number, cashier_id, journal_id, confirmed_at)
         VALUES ($1, $2, 'top_up', 'branch_cash', 'branch', $3, $4, 'succeeded', $5, $6, $5, $7, $8, now())`,
        [id, p.accountId, p.currency, big(p.amountMinor), p.receiptNumber, p.branch, p.cashierId, journalId],
      );
      return id;
    });
  }

  /** Daily reconciliation of one gateway and currency against its statement. */
  async reconcileDay(gatewayId: string, currency: Currency, date: string): Promise<{ runId: string; items: ReconItem[] }> {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway?.statement) throw new Error(`${gatewayId} has no statement feed; import its report instead`);
    const statement = await gateway.statement(date, currency);
    const actor: Actor = { type: 'system', id: 'reconciliation', name: 'Daily reconciliation' };
    return this.db.tx(actor, async (c: Client) => {
      const recorded = await c.query<{ id: string; gateway_reference: string; amount_minor: bigint; currency: Currency }>(
        `SELECT id, gateway_reference, amount_minor, currency FROM payment.payment
          WHERE gateway = $1 AND currency = $2 AND status = 'succeeded' AND confirmed_at::date = $3::date`,
        [gatewayId, currency, date],
      );
      const items = reconcile(
        statement,
        recorded.rows.map((r) => ({ paymentId: r.id, gatewayReference: r.gateway_reference, amountMinor: r.amount_minor, currency: r.currency })),
      );
      const exceptions = items.filter((i) => i.outcome !== 'matched').length;
      const run = await c.query<{ id: string }>(
        `INSERT INTO payment.reconciliation_run (source, currency, statement_date, status, matched_count, exception_count, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
        [gatewayId, currency, date, exceptions === 0 ? 'balanced' : 'exceptions', items.length - exceptions, exceptions],
      );
      for (const i of items) {
        await c.query(
          `INSERT INTO payment.reconciliation_item (run_id, external_reference, statement_amount_minor, payment_id, outcome) VALUES ($1, $2, $3, $4, $5)`,
          [run.rows[0]!.id, i.externalReference, i.statementAmountMinor !== undefined ? big(i.statementAmountMinor) : null, i.paymentId ?? null, i.outcome],
        );
      }
      return { runId: run.rows[0]!.id, items };
    });
  }
}
