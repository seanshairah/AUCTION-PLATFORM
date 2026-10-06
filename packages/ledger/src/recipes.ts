import type { Currency } from '@abc/domain';

/**
 * Posting recipes: every movement of money in the System, as a balanced journal
 * (architecture rule R1; docs/02-data-model.md §4.3 and docs/08-wallet-ledger.md §3).
 * Recipes are pure. LedgerStore writes them through ledger.post_journal(), which is
 * idempotent on the journal's key and re-checks the balance in the database.
 *
 * Convention: positive = debit, negative = credit.
 */

export type Owner =
  | { type: 'customer'; id: string }
  | { type: 'seller'; id: string }
  | { type: 'platform' }
  | { type: 'gateway'; id: string }
  | { type: 'branch'; id: string };

export type Purpose =
  | 'wallet_available'
  | 'wallet_held'
  | 'customer_receivable'
  | 'seller_payable'
  | 'gateway_clearing'
  | 'branch_cash'
  | 'trust_bank'
  | 'commission_income'
  | 'fee_income'
  | 'delivery_income'
  | 'forfeiture_income'
  | 'tax_payable'
  | 'fx_clearing'
  | 'suspense'
  | 'write_off';

export interface AccountRef {
  owner: Owner;
  purpose: Purpose;
  sub?: string;
}

export type JournalKind =
  | 'top_up'
  | 'branch_cash'
  | 'hold'
  | 'hold_release'
  | 'invoice_issued'
  | 'invoice_payment'
  | 'invoice_credit'
  | 'refund'
  | 'forfeit'
  | 'relist_fee'
  | 'commission'
  | 'payout'
  | 'gateway_settlement'
  | 'reversal'
  | 'adjustment'
  | 'storage_fee'
  | 'delivery_charge'
  | 'clawback';

export interface JournalLine {
  account: AccountRef;
  amountMinor: bigint;
}

export interface JournalSpec {
  kind: JournalKind;
  currency: Currency;
  idempotencyKey: string;
  description: string;
  referenceType?: string;
  referenceId?: string;
  reversesJournalId?: string;
  lines: JournalLine[];
}

/** Chart of accounts: normal side and whether the balance may go negative. */
export const CHART: Record<Purpose, { normalSide: 'D' | 'C'; allowNegative: boolean }> = {
  wallet_available: { normalSide: 'C', allowNegative: false },
  wallet_held: { normalSide: 'C', allowNegative: false },
  customer_receivable: { normalSide: 'D', allowNegative: false },
  seller_payable: { normalSide: 'C', allowNegative: false },
  gateway_clearing: { normalSide: 'D', allowNegative: true },
  branch_cash: { normalSide: 'D', allowNegative: false },
  trust_bank: { normalSide: 'D', allowNegative: false },
  commission_income: { normalSide: 'C', allowNegative: false },
  fee_income: { normalSide: 'C', allowNegative: false },
  delivery_income: { normalSide: 'C', allowNegative: false },
  forfeiture_income: { normalSide: 'C', allowNegative: false },
  tax_payable: { normalSide: 'C', allowNegative: false },
  fx_clearing: { normalSide: 'D', allowNegative: true },
  suspense: { normalSide: 'D', allowNegative: true },
  write_off: { normalSide: 'D', allowNegative: false },
};

export class UnbalancedJournalError extends Error {
  constructor(spec: Pick<JournalSpec, 'kind' | 'idempotencyKey'>, sum: bigint) {
    super(`Journal ${spec.kind} (${spec.idempotencyKey}) does not balance: sum ${sum}`);
    this.name = 'UnbalancedJournalError';
  }
}

function journal(spec: JournalSpec): JournalSpec {
  const lines = spec.lines.filter((l) => l.amountMinor !== 0n);
  const sum = lines.reduce((a, l) => a + l.amountMinor, 0n);
  if (sum !== 0n || lines.length < 2) throw new UnbalancedJournalError(spec, sum);
  return { ...spec, lines };
}

function positive(amount: bigint, what: string): bigint {
  if (amount <= 0n) throw new RangeError(`${what} must be positive`);
  return amount;
}

const customer = (id: string, purpose: Purpose): AccountRef => ({ owner: { type: 'customer', id }, purpose });
const seller = (id: string): AccountRef => ({ owner: { type: 'seller', id }, purpose: 'seller_payable' });
const platform = (purpose: Purpose, sub?: string): AccountRef => ({ owner: { type: 'platform' }, purpose, ...(sub ? { sub } : {}) });
const gateway = (id: string): AccountRef => ({ owner: { type: 'gateway', id }, purpose: 'gateway_clearing' });

// --- Money in ----------------------------------------------------------------

export function topUp(p: { paymentId: string; accountId: string; currency: Currency; amountMinor: bigint; gateway: string }): JournalSpec {
  const a = positive(p.amountMinor, 'Top-up');
  return journal({
    kind: 'top_up',
    currency: p.currency,
    idempotencyKey: `payment:${p.paymentId}`,
    description: `Top-up via ${p.gateway}`,
    referenceType: 'payment',
    referenceId: p.paymentId,
    lines: [
      { account: gateway(p.gateway), amountMinor: a },
      { account: customer(p.accountId, 'wallet_available'), amountMinor: -a },
    ],
  });
}

export function branchCash(p: { paymentId: string; accountId: string; currency: Currency; amountMinor: bigint; branch: string; receiptNumber: string }): JournalSpec {
  const a = positive(p.amountMinor, 'Cash deposit');
  return journal({
    kind: 'branch_cash',
    currency: p.currency,
    idempotencyKey: `payment:${p.paymentId}`,
    description: `Cash at ${p.branch}, receipt ${p.receiptNumber}`,
    referenceType: 'payment',
    referenceId: p.paymentId,
    lines: [
      { account: { owner: { type: 'branch', id: p.branch }, purpose: 'branch_cash' }, amountMinor: a },
      { account: customer(p.accountId, 'wallet_available'), amountMinor: -a },
    ],
  });
}

export function gatewaySettlement(p: { settlementId: string; gateway: string; currency: Currency; amountMinor: bigint }): JournalSpec {
  const a = positive(p.amountMinor, 'Settlement');
  return journal({
    kind: 'gateway_settlement',
    currency: p.currency,
    idempotencyKey: `settlement:${p.settlementId}`,
    description: `${p.gateway} settled to the trust account`,
    referenceType: 'gateway_settlement',
    referenceId: p.settlementId,
    lines: [
      { account: platform('trust_bank'), amountMinor: a },
      { account: gateway(p.gateway), amountMinor: -a },
    ],
  });
}

// --- Deposits ------------------------------------------------------------------

export function placeHold(p: { holdId: string; accountId: string; currency: Currency; amountMinor: bigint }): JournalSpec {
  const a = positive(p.amountMinor, 'Hold');
  return journal({
    kind: 'hold',
    currency: p.currency,
    idempotencyKey: `hold:${p.holdId}:place`,
    description: 'Deposit held',
    referenceType: 'hold',
    referenceId: p.holdId,
    lines: [
      { account: customer(p.accountId, 'wallet_available'), amountMinor: a },
      { account: customer(p.accountId, 'wallet_held'), amountMinor: -a },
    ],
  });
}

export function releaseHold(p: { holdId: string; accountId: string; currency: Currency; amountMinor: bigint }): JournalSpec {
  const a = positive(p.amountMinor, 'Hold');
  return journal({
    kind: 'hold_release',
    currency: p.currency,
    idempotencyKey: `hold:${p.holdId}:close`,
    description: 'Deposit released',
    referenceType: 'hold',
    referenceId: p.holdId,
    lines: [
      { account: customer(p.accountId, 'wallet_held'), amountMinor: a },
      { account: customer(p.accountId, 'wallet_available'), amountMinor: -a },
    ],
  });
}

/** Forfeits a held deposit; a share may go to the seller (rule settlement.forfeit_seller_share_bp). */
export function forfeitHold(p: {
  holdId: string;
  accountId: string;
  currency: Currency;
  amountMinor: bigint;
  sellerId?: string;
  sellerShareMinor?: bigint;
}): JournalSpec {
  const a = positive(p.amountMinor, 'Forfeit');
  const share = p.sellerShareMinor ?? 0n;
  if (share < 0n || share > a) throw new RangeError('Seller share must be between 0 and the deposit');
  if (share > 0n && !p.sellerId) throw new RangeError('A seller share needs a seller');
  return journal({
    kind: 'forfeit',
    currency: p.currency,
    idempotencyKey: `hold:${p.holdId}:close`,
    description: 'Deposit forfeited after a missed payment',
    referenceType: 'hold',
    referenceId: p.holdId,
    lines: [
      { account: customer(p.accountId, 'wallet_held'), amountMinor: a },
      { account: platform('forfeiture_income'), amountMinor: -(a - share) },
      ...(share > 0n ? [{ account: seller(p.sellerId!), amountMinor: -share }] : []),
    ],
  });
}

// --- Invoices ------------------------------------------------------------------

export interface InvoiceLineForLedger {
  type: 'hammer' | 'buyers_premium' | 'purchasers_levy' | 'vat' | 'imtt' | 'transfer_tax' | 'delivery';
  amountMinor: bigint;
  /** Required on hammer lines: whose proceeds these are. */
  sellerId?: string;
}

/** Invoice issued at the hammer: the buyer owes the total; seller, tax authority and ABC are owed their parts. */
export function invoiceIssued(p: { invoiceId: string; buyerId: string; currency: Currency; lines: readonly InvoiceLineForLedger[] }): JournalSpec {
  const total = p.lines.reduce((a, l) => a + l.amountMinor, 0n);
  const credits: JournalLine[] = p.lines.map((l) => {
    switch (l.type) {
      case 'hammer':
        if (!l.sellerId) throw new RangeError('Hammer lines need a seller');
        return { account: seller(l.sellerId), amountMinor: -l.amountMinor };
      case 'buyers_premium':
        return { account: platform('fee_income', 'buyers_premium'), amountMinor: -l.amountMinor };
      case 'delivery':
        return { account: platform('delivery_income'), amountMinor: -l.amountMinor };
      default:
        return { account: platform('tax_payable', l.type), amountMinor: -l.amountMinor };
    }
  });
  return journal({
    kind: 'invoice_issued',
    currency: p.currency,
    idempotencyKey: `invoice:${p.invoiceId}:issue`,
    description: 'Invoice issued',
    referenceType: 'invoice',
    referenceId: p.invoiceId,
    lines: [{ account: customer(p.buyerId, 'customer_receivable'), amountMinor: total }, ...credits],
  });
}

export function invoicePayment(p: { invoiceId: string; buyerId: string; currency: Currency; amountMinor: bigint; paymentId: string }): JournalSpec {
  const a = positive(p.amountMinor, 'Payment');
  return journal({
    kind: 'invoice_payment',
    currency: p.currency,
    idempotencyKey: `payment:${p.paymentId}`,
    description: 'Invoice paid from wallet',
    referenceType: 'invoice',
    referenceId: p.invoiceId,
    lines: [
      { account: customer(p.buyerId, 'wallet_available'), amountMinor: a },
      { account: customer(p.buyerId, 'customer_receivable'), amountMinor: -a },
    ],
  });
}

/** Cancels an unpaid invoice: the exact mirror of its issue journal. */
export function invoiceCredit(issued: JournalSpec, invoiceId: string): JournalSpec {
  return journal({
    kind: 'invoice_credit',
    currency: issued.currency,
    idempotencyKey: `invoice:${invoiceId}:credit`,
    description: 'Invoice cancelled',
    referenceType: 'invoice',
    referenceId: invoiceId,
    lines: issued.lines.map((l) => ({ account: l.account, amountMinor: -l.amountMinor })),
  });
}

export function commission(p: { invoiceId: string; lotId: string; sellerId: string; currency: Currency; amountMinor: bigint }): JournalSpec {
  const a = positive(p.amountMinor, 'Commission');
  return journal({
    kind: 'commission',
    currency: p.currency,
    idempotencyKey: `commission:${p.invoiceId}:${p.lotId}`,
    description: 'Seller commission',
    referenceType: 'invoice',
    referenceId: p.invoiceId,
    lines: [
      { account: seller(p.sellerId), amountMinor: a },
      { account: platform('commission_income'), amountMinor: -a },
    ],
  });
}

/** Relist fee after a missed payment: from the wallet if it can cover it, otherwise owed. */
export function relistFee(p: { invoiceId: string; buyerId: string; currency: Currency; amountMinor: bigint; fromWallet: boolean }): JournalSpec {
  const a = positive(p.amountMinor, 'Relist fee');
  return journal({
    kind: 'relist_fee',
    currency: p.currency,
    idempotencyKey: `invoice:${p.invoiceId}:relist_fee`,
    description: 'Relisting fee after a missed payment',
    referenceType: 'invoice',
    referenceId: p.invoiceId,
    lines: [
      { account: customer(p.buyerId, p.fromWallet ? 'wallet_available' : 'customer_receivable'), amountMinor: a },
      { account: platform('fee_income', 'relist_fee'), amountMinor: -a },
    ],
  });
}

// --- Money out ---------------------------------------------------------------------

export function payout(p: { payoutId: string; sellerId: string; currency: Currency; amountMinor: bigint; via: { gateway: string } | 'trust_bank' }): JournalSpec {
  const a = positive(p.amountMinor, 'Payout');
  return journal({
    kind: 'payout',
    currency: p.currency,
    idempotencyKey: `payout:${p.payoutId}`,
    description: 'Seller payout',
    referenceType: 'payout',
    referenceId: p.payoutId,
    lines: [
      { account: seller(p.sellerId), amountMinor: a },
      { account: p.via === 'trust_bank' ? platform('trust_bank') : gateway(p.via.gateway), amountMinor: -a },
    ],
  });
}

/** Refund to the wallet after an upheld dispute, funded by the seller's payable or, once paid out, by ABC. */
export function refundToWallet(p: { disputeId: string; buyerId: string; currency: Currency; amountMinor: bigint; fundedBy: { sellerId: string } | 'platform' }): JournalSpec {
  const a = positive(p.amountMinor, 'Refund');
  return journal({
    kind: 'refund',
    currency: p.currency,
    idempotencyKey: `dispute:${p.disputeId}:refund`,
    description: 'Refund after an upheld claim',
    referenceType: 'dispute',
    referenceId: p.disputeId,
    lines: [
      { account: p.fundedBy === 'platform' ? platform('suspense') : seller(p.fundedBy.sellerId), amountMinor: a },
      { account: customer(p.buyerId, 'wallet_available'), amountMinor: -a },
    ],
  });
}

/**
 * Full refund and return after an upheld claim (docs/17 §6): the sale of one lot is
 * unwound. The buyer gets back everything the invoice charged for that lot. The
 * seller's net share (hammer less commission) comes out of their payable, or out of
 * platform suspense once they have been paid, to be clawed back. ABC gives back its
 * commission, and the tax, premium and delivery credits made at issue are reversed.
 */
export function fullRefundAndReturn(p: {
  disputeId: string;
  buyerId: string;
  sellerId: string;
  currency: Currency;
  hammerMinor: bigint;
  commissionMinor: bigint;
  /** The lot's other invoice lines (taxes, premium, delivery), reversed account by account. */
  otherLines: ReadonlyArray<{ type: Exclude<InvoiceLineForLedger['type'], 'hammer'>; amountMinor: bigint }>;
  fundedBy: 'seller' | 'platform';
}): JournalSpec {
  const hammer = positive(p.hammerMinor, 'Hammer');
  if (p.commissionMinor < 0n || p.commissionMinor > hammer) throw new RangeError('Commission must be between 0 and the hammer');
  const share = hammer - p.commissionMinor;
  const reversed: JournalLine[] = p.otherLines.map((l) => {
    switch (l.type) {
      case 'buyers_premium':
        return { account: platform('fee_income', 'buyers_premium'), amountMinor: l.amountMinor };
      case 'delivery':
        return { account: platform('delivery_income'), amountMinor: l.amountMinor };
      default:
        return { account: platform('tax_payable', l.type), amountMinor: l.amountMinor };
    }
  });
  const total = hammer + p.otherLines.reduce((a, l) => a + l.amountMinor, 0n);
  return journal({
    kind: 'refund',
    currency: p.currency,
    idempotencyKey: `dispute:${p.disputeId}:refund`,
    description: 'Full refund after an upheld claim; lot returned to the seller',
    referenceType: 'dispute',
    referenceId: p.disputeId,
    lines: [
      { account: p.fundedBy === 'platform' ? platform('suspense') : seller(p.sellerId), amountMinor: share },
      { account: platform('commission_income'), amountMinor: p.commissionMinor },
      ...reversed,
      { account: customer(p.buyerId, 'wallet_available'), amountMinor: -total },
    ],
  });
}

/**
 * Recovers part of a clawback from a seller's later proceeds (docs/17 §6): the seller's
 * payable goes down by what ABC fronted, and platform suspense is repaid.
 */
export function clawbackRecovery(p: { clawbackId: string; payoutId: string; sellerId: string; currency: Currency; amountMinor: bigint }): JournalSpec {
  const a = positive(p.amountMinor, 'Clawback recovery');
  return journal({
    kind: 'clawback',
    currency: p.currency,
    idempotencyKey: `clawback:${p.clawbackId}:payout:${p.payoutId}`,
    description: 'Clawback recovered from a later payout',
    referenceType: 'clawback',
    referenceId: p.clawbackId,
    lines: [
      { account: seller(p.sellerId), amountMinor: a },
      { account: platform('suspense'), amountMinor: -a },
    ],
  });
}

// --- Logistics charges ---------------------------------------------------------------

/** Storage for goods left past the free period, paid from the wallet at release (docs/15 §5). */
export function storageFee(p: { collectionId: string; buyerId: string; currency: Currency; amountMinor: bigint; days: number }): JournalSpec {
  const a = positive(p.amountMinor, 'Storage fee');
  return journal({
    kind: 'storage_fee',
    currency: p.currency,
    idempotencyKey: `collection:${p.collectionId}:storage`,
    description: `Storage, ${p.days} day${p.days === 1 ? '' : 's'}`,
    referenceType: 'collection',
    referenceId: p.collectionId,
    lines: [
      { account: customer(p.buyerId, 'wallet_available'), amountMinor: a },
      { account: platform('fee_income', 'storage'), amountMinor: -a },
    ],
  });
}

/**
 * Door delivery booked after payment, paid from the wallet (docs/15 §6). The lines are
 * the delivery lines quoteLot produced (the charge and any tax on it), so the bill
 * equals the quote the buyer saw.
 */
export function deliveryCharge(p: {
  deliveryId: string;
  buyerId: string;
  currency: Currency;
  lines: ReadonlyArray<{ type: 'delivery' | 'purchasers_levy' | 'vat' | 'imtt' | 'transfer_tax'; amountMinor: bigint }>;
}): JournalSpec {
  const total = p.lines.reduce((a, l) => a + l.amountMinor, 0n);
  positive(total, 'Delivery charge');
  return journal({
    kind: 'delivery_charge',
    currency: p.currency,
    idempotencyKey: `delivery:${p.deliveryId}:charge`,
    description: 'Door delivery',
    referenceType: 'delivery',
    referenceId: p.deliveryId,
    lines: [
      { account: customer(p.buyerId, 'wallet_available'), amountMinor: total },
      ...p.lines.map((l) => ({
        account: l.type === 'delivery' ? platform('delivery_income') : platform('tax_payable', l.type),
        amountMinor: -l.amountMinor,
      })),
    ],
  });
}

/** Money leaves the wallet back to where it came from (never to a new destination: Q7). */
export function refundToSource(p: { refundId: string; accountId: string; currency: Currency; amountMinor: bigint; gateway: string }): JournalSpec {
  const a = positive(p.amountMinor, 'Refund');
  return journal({
    kind: 'refund',
    currency: p.currency,
    idempotencyKey: `refund:${p.refundId}`,
    description: `Refund to source via ${p.gateway}`,
    referenceType: 'refund',
    referenceId: p.refundId,
    lines: [
      { account: customer(p.accountId, 'wallet_available'), amountMinor: a },
      { account: gateway(p.gateway), amountMinor: -a },
    ],
  });
}

/**
 * A reconciliation shortfall written off after a second person approves (docs/18 §6):
 * the gateway will never settle money the System credited, so the clearing balance
 * it left behind becomes an expense.
 */
export function reconciliationWriteOff(p: { itemId: string; gateway: string; currency: Currency; amountMinor: bigint }): JournalSpec {
  const a = positive(p.amountMinor, 'Write-off');
  return journal({
    kind: 'adjustment',
    currency: p.currency,
    idempotencyKey: `reconciliation:${p.itemId}:write_off`,
    description: `Reconciliation shortfall written off (${p.gateway})`,
    referenceType: 'reconciliation_item',
    referenceId: p.itemId,
    lines: [
      { account: platform('write_off'), amountMinor: a },
      { account: gateway(p.gateway), amountMinor: -a },
    ],
  });
}

/**
 * After a forfeit is reversed on appeal (docs/18 §7), the deposit is back in wallet_held
 * with no active hold behind it; this moves it to the available balance.
 */
export function returnForfeitedDeposit(p: { holdId: string; accountId: string; currency: Currency; amountMinor: bigint }): JournalSpec {
  const a = positive(p.amountMinor, 'Deposit');
  return journal({
    kind: 'hold_release',
    currency: p.currency,
    idempotencyKey: `hold:${p.holdId}:waiver_return`,
    description: 'Forfeited deposit returned after an appeal',
    referenceType: 'hold',
    referenceId: p.holdId,
    lines: [
      { account: customer(p.accountId, 'wallet_held'), amountMinor: a },
      { account: customer(p.accountId, 'wallet_available'), amountMinor: -a },
    ],
  });
}

/** The mirror image of any journal, pointing at the original. */
export function reversal(original: JournalSpec, originalJournalId: string, reason: string): JournalSpec {
  return journal({
    kind: 'reversal',
    currency: original.currency,
    idempotencyKey: `reversal:${originalJournalId}`,
    description: `Reversal: ${reason}`,
    reversesJournalId: originalJournalId,
    referenceType: original.referenceType,
    referenceId: original.referenceId,
    lines: original.lines.map((l) => ({ account: l.account, amountMinor: -l.amountMinor })),
  });
}
