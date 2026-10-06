import { createHmac, randomBytes } from 'node:crypto';
import type { Currency } from '@abc/domain';
import { applyBasisPoints } from '@abc/domain';
import { quoteLot, type LotPricing, type QuoteLine } from '@abc/quote';
import { DEFAULT_LADDER_STEPS, type RuleSnapshot, type TaxRateRecord } from '@abc/rules';

/**
 * Close and settlement, pure parts (docs/11-close-settlement.md): invoices built at
 * the hammer, deadlines, reminders, the default ladder, gate passes and payout dates.
 */

const HOUR = 3_600_000;

export interface SoldLot {
  auctionLotId: string;
  lotId: string;
  sellerId: string;
  buyerId: string;
  pricing: LotPricing;
  hammerMinor: bigint;
  hammerAt: Date;
}

export interface DraftLine extends QuoteLine {
  lotId: string;
  auctionLotId: string;
  sellerId: string;
}

export interface InvoiceDraft {
  buyerId: string;
  currency: Currency;
  lines: DraftLine[];
  totalMinor: bigint;
  issuedAt: Date;
  dueAt: Date;
  collectByAt: Date;
  ruleVersionId: string;
}

/**
 * One invoice per buyer and currency for an auction (lots won together are billed
 * together). Each lot is priced by the same QuoteService the commit screen used,
 * with the auction's pinned rules and the tax rates in force at that lot's hammer.
 */
export function buildInvoiceDrafts(
  sold: readonly SoldLot[],
  snapshot: RuleSnapshot,
  taxRates: readonly TaxRateRecord[],
  issuedAt: Date,
): InvoiceDraft[] {
  const payWindow = snapshot.get('settlement.pay_window_hours');
  const collectWindow = snapshot.get('settlement.collect_window_hours');
  const groups = new Map<string, InvoiceDraft>();
  for (const lot of sold) {
    const key = `${lot.buyerId}|${lot.pricing.currency}`;
    let draft = groups.get(key);
    if (!draft) {
      draft = {
        buyerId: lot.buyerId,
        currency: lot.pricing.currency,
        lines: [],
        totalMinor: 0n,
        issuedAt,
        dueAt: new Date(issuedAt.getTime() + payWindow * HOUR),
        collectByAt: new Date(issuedAt.getTime() + (payWindow + collectWindow) * HOUR),
        ruleVersionId: snapshot.versionId,
      };
      groups.set(key, draft);
    }
    const quote = quoteLot({ lot: lot.pricing, hammerMinor: lot.hammerMinor, snapshot, taxRates, at: lot.hammerAt });
    for (const line of quote.lines) {
      draft.lines.push({ ...line, lotId: lot.lotId, auctionLotId: lot.auctionLotId, sellerId: lot.sellerId });
    }
    draft.totalMinor += quote.totalMinor;
  }
  return [...groups.values()];
}

/** When payment reminders go out (rule settlement.reminder_offsets_hours). */
export function reminderTimes(issuedAt: Date, snapshot: RuleSnapshot): Array<{ offsetHours: number; at: Date }> {
  return snapshot.get('settlement.reminder_offsets_hours').map((h) => ({ offsetHours: h, at: new Date(issuedAt.getTime() + h * HOUR) }));
}

export type LadderStep = (typeof DEFAULT_LADDER_STEPS)[number];

/** Default-ladder steps that are due now and not yet applied, in ladder order. */
export function dueLadderSteps(dueAt: Date, now: Date, applied: ReadonlySet<LadderStep>, snapshot: RuleSnapshot): LadderStep[] {
  if (now.getTime() < dueAt.getTime()) return [];
  return snapshot
    .get('settlement.default_ladder')
    .filter((s) => !applied.has(s.step) && now.getTime() >= dueAt.getTime() + s.afterDueHours * HOUR)
    .map((s) => s.step);
}

/** Relist fee: a share of the hammer, at least the minimum in that currency (rule settlement.relist_fee). */
export function relistFeeAmount(hammerMinor: bigint, currency: Currency, snapshot: RuleSnapshot): bigint {
  const rule = snapshot.get('settlement.relist_fee');
  const fee = applyBasisPoints(hammerMinor, rule.rateBp);
  const minimum = rule.minimum[currency];
  return minimum !== null && fee < BigInt(minimum) ? BigInt(minimum) : fee;
}

/** Sellers are paid after the buyer's claim window closes plus processing time. */
export function payoutDueAt(releasedAt: Date, snapshot: RuleSnapshot): Date {
  const hours = snapshot.get('dispute.claim_window_hours_after_release') + snapshot.get('payout.processing_hours');
  return new Date(releasedAt.getTime() + hours * HOUR);
}

/** The QR gate pass: a random token shown as a QR code; only its keyed hash is stored. */
export function newGatePassToken(): string {
  return randomBytes(18).toString('base64url');
}

export function hashGatePass(token: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(token).digest();
}
