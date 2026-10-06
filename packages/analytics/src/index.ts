import type { Currency } from '@abc/domain';
import { run, type Db, type Queryable } from '@abc/db';

/**
 * Analytics (docs/19-analytics.md): the blueprint §9 measures, read through the
 * analytics.* SQL functions. Every function is STABLE and reads domain tables and the
 * outbox only, so this runs against the read replica (docs/01 §4). Periods are
 * half-open [from, to); the branch filter is optional. Money is reported per currency:
 * USD and ZiG are never added together. "Time to" measures report the median and the
 * 90th percentile in seconds, as the blueprint asks.
 */

export interface Period {
  from: Date;
  to: Date;
  branch?: string | null;
}

export class AnalyticsError extends Error {
  constructor(
    readonly code: 'invalid' | 'conflict' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'AnalyticsError';
  }
}

export interface TimeMeasure {
  /** Cases in the cohort (e.g. registrations, invoices, sold lots). */
  cohort: number;
  /** Cases that reached the end event (first bid, payment, payout). */
  completed: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
}

export interface Measures {
  period: { from: string; to: string; branch: string | null };
  registrationToFirstBid: TimeMeasure;
  inAppPayments: Array<{
    currency: Currency;
    depositCount: number; depositInAppCount: number; depositShare: number | null; depositsMinor: bigint; depositsInAppMinor: bigint;
    winningCount: number; winningInAppCount: number; winningsShare: number | null; winningsMinor: bigint; winningsInAppMinor: bigint;
  }>;
  hammerToPayment: TimeMeasure;
  sellThrough: { offered: number; sold: number; rate: number | null; byCategory: Array<{ category: string; offered: number; sold: number; rate: number | null }> };
  defaults: {
    invoices: number; overdue: number; defaulted: number; cured: number; defaultedLots: number; recoveredLots: number;
    defaultRate: number | null; cureRate: number | null; recoveryRate: number | null;
  };
  bidsPerLot: { lots: number; lotsWithBids: number; bids: number; bidderBids: number; averageBids: number | null; medianBids: number | null; averageUniqueBidders: number | null; medianUniqueBidders: number | null };
  inspectionCoverage: { vehicleLots: number; withReport: number; share: number | null };
  saleToPayout: TimeMeasure;
  support: { instrumented: boolean; tickets: number | null; sales: number; ticketsPer100Sales: number | null; replied: number | null; medianFirstReplySeconds: number | null; p90FirstReplySeconds: number | null };
  realisedPrices: Array<{ category: string; currency: Currency; lotsSold: number; medianHammerMinor: bigint; minHammerMinor: bigint; maxHammerMinor: bigint; totalHammerMinor: bigint }>;
  revenue: Array<{ currency: Currency; lines: Array<{ type: string; amountMinor: bigint }>; netRevenueMinor: bigint; grossHammerMinor: bigint }>;
  gatewaySuccess: Array<{ gateway: string; method: string; currency: Currency; attempts: number; succeeded: number; failed: number; expired: number; cancelled: number; pending: number; successRate: number | null }>;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const int = (v: unknown): number => Number(v ?? 0);
const ratio = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 10_000) / 10_000);

export function checkPeriod(p: Period): void {
  if (Number.isNaN(p.from.getTime()) || Number.isNaN(p.to.getTime())) throw new AnalyticsError('invalid', 'Give the period as two dates.');
  if (p.to.getTime() <= p.from.getTime()) throw new AnalyticsError('invalid', 'The end of the period must be after its start.');
  if (p.to.getTime() - p.from.getTime() > 3 * 366 * 86_400_000) throw new AnalyticsError('invalid', 'Choose a period of three years or less.');
  if (p.branch !== undefined && p.branch !== null && !/^[A-Z]{2,5}$/.test(p.branch)) throw new AnalyticsError('invalid', 'Unknown branch code.');
}

export class Analytics {
  /** `replica` is any read-only connection: the read replica in production. */
  constructor(private readonly replica: Queryable) {}

  private fn<R extends Record<string, unknown>>(name: string, p: Period): Promise<R[]> {
    return run<R>(this.replica, `SELECT * FROM analytics.${name}($1, $2, $3)`, [p.from, p.to, p.branch ?? null]).then((r) => r.rows);
  }

  async measures(p: Period): Promise<Measures> {
    checkPeriod(p);
    const [reg, pay, h2p, sell, def, bids, insp, s2p, sup, prices, rev, gw] = await Promise.all([
      this.fn<{ registrations: bigint; with_first_bid: bigint; median_seconds: string | null; p90_seconds: string | null }>('registration_to_first_bid', p),
      this.fn<{ currency: Currency; deposits: bigint; deposits_in_app: bigint; deposits_minor: bigint; deposits_in_app_minor: bigint; winnings: bigint; winnings_in_app: bigint; winnings_minor: bigint; winnings_in_app_minor: bigint }>('in_app_payment_share', p),
      this.fn<{ invoices: bigint; paid: bigint; median_seconds: string | null; p90_seconds: string | null }>('hammer_to_payment', p),
      this.fn<{ category_code: string; offered: bigint; sold: bigint; sell_through: string }>('sell_through_by_category', p),
      this.fn<{ invoices: bigint; overdue: bigint; defaulted: bigint; cured: bigint; defaulted_lots: bigint; recovered_lots: bigint; default_rate: string | null; cure_rate: string | null; recovery_rate: string | null }>('default_and_recovery', p),
      this.fn<{ lots: bigint; lots_with_bids: bigint; bids: bigint; bidder_bids: bigint; avg_bids: string | null; median_bids: string | null; avg_unique_bidders: string | null; median_unique_bidders: string | null }>('bids_per_lot', p),
      this.fn<{ vehicle_lots: bigint; with_report: bigint; share: string | null }>('inspection_coverage', p),
      this.fn<{ sold_lots: bigint; paid_out: bigint; median_seconds: string | null; p90_seconds: string | null }>('sale_to_payout', p),
      this.fn<{ instrumented: boolean; tickets: bigint | null; sales: bigint; tickets_per_100_sales: string | null; replied: bigint | null; median_first_reply_seconds: string | null; p90_first_reply_seconds: string | null }>('support_measures', p),
      this.fn<{ category_code: string; currency: Currency; lots_sold: bigint; median_hammer_minor: bigint; min_hammer_minor: bigint; max_hammer_minor: bigint; total_hammer_minor: bigint }>('realised_prices', p),
      this.fn<{ currency: Currency; revenue_type: string; amount_minor: bigint }>('revenue_by_currency', p),
      this.fn<{ gateway: string; method: string; currency: Currency; attempts: bigint; succeeded: bigint; failed: bigint; expired: bigint; cancelled: bigint; pending: bigint; success_rate: string | null }>('gateway_success', p),
    ]);
    const r = reg[0]!;
    const h = h2p[0]!;
    const d = def[0]!;
    const b = bids[0]!;
    const i = insp[0]!;
    const s = s2p[0]!;
    const t = sup[0]!;
    const offered = sell.reduce((a, x) => a + int(x.offered), 0);
    const sold = sell.reduce((a, x) => a + int(x.sold), 0);
    const currencies = [...new Set(rev.map((x) => x.currency))].sort();
    return {
      period: { from: p.from.toISOString(), to: p.to.toISOString(), branch: p.branch ?? null },
      registrationToFirstBid: { cohort: int(r.registrations), completed: int(r.with_first_bid), medianSeconds: num(r.median_seconds), p90Seconds: num(r.p90_seconds) },
      inAppPayments: pay.map((x) => ({
        currency: x.currency,
        depositCount: int(x.deposits), depositInAppCount: int(x.deposits_in_app), depositShare: ratio(int(x.deposits_in_app), int(x.deposits)),
        depositsMinor: x.deposits_minor, depositsInAppMinor: x.deposits_in_app_minor,
        winningCount: int(x.winnings), winningInAppCount: int(x.winnings_in_app), winningsShare: ratio(int(x.winnings_in_app), int(x.winnings)),
        winningsMinor: x.winnings_minor, winningsInAppMinor: x.winnings_in_app_minor,
      })),
      hammerToPayment: { cohort: int(h.invoices), completed: int(h.paid), medianSeconds: num(h.median_seconds), p90Seconds: num(h.p90_seconds) },
      sellThrough: {
        offered, sold, rate: ratio(sold, offered),
        byCategory: sell.map((x) => ({ category: x.category_code, offered: int(x.offered), sold: int(x.sold), rate: num(x.sell_through) })),
      },
      defaults: {
        invoices: int(d.invoices), overdue: int(d.overdue), defaulted: int(d.defaulted), cured: int(d.cured),
        defaultedLots: int(d.defaulted_lots), recoveredLots: int(d.recovered_lots),
        defaultRate: num(d.default_rate), cureRate: num(d.cure_rate), recoveryRate: num(d.recovery_rate),
      },
      bidsPerLot: {
        lots: int(b.lots), lotsWithBids: int(b.lots_with_bids), bids: int(b.bids), bidderBids: int(b.bidder_bids),
        averageBids: num(b.avg_bids), medianBids: num(b.median_bids), averageUniqueBidders: num(b.avg_unique_bidders), medianUniqueBidders: num(b.median_unique_bidders),
      },
      inspectionCoverage: { vehicleLots: int(i.vehicle_lots), withReport: int(i.with_report), share: num(i.share) },
      saleToPayout: { cohort: int(s.sold_lots), completed: int(s.paid_out), medianSeconds: num(s.median_seconds), p90Seconds: num(s.p90_seconds) },
      support: {
        instrumented: t.instrumented, tickets: t.tickets === null ? null : int(t.tickets), sales: int(t.sales),
        ticketsPer100Sales: num(t.tickets_per_100_sales), replied: t.replied === null ? null : int(t.replied),
        medianFirstReplySeconds: num(t.median_first_reply_seconds), p90FirstReplySeconds: num(t.p90_first_reply_seconds),
      },
      realisedPrices: prices.map((x) => ({
        category: x.category_code, currency: x.currency, lotsSold: int(x.lots_sold), medianHammerMinor: x.median_hammer_minor,
        minHammerMinor: x.min_hammer_minor, maxHammerMinor: x.max_hammer_minor, totalHammerMinor: x.total_hammer_minor,
      })),
      revenue: currencies.map((c) => {
        const lines = rev.filter((x) => x.currency === c && x.revenue_type !== 'gross_hammer').map((x) => ({ type: x.revenue_type, amountMinor: x.amount_minor }));
        return {
          currency: c,
          lines,
          netRevenueMinor: lines.reduce((a, l) => a + l.amountMinor, 0n),
          grossHammerMinor: rev.find((x) => x.currency === c && x.revenue_type === 'gross_hammer')?.amount_minor ?? 0n,
        };
      }),
      gatewaySuccess: gw.map((x) => ({
        gateway: x.gateway, method: x.method, currency: x.currency, attempts: int(x.attempts), succeeded: int(x.succeeded), failed: int(x.failed),
        expired: int(x.expired), cancelled: int(x.cancelled), pending: int(x.pending), successRate: num(x.success_rate),
      })),
    };
  }

  async baselines(): Promise<Array<{ id: string; label: string; from: Date; to: Date; branch: string | null; frozenBy: string; frozenAt: Date; notes: string | null }>> {
    const r = await run<{ id: string; label: string; period_from: Date; period_to: Date; branch_code: string | null; frozen_by: string; frozen_at: Date; notes: string | null }>(
      this.replica,
      'SELECT id, label, period_from, period_to, branch_code, frozen_by, frozen_at, notes FROM analytics.baseline_snapshot ORDER BY frozen_at DESC',
    );
    return r.rows.map((x) => ({ id: x.id, label: x.label, from: x.period_from, to: x.period_to, branch: x.branch_code, frozenBy: x.frozen_by, frozenAt: x.frozen_at, notes: x.notes }));
  }

  async baseline(label: string): Promise<{ label: string; frozenAt: Date; measures: unknown } | null> {
    const r = await run<{ label: string; frozen_at: Date; measures: unknown }>(this.replica, 'SELECT label, frozen_at, measures FROM analytics.baseline_snapshot WHERE label = $1', [label]);
    return r.rows[0] ? { label: r.rows[0].label, frozenAt: r.rows[0].frozen_at, measures: r.rows[0].measures } : null;
  }
}

/** Measures as stored JSON: bigints become strings so nothing loses precision. */
export function measuresToJson(m: Measures): unknown {
  return JSON.parse(JSON.stringify(m, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/**
 * Freezes the measures for a period as a named baseline (blueprint §9: "the first task
 * is a baseline"). Writes to the primary. A baseline is append-only; repeating the same
 * label and period returns the frozen one (R4), a different period under that label is refused.
 */
export async function freezeBaseline(
  primary: Db,
  by: { id: string; name: string },
  input: Period & { label: string; notes?: string },
): Promise<{ id: string; label: string; created: boolean; measures: unknown }> {
  checkPeriod(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{2,60}$/.test(input.label)) throw new AnalyticsError('invalid', 'Give the baseline a short label, e.g. "baseline-2026-11".');
  const existing = await primary.query<{ id: string; period_from: Date; period_to: Date; branch_code: string | null; measures: unknown }>(
    'SELECT id, period_from, period_to, branch_code, measures FROM analytics.baseline_snapshot WHERE label = $1',
    [input.label],
  );
  const e = existing.rows[0];
  if (e) {
    const same = e.period_from.getTime() === input.from.getTime() && e.period_to.getTime() === input.to.getTime() && (e.branch_code ?? null) === (input.branch ?? null);
    if (!same) throw new AnalyticsError('conflict', `A baseline called "${input.label}" is already frozen for a different period. Choose another label.`);
    return { id: e.id, label: input.label, created: false, measures: e.measures };
  }
  // Measured on the primary inside the same transaction, so the frozen figures are exactly what was stored.
  return primary.tx({ type: 'staff', id: by.id, name: by.name, reason: `freeze analytics baseline ${input.label}` }, async (c) => {
    const measures = measuresToJson(await new Analytics(c).measures(input));
    const r = await c.query<{ id: string }>(
      `INSERT INTO analytics.baseline_snapshot (label, period_from, period_to, branch_code, measures, frozen_by, notes)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
      [input.label, input.from, input.to, input.branch ?? null, JSON.stringify(measures), by.id, input.notes ?? null],
    );
    await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('analytics.baseline_frozen', 'baseline_snapshot', $1, $2::jsonb)`, [
      r.rows[0]!.id,
      JSON.stringify({ label: input.label }),
    ]);
    return { id: r.rows[0]!.id, label: input.label, created: true, measures };
  });
}
