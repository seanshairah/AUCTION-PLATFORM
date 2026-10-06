# 07 — Bidding Engine Integration

| | |
|---|---|
| Phase | 2 — Informed bids (deliverable 8) |
| Source of truth | Blueprint §2 module 5 (CONFIRMED: max bid with auto-bidding, 10-minute extension, staggered ends, binding bids), §6 module 5 (target), §4 (Bring a Trailer; Robert Wilson on soft close), §8 risk controls, §9 build-or-buy; [00 Assumptions register](00-assumptions-register.md) Q6 |
| Code | [`packages/engine`](../packages/engine/src): `placeMaxBid`, `closeLot`, `replay`, `reserveStatus`, `scheduleEndTimes`, `endAfterOutage`, `publicHistory` |
| Related | [06 Commit screen](06-commit-screen.md) · [02 Data model](02-data-model.md) (`auction.*`, `bidding.*`) · [01 §5.1](01-solution-architecture.md#51-place-a-bid) |

## 1. Keep or rebuild (Q6)

Blueprint §9: *"Keep ABC's if proxy bidding, soft-close settings and an audit log can be configured. Otherwise rebuild."* The blueprint author could not see ABC's engine.

This repository therefore ships a **reference engine**, which serves two purposes:
- **A test oracle.** Whichever engine runs in production, the commit screen, limits, receipts and settlement are tested against this one.
- **The fallback.** If ABC's engine fails any test below, the reference engine becomes the production engine.

| # | Test for ABC's engine | Pass means | How to check in discovery |
|---|---|---|---|
| 1 | Proxy bidding with a secret ceiling | A maximum is stored, other bidders never see it, and the engine bids for the bidder step by step | Place two maximums in a test auction; confirm the price and leader match `placeMaxBid` for the same inputs |
| 2 | Soft-close duration configurable **per auction** | 2, 5 and 10 minutes can be set without code changes | Configure each value on a test auction and bid inside the window |
| 3 | Exportable, immutable bid log with server timestamps | Every bid, including automatic ones and rejections, is exportable with server time and order, and cannot be edited | Export a test auction's log and `replay` it through the reference engine: the final state must match |

All three pass → wrap ABC's engine behind the adapter (§9). Any fail → the reference engine goes to production, and that decision is recorded in the register.

## 2. Who decides what

The **engine** decides price discovery only. Everything else happens in the **bidding service** before or after the engine runs, in the same database transaction.

| Concern | Owner | Rule / source |
|---|---|---|
| Signed in, account active | Bidding service (Identity) | — |
| Registered for this auction | Bidding service (Registration) | Deliverable 11 |
| Not linked to the lot's seller | Bidding service (Risk) | `bidding.seller_linked_accounts_barred` |
| All-in total within the limit | Bidding service (Limits + QuoteService) | `limit.*`, deliverable 11 |
| Quoted total still correct | Bidding service (QuoteService) | [06 §5](06-commit-screen.md#5-submitting) |
| Idempotency by client request ID | Database unique key | R4 |
| **Minimum bid, proxy price, leader, ties, reserve, soft close, closing** | **Engine** | `bidding.*` rules |
| Persisting bids, audit, outbox events | Bidding service | R1–R4 |

Rejections from the service (`over_limit`, `not_registered`, `seller_linked`, `price_changed`) are logged in `bidding.bid` with their reason, just like engine rejections, so the log records every attempt.

## 3. Proxy bidding

A bid is a **maximum** (rule `bidding.proxy_enabled`, CONFIRMED). The engine keeps the leader's maximum secret and bids for them only as far as needed.

**Rules, in order:**

1. **Lot closed** (server time ≥ end time) → reject `lot_closed`.
2. **The leader raises their own maximum.** It must be above their current maximum (else `not_above_your_max`). The price does not move, except to meet the reserve (rule 6).
3. **Minimum next bid.** Starting bid if there are no bids, else current price plus the increment for the current price band (`bidding.increment_ladder`). Lower → reject `below_minimum`, telling the bidder the minimum.
4. **The challenger's maximum is above the leader's.** The challenger leads. The price is one increment above the old maximum, capped at the challenger's maximum. The old leader's proxy is logged bidding up to its maximum, then the old leader is notified `outbid`.
5. **The challenger's maximum is at or below the leader's.** The leader stays. The price is the challenger's maximum plus one increment, capped at the leader's maximum. **Ties go to the earlier maximum.** The challenger's receipt says outbid at once.
6. **Reserve jump** (`bidding.price_jumps_to_reserve`, PROPOSED): if the leading maximum covers the reserve, the price is raised to at least the reserve, so "reserve met" is shown as soon as it is true.
7. **Increments never shrink as the price rises.** The rulebook validator rejects such a ladder. This guarantees the price in rule 4 is always at least the minimum next bid.

**Worked example** (placeholder ladder: US$5 steps from US$50, US$10 from US$200; starting bid US$50):

| # | Bid | Price after | Leader | Logged rows |
|---|---|---|---|---|
| 1 | A max US$200 | US$50 | A | A bidder US$50 leading |
| 2 | B max US$80 | US$85 | A | B bidder US$80 outbid · A proxy US$85 leading |
| 3 | C max US$86 | — | A | C rejected below minimum (US$90) |
| 4 | B max US$500 | US$210 | B | A proxy US$200 outbid · B bidder US$210 leading |
| 5 | B max US$800 | US$210 | B | B bidder US$210 leading (own maximum raised) |

Every row is a test in `packages/engine/src/engine.test.ts`.

**Verified two ways.** Scenario tests cover each rule. A **randomised simulation of 300 auctions** (2–5 bidders, random reserves and starting bids, 40 bid attempts each) checks after every bid that:
- the leader and price match an independently written model
- the price never exceeds the leader's maximum and never falls
- sequence numbers are contiguous
- the end time never moves earlier
- replaying the requests reproduces the identical state

## 4. Soft close and staggered ends

| Rule | Key | Initial value |
|---|---|---|
| Extension length | `bidding.soft_close_seconds` (per auction from `bidding.soft_close_allowed_seconds`) | 10 minutes (CONFIRMED); 2 and 5 allowed for the test |
| Trigger window | `bidding.soft_close_trigger_seconds` | Last 10 minutes (assumption, A23) |
| Which bids extend | `bidding.extend_on` | Bids that change the price or the leader (PROPOSED) |
| Stagger between lots | `bidding.stagger_seconds` | 60 seconds (PROPOSED) |
| Outage | `operations.outage_extension` | Outage length plus soft close |

- A qualifying bid placed with ≤ trigger window remaining pushes the end to **at least extension-length after the bid's server time**. The end never moves earlier, and there is no cap on extensions: bidding ends when nobody bids for a full extension.
- **Raising your own maximum while leading does not extend** the lot. It changes nothing visible, and letting a leader prolong a lot invites abuse.
- Staggered ends: lot *n* closes `n × stagger` after the first (`scheduleEndTimes`), so closes are spread over time. That also spreads database load ([01 §5.1](01-solution-architecture.md#51-place-a-bid)).
- The soft close in force is always shown on the auction and lot pages, including when an auction is in the A/B test (§10).

## 5. Reserve-met indicator

`reserveStatus` returns `no_reserve`, `not_met` or `met`, and `auction_lot.reserve_met` is a generated column, so the indicator can never disagree with the price. The reserve amount is never sent to clients. At close:

| State at close | Result | Next lot state |
|---|---|---|
| No bids | `unsold` | `unsold` → relist or withdraw |
| Bids, reserve not met | `reserve_not_met` with top bidder and top bid | `reserve_not_met` → offer to top bidder (`reserve.offer_window_hours`), relist or withdraw |
| Otherwise | `sold`: winner and hammer price | `closed` → `invoiced` (deliverable 12) |

## 6. The immutable bid log and receipts

Each engine call returns the rows to append. The bidding service writes them to `bidding.bid`:

| Engine field | Column | Note |
|---|---|---|
| `seq` | `sequence_no` | Per lot, contiguous, issued under the lot's row lock (`auction_lot.bid_seq`) |
| `origin` | `origin` | `bidder` or `proxy` (floor clerk for floor sales) |
| `amountMinor`, `maxMinor` | `amount_minor`, `max_amount_minor` | The maximum is secret; it is stored but never shown to others |
| `outcome`, `rejectReason` | `outcome_at_placement`, `reject_reason` | Outcome **at placement**: a later bid doesn't edit earlier rows |
| `parentSeq` | `parent_bid_id` | A proxy row points at the maximum that produced it |
| `at` | `server_received_at` | Server time only |
| — | `quoted_total_minor`, `quoted_rule_version_id` | Required on bidder rows (database check) |

**Receipts** return the sequence number, server time, outcome, current price, whether the bidder leads, the end time and the reserve status ([06 §6](06-commit-screen.md#6-the-receipt)).

**Corrections never edit the log.** A staff bid removal is a `bidding.bid_void` row backed by an approved override (two-person above A15's threshold; database-enforced). The corrected lot state comes from `replay`: the original requests, in order, minus the voided ones. The log therefore always fully determines the price. If the corrected state changes the leader after close, the affected bidders are notified and settlement follows the corrected result.

## 7. Realtime updates and reconnecting

- After commit, the outbox publishes `price_changed`, `leader_changed`, `outbid`, `extended` and `reserve_met` to the lot's realtime channel. Personal events (`outbid`) also go to the communications layer (WhatsApp → push → SMS).
- **Subscribe with a cursor.** A client subscribes to a lot with its last seen sequence number. The server replies with a snapshot:
  - current price
  - whether the viewer leads, and their maximum if so
  - end time and reserve status
  - latest sequence number
  - the public history entries missed since the cursor
- **Server time.** Every message carries `serverTime`; clients keep a smoothed offset and drive countdowns from it.
- **Heartbeats** every 15 seconds (PROPOSED). Socket.IO falls back to long-polling where WebSockets are blocked.
- **Dropped connection rule** (`bidding.dropped_connection_policy`, rendered to bidders): *"Only bids confirmed with a bid receipt (sequence number and server time) count. If your connection drops, your maximum bid keeps bidding for you; a bid without a receipt was not placed."*

## 8. Persistence, concurrency and closing

**Placing a bid** (one transaction):

1. Idempotency: if `(account_id, client_request_id)` exists, return the stored receipt.
2. Service checks (§2).
3. `SELECT … FROM auction.auction_lot WHERE id = $1 FOR UPDATE`. Load the leader from `leading_bid_id` and that bid's maximum.
4. Run `placeMaxBid` with the auction's pinned rules and the server time.
5. Insert the returned rows into `bidding.bid`. Update `auction_lot`: price, leader, end time, extension count, `bid_seq`.
6. Audit rows are written by trigger; outbox rows for the events.
7. Commit, then publish.

Bids on one lot serialise on its row lock, and lots are independent. At A19's peak (50 bids per second spread over staggered closes) this is far within one PostgreSQL primary's capacity.

**Closing:** a worker polls `auction_lot_closing_idx` every second for lots with `current_end_at ≤ now()`. It locks each lot, re-checks the end time (a last-second extension may have moved it), runs `closeLot`, records the result, moves the lot state, and emits `lot.closed`. Settlement listens for that event (deliverable 12).

## 9. Adapter for ABC's engine

If Q6 passes, a second implementation of `AuctionEngine` ([01 §7.4](01-solution-architecture.md#74-auctionengine-adapter)) calls ABC's engine. To keep the guarantees:

- ABC's bid log is **mirrored** into `bidding.bid` as it happens, with server times and order, so audit, receipts, the commit-screen record (`quoted_total_minor`) and settlement work the same way.
- A nightly job replays each closed lot's mirrored log through the reference engine. Any difference is a finance and risk alert.
- Service checks (§2) run in the System before ABC's engine is called. ABC's engine is never exposed directly to clients.

## 10. Soft-close A/B test plan

The blueprint asks to test 2-minute and 5-minute extensions against today's 10 (§6 module 5). It cites Robert Wilson's view that the rule encourages active bidding, and notes a trade-off: *"A shorter window ends auctions on time; a longer one suits slow connections."* The test is planned and configurable now; it **runs in Phase 5** (D6).

| Element | Plan |
|---|---|
| Question | Does a shorter soft close keep prices and sell-through while ending auctions closer to schedule, without disadvantaging bidders on slow connections? |
| Variants | 120 s, 300 s, 600 s (control), from `bidding.soft_close_allowed_seconds`. The trigger window equals the extension in each variant |
| Unit | **The auction.** All lots in one auction share a setting, so bidders are not confused within a sale. Stored in `auction.soft_close_seconds` and `auction.experiment_variant` |
| Assignment | Stratified random assignment by category group (vehicles, IT, general goods) and branch, balanced weekly. Special and institutional sales (e.g. customs lots) are excluded unless ABC opts them in |
| Transparency | The soft close in force is shown on the auction and lot pages and in the rules link. Bidders are never subject to a hidden rule |
| Primary metrics | (1) Hammer price relative to the category's median realised price over the prior 90 days. (2) Sell-through rate |
| Secondary metrics | Overrun (actual minus scheduled end); extensions per lot; bids in the final window; unique bidders per lot; share of lots won by a bid in the final 60 seconds |
| Fairness metric | Share of winning bids from lite-mode or slow-connection sessions, by variant |
| Guardrails (stop rules) | Median overrun over 30 minutes; a spike in closing-related support tickets; fairness metric down more than 20 % relative to control |
| Sample | Lots are clustered by auction. With ABC running at least 10 auctions a month (CONFIRMED) plus timed online sales, the size is set from Phase 1–4 baseline data (variance of the price ratio and intra-auction correlation). Expect several months at three arms; two arms (120 vs 600) halve the time if needed |
| Analysis | Pre-registered. Mixed-effects regression of each metric on variant, with auction as a random effect and category and branch as fixed effects |
| Decision rule | Adopt the shortest window whose primary metrics are not worse than control by more than 1 % (non-inferiority) and whose fairness metric is not significantly worse. Otherwise keep 10 minutes. The winner becomes the new `bidding.soft_close_seconds` through a normal rulebook publish |

## 11. Rules the engine reads

`bidding.proxy_enabled` · `bidding.increment_ladder` · `bidding.price_jumps_to_reserve` · `bidding.soft_close_seconds` · `bidding.soft_close_allowed_seconds` · `bidding.soft_close_trigger_seconds` · `bidding.extend_on` · `bidding.stagger_seconds` · `operations.outage_extension` · `reserve.offer_window_hours`. All are pinned per auction when it opens (A20).

## 12. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| Q6: can ABC's engine pass the three tests? | ABC IT + tech lead | Reference engine |
| A23: ABC's increment table and trigger window | ABC Operations | Placeholder ladder; 10-minute window |
| A30: reserve jump reveals roughly where the reserve is; extensions only on price or leader change | ABC Commercial | Both on, as proposed |
