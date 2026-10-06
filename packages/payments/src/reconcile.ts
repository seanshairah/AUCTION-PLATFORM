import type { Currency } from '@abc/domain';
import type { StatementLine } from './gateway';

/**
 * Daily reconciliation (blueprint §6 module 3: "daily reconciliation"; §8 payment
 * fraud: "daily reconciliation, idempotent payment references"). Matches a
 * gateway's statement against the payments the System recorded as succeeded.
 */

export type ReconOutcome = 'matched' | 'missing_in_system' | 'missing_at_source' | 'amount_mismatch' | 'currency_mismatch';

export interface RecordedPayment {
  paymentId: string;
  gatewayReference: string;
  amountMinor: bigint;
  currency: Currency;
}

export interface ReconItem {
  outcome: ReconOutcome;
  externalReference: string;
  statementAmountMinor?: bigint;
  paymentId?: string;
}

export function reconcile(statement: readonly StatementLine[], recorded: readonly RecordedPayment[]): ReconItem[] {
  const byRef = new Map(recorded.map((p) => [p.gatewayReference, p]));
  const seen = new Set<string>();
  const items: ReconItem[] = [];
  for (const line of statement) {
    const p = byRef.get(line.gatewayReference);
    seen.add(line.gatewayReference);
    if (!p) {
      items.push({ outcome: 'missing_in_system', externalReference: line.gatewayReference, statementAmountMinor: line.amountMinor });
      continue;
    }
    const outcome: ReconOutcome =
      p.currency !== line.currency ? 'currency_mismatch' : p.amountMinor !== line.amountMinor ? 'amount_mismatch' : 'matched';
    items.push({ outcome, externalReference: line.gatewayReference, statementAmountMinor: line.amountMinor, paymentId: p.paymentId });
  }
  for (const p of recorded) {
    if (!seen.has(p.gatewayReference)) items.push({ outcome: 'missing_at_source', externalReference: p.gatewayReference, paymentId: p.paymentId });
  }
  return items;
}
