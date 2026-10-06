import type { Currency } from '@abc/domain';
import type { IncrementBands } from './registry';
import type { RuleSnapshot } from './resolve';
import { RuleMissingError } from './resolve';
import type { ScopeContext } from './types';

/**
 * The visible increment ladder (blueprint module 5). Bidding validates against it,
 * the commit screen shows it, and both read it from the same rule.
 */

export function ladderFor(snapshot: RuleSnapshot, currency: Currency, ctx: ScopeContext = {}): IncrementBands {
  const ladder = snapshot.get('bidding.increment_ladder', { ...ctx, currency })[currency];
  if (ladder === null) throw new RuleMissingError('bidding.increment_ladder', `no ${currency} ladder is set`);
  return ladder;
}

export function incrementAt(priceMinor: bigint, bands: IncrementBands): bigint {
  let increment: number | undefined;
  for (const band of bands) {
    if (BigInt(band.from) <= priceMinor) increment = band.increment;
    else break;
  }
  if (increment === undefined) throw new Error('Increment ladder must start at 0');
  return BigInt(increment);
}

export interface LotPriceState {
  startingBidMinor: bigint;
  /** null when the lot has no bids yet. */
  currentPriceMinor: bigint | null;
}

/** The lowest amount a new bid (or new maximum) may be. */
export function minimumNextBid(state: LotPriceState, bands: IncrementBands): bigint {
  if (state.currentPriceMinor === null) return state.startingBidMinor;
  return state.currentPriceMinor + incrementAt(state.currentPriceMinor, bands);
}

export type BidAmountCheck = { ok: true } | { ok: false; reason: 'below_minimum'; minimumMinor: bigint };

/**
 * A maximum bid may be any amount at or above the minimum next bid; the engine
 * then bids on the bidder's behalf in ladder steps.
 */
export function checkBidAmount(amountMinor: bigint, state: LotPriceState, bands: IncrementBands): BidAmountCheck {
  const minimumMinor = minimumNextBid(state, bands);
  return amountMinor >= minimumMinor ? { ok: true } : { ok: false, reason: 'below_minimum', minimumMinor };
}

/** The next `count` prices on the ladder from the current state, for the "quick bid" buttons. */
export function ladderSteps(state: LotPriceState, bands: IncrementBands, count: number): bigint[] {
  const steps: bigint[] = [];
  let price = minimumNextBid(state, bands);
  for (let i = 0; i < count; i++) {
    steps.push(price);
    price += incrementAt(price, bands);
  }
  return steps;
}
