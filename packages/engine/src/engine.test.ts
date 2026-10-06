import { describe, expect, it } from 'vitest';
import { incrementAt, type IncrementBands } from '@abc/rules';
import {
  closeLot,
  endAfterOutage,
  initialState,
  LotStillOpenError,
  placeMaxBid,
  publicHistory,
  replay,
  scheduleEndTimes,
  type LotConfig,
  type LotState,
  type MaxBidRequest,
} from './index';

// The placeholder USD ladder from the initial rule set.
const LADDER: IncrementBands = [
  { from: 0, increment: 100 },
  { from: 5_000, increment: 500 },
  { from: 20_000, increment: 1_000 },
  { from: 100_000, increment: 5_000 },
  { from: 500_000, increment: 10_000 },
  { from: 2_000_000, increment: 25_000 },
];

const END = new Date('2026-11-20T18:00:00Z');
const MIN = 60_000;

const CONFIG: LotConfig = {
  currency: 'USD',
  startingBidMinor: 5_000n, // US$50
  reserveMinor: null,
  ladder: LADDER,
  softCloseSeconds: 600,
  triggerSeconds: 600,
  priceJumpsToReserve: true,
  extendOn: 'price_or_leader_change',
};

let counter = 0;
function bid(accountId: string, maxMinor: bigint, at: Date = new Date(END.getTime() - 60 * MIN)): MaxBidRequest {
  return { accountId, maxMinor, at, clientRequestId: `req-${++counter}` };
}

function run(config: LotConfig, requests: MaxBidRequest[]) {
  return replay(config, END, requests);
}

describe('proxy bidding', () => {
  it('opens at the starting bid, whatever the first maximum', () => {
    const { state, receipts } = run(CONFIG, [bid('A', 20_000n)]);
    expect(state.currentPriceMinor).toBe(5_000n);
    expect(state.leader).toMatchObject({ accountId: 'A', maxMinor: 20_000n });
    expect(receipts[0]).toMatchObject({ outcome: 'leading', youAreLeading: true, seq: 1n, currentPriceMinor: 5_000n });
  });

  it('a lower challenger is outbid at once by the leader’s proxy, one increment above', () => {
    const { state, bids, receipts } = run(CONFIG, [bid('A', 20_000n), bid('B', 8_000n)]);
    expect(state.currentPriceMinor).toBe(8_500n); // US$80 + US$5
    expect(state.leader?.accountId).toBe('A');
    expect(receipts[1]).toMatchObject({ outcome: 'outbid', youAreLeading: false, currentPriceMinor: 8_500n });
    expect(bids.map((b) => [b.seq, b.accountId, b.origin, b.amountMinor, b.outcome])).toEqual([
      [1n, 'A', 'bidder', 5_000n, 'leading'],
      [2n, 'B', 'bidder', 8_000n, 'outbid'],
      [3n, 'A', 'proxy', 8_500n, 'leading'],
    ]);
    expect(bids[2]!.parentSeq).toBe(1n);
  });

  it('a higher challenger takes the lead at one increment above the old maximum', () => {
    const { state, bids, receipts } = run(CONFIG, [bid('A', 20_000n), bid('B', 50_000n)]);
    expect(state.currentPriceMinor).toBe(21_000n); // US$200 + US$10
    expect(state.leader?.accountId).toBe('B');
    expect(receipts[1]).toMatchObject({ outcome: 'leading', youAreLeading: true });
    // A's proxy is shown bidding up to A's maximum before B takes over.
    expect(bids.slice(1).map((b) => [b.accountId, b.origin, b.amountMinor, b.outcome])).toEqual([
      ['A', 'proxy', 20_000n, 'outbid'],
      ['B', 'bidder', 21_000n, 'leading'],
    ]);
  });

  it('caps the price at the new leader’s maximum when it is less than a full increment above', () => {
    const { state } = run(CONFIG, [bid('A', 20_000n), bid('B', 20_500n)]);
    expect(state.currentPriceMinor).toBe(20_500n);
    expect(state.leader?.accountId).toBe('B');
  });

  it('gives a tie to the earlier maximum', () => {
    const { state, receipts } = run(CONFIG, [bid('A', 20_000n), bid('B', 20_000n)]);
    expect(state.leader?.accountId).toBe('A');
    expect(state.currentPriceMinor).toBe(20_000n);
    expect(receipts[1]!.outcome).toBe('outbid');
  });

  it('rejects a bid below the minimum and says what the minimum is', () => {
    const { state, receipts, bids } = run(CONFIG, [bid('A', 20_000n), bid('B', 8_000n), bid('C', 8_600n)]);
    // Price is US$85, so the minimum next bid is US$90.
    expect(receipts[2]).toMatchObject({ outcome: 'rejected', rejectReason: 'below_minimum', minimumMinor: 9_000n });
    expect(state.currentPriceMinor).toBe(8_500n);
    expect(bids.at(-1)).toMatchObject({ outcome: 'rejected', seq: 4n }); // rejected attempts are logged too
  });

  it('lets the leader raise their maximum without moving the price', () => {
    const { state, receipts } = run(CONFIG, [bid('A', 20_000n), bid('B', 8_000n), bid('A', 40_000n)]);
    expect(state.currentPriceMinor).toBe(8_500n);
    expect(state.leader).toMatchObject({ accountId: 'A', maxMinor: 40_000n });
    expect(receipts[2]).toMatchObject({ outcome: 'leading', youAreLeading: true });
  });

  it('refuses a leader’s new maximum that is not above their current one', () => {
    const { receipts } = run(CONFIG, [bid('A', 20_000n), bid('A', 20_000n)]);
    expect(receipts[1]).toMatchObject({ outcome: 'rejected', rejectReason: 'not_above_your_max', youAreLeading: true });
  });

  it('refuses a non-positive amount outright (it never reaches the log)', () => {
    expect(() => placeMaxBid(CONFIG, initialState(END), bid('A', 0n))).toThrow(RangeError);
  });
});

describe('worked example in docs/07 §3', () => {
  it('matches the table row by row', () => {
    const { state, bids, receipts } = run(CONFIG, [
      bid('A', 20_000n),
      bid('B', 8_000n),
      bid('C', 8_600n),
      bid('B', 50_000n),
      bid('B', 80_000n),
    ]);
    const rows = bids.map((b) => [b.accountId, b.origin, b.amountMinor, b.outcome]);
    expect(rows).toEqual([
      ['A', 'bidder', 5_000n, 'leading'],
      ['B', 'bidder', 8_000n, 'outbid'],
      ['A', 'proxy', 8_500n, 'leading'],
      ['C', 'bidder', 8_600n, 'rejected'],
      ['A', 'proxy', 20_000n, 'outbid'],
      ['B', 'bidder', 21_000n, 'leading'],
      ['B', 'bidder', 21_000n, 'leading'],
    ]);
    expect(receipts[2]).toMatchObject({ rejectReason: 'below_minimum', minimumMinor: 9_000n });
    expect(state).toMatchObject({ currentPriceMinor: 21_000n, leader: { accountId: 'B', maxMinor: 80_000n } });
  });
});

describe('reserve', () => {
  const RESERVED: LotConfig = { ...CONFIG, reserveMinor: 30_000n };

  it('jumps to the reserve as soon as a maximum covers it, and reports reserve met', () => {
    const r = placeMaxBid(RESERVED, initialState(END), bid('A', 40_000n));
    expect(r.state.currentPriceMinor).toBe(30_000n);
    expect(r.receipt.reserveStatus).toBe('met');
    expect(r.events).toContainEqual({ type: 'reserve_met' });
  });

  it('stays below the reserve while no maximum covers it', () => {
    const { state, receipts } = run(RESERVED, [bid('A', 20_000n), bid('B', 25_000n)]);
    expect(state.currentPriceMinor).toBe(21_000n);
    expect(receipts[1]!.reserveStatus).toBe('not_met');
  });

  it('jumps when the leader raises their maximum past the reserve', () => {
    const { state, receipts } = run(RESERVED, [bid('A', 20_000n), bid('A', 35_000n)]);
    expect(state.currentPriceMinor).toBe(30_000n);
    expect(receipts[1]!.reserveStatus).toBe('met');
  });

  it('can rise one increment at a time instead, if the rule is off', () => {
    const r = placeMaxBid({ ...RESERVED, priceJumpsToReserve: false }, initialState(END), bid('A', 40_000n));
    expect(r.state.currentPriceMinor).toBe(5_000n);
    expect(r.receipt.reserveStatus).toBe('not_met');
  });

  it('closes as reserve not met, offering the top bidder', () => {
    const { state } = run(RESERVED, [bid('A', 20_000n), bid('B', 25_000n)]);
    expect(closeLot(RESERVED, state, END)).toEqual({ result: 'reserve_not_met', topBidderAccountId: 'B', topBidMinor: 21_000n });
  });
});

describe('soft close', () => {
  const at = (minutesBeforeEnd: number) => new Date(END.getTime() - minutesBeforeEnd * MIN);

  it('does not extend for a bid outside the trigger window', () => {
    const { state } = run(CONFIG, [bid('A', 20_000n, at(11))]);
    expect(state.endAt).toEqual(END);
    expect(state.extensionCount).toBe(0);
  });

  it('extends to 10 minutes after a late bid that changes the price', () => {
    const { state } = run(CONFIG, [bid('A', 20_000n, at(30)), bid('B', 8_000n, at(2))]);
    expect(state.endAt).toEqual(new Date(END.getTime() + 8 * MIN));
    expect(state.extensionCount).toBe(1);
  });

  it('keeps extending while bidding continues, and never moves the end earlier', () => {
    const t1 = at(1);
    const t2 = new Date(END.getTime() + 5 * MIN); // after the original end, inside the extension
    const { state } = run(CONFIG, [bid('A', 20_000n, at(30)), bid('B', 25_000n, t1), bid('A', 40_000n, t2)]);
    // A raising their maximum while leading? No: B leads after t1, so A's bid at t2 retakes the lead.
    expect(state.leader?.accountId).toBe('A');
    expect(state.endAt).toEqual(new Date(t2.getTime() + 10 * MIN));
    expect(state.extensionCount).toBe(2);
  });

  it('does not extend when the leader only raises their own maximum (rule extend_on)', () => {
    const { state } = run(CONFIG, [bid('A', 20_000n, at(30)), bid('A', 40_000n, at(1))]);
    expect(state.endAt).toEqual(END);
  });

  it('does extend on any accepted bid if the rule says so', () => {
    const { state } = run({ ...CONFIG, extendOn: 'any_accepted_bid' }, [bid('A', 20_000n, at(30)), bid('A', 40_000n, at(1))]);
    expect(state.endAt).toEqual(new Date(at(1).getTime() + 10 * MIN));
  });

  it('works with the 2-minute and 5-minute test values', () => {
    const two = run({ ...CONFIG, softCloseSeconds: 120, triggerSeconds: 120 }, [bid('A', 20_000n, at(30)), bid('B', 8_000n, at(1))]);
    expect(two.state.endAt).toEqual(new Date(at(1).getTime() + 2 * MIN));
    const five = run({ ...CONFIG, softCloseSeconds: 300, triggerSeconds: 300 }, [bid('A', 20_000n, at(30)), bid('B', 8_000n, at(6))]);
    expect(five.state.endAt).toEqual(END); // 6 minutes out is outside a 5-minute window
  });

  it('rejects bids at or after the end time, by server time', () => {
    const { receipts } = run(CONFIG, [bid('A', 20_000n, at(30)), bid('B', 30_000n, END)]);
    expect(receipts[1]).toMatchObject({ outcome: 'rejected', rejectReason: 'lot_closed' });
  });
});

describe('closing', () => {
  it('refuses to close before the end time', () => {
    expect(() => closeLot(CONFIG, initialState(END), new Date(END.getTime() - 1))).toThrow(LotStillOpenError);
  });

  it('is unsold with no bids, sold to the leader at the current price otherwise', () => {
    expect(closeLot(CONFIG, initialState(END), END)).toEqual({ result: 'unsold' });
    const { state } = run(CONFIG, [bid('A', 20_000n), bid('B', 8_000n)]);
    expect(closeLot(CONFIG, state, END)).toEqual({ result: 'sold', winnerAccountId: 'A', hammerMinor: 8_500n });
  });
});

describe('staff bid removal by replay', () => {
  it('rebuilds the lot without the voided bid', () => {
    const reqs = [bid('A', 20_000n), bid('B', 90_000n), bid('C', 30_000n)];
    const live = run(CONFIG, reqs);
    expect(live.state.leader?.accountId).toBe('B');
    // B confirms a typing error (an extra zero); staff void it with a second approval.
    const corrected = run(CONFIG, reqs.filter((r) => r.accountId !== 'B'));
    expect(corrected.state.leader?.accountId).toBe('C');
    expect(corrected.state.currentPriceMinor).toBe(21_000n);
  });
});

describe('schedule and outages', () => {
  it('staggers end times by lot order', () => {
    const ends = scheduleEndTimes(END, 60, 3);
    expect(ends.map((d) => d.toISOString())).toEqual(['2026-11-20T18:00:00.000Z', '2026-11-20T18:01:00.000Z', '2026-11-20T18:02:00.000Z']);
  });

  it('extends lots due during an outage by its length plus the soft close', () => {
    const start = new Date('2026-11-20T17:55:00Z');
    const stop = new Date('2026-11-20T18:05:00Z');
    expect(endAfterOutage(END, start, stop, 600)).toEqual(new Date('2026-11-20T18:20:00Z'));
    expect(endAfterOutage(new Date('2026-11-20T18:30:00Z'), start, stop, 600)).toEqual(new Date('2026-11-20T18:30:00Z'));
  });
});

describe('public bid history', () => {
  it('hides maximums and identities, newest first, and shows the viewer as You', () => {
    const { bids } = run(CONFIG, [bid('A', 20_000n), bid('B', 8_000n), bid('C', 1_000n)]);
    const history = publicHistory(bids, 'B');
    expect(history.map((h) => [h.bidder, h.amountMinor, h.auto])).toEqual([
      ['Bidder 1', 8_500n, true],
      ['You', 8_000n, false],
      ['Bidder 1', 5_000n, false],
    ]);
    expect(JSON.stringify(history, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('20000');
  });
});

// ---------------------------------------------------------------------------
// Randomised simulation against an independent model of the price
// ---------------------------------------------------------------------------

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Independent model of the price. Each bidder's standing maximum is their highest
 * accepted maximum; the leader is the highest, earliest on ties. When someone other
 * than the leader bids, the price becomes the starting bid (one bidder) or
 * min(leader max, runner-up max + increment). When the leader only raises their own
 * maximum, the price stays where it was. Either way it is lifted to the reserve when
 * the leader's maximum covers it.
 */
function standings(config: LotConfig, accepted: Array<{ accountId: string; maxMinor: bigint }>) {
  const best = new Map<string, { max: bigint; order: number }>();
  accepted.forEach((a, i) => {
    const cur = best.get(a.accountId);
    if (!cur || a.maxMinor > cur.max) best.set(a.accountId, { max: a.maxMinor, order: i });
  });
  const ranked = [...best.entries()].sort((x, y) => (y[1].max > x[1].max ? 1 : y[1].max < x[1].max ? -1 : x[1].order - y[1].order));
  const [leaderId, leader] = ranked[0]!;
  let price: bigint;
  if (ranked.length === 1) price = config.startingBidMinor;
  else {
    const second = ranked[1]![1].max;
    const candidate = second === leader.max ? leader.max : second + incrementAt(second, config.ladder);
    price = candidate < leader.max ? candidate : leader.max;
  }
  return { leaderId, leaderMax: leader.max, price };
}

function liftToReserve(config: LotConfig, price: bigint, leaderMax: bigint): bigint {
  const r = config.reserveMinor;
  return config.priceJumpsToReserve && r !== null && leaderMax >= r && price < r ? r : price;
}

function modelPrice(config: LotConfig, accepted: Array<{ accountId: string; maxMinor: bigint }>): { leader: string; price: bigint } {
  let price = 0n;
  let leader = '';
  for (let k = 0; k < accepted.length; k++) {
    const now = standings(config, accepted.slice(0, k + 1));
    if (accepted[k]!.accountId === leader) price = liftToReserve(config, price, now.leaderMax); // self-raise
    else price = liftToReserve(config, now.price, now.leaderMax);
    leader = now.leaderId;
  }
  return { leader, price };
}

describe('randomised simulation (300 auctions)', () => {
  it('matches the model and keeps every invariant', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = prng(seed);
      const config: LotConfig = {
        ...CONFIG,
        startingBidMinor: BigInt(Math.floor(rand() * 20) * 500),
        reserveMinor: rand() < 0.5 ? BigInt(10_000 + Math.floor(rand() * 200) * 500) : null,
        priceJumpsToReserve: rand() < 0.8,
      };
      if (config.startingBidMinor === 0n) config.startingBidMinor = 100n;
      const bidders = ['A', 'B', 'C', 'D', 'E'].slice(0, 2 + Math.floor(rand() * 4));
      let state: LotState = initialState(END);
      const requests: MaxBidRequest[] = [];
      const accepted: Array<{ accountId: string; maxMinor: bigint }> = [];
      let lastPrice = -1n;
      let lastSeq = 0n;
      let lastEnd = state.endAt.getTime();
      let t = END.getTime() - 120 * MIN;

      for (let i = 0; i < 40; i++) {
        t += Math.floor(rand() * 6 * MIN);
        const who = bidders[Math.floor(rand() * bidders.length)]!;
        const base = state.currentPriceMinor ?? config.startingBidMinor;
        const maxMinor = base + BigInt(Math.floor(rand() * 60_000) - 2_000);
        if (maxMinor <= 0n) continue;
        const req = { accountId: who, maxMinor, at: new Date(t), clientRequestId: `s${seed}-${i}` };
        requests.push(req);
        const r = placeMaxBid(config, state, req);
        state = r.state;

        // Sequence numbers: contiguous, one per logged row.
        for (const b of r.bids) expect(b.seq).toBe(++lastSeq);
        expect(state.seq).toBe(lastSeq);
        // End time never moves earlier.
        expect(state.endAt.getTime()).toBeGreaterThanOrEqual(lastEnd);
        lastEnd = state.endAt.getTime();

        if (r.receipt.outcome !== 'rejected') accepted.push({ accountId: who, maxMinor });
        if (state.leader) {
          const m = modelPrice(config, accepted);
          expect(state.leader.accountId, `seed ${seed} step ${i}`).toBe(m.leader);
          expect(state.currentPriceMinor, `seed ${seed} step ${i}`).toBe(m.price);
          // Price never exceeds the leader's maximum and never falls.
          expect(state.currentPriceMinor! <= state.leader.maxMinor).toBe(true);
          expect(state.currentPriceMinor! >= lastPrice).toBe(true);
          lastPrice = state.currentPriceMinor!;
        }
      }

      // The bid log alone rebuilds the same state.
      const rebuilt = replay(config, END, requests);
      expect(rebuilt.state).toEqual(state);
    }
  });
});
