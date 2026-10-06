import type { Currency } from '@abc/domain';
import { big, type Client } from '@abc/db';
import { clawbackRecovery, postJournal } from '@abc/ledger';

/**
 * Payout adjustments for the disputes module (docs/17-support-disputes.md §5–6).
 * Payouts are owned here, so Support changes them only through these functions,
 * inside its own transaction:
 *   - a dispute holds every unpaid payout that contains the disputed lot;
 *   - a refund reduces the unpaid payout for that lot by the seller's share;
 *   - a refund made after the seller was paid becomes a clawback, recovered from
 *     the seller's later payouts in that currency.
 * The database refuses to approve or pay a payout while a hold is active.
 */

async function outbox(c: Client, topic: string, aggregateType: string, aggregateId: string, payload: unknown): Promise<void> {
  await c.query('INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4::jsonb)', [
    topic,
    aggregateType,
    aggregateId,
    JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ]);
}

export type LotPayoutState =
  | { kind: 'none' }
  | { kind: 'unpaid'; payoutId: string; status: string }
  | { kind: 'paid'; payoutId: string };

/** Where the seller's money for a lot stands: no payout yet, an unpaid payout, or already paid. */
export async function lotPayoutState(c: Client, lotId: string): Promise<LotPayoutState> {
  const r = await c.query<{ id: string; status: string }>(
    `SELECT p.id, p.status FROM payout.payout p
      WHERE p.status <> 'cancelled' AND EXISTS (SELECT 1 FROM payout.payout_line l WHERE l.payout_id = p.id AND l.lot_id = $1 AND l.line_type = 'hammer')
      ORDER BY p.created_at DESC LIMIT 1
      FOR UPDATE`,
    [lotId],
  );
  const p = r.rows[0];
  if (!p) return { kind: 'none' };
  return p.status === 'paid' ? { kind: 'paid', payoutId: p.id } : { kind: 'unpaid', payoutId: p.id, status: p.status };
}

/** Holds every unpaid payout containing the lot while the dispute is open. Returns the payouts held. */
export async function holdLotPayouts(c: Client, p: { lotId: string; disputeId: string }): Promise<string[]> {
  const r = await c.query<{ id: string }>(
    `SELECT p.id FROM payout.payout p
      WHERE p.status IN ('scheduled', 'approved', 'processing', 'held')
        AND EXISTS (SELECT 1 FROM payout.payout_line l WHERE l.payout_id = p.id AND l.lot_id = $1)
      FOR UPDATE`,
    [p.lotId],
  );
  for (const { id } of r.rows) {
    await c.query('INSERT INTO payout.payout_hold (payout_id, dispute_id) VALUES ($1, $2) ON CONFLICT (payout_id, dispute_id) DO NOTHING', [id, p.disputeId]);
    await c.query(`UPDATE payout.payout SET status = 'held' WHERE id = $1 AND status <> 'held'`, [id]);
    await outbox(c, 'payout.held', 'payout', id, { disputeId: p.disputeId, lotId: p.lotId });
  }
  return r.rows.map((x) => x.id);
}

/**
 * Lifts the dispute's holds. A payout with nothing left to pay is cancelled; one with
 * no other hold goes back to scheduled if it has a usable destination, else stays held.
 */
export async function releaseDisputeHolds(c: Client, disputeId: string, now: Date): Promise<void> {
  const r = await c.query<{ payout_id: string }>(
    `UPDATE payout.payout_hold SET released_at = $2 WHERE dispute_id = $1 AND released_at IS NULL RETURNING payout_id`,
    [disputeId, now],
  );
  for (const { payout_id } of r.rows) {
    const p = (await c.query<{ status: string; net_minor: bigint; destination_id: string | null; seller_account_id: string; currency: Currency }>(
      'SELECT status, net_minor, destination_id, seller_account_id, currency FROM payout.payout WHERE id = $1 FOR UPDATE',
      [payout_id],
    )).rows[0]!;
    if (p.status !== 'held') continue;
    const otherHolds = await c.query('SELECT 1 FROM payout.payout_hold WHERE payout_id = $1 AND released_at IS NULL', [payout_id]);
    if (otherHolds.rowCount) continue;
    if (p.net_minor === 0n) {
      await c.query(`UPDATE payout.payout SET status = 'cancelled' WHERE id = $1`, [payout_id]);
      await outbox(c, 'payout.cancelled', 'payout', payout_id, { disputeId, reason: 'nothing_left_to_pay' });
      continue;
    }
    let destination = p.destination_id;
    if (!destination) {
      const d = await c.query<{ id: string }>(
        `SELECT id FROM payout.destination WHERE account_id = $1 AND currency = $2 AND active AND cooling_off_until <= $3 ORDER BY created_at DESC LIMIT 1`,
        [p.seller_account_id, p.currency, now],
      );
      destination = d.rows[0]?.id ?? null;
    }
    if (destination) {
      await c.query(`UPDATE payout.payout SET status = 'scheduled', destination_id = $2 WHERE id = $1`, [payout_id, destination]);
      await outbox(c, 'payout.hold_released', 'payout', payout_id, { disputeId });
    }
  }
}

async function addDeduction(c: Client, payoutId: string, p: { lotId?: string | null; invoiceId?: string | null; description: string; amountMinor: bigint }): Promise<void> {
  await c.query(
    `INSERT INTO payout.payout_line (payout_id, lot_id, invoice_id, line_type, description, amount_minor) VALUES ($1, $2, $3, 'adjustment', $4, $5)`,
    [payoutId, p.lotId ?? null, p.invoiceId ?? null, p.description, big(-p.amountMinor)],
  );
  await c.query(
    `UPDATE payout.payout SET deductions_minor = deductions_minor + $2, net_minor = net_minor - $2 WHERE id = $1`,
    [payoutId, big(p.amountMinor)],
  );
}

/** Reduces an unpaid payout by a refund taken from the seller's share (the refund journal already debited their payable). */
export async function deductRefundFromPayout(
  c: Client,
  p: { payoutId: string; lotId: string; invoiceId: string; disputeId: string; amountMinor: bigint },
): Promise<void> {
  const r = await c.query<{ net_minor: bigint; status: string }>('SELECT net_minor, status FROM payout.payout WHERE id = $1 FOR UPDATE', [p.payoutId]);
  const payout = r.rows[0];
  if (!payout || payout.status === 'paid' || payout.status === 'cancelled') throw new Error(`Payout ${p.payoutId} cannot be adjusted`);
  if (payout.net_minor < p.amountMinor) throw new Error(`Payout ${p.payoutId} is smaller than the refund`);
  await addDeduction(c, p.payoutId, { lotId: p.lotId, invoiceId: p.invoiceId, description: `Refund after claim ${p.disputeId.slice(0, 8)}`, amountMinor: p.amountMinor });
}

/**
 * Applies a seller's open clawbacks to their unpaid payouts in a currency, oldest
 * clawback first, never taking a payout below zero. Each recovery is a ledger
 * journal (seller payable → platform suspense) and a payout deduction line.
 */
export async function applyClawbacks(c: Client, sellerId: string, currency: Currency, onlyPayoutId?: string): Promise<bigint> {
  const clawbacks = await c.query<{ id: string; amount_minor: bigint; recovered_minor: bigint }>(
    `SELECT id, amount_minor, recovered_minor FROM payout.clawback
      WHERE seller_account_id = $1 AND currency = $2 AND status = 'open' ORDER BY created_at FOR UPDATE`,
    [sellerId, currency],
  );
  if (!clawbacks.rowCount) return 0n;
  const payouts = await c.query<{ id: string; net_minor: bigint }>(
    `SELECT id, net_minor FROM payout.payout
      WHERE seller_account_id = $1 AND currency = $2 AND status IN ('scheduled', 'held') AND net_minor > 0
        AND ($3::uuid IS NULL OR id = $3::uuid)
      ORDER BY created_at FOR UPDATE`,
    [sellerId, currency, onlyPayoutId ?? null],
  );
  let total = 0n;
  for (const cb of clawbacks.rows) {
    let remaining = cb.amount_minor - cb.recovered_minor;
    for (const po of payouts.rows) {
      if (remaining === 0n) break;
      if (po.net_minor === 0n) continue;
      const take = remaining < po.net_minor ? remaining : po.net_minor;
      const journalId = await postJournal(c, clawbackRecovery({ clawbackId: cb.id, payoutId: po.id, sellerId, currency, amountMinor: take }));
      await addDeduction(c, po.id, { description: `Clawback ${cb.id.slice(0, 8)} recovered`, amountMinor: take });
      await c.query('INSERT INTO payout.clawback_recovery (clawback_id, payout_id, amount_minor, journal_id) VALUES ($1, $2, $3, $4)', [cb.id, po.id, big(take), journalId]);
      po.net_minor -= take;
      remaining -= take;
      total += take;
    }
    const recovered = cb.amount_minor - remaining;
    if (recovered !== cb.recovered_minor) {
      await c.query(`UPDATE payout.clawback SET recovered_minor = $2, status = CASE WHEN $2 = amount_minor THEN 'recovered' ELSE 'open' END WHERE id = $1`, [cb.id, big(recovered)]);
      if (remaining === 0n) await outbox(c, 'payout.clawback_recovered', 'clawback', cb.id, { sellerId });
    }
  }
  for (const po of payouts.rows) {
    if (po.net_minor === 0n) {
      const held = await c.query('SELECT 1 FROM payout.payout_hold WHERE payout_id = $1 AND released_at IS NULL', [po.id]);
      if (!held.rowCount) await c.query(`UPDATE payout.payout SET status = 'cancelled' WHERE id = $1`, [po.id]);
    }
  }
  return total;
}

/** Records what a seller owes back after a refund made once they had been paid, and recovers what it can now. */
export async function recordClawback(c: Client, p: { disputeId: string; sellerId: string; currency: Currency; amountMinor: bigint }): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO payout.clawback (seller_account_id, currency, amount_minor, dispute_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (dispute_id) DO UPDATE SET dispute_id = EXCLUDED.dispute_id RETURNING id`,
    [p.sellerId, p.currency, big(p.amountMinor), p.disputeId],
  );
  const id = r.rows[0]!.id;
  await outbox(c, 'payout.clawback_recorded', 'clawback', id, { disputeId: p.disputeId, sellerId: p.sellerId, amountMinor: p.amountMinor });
  await applyClawbacks(c, p.sellerId, p.currency);
  return id;
}
