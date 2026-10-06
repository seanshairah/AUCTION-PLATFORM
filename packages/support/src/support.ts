import type { Currency } from '@abc/domain';
import type { RuleSnapshot } from '@abc/rules';

/**
 * Support and disputes, pure parts (docs/17-support-disputes.md): deadlines from the
 * rulebook, the remedy → status mapping, the refund plan and the two-person threshold.
 */

const HOUR = 3_600_000;

export const DISPUTE_CATEGORIES = ['not_as_described', 'missing', 'damaged_in_custody', 'inspection_inaccuracy', 'other'] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export const REMEDIES = ['none', 'partial_refund', 'full_refund_and_return', 'repair_or_replace'] as const;
export type Remedy = (typeof REMEDIES)[number];

export const TICKET_CHANNELS = ['web', 'whatsapp', 'phone', 'branch'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export const TICKET_CATEGORIES = ['payment', 'collection', 'delivery', 'dispute', 'bidding', 'account', 'selling', 'other'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** A dispute's response and decision deadlines (rules dispute.response_target_hours, dispute.decision_target_hours). */
export function disputeDeadlines(raisedAt: Date, snapshot: RuleSnapshot): { responseDueAt: Date; decisionDueAt: Date } {
  return {
    responseDueAt: new Date(raisedAt.getTime() + snapshot.get('dispute.response_target_hours') * HOUR),
    decisionDueAt: new Date(raisedAt.getTime() + snapshot.get('dispute.decision_target_hours') * HOUR),
  };
}

/** Claims are accepted until the claim window after release (or after delivery, for delivered goods) closes. */
export function claimWindowClosesAt(receivedAt: Date, snapshot: RuleSnapshot): Date {
  return new Date(receivedAt.getTime() + snapshot.get('dispute.claim_window_hours_after_release') * HOUR);
}

/** The dispute status a remedy leads to. */
export function statusForRemedy(remedy: Remedy): 'upheld' | 'partially_upheld' | 'rejected' {
  switch (remedy) {
    case 'none':
      return 'rejected';
    case 'partial_refund':
      return 'partially_upheld';
    default:
      return 'upheld';
  }
}

/**
 * Whether a refund needs a second approver (rule dispute.refund_second_approver_threshold).
 * No amount set for the currency means every refund in it needs one (the safe default).
 */
export function refundNeedsSecondApprover(amountMinor: bigint, currency: Currency, snapshot: RuleSnapshot): boolean {
  const threshold = snapshot.get('dispute.refund_second_approver_threshold')[currency];
  return threshold === null || amountMinor > BigInt(threshold);
}

export interface LotSale {
  hammerMinor: bigint;
  /** Commission ABC recognised on the lot when the buyer paid (0 if none was posted). */
  commissionMinor: bigint;
  /** The lot's other invoice lines: taxes, premium, delivery. */
  otherLines: Array<{ type: 'buyers_premium' | 'purchasers_levy' | 'vat' | 'imtt' | 'transfer_tax' | 'delivery'; amountMinor: bigint }>;
}

export type RefundPlan =
  | { ok: true; refundMinor: bigint; sellerShareMinor: bigint }
  | { ok: false; reason: 'refund_required' | 'refund_too_large'; maxMinor?: bigint };

/**
 * How much a remedy refunds, and how much of it is the seller's.
 *   - full refund and return: everything the buyer paid for the lot; the seller loses
 *     their net share (hammer less commission), ABC gives back its commission and the
 *     tax and other lines are reversed;
 *   - partial refund: an amount staff decide, at most the seller's net share, all of
 *     it taken from the seller's proceeds;
 *   - none, repair or replace: no money moves.
 */
export function refundPlan(remedy: Remedy, sale: LotSale, requestedMinor?: bigint | null): RefundPlan {
  const sellerShare = sale.hammerMinor - sale.commissionMinor;
  if (remedy === 'full_refund_and_return') {
    return { ok: true, refundMinor: sale.hammerMinor + sale.otherLines.reduce((a, l) => a + l.amountMinor, 0n), sellerShareMinor: sellerShare };
  }
  if (remedy === 'partial_refund') {
    if (!requestedMinor || requestedMinor <= 0n) return { ok: false, reason: 'refund_required' };
    if (requestedMinor > sellerShare) return { ok: false, reason: 'refund_too_large', maxMinor: sellerShare };
    return { ok: true, refundMinor: requestedMinor, sellerShareMinor: requestedMinor };
  }
  return { ok: true, refundMinor: 0n, sellerShareMinor: 0n };
}

/** Ticket targets for a priority (rule support.ticket_targets), from when the ticket was opened. */
export function ticketDueDates(priority: TicketPriority, openedAt: Date, snapshot: RuleSnapshot): { firstResponseDueAt: Date; resolutionDueAt: Date } {
  const t = snapshot.get('support.ticket_targets')[priority];
  return {
    firstResponseDueAt: new Date(openedAt.getTime() + t.firstResponseHours * HOUR),
    resolutionDueAt: new Date(openedAt.getTime() + t.resolutionHours * HOUR),
  };
}

/** Default priority when a customer opens a ticket: claims and payments first. */
export function defaultPriority(category: TicketCategory): TicketPriority {
  return category === 'dispute' || category === 'payment' ? 'high' : 'normal';
}
