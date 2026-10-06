# 17 — Support and Disputes

| | |
|---|---|
| Phase | 5 — Reach (deliverable 17) |
| Source of truth | Blueprint §6 module 12 ("Disputes with evidence and remedies tied to the condition vocabulary. Tickets with owners and response targets"), §8 (misdescribed lots: a claim window at collection; two-person approval above a set amount), §9 measure "support tickets per 100 sales and time to first reply", gap 4 (vehicle remedies) |
| Code | [`packages/support`](../packages/support/src): `support.ts` (pure: deadlines, refund plan, remedy → status, two-person threshold, ticket targets), `service.ts` (`SupportService`) · payout holds and clawbacks: [`packages/settlement/src/payout-adjust.ts`](../packages/settlement/src/payout-adjust.ts) · recipes `fullRefundAndReturn`, `refundToWallet`, `clawbackRecovery` in [`packages/ledger`](../packages/ledger/src/recipes.ts) · schema: `support.dispute` (extended), `dispute_evidence`, `ticket`, `ticket_message`, `payout.payout_hold`, `payout.clawback`, `payout.clawback_recovery` (migration `0003`) · API: [`apps/api/src/support`](../apps/api/src/support) |
| Related | [13 Vehicle module §4](13-vehicle-module.md#4-the-gross-inaccuracy-remedy) (gross-inaccuracy assessment) · [08 Wallet and ledger §6–7](08-wallet-ledger.md#6-refunds) (refunds, payouts) · [11 Close and settlement §10](11-close-settlement.md#10-payouts-after-release) (payouts after the claim window) · [15 Logistics](15-logistics.md) (release and delivery start the claim window) |

## 1. Purpose

ABC's help material gives no remedy for a lot that is not as described, and no response time for a query (blueprint §6 module 12). This module gives every claim and every question an owner, a deadline and a recorded outcome, and moves any money through the ledger.

**Acceptance test.** A buyer who receives something other than what was listed has a claim window, a named owner, a decision deadline and a refund to their wallet, which lowers buyer regret. The seller's payout is held only for the disputed sale and only until the decision deadline, and sellers whose goods match their listing are paid on schedule. That keeps the seller's time to cash short and predictable. Tickets with targets and breach flags shorten the time to first reply, a blueprint measure.

## 2. Raising a claim

`raiseDispute` (`POST /disputes`) takes:
- the lot
- a category: `not_as_described`, `missing`, `damaged_in_custody`, `inspection_inaccuracy` (vehicles only) or `other`
- a description
- the claimed condition, from the fixed vocabulary ([02 §7](02-data-model.md#7-notes-on-the-other-entities))
- evidence as object keys (photo, video, document)
- a client key

| Check | Refusal |
|---|---|
| The lot is on a paid invoice of this buyer | `not_found` |
| The goods have been released (collected, or handed to the courier) | `not_released`: check goods with staff at collection |
| Within `dispute.claim_window_hours_after_release` (48 h, PROPOSED) of release, or of delivery for delivered goods | `claim_window_closed` |
| Only one open claim per lot (partial unique index) | `already_open`, with its id |
| Inspection claims only for vehicles | `not_a_vehicle` |

The listed condition is copied from the lot, so the claim records both sides in the same vocabulary. A retried tap with the same client key returns the first claim (`UNIQUE (raised_by, client_key)`).

**Deadlines** (rules): a named owner within `dispute.response_target_hours` (24, PROPOSED), a decision within `dispute.decision_target_hours` (120, PROPOSED, A56).

## 3. Payouts are held while a claim is open

Raising a claim holds **every unpaid payout containing the lot** (`holdLotPayouts`): a `payout.payout_hold` row and payout status `held`. A payout covers one seller's lots on one invoice, so lots on other invoices are not held (A53).

- **The database refuses to approve or pay a held payout** (trigger on `payout.payout`), so finance cannot pay a seller from under a claim even by mistake. `markPayoutPaid` also refuses held payouts.
- Deciding the claim lifts its holds (`releaseDisputeHolds`). A payout with nothing left goes to `cancelled`. Otherwise it goes back to `scheduled` if the seller has a usable destination, or stays `held` without one, as before.
- A payout already paid cannot be held; a refund on that lot becomes a clawback (§6).

## 4. Working the queue

- `GET /staff/disputes` lists open claims first, by response deadline, with an `overdue` flag.
- `assign` gives the claim a named owner and moves it to `under_review`.
- The worker's `flagSlaBreaches` emits `dispute.response_overdue` (still `open` after the response deadline) and `dispute.decision_overdue` (undecided after the decision deadline), once each.

## 5. Decisions and remedies

| Remedy | Status | Money |
|---|---|---|
| `none` | `rejected` | None; holds lifted, seller paid on schedule |
| `partial_refund` | `partially_upheld` | Staff choose an amount, **at most the seller's net share** (hammer less commission) |
| `full_refund_and_return` | `upheld` | Everything the buyer paid for that lot on the invoice; the lot goes back to the seller |
| `repair_or_replace` | `upheld` | None in the System; the remedy is recorded |

A decision always records the decider, the decision text, the time and the remedy (database check). Staff act by name, with the decision as the audit reason (R3).

**Vehicle inspection claims.** For `inspection_inaccuracy` on a vehicle, staff record what they found (chassis or engine number, odometer, failing checklist items). `VehicleService.assessClaim` compares the findings with the latest **published** inspection report ([13 §4](13-vehicle-module.md#4-the-gross-inaccuracy-remedy)). The assessment (qualifies, reasons, report id, findings) is **stored with the decision**. A refund remedy needs a qualifying assessment (`assessment_does_not_qualify` otherwise), because minor items the buyer could see in the photos never qualify. In the test, a paint finding is refused, and an odometer 25 % above the report supports a partial refund.

**Two-person approval** (R3, A55). A refund above `dispute.refund_second_approver_threshold` (US$500, as A15; with no ZiG figure, **every** ZiG refund needs one) needs an approved override:

```
agent ── POST /staff/disputes/:id/refund-approval ──▶ audit.override_request (refund, amount, reason)
finance ── POST /staff/refund-approvals/:id ──▶ approved (database: approver ≠ requester)
agent ── POST /staff/disputes/:id/decision {overrideRequestId} ──▶ refund posted, override "executed"
```

The service checks the override is approved, for this claim, this amount and this currency. A database trigger refuses a claim that cites an override that is not an approved refund of the same amount for that claim. Refunds at or below the threshold need one named person.

## 6. Refunds, payouts and clawbacks

Every refund goes **to the buyer's wallet** through the ledger. From there it can be spent or sent back to its source ([08 §6](08-wallet-ledger.md#6-refunds)). The funding depends on where the seller's money for that lot stands (`lotPayoutState`):

| Seller's money | Refund funded by | Seller side |
|---|---|---|
| Not paid out yet (payout scheduled or held, or blocked because commission is unpublished) | `seller_payable` | The unpaid payout for the lot gets a negative `adjustment` line for the seller's share |
| Already paid out | Platform `suspense` (ABC fronts it) | A `payout.clawback` for the seller's share, recovered from the seller's later payouts in that currency (A54) |

**Recipes** (signed postings: + debit, − credit; key `dispute:<id>:refund`, so a claim can refund only once):

| Movement | Recipe | Lines |
|---|---|---|
| Partial refund | `refundToWallet` | + seller_payable (or + suspense) · − wallet_available:buyer |
| Full refund and return | `fullRefundAndReturn` | + seller_payable (or + suspense) by hammer − commission · + commission_income by commission · + tax_payable:levy, + tax_payable:vat (and premium, delivery) as charged · − wallet_available:buyer by the lot total |
| Clawback recovered | `clawbackRecovery` (kind `clawback`, key `clawback:<id>:payout:<payout>`) | + seller_payable · − suspense |

A full refund **unwinds the sale**: ABC gives back its commission, and the tax credits made at issue are reversed. The seller loses exactly their net proceeds. Storage and delivery charges booked after the sale (deliverable 15) are not refunded by this recipe (A53).

Worked example (test B, placeholder rates): a US$600 table, levy US$90.00, VAT US$93.00, total **US$783.00**, commission 10 %. A full refund credits the buyer's wallet US$783.00. It debits the seller's payable US$540.00, commission income US$60.00, the levy payable US$90.00 and the VAT payable US$93.00. The seller's payout for the table falls from US$540.00 to nil and is cancelled. The lot moves `released → refunded`, then `withdrawn` when the goods are back with the seller (`POST /staff/disputes/:id/return`; `listed` relists instead).

**Clawback example** (test C). A US$100 projector was paid out to the seller (US$90.00 net). A claim is then upheld in full: ABC fronts the refund (suspense US$90.00), and the lot moves `paid_out → refunded` (a transition added for this case; a database trigger allows `refunded` only with an upheld full-refund claim). The seller's next sale, a US$200 camera, schedules a payout of US$180.00 less the US$90.00 clawback = **US$90.00**. Suspense returns to zero and the books reconcile. Until the clawback is recovered, the daily safeguarding check ([08 §8](08-wallet-ledger.md#8-daily-reconciliation)) may show that customer money exceeds cash. That is correct: ABC must fund the gap from operating money until it is recovered.

## 7. Support tickets

One queue for every channel: `web`, `whatsapp`, `phone`, `branch`. Customers open their own tickets in the app (web) or through WhatsApp. Staff open one for a customer on the phone or at the counter.

| Field | Notes |
|---|---|
| Number | `T-000123`, from a sequence |
| Customer, opened by | The opener may be staff taking a call |
| Category | payment, collection, delivery, dispute, bidding, account, selling, other |
| Priority | urgent, high, normal, low. Customers get `high` for payment and dispute questions, `normal` otherwise; staff can set any |
| Owner | The first staff member to reply, or as assigned (owners must hold a staff role) |
| Status | `open` → `pending_customer` (staff replied) → `resolved` / `closed`. A customer reply reopens it |
| Links | Lot, invoice and claim, each checked against the customer |
| Targets | First response and resolution due times from `support.ticket_targets` (A56), recalculated if staff change the priority |

| `support.ticket_targets` (PROPOSED, clock hours) | First response | Resolution |
|---|---|---|
| urgent | 1 h | 8 h |
| high | 4 h | 24 h |
| normal | 8 h | 72 h |
| low | 24 h | 120 h |

- **Messages** are append-only (`support.ticket_message`). Staff may add **internal notes** that customers never see (database check: only staff write them). Customers see staff replies as "ABC Auctions support".
- **First response** is the first public staff reply. It sets `first_responded_at` once and emits `ticket.first_reply` with the minutes taken and whether it met the target. An internal note does not count (tested).
- **SLA breaches.** The worker's `flagSlaBreaches` stamps `first_response_breached_at` and `resolution_breached_at` once each and emits `ticket.sla_breached`. Breached tickets sort to the top of the staff queue.
- **Idempotency.** Client keys on tickets (`UNIQUE (opened_by, client_key)`) and messages (`UNIQUE (ticket_id, author, client_key)`).

## 8. API

| Method and path | Who | What |
|---|---|---|
| `POST /disputes` | buyer | §2 |
| `GET /me/disputes` | buyer | My claims, with status, refund and evidence |
| `POST /tickets`, `GET /me/tickets`, `POST /tickets/:id/messages` | customer | §7 (internal notes never returned) |
| `GET /staff/disputes?status=` | support, ops, admin, finance, risk | Claims queue |
| `POST /staff/disputes/:id/assign` | support, ops, admin | Take ownership |
| `POST /staff/disputes/:id/refund-approval` | support, ops, admin | Ask for a second approver |
| `POST /staff/refund-approvals/:id` `{approve}` | finance, admin | Approve or reject (never your own) |
| `POST /staff/disputes/:id/decision` | support, ops, admin | Remedy, decision, refund, vehicle findings, override |
| `POST /staff/disputes/:id/return` `{outcome}` | support, ops, admin | Goods back: `withdrawn` or `listed` |
| `GET /staff/tickets`, `GET /staff/tickets/:id` | support, ops, admin | Queue (breached first) and detail with internal notes |
| `POST /staff/tickets` | support, ops, admin, cashier | Log a phone or branch ticket |
| `POST /staff/tickets/:id/messages` `{body, internal?, resolve?}` | support, ops, admin | Reply, note, resolve |
| `POST /staff/tickets/:id/assign` `{ownerStaffId, priority?}` | support, ops, admin | Owner and priority |

## 9. Measures instrumented

| Blueprint measure (§9, [01 §11](01-solution-architecture.md#11-analytics-from-day-one)) | Events |
|---|---|
| Support tickets per 100 sales and time to first reply | `ticket.opened` (channel, category, priority), `ticket.first_reply` (minutes, within target), `ticket.resolved`, `ticket.sla_breached` |
| Claims and their outcomes | `dispute.raised`, `dispute.assigned`, `dispute.decided` (remedy, refund, funded by), `dispute.response_overdue`, `dispute.decision_overdue` |
| Seller cash held or clawed back by claims | `payout.held`, `payout.hold_released`, `payout.cancelled`, `payout.clawback_recorded`, `payout.clawback_recovered` |

## 10. Evidence

| Behaviour | Test |
|---|---|
| Refund plan: full = lot total; partial capped at the seller's net share; remedy → status | `support.test.ts` (pure) |
| Second approver above US$500; every ZiG refund until a figure is set; ticket targets by priority | pure |
| Claims only after release, once per lot, idempotent, only by the buyer; payout held and finance refused | database |
| Partial refund from the seller's share; payout reduced and released | database |
| Full refund above the threshold: refused without approval; requester cannot approve; approved refund unwinds the sale; payout cancelled; lot refunded then withdrawn | database |
| Refund after payout: ABC fronts it, clawback recovered from the next payout; books reconcile | database |
| Claim window closes; inspection claims only for vehicles; vehicle claim assessed against the published report, assessment stored | database |
| Tickets: targets, idempotency, link checks, internal notes, first reply once, reopen, resolve, phone tickets, SLA breach flagged once, claim deadlines flagged once | database |
| Paid payout can't be paid under a hold; one open claim per lot; refunded only via an upheld claim (also from `paid_out`); override must be approved and match; upheld refund needs its journal; clawback can't over-recover; ticket messages append-only; staff-only internal notes; ticket numbers | `db/tests/invariants.sql` |
| API: claims, staff queue and decision, finance-only approval, refund and return, tickets end to end, staff role required | `apps/api/src/support.test.ts` |
| Ledger recipes balance and hit the data-model accounts | `packages/ledger/src/ledger.test.ts` |

## 11. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| A53: hold scope (whole payout for the invoice), what a full refund covers | ABC Commercial / counsel | As in §3 and §6 |
| A54: clawback from later payouts; ABC fronts the refund meanwhile | ABC Finance | As in §6; the safeguarding check shows the gap |
| A55: refund approval threshold (US$500; every ZiG refund) | ABC Finance | As in §5 |
| A56: ticket targets and decision deadline, in clock hours | ABC Operations | As in §7; business-hours clocks would be a rule change plus code |
| Return logistics for full refunds (who collects the goods back) | ABC Operations | Staff record the outcome when the goods are back |
| Refunds back to source | ABC Finance | Refunds land in the wallet; `refundToSource` exists but no endpoint yet |
| Admin console screens (deliverable 18) | Build | API only; the queue endpoints are ready for it |
