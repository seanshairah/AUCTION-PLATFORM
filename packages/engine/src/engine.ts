import type { Currency } from '@abc/domain';
import { incrementAt, minimumNextBid, type IncrementBands } from '@abc/rules';

/**
 * The reference bidding engine: proxy (maximum) bidding with soft close, as a
 * pure state machine. It decides price discovery only. Registration, the
 * spending limit and the seller-linked bar are checked by the bidding service
 * before a request reaches the engine (docs/07-bidding-engine.md §2).
 *
 * Every call returns the new state plus the bid rows to append to the
 * immutable bid log, so the log alone can rebuild the state (replay).
 */

export interface LotConfig {
  currency: Currency;
  startingBidMinor: bigint;
  reserveMinor: bigint | null;
  ladder: IncrementBands;
  softCloseSeconds: number;
  triggerSeconds: number;
  priceJumpsToReserve: boolean;
  extendOn: 'price_or_leader_change' | 'any_accepted_bid';
}

export interface Leader {
  accountId: string;
  maxMinor: bigint;
  /** Sequence number of the bid that set this maximum. */
  bidSeq: bigint;
}

export interface LotState {
  /** Last sequence number issued on this lot. */
  seq: bigint;
  currentPriceMinor: bigint | null;
  leader: Leader | null;
  endAt: Date;
  extensionCount: number;
}

export interface MaxBidRequest {
  accountId: string;
  maxMinor: bigint;
  /** Server receive time. Never the device clock. */
  at: Date;
  clientRequestId: string;
}

export type RejectReason = 'lot_closed' | 'below_minimum' | 'not_above_your_max';

export interface LoggedBid {
  seq: bigint;
  accountId: string;
  origin: 'bidder' | 'proxy';
  amountMinor: bigint;
  /** The secret ceiling, on bidder rows only. */
  maxMinor?: bigint;
  outcome: 'leading' | 'outbid' | 'rejected';
  rejectReason?: RejectReason;
  /** For proxy rows: the bidder row whose maximum produced this bid. */
  parentSeq?: bigint;
  clientRequestId?: string;
  at: Date;
}

export type EngineEvent =
  | { type: 'price_changed'; priceMinor: bigint }
  | { type: 'leader_changed'; accountId: string }
  | { type: 'outbid'; accountId: string; priceMinor: bigint }
  | { type: 'extended'; endAt: Date }
  | { type: 'reserve_met' };

export type ReserveStatus = 'no_reserve' | 'not_met' | 'met';

/** What the bidder gets back: the bid receipt (blueprint §8 "bid receipts with a sequence number"). */
export interface BidReceipt {
  seq: bigint;
  serverTime: Date;
  outcome: 'leading' | 'outbid' | 'rejected';
  rejectReason?: RejectReason;
  /** Lowest acceptable amount, when rejected for being too low. */
  minimumMinor?: bigint;
  currentPriceMinor: bigint | null;
  youAreLeading: boolean;
  endAt: Date;
  reserveStatus: ReserveStatus;
}

export interface PlaceResult {
  state: LotState;
  bids: LoggedBid[];
  events: EngineEvent[];
  receipt: BidReceipt;
}

export function initialState(scheduledEndAt: Date): LotState {
  return { seq: 0n, currentPriceMinor: null, leader: null, endAt: scheduledEndAt, extensionCount: 0 };
}

export function reserveStatus(config: LotConfig, state: LotState): ReserveStatus {
  if (config.reserveMinor === null) return 'no_reserve';
  return state.currentPriceMinor !== null && state.currentPriceMinor >= config.reserveMinor ? 'met' : 'not_met';
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Raises a price to the reserve when the leading maximum covers it (rule bidding.price_jumps_to_reserve). */
function withReserveJump(config: LotConfig, price: bigint, leaderMax: bigint): bigint {
  const r = config.reserveMinor;
  if (!config.priceJumpsToReserve || r === null || leaderMax < r) return price;
  return max(price, r);
}

export function isClosed(state: LotState, at: Date): boolean {
  return at.getTime() >= state.endAt.getTime();
}

/**
 * Places a maximum bid. Ties go to the earlier maximum. The price is the lowest
 * amount that beats every other bidder's maximum by one increment, capped at the
 * leader's own maximum, and raised to the reserve when the leader's maximum covers it.
 */
export function placeMaxBid(config: LotConfig, state: LotState, req: MaxBidRequest): PlaceResult {
  // Amounts are parsed and validated as positive before they reach the engine (commitPreview / API).
  if (req.maxMinor <= 0n) throw new RangeError('A maximum bid must be a positive amount');
  let seq = state.seq;
  const next = () => ++seq;
  const bids: LoggedBid[] = [];
  const events: EngineEvent[] = [];
  const before = reserveStatus(config, state);

  const reject = (reason: RejectReason, minimumMinor?: bigint): PlaceResult => {
    const row: LoggedBid = {
      seq: next(),
      accountId: req.accountId,
      origin: 'bidder',
      amountMinor: req.maxMinor,
      maxMinor: req.maxMinor,
      outcome: 'rejected',
      rejectReason: reason,
      clientRequestId: req.clientRequestId,
      at: req.at,
    };
    const newState = { ...state, seq };
    return {
      state: newState,
      bids: [row],
      events: [],
      receipt: {
        seq: row.seq,
        serverTime: req.at,
        outcome: 'rejected',
        rejectReason: reason,
        ...(minimumMinor !== undefined ? { minimumMinor } : {}),
        currentPriceMinor: state.currentPriceMinor,
        youAreLeading: state.leader?.accountId === req.accountId,
        endAt: state.endAt,
        reserveStatus: before,
      },
    };
  };

  if (isClosed(state, req.at)) return reject('lot_closed');

  const leader = state.leader;
  let price = state.currentPriceMinor;
  let newLeader: Leader | null = leader;
  let bidderSeq: bigint;
  let bidderOutcome: 'leading' | 'outbid';

  if (leader && leader.accountId === req.accountId) {
    // The leader raises their own maximum. The price moves only to meet the reserve.
    if (req.maxMinor <= leader.maxMinor) return reject('not_above_your_max');
    bidderSeq = next();
    price = withReserveJump(config, price!, req.maxMinor);
    newLeader = { accountId: req.accountId, maxMinor: req.maxMinor, bidSeq: bidderSeq };
    bidderOutcome = 'leading';
    bids.push({
      seq: bidderSeq,
      accountId: req.accountId,
      origin: 'bidder',
      amountMinor: price,
      maxMinor: req.maxMinor,
      outcome: 'leading',
      clientRequestId: req.clientRequestId,
      at: req.at,
    });
  } else {
    const minimum = minimumNextBid({ startingBidMinor: config.startingBidMinor, currentPriceMinor: state.currentPriceMinor }, config.ladder);
    if (req.maxMinor < minimum) return reject('below_minimum', minimum);

    if (!leader) {
      // First bid on the lot.
      bidderSeq = next();
      price = withReserveJump(config, config.startingBidMinor, req.maxMinor);
      newLeader = { accountId: req.accountId, maxMinor: req.maxMinor, bidSeq: bidderSeq };
      bidderOutcome = 'leading';
      bids.push({
        seq: bidderSeq,
        accountId: req.accountId,
        origin: 'bidder',
        amountMinor: price,
        maxMinor: req.maxMinor,
        outcome: 'leading',
        clientRequestId: req.clientRequestId,
        at: req.at,
      });
    } else if (req.maxMinor > leader.maxMinor) {
      // The challenger takes the lead. The previous leader's proxy bids up to their maximum first.
      if (leader.maxMinor > state.currentPriceMinor!) {
        bids.push({
          seq: next(),
          accountId: leader.accountId,
          origin: 'proxy',
          amountMinor: leader.maxMinor,
          outcome: 'outbid',
          parentSeq: leader.bidSeq,
          at: req.at,
        });
      }
      bidderSeq = next();
      price = min(req.maxMinor, max(leader.maxMinor + incrementAt(leader.maxMinor, config.ladder), minimum));
      price = withReserveJump(config, price, req.maxMinor);
      newLeader = { accountId: req.accountId, maxMinor: req.maxMinor, bidSeq: bidderSeq };
      bidderOutcome = 'leading';
      bids.push({
        seq: bidderSeq,
        accountId: req.accountId,
        origin: 'bidder',
        amountMinor: price,
        maxMinor: req.maxMinor,
        outcome: 'leading',
        clientRequestId: req.clientRequestId,
        at: req.at,
      });
      events.push({ type: 'outbid', accountId: leader.accountId, priceMinor: price });
    } else {
      // The leader's maximum holds (ties go to the earlier maximum). Their proxy answers.
      bidderSeq = next();
      bidderOutcome = 'outbid';
      bids.push({
        seq: bidderSeq,
        accountId: req.accountId,
        origin: 'bidder',
        amountMinor: req.maxMinor,
        maxMinor: req.maxMinor,
        outcome: 'outbid',
        clientRequestId: req.clientRequestId,
        at: req.at,
      });
      price = min(leader.maxMinor, req.maxMinor + incrementAt(req.maxMinor, config.ladder));
      price = withReserveJump(config, price, leader.maxMinor);
      bids.push({
        seq: next(),
        accountId: leader.accountId,
        origin: 'proxy',
        amountMinor: price,
        outcome: 'leading',
        parentSeq: leader.bidSeq,
        at: req.at,
      });
    }
  }

  const priceChanged = price !== state.currentPriceMinor;
  const leaderChanged = newLeader?.accountId !== leader?.accountId;
  if (priceChanged) events.push({ type: 'price_changed', priceMinor: price! });
  if (leaderChanged) events.push({ type: 'leader_changed', accountId: newLeader!.accountId });

  // Soft close: a qualifying bid inside the trigger window pushes the end to at least
  // `softCloseSeconds` after the bid. The end time never moves earlier.
  let endAt = state.endAt;
  let extensionCount = state.extensionCount;
  const qualifies = config.extendOn === 'any_accepted_bid' || priceChanged || leaderChanged;
  const remainingMs = state.endAt.getTime() - req.at.getTime();
  if (qualifies && remainingMs <= config.triggerSeconds * 1000) {
    const candidate = new Date(req.at.getTime() + config.softCloseSeconds * 1000);
    if (candidate.getTime() > endAt.getTime()) {
      endAt = candidate;
      extensionCount += 1;
      events.push({ type: 'extended', endAt });
    }
  }

  const newState: LotState = { seq, currentPriceMinor: price, leader: newLeader, endAt, extensionCount };
  const after = reserveStatus(config, newState);
  if (before === 'not_met' && after === 'met') events.push({ type: 'reserve_met' });

  return {
    state: newState,
    bids,
    events,
    receipt: {
      seq: bidderSeq,
      serverTime: req.at,
      outcome: bidderOutcome,
      currentPriceMinor: price,
      youAreLeading: newLeader?.accountId === req.accountId,
      endAt,
      reserveStatus: after,
    },
  };
}

export type CloseResult =
  | { result: 'unsold' }
  | { result: 'reserve_not_met'; topBidderAccountId: string; topBidMinor: bigint }
  | { result: 'sold'; winnerAccountId: string; hammerMinor: bigint };

export class LotStillOpenError extends Error {
  constructor(endAt: Date) {
    super(`Lot is open until ${endAt.toISOString()}`);
    this.name = 'LotStillOpenError';
  }
}

/** Closes a lot at or after its (possibly extended) end time. */
export function closeLot(config: LotConfig, state: LotState, at: Date): CloseResult {
  if (!isClosed(state, at)) throw new LotStillOpenError(state.endAt);
  if (!state.leader || state.currentPriceMinor === null) return { result: 'unsold' };
  if (reserveStatus(config, state) === 'not_met') {
    return { result: 'reserve_not_met', topBidderAccountId: state.leader.accountId, topBidMinor: state.currentPriceMinor };
  }
  return { result: 'sold', winnerAccountId: state.leader.accountId, hammerMinor: state.currentPriceMinor };
}

/**
 * Rebuilds a lot from its bidder requests in their original order, skipping voided
 * ones. The bid log fully determines the price; after a staff bid removal this is
 * how the corrected state is computed (docs/07-bidding-engine.md §6).
 */
export function replay(
  config: LotConfig,
  scheduledEndAt: Date,
  requests: readonly MaxBidRequest[],
): { state: LotState; bids: LoggedBid[]; receipts: BidReceipt[] } {
  let state = initialState(scheduledEndAt);
  const bids: LoggedBid[] = [];
  const receipts: BidReceipt[] = [];
  for (const req of requests) {
    const r = placeMaxBid(config, state, req);
    state = r.state;
    bids.push(...r.bids);
    receipts.push(r.receipt);
  }
  return { state, bids, receipts };
}
