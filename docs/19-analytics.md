# 19 — Analytics

| | |
|---|---|
| Phase | 5 — Reach (deliverable 19; events instrumented from Phase 1) |
| Source of truth | Blueprint §9 measures ("ABC's current values are unknown, so the first task is a baseline"), [01 §11](01-solution-architecture.md#11-analytics-from-day-one); [00 Assumptions register](00-assumptions-register.md) A63, A64 |
| Code | [`packages/analytics`](../packages/analytics/src) (`Analytics`, `freezeBaseline`) · SQL functions in schema `analytics` (migration [`0004_admin_analytics`](../db/migrations/0004_admin_analytics.sql), folded into [`db/schema.sql`](../db/schema.sql)) · API: [`apps/api/src/analytics`](../apps/api/src/analytics) |
| Related | [18 Admin and operations](18-admin-operations.md) · [02 Data model](02-data-model.md) · [11 Close and settlement](11-close-settlement.md) |

## 1. Purpose

The blueprint's success measures are all about speed to cash and regret: how fast a new bidder gets to bid, how fast winners pay, how often they default, how fast sellers are paid. ABC's current values are unknown (blueprint §9), so nothing can be shown to improve until the first measurement is taken and frozen.

This deliverable computes every §9 measure from the System's own records. It runs on the read replica, and its first result can be frozen as the baseline.

**Acceptance test.** ABC can see, per branch and period, whether sellers are paid sooner and buyers default less than at the baseline. Without that, no other deliverable can show it shortened time to cash or lowered regret.

## 2. The measures

Each measure is one `STABLE` SQL function in schema `analytics`, taking `(from, to, branch)`. Periods are half-open, `[from, to)`. "Time to" measures report the **median and the 90th percentile** in seconds, plus the cohort size and how many reached the end event.

| Measure (blueprint §9) | Function | Cohort and definition (A63) | Read from |
|---|---|---|---|
| Time from registration to first bid | `registration_to_first_bid` | Registrations created in the period. Time from joining an auction (including any review wait) to the first accepted bid in it | `registration.registration`, `bidding.bid` |
| Share of deposits and winnings paid in the app | `in_app_payment_share` | Per currency. Deposits: succeeded top-ups; in the app means not branch cash. Winnings: invoice payments; in the app means not branch cash. Counts and amounts | `payment.payment` |
| Time from hammer to payment | `hammer_to_payment` | Invoices whose (last) hammer fell in the period. Hammer to `paid_at` | `settlement.invoice`, `auction.auction_lot` |
| Sell-through rate by category | `sell_through_by_category` | Lots that closed in the period, sold out of offered (sold, unsold and reserve not met; withdrawn lots are not counted as offered) | `auction.auction_lot`, `catalogue.lot` |
| Default rate and recovery rate | `default_and_recovery` | Invoices issued in the period. **Default rate**: reached the forfeit stage (`defaulted`) out of all issued. **Cure rate**: went overdue but were paid. **Recovery rate**: defaulted lots later sold again and paid for | `settlement.*`, `auction.auction_lot` |
| Bids and unique bidders per lot | `bids_per_lot` | Lots that closed in the period. Accepted bids, including proxy bids and excluding voided ones; average and median; unique bidders | `bidding.bid`, `bidding.bid_void` |
| Share of vehicle lots with an inspection report | `inspection_coverage` | Vehicle lots in auctions that opened in the period, with a report published before the lot closed | `catalogue.inspection_report` |
| Time from sale to seller payout | `sale_to_payout` | Lots sold in the period. Hammer to the payout being marked paid | `payout.payout`, `payout.payout_line` |
| Support tickets per 100 sales and time to first reply | `support_measures` | Tickets opened in the period per 100 lots sold; time from `ticket.opened` to `ticket.first_reply` | `core.outbox` (§6) |

Also, from the brief:

| Measure | Function | Definition |
|---|---|---|
| Realised prices | `realised_prices` | Per category and currency: lots sold, median, minimum, maximum and total hammer |
| Revenue by currency | `revenue_by_currency` | Per currency, from the ledger: commission, fees (by sub-code), delivery and forfeitures, net of reversals; the write-off cost; and gross hammer. Branch from the journal's reference (invoice or deposit hold → auction) |
| Gateway success rates | `gateway_success` | Per gateway, method and currency: attempts, succeeded, failed, expired, cancelled, still pending; success rate = succeeded ÷ finished attempts |

## 3. Choices behind the definitions

These are design choices, recorded as **A63** (PROPOSED, owner ABC Product):

- **Cohorts by start event.** A "time to" measure counts the cases that *started* in the period (registered, hammered, sold), so a slow case is never dropped because it finished in the next period. Cases still open count in the cohort, not in the median.
- **"In the app" means not branch cash.** Every payment lands in the wallet (A35). A winner who pays from a wallet topped up in cash still pays "in the app", so the deposit share (top-ups) is the measure that shows the move away from counters.
- **Default means the forfeit stage,** not a warning. A buyer who pays while the ladder is at *warning* is a cure, not a default (docs/02 §5).
- **Recovery means sold again and paid for,** so the money actually came in.
- **Harare time** for calendar days on the dashboard; analytics periods are exact instants chosen by the caller.

## 4. Filters

- `from` and `to` are required; the period must be positive and at most three years.
- `branch` (e.g. `HRE`, `BYO`) narrows by the **auction's branch**. Two measures belong to no branch: top-ups (deposits share) and gateway attempts. The filter does not narrow those, and the function comments say so. Title cases and viewings use the lot's or slot's branch on the dashboard (docs/18 §10).

## 5. Money and currency

USD and ZiG are never added together (docs/01 §6.5). Every money figure is reported per currency, and the API sends it as `{ minor, currency, text }`. Counts and rates may be summed across currencies, because they are not money.

## 6. Support measures before the support module

Support tickets (deliverable 17) are being built in parallel. `support_measures` reads only the outbox events `ticket.opened` and `ticket.first_reply`, joined by `aggregate_id` (the ticket), with an optional `branch` in the opened event's payload. Until any such event exists, `instrumented` is `false` and the ticket figures are `NULL`, never a misleading zero (**A64**, PROPOSED, owner ABC Product / support build).

## 7. The baseline

`freezeBaseline(primary, staff, { label, from, to, branch?, notes? })` computes every measure and stores the result in `analytics.baseline_snapshot`, with who froze it and when:

- The measures are taken on the primary, inside the same transaction as the insert, so what is stored is exactly what was measured.
- The table is **append-only**: the database refuses updates and deletes (tested).
- A label is used once. Repeating the same label and period returns the frozen baseline (R4); the same label for a different period is refused.
- Money is stored as strings, so no amount loses precision in JSON.

Freezing needs finance or admin (docs/18 §3). Reading baselines needs the analytics view permission.

## 8. Read replica

Every measure function is `STABLE`, and reads domain tables and the outbox only. A test runs them all inside a `READ ONLY` transaction. `Analytics` takes any connection, so production points it at the replica (docs/01 §4: "admin reports and analytics read the replica"); until one exists, the API uses the primary pool. Only `freezeBaseline` writes.

## 9. API

| Method and path | Who | What |
|---|---|---|
| `GET /staff/analytics/measures?from&to&branch` | ops, finance, risk, admin, auditor | All measures for the period |
| `GET /staff/analytics/baselines` | same | Frozen baselines |
| `GET /staff/analytics/baselines/:label` | same | One baseline with its stored measures |
| `POST /staff/analytics/baselines` `{label, from, to, branch?, notes?}` | finance, admin | Freeze the baseline |

## 10. Evidence

| Behaviour | Test |
|---|---|
| Period and branch validation; money kept as strings in a frozen baseline | `packages/analytics/src/analytics.test.ts` (pure) |
| Registration to first bid (median and p90) over a full scenario: EcoCash and cash top-ups, a declined EcoCash attempt, a sale paid, collected and paid out, a default with forfeit and relist fee, the relisted lot sold and paid, vehicles with and without a report, a ZiG income line | same (database) |
| In-app shares per currency; hammer to payment; sale to payout; sell-through; default, cure and recovery rates; bids and unique bidders; inspection coverage; realised prices; revenue per currency with USD and ZiG apart; gateway success | same |
| Support measures NULL until ticket events exist, then per 100 sales with time to first reply | same |
| Branch filter; baseline frozen once, refused for another period, unchangeable; all measures run in a read-only transaction | same |
| Every analytics function is `STABLE`; baselines append-only; support measures NULL before instrumentation | `db/tests/invariants.sql` (3 checks, prefixed "Analytics") |
| Measures over HTTP with the demo data, branch filter, bad periods refused, baseline frozen by finance only | `apps/api/src/analytics.test.ts` |

## 11. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| A63: the measure definitions in §2–3 | ABC Product | As defined; changing one is a new function version, and baselines keep the old figures |
| A64: support measures from outbox events | Support build (deliverable 17) | NULL until `ticket.opened` / `ticket.first_reply` are emitted |
| Read replica | ABC IT / tech lead | Analytics reads the primary pool |
| Product analytics (PostHog) for screen-level funnels | Product | Not built; the §9 measures do not need it |
| Freeze the real baseline | ABC Product / finance | As soon as the System runs live auctions: the first full month |
