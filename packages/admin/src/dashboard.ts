import type { Currency } from '@abc/domain';
import type { Queryable } from '@abc/db';
import { run } from '@abc/db';

/**
 * The operations dashboard (docs/18 §9): today's closing lots, unpaid invoices by
 * age, payouts due, overdue title cases and viewing bookings. Read-only queries, so
 * it can run on the read replica. "Today" is the Harare calendar day (CAT, UTC+2).
 * Money is grouped per currency and never added across currencies.
 */

export const OPS_TIME_ZONE = 'Africa/Harare';

export interface OpsDashboard {
  asOf: Date;
  branch: string | null;
  closingToday: Array<{
    auctionLotId: string; lotRef: string; title: string; auctionCode: string; branch: string; currency: Currency;
    currentPriceMinor: bigint | null; endsAt: Date; reserveMet: boolean; bids: number;
  }>;
  unpaidInvoices: Array<{ bucket: 'within_pay_window' | 'overdue_under_24h' | 'overdue_24_to_72h' | 'overdue_over_72h'; currency: Currency; count: number; totalMinor: bigint }>;
  payoutsDue: Array<{ currency: Currency; count: number; netMinor: bigint; overdue: number }>;
  titleCasesOverdue: Array<{ titleCaseId: string; lotRef: string; title: string; buyer: string; deadlineAt: Date; status: string; nextStep: string | null }>;
  viewings: Array<{ slotId: string; branch: string; lotRef: string | null; startsAt: Date; endsAt: Date; capacity: number; booked: number }>;
}

export async function opsDashboard(q: Queryable, options: { branch?: string | null; now?: Date } = {}): Promise<OpsDashboard> {
  const now = options.now ?? new Date();
  const branch = options.branch ?? null;
  const day = `(date_trunc('day', $1::timestamptz AT TIME ZONE '${OPS_TIME_ZONE}') AT TIME ZONE '${OPS_TIME_ZONE}')`;

  const closing = await run<{
    id: string; lot_ref: string; title: string; code: string; branch_code: string; currency: Currency;
    current_price_minor: bigint | null; current_end_at: Date; reserve_met: boolean; bids: bigint;
  }>(
    q,
    `SELECT al.id, l.lot_ref, l.title, a.code, a.branch_code, al.currency, al.current_price_minor, al.current_end_at, al.reserve_met,
            (SELECT count(*) FROM bidding.bid b WHERE b.auction_lot_id = al.id AND b.outcome_at_placement <> 'rejected') AS bids
       FROM auction.auction_lot al
       JOIN auction.auction a ON a.id = al.auction_id
       JOIN catalogue.lot l ON l.id = al.lot_id
      WHERE al.result = 'pending' AND a.status IN ('open', 'closing')
        AND al.current_end_at >= ${day} AND al.current_end_at < ${day} + interval '1 day'
        AND ($2::text IS NULL OR a.branch_code = $2)
      ORDER BY al.current_end_at`,
    [now, branch],
  );

  const unpaid = await run<{ bucket: OpsDashboard['unpaidInvoices'][number]['bucket']; currency: Currency; n: bigint; total: bigint }>(
    q,
    `SELECT CASE WHEN $1 < i.due_at THEN 'within_pay_window'
                 WHEN $1 < i.due_at + interval '24 hours' THEN 'overdue_under_24h'
                 WHEN $1 < i.due_at + interval '72 hours' THEN 'overdue_24_to_72h'
                 ELSE 'overdue_over_72h' END AS bucket,
            i.currency, count(*) AS n, sum(i.total_minor)::bigint AS total
       FROM settlement.invoice i JOIN auction.auction a ON a.id = i.auction_id
      WHERE i.status IN ('issued', 'overdue') AND ($2::text IS NULL OR a.branch_code = $2)
      GROUP BY 1, 2 ORDER BY 2, 1`,
    [now, branch],
  );

  // Payouts belong to sellers, not branches: the branch filter does not narrow them.
  const payouts = await run<{ currency: Currency; n: bigint; net: bigint; overdue: bigint }>(
    q,
    `SELECT p.currency, count(*) AS n, sum(p.net_minor)::bigint AS net,
            count(*) FILTER (WHERE p.due_date < (${day})::date) AS overdue
       FROM payout.payout p
      WHERE p.status IN ('scheduled', 'approved', 'held') AND p.due_date <= ((${day})::date + 1)
      GROUP BY p.currency ORDER BY p.currency`,
    [now],
  );

  const titles = await run<{ id: string; lot_ref: string; title: string; buyer: string; deadline_at: Date; status: string; next_step: string | null }>(
    q,
    `SELECT tc.id, l.lot_ref, l.title, a.display_name AS buyer, tc.deadline_at, tc.status,
            (SELECT s.step FROM logistics.title_step s WHERE s.title_case_id = tc.id AND s.status <> 'done' ORDER BY s.sort LIMIT 1) AS next_step
       FROM logistics.title_case tc
       JOIN catalogue.lot l ON l.id = tc.lot_id
       JOIN identity.account a ON a.id = tc.buyer_account_id
      WHERE tc.status IN ('open', 'in_progress', 'blocked')
        AND (tc.deadline_at < $1 OR EXISTS (SELECT 1 FROM logistics.title_step s WHERE s.title_case_id = tc.id AND s.status <> 'done' AND s.due_at < $1))
        AND ($2::text IS NULL OR l.location_branch = $2)
      ORDER BY tc.deadline_at`,
    [now, branch],
  );

  const viewings = await run<{ id: string; branch_code: string; lot_ref: string | null; starts_at: Date; ends_at: Date; capacity: number; booked: bigint }>(
    q,
    `SELECT s.id, s.branch_code, l.lot_ref, s.starts_at, s.ends_at, s.capacity,
            (SELECT count(*) FROM catalogue.viewing_booking b WHERE b.slot_id = s.id AND b.status = 'booked') AS booked
       FROM catalogue.viewing_slot s LEFT JOIN catalogue.lot l ON l.id = s.lot_id
      WHERE s.starts_at >= ${day} AND s.starts_at < ${day} + interval '1 day'
        AND ($2::text IS NULL OR s.branch_code = $2)
      ORDER BY s.starts_at`,
    [now, branch],
  );

  return {
    asOf: now,
    branch,
    closingToday: closing.rows.map((r) => ({
      auctionLotId: r.id, lotRef: r.lot_ref, title: r.title, auctionCode: r.code, branch: r.branch_code, currency: r.currency,
      currentPriceMinor: r.current_price_minor, endsAt: r.current_end_at, reserveMet: r.reserve_met, bids: Number(r.bids),
    })),
    unpaidInvoices: unpaid.rows.map((r) => ({ bucket: r.bucket, currency: r.currency, count: Number(r.n), totalMinor: r.total })),
    payoutsDue: payouts.rows.map((r) => ({ currency: r.currency, count: Number(r.n), netMinor: r.net, overdue: Number(r.overdue) })),
    titleCasesOverdue: titles.rows.map((r) => ({ titleCaseId: r.id, lotRef: r.lot_ref, title: r.title, buyer: r.buyer, deadlineAt: r.deadline_at, status: r.status, nextStep: r.next_step })),
    viewings: viewings.rows.map((r) => ({ slotId: r.id, branch: r.branch_code, lotRef: r.lot_ref, startsAt: r.starts_at, endsAt: r.ends_at, capacity: r.capacity, booked: Number(r.booked) })),
  };
}
