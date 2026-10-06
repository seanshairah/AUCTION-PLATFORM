import type { Currency } from '@abc/domain';
import type { RuleSnapshot, Tier } from '@abc/rules';

/**
 * Spending limits and one-tap registration (docs/10-registration-limits.md;
 * formula in docs/02-data-model.md §6.2). Pure functions: the registration
 * service feeds them figures read from the ledger and invoices.
 */

export type VerificationLevel = 'none' | 'partial' | 'full';
export type AccountStatus = 'active' | 'suspended' | 'closed';

export interface LimitInput {
  snapshot: RuleSnapshot;
  currency: Currency;
  tier: Tier;
  verificationLevel: VerificationLevel;
  accountStatus: AccountStatus;
  /** True when the auction being bid in needs a deposit: no free allowance then. */
  depositRequired: boolean;
  /** Active deposit holds in this currency. */
  heldDepositMinor: bigint;
  /** Invoices paid in full in this currency over the last 12 months. */
  paidInFull12mMinor: bigint;
  /** An approved, unexpired staff limit override (audited, two-person above threshold). */
  overrideMinor?: bigint | null;
}

export interface LimitResult {
  limitMinor: bigint;
  basis: 'blocked' | 'override' | 'formula';
  parts: {
    baseMinor: bigint;
    depositMinor: bigint;
    multiplier: number;
    depositComponentMinor: bigint;
    upliftMinor: bigint;
  };
  /** Why the limit is zero or limited, in plain words, when that is useful to show. */
  notes: string[];
}

const ZERO_PARTS = { baseMinor: 0n, depositMinor: 0n, multiplier: 0, depositComponentMinor: 0n, upliftMinor: 0n };

export function computeLimit(input: LimitInput): LimitResult {
  const { snapshot: s, currency, tier } = input;
  const ctx = { currency, tier };
  if (input.accountStatus !== 'active') {
    return { limitMinor: 0n, basis: 'blocked', parts: ZERO_PARTS, notes: ['Your account is not active.'] };
  }
  if (tier === 'guest' || input.verificationLevel === 'none') {
    return { limitMinor: 0n, basis: 'blocked', parts: ZERO_PARTS, notes: ['Verify your email and phone to bid.'] };
  }
  if (input.overrideMinor !== undefined && input.overrideMinor !== null) {
    return { limitMinor: input.overrideMinor, basis: 'override', parts: ZERO_PARTS, notes: ['A staff-approved limit applies.'] };
  }

  const notes: string[] = [];
  const multiplier = s.get('limit.deposit_multiplier', ctx);
  const depositComponent = input.heldDepositMinor * BigInt(multiplier);

  let base = 0n;
  if (!input.depositRequired && tier !== 'restricted') {
    const level = input.verificationLevel === 'full' ? 'full' : 'partial';
    const configured = s.get('limit.base', ctx)[level][currency];
    if (configured === null) notes.push(`The free allowance in ${currency === 'USD' ? 'USD' : 'ZiG'} is not set yet; add a deposit to bid.`);
    base = configured === null ? 0n : BigInt(configured);
  }
  if (input.depositRequired && input.heldDepositMinor === 0n) notes.push('This auction needs a deposit.');

  let uplift = 0n;
  const upliftBp = s.get('limit.history_uplift_bp', ctx);
  if (upliftBp > 0) {
    const cap = s.get('limit.history_uplift_cap', ctx)[currency];
    const raw = (input.paidInFull12mMinor * BigInt(upliftBp)) / 10_000n;
    uplift = cap === null ? 0n : raw < BigInt(cap) ? raw : BigInt(cap);
  }

  const formula = s.get('limit.formula', ctx);
  if (formula !== 'max_of_base_and_deposit') throw new Error(`Unknown limit formula ${formula}`);
  const limitMinor = (base > depositComponent ? base : depositComponent) + uplift;
  return {
    limitMinor,
    basis: 'formula',
    parts: { baseMinor: base, depositMinor: input.heldDepositMinor, multiplier, depositComponentMinor: depositComponent, upliftMinor: uplift },
    notes,
  };
}

export interface LeadingLot {
  auctionLotId: string;
  /** All-in total at the bidder's maximum and at the current price (from QuoteService). */
  allInAtMaxMinor: bigint;
  allInAtCurrentMinor: bigint;
}

/** What already counts against the limit (rule limit.exposure_basis, A21). */
export function exposure(
  snapshot: RuleSnapshot,
  leading: readonly LeadingLot[],
  unpaidInvoicesMinor: bigint,
  excludeAuctionLotId?: string,
): bigint {
  const basis = snapshot.get('limit.exposure_basis');
  return leading
    .filter((l) => l.auctionLotId !== excludeAuctionLotId)
    .reduce((acc, l) => acc + (basis === 'proxy_ceiling' ? l.allInAtMaxMinor : l.allInAtCurrentMinor), unpaidInvoicesMinor);
}

/** Room left to bid, all-in. Never negative. */
export function capacity(limitMinor: bigint, exposureMinor: bigint): bigint {
  return limitMinor > exposureMinor ? limitMinor - exposureMinor : 0n;
}

// --- Registration decision -------------------------------------------------------

export type ReviewTrigger = 'tier_restricted' | 'linked_to_seller' | 'risk_flag' | 'kyc_pending_for_deposit_auction';

export interface RegistrationInput {
  snapshot: RuleSnapshot;
  tier: Tier;
  verificationLevel: VerificationLevel;
  accountStatus: AccountStatus;
  depositRequired: boolean;
  /** Minimum deposit per currency used in the auction; null where not set. */
  minimumDeposit: Partial<Record<Currency, bigint | null>>;
  /** Deposit the bidder offers to hold now, per currency. */
  depositOffered: Partial<Record<Currency, bigint>>;
  linkedToSeller: boolean;
  openRiskFlag: boolean;
  kycPending: boolean;
}

export type RegistrationDecision =
  | { status: 'approved'; reasons: [] }
  | { status: 'pending_review'; reasons: Array<ReviewTrigger | 'manual_policy'> }
  | { status: 'rejected'; reasons: Array<'not_verified' | 'account_inactive' | 'deposit_needed' | 'deposit_not_configured'>; message: string };

/**
 * One tap to join: approve automatically unless a review trigger applies
 * (blueprint module 2: "auto-approve any account in good standing").
 */
export function decideRegistration(input: RegistrationInput): RegistrationDecision {
  if (input.accountStatus !== 'active') {
    return { status: 'rejected', reasons: ['account_inactive'], message: 'Your account is not active. Contact ABC to restore it.' };
  }
  if (input.tier === 'guest' || input.verificationLevel === 'none') {
    return { status: 'rejected', reasons: ['not_verified'], message: 'Verify your email and phone number to join auctions.' };
  }

  if (input.depositRequired) {
    const offered = Object.entries(input.depositOffered) as Array<[Currency, bigint]>;
    const enough = offered.some(([c, amount]) => {
      const min = input.minimumDeposit[c];
      return min !== undefined && min !== null && amount >= min;
    });
    if (!enough) {
      const configured = Object.values(input.minimumDeposit).some((m) => m !== null && m !== undefined);
      return configured
        ? { status: 'rejected', reasons: ['deposit_needed'], message: 'This auction needs a deposit of at least the minimum shown.' }
        : { status: 'rejected', reasons: ['deposit_not_configured'], message: 'Deposits for this auction are not open yet.' };
    }
  }

  const enabled = new Set(input.snapshot.get('registration.manual_review_triggers'));
  const reasons: ReviewTrigger[] = [];
  if (input.tier === 'restricted' && enabled.has('tier_restricted')) reasons.push('tier_restricted');
  if (input.linkedToSeller && enabled.has('linked_to_seller')) reasons.push('linked_to_seller');
  if (input.openRiskFlag && enabled.has('risk_flag')) reasons.push('risk_flag');
  if (input.depositRequired && input.kycPending && enabled.has('kyc_pending_for_deposit_auction')) reasons.push('kyc_pending_for_deposit_auction');

  if (reasons.length > 0) return { status: 'pending_review', reasons };
  if (!input.snapshot.get('registration.auto_approve')) return { status: 'pending_review', reasons: ['manual_policy'] };
  return { status: 'approved', reasons: [] };
}
