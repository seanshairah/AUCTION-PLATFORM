# 15 — Logistics Module

| | |
|---|---|
| Phase | 5 — Reach (deliverable 15) |
| Source of truth | Blueprint §1 cash cycle (CONFIRMED: 48 hours to collect), §2 module 8 (CONFIRMED: next-day delivery with a 2:30 pm cut-off, no vehicles), §6 module 10 ("Collection slots and QR pass. Delivery quotes at commit. Bundling. Storage clock"), gap 6 (delivery towns and prices unpublished), Q4 (storage fees) |
| Code | [`packages/logistics`](../packages/logistics/src): `logistics.ts` (pure: slots from branch hours, storage clock, bundled delivery quote, cut-off), `service.ts` (`LogisticsService`, the "my purchases" read model), `testing.ts` (paid-invoice fixtures) · settlement hooks: `releaseAtGate(…, check)`, `releaseCollection` in [`packages/settlement`](../packages/settlement/src/service.ts) · schema: `logistics.collection_slot`, `slot_booking`, `storage_charge`, `delivery`, `delivery_event` (migration `0003`) · API: [`apps/api/src/logistics`](../apps/api/src/logistics) |
| Related | [11 Close and settlement §6–7](11-close-settlement.md#6-one-tap-payment) (payment creates the collection and QR pass) · [13 Vehicle module §6–7](13-vehicle-module.md#6-title-tracker) (title hold, towing partners) · [04 Fee and tax engine](04-fee-tax-engine.md) (`quoteLot` delivery option) · [17 Support and disputes](17-support-disputes.md) (claim window after release or delivery) |

## 1. Purpose

Today a winner has 48 hours to collect from the Harare or Bulawayo branch (CONFIRMED). There is no appointment, delivery prices are not published, and the storage-fee rule is only *Reported* (Q4). Vehicles are never delivered (CONFIRMED).

This module turns a paid invoice into goods in the buyer's hands:
- a **collection** bundling every lot on the invoice, with the QR gate pass
- **bookable collection slots**, cut from branch hours, with reminders
- a **storage clock** that shows the deadline and, if ABC switches storage on, the fee as it accrues
- **door delivery** by a courier partner, priced by the same `quoteLot` the commit screen uses

**Acceptance test.** A buyer knows when to come, what any delay costs and what delivery costs before booking it, and the bill always matches the screen. That lowers buyer regret. Goods leave on a booked slot or with a courier instead of waiting for a phone call, and release schedules the seller's payout, which shortens the seller's time to cash.

## 2. Collections: one per paid invoice

Paying from the wallet (`SettlementService.payFromWallet`, [11 §6](11-close-settlement.md#6-one-tap-payment)) already creates the collection, so this module builds on it instead of duplicating it:

| On payment | Detail |
|---|---|
| One collection per invoice | Every lot on the invoice is in `logistics.collection_lot`, so lots won together leave together |
| Status `ready`, method `pickup` | The database refuses `ready` or later against an unpaid invoice |
| QR gate pass | A random token; only its keyed hash is stored |
| Storage clock start | `storage_clock_from` = the moment of payment |

Collection statuses used here: `ready` → `scheduled` (slot or delivery booked) → `released` (at the gate, or handed to the courier) → `delivered` (courier proof recorded).

## 3. Collection slots

| Rule | Value | Tag |
|---|---|---|
| Branch hours | 9:00–15:00 weekdays, 9:00–12:00 Saturdays (`core.branch.opening_hours`) | CONFIRMED |
| `logistics.collection_slot` | 30 minutes, 6 buyers per slot, bookable 7 days ahead | PROPOSED (A50) |
| `logistics.slot_reminder_hours` | 24 h and 2 h before the slot | PROPOSED (A50) |

- **Generation.** The worker runs `ensureSlots` hourly. It cuts consecutive slots from each branch's hours in Central Africa Time (UTC+2; Zimbabwe has no daylight saving), never past closing time, and leaves existing slots alone (`UNIQUE (branch_code, starts_at)`). That gives 12 slots on a weekday, 6 on a Saturday and none on a Sunday.
- **Booking** (`bookSlot`). The collection must be the buyer's, `ready` or `scheduled`, and for pickup. The slot must be at the goods' branch and not yet started. Results: `booked`, `full`, `wrong_branch`, `past`, `not_bookable`, `not_found`.
- **Capacity under simultaneous bookings.** Same pattern as viewing slots ([13 §5](13-vehicle-module.md#5-viewing-slots-instead-of-phone-calls)): a trigger locks the slot row and counts live bookings before each insert. A partial unique index allows one live booking per collection. In the test, four buyers book a two-place slot at the same moment and exactly two get in.
- **Rebooking** cancels the old booking and inserts the new one **in one transaction**. If the new slot is full, the transaction rolls back and the old booking stands (tested).
- **Idempotency.** A client key per booking (`UNIQUE (account_id, client_key)`): a retried tap returns the first booking.
- **Reminders.** `queueSlotReminders` emits `collection.slot_reminder` once per booking and offset. The communications layer (deliverable 16) delivers it; the `comms.fallback` rule already has a `collection_ready` channel order.

## 4. Release at the gate

The QR flow from [11 §7](11-close-settlement.md#7-the-gate-pass) is kept: invalid pass, pass already used, and vehicle title hold are all refused as before. It is extended in two ways, both running **inside the settlement release transaction** through a `ReleaseCheck` hook, so nothing half-happens:

1. **Storage first** (§5). If storage is due and the wallet covers it, it is charged and the goods go. If not, the release is refused with `charges_due` and the amount, and nothing is written.
2. **Courier hand-over** (`handOverToCourier`). Staff release a delivery collection by id, with the same storage check, title rule and payout scheduling. The delivery becomes `collected`.

Release still moves lots to `released`, records who released them, and schedules payouts after the claim window. It now also deducts any open clawback the seller owes ([17 §6](17-support-disputes.md#6-refunds-payouts-and-clawbacks)).

## 5. The storage clock

| Rule | Value | Tag |
|---|---|---|
| `settlement.collect_window_hours` | 48 | CONFIRMED |
| `storage.enabled` | `false` | PROPOSED (Q4) |
| `storage.free_hours` | 48, from payment; the validator refuses a figure shorter than the collection window | PROPOSED |
| `storage.daily_rate_bp` | 100 (1 % of hammer per day) | BENCHMARK (Hammer and Tongues) |

```
paid ──── collect by (paid + 48 h) ──── free until (paid + max(free hours, 48 h)) ──── day 1 ── day 2 ── …
```

- Each day **or part day** after the free period costs `daily_rate_bp` of the hammer of every lot in the collection (A51).
- The figures come from **the invoice's pinned rule set** (A20), so switching storage on later never surprises a buyer who has already won.
- **Charged once, at release**, from the wallet: journal `storage_fee` (wallet available → `fee_income:storage`), key `collection:<id>:storage`, and a `logistics.storage_charge` row (unique per collection, append-only).
- **Read model.** `GET /me/purchases` shows collect-by, free-until, chargeable days, daily fee, accrued so far and, after release, what was charged. With `storage.enabled = false` (the default) the accrual is always zero, but the deadline still shows.

Worked example (test, storage switched on): a US$260 desk paid at *T*. Free until *T* + 48 h. At *T* + 48 h + 2 days + 1 hour, three days are due: 3 × US$2.60 = **US$7.80**. At day 24 the wallet (US$60.70) cannot cover US$62.40, so the gate refuses with `charges_due` and nothing moves.

## 6. Door delivery (not vehicles)

**Quote.** `quoteDelivery` calls `quoteLot` with the delivery option for **every lot** in the collection, the same function the commit screen calls. That also refuses vehicles and `delivery.excluded_categories` (`DELIVERY_UNAVAILABLE`). One trip carries the whole bundle, so the price is the **single most expensive lot delivery** at the buyer's declared size (small, medium or large), with its delivery tax lines unchanged (A52). The rate card is the invoice's pinned `delivery.rate_card`, empty until operations publishes towns and prices (A24). Until then every quote is "unavailable" and buyers book a slot.

**Booking** (`bookDelivery`) runs in one transaction:

| Check | Result if it fails |
|---|---|
| Re-quote equals the total the client showed | `price_changed`, with the new quote; nothing booked |
| Active courier partner (`logistics.partner`, kind `courier`) serving the branch | `no_courier` |
| Wallet covers the charge | `insufficient_funds`, with the shortfall |

When all checks pass, the System:
- posts the `delivery_charge` journal (wallet available → `delivery_income`, plus `tax_payable` for any tax on delivery), key `delivery:<id>:charge`
- records the delivery, with the quote lines charged and the rule version
- cancels any pickup slot
- sets the collection to `method = delivery`, `scheduled`
- emits `delivery.booked` for the courier integration

It is idempotent on the client key. Expected arrival follows the CONFIRMED cut-off (`delivery.cutoff_local_time` 14:30): next day if booked before it, otherwise the day after.

**Status and proof.** Staff record the courier's updates (`POST /staff/deliveries/:id/status`). Every change is an append-only `logistics.delivery_event`.

```
booked ──hand-over at branch──▶ collected ──▶ in_transit ──▶ delivered (proof object key required)
   │                                │              └────────▶ failed (reason required)
   └──▶ cancelled (reason required; charge reversed in full; goods back to "ready")
```

The database refuses `delivered` without a proof key, and refuses a delivery whose partner is not a courier or whose collection holds a vehicle. Vehicles go with listed towing partners ([13 §7](13-vehicle-module.md#7-towing-partners)).

## 7. What the buyer sees: `GET /me/purchases`

For each invoice:
- the invoice: number, status, total, due and paid times
- each lot, with its invoice lines
- the lot state and any claim
- for vehicles, title-case progress: steps done of three, with due dates
- the collection: status, method, branch, booked slot
- gate-pass status: `valid`, `used`, `void` or `not_issued` (the token itself is only shown once, at payment)
- the storage clock (§5)
- any delivery, with its partner and charge

Money travels as `{ minor, currency, text }`.

## 8. API

| Method and path | Who | What |
|---|---|---|
| `GET /me/purchases` | buyer | §7 |
| `GET /branches/:code/collection-slots` | anyone | Slots to the booking horizon, with places left |
| `POST /collections/:id/slot` `{slotId, clientKey?}` | buyer | Book or rebook |
| `POST /collections/:id/delivery-quote` `{town, sizeClass}` | buyer | The quoteLot delivery lines and total |
| `POST /collections/:id/delivery` `{town, sizeClass, address, quotedTotalMinor, clientKey, partnerId?}` | buyer | Book and pay |
| `POST /staff/gate/release` `{token}` | ops, cashier, vehicle desk, admin | QR release with storage check |
| `POST /staff/deliveries/:id/hand-over` | ops, admin | Release to the courier |
| `POST /staff/deliveries/:id/status` `{status, proofObjectKey?, note?}` | ops, admin | Courier status with proof |

Staff endpoints use `StaffOnly(...)` ([`apps/api/src/staff-guard.ts`](../apps/api/src/staff-guard.ts)): a session plus a matching row in `identity.staff_role`. Writes run as that staff member, by name, with a reason (R3).

## 9. Measures instrumented

| Measure | Events |
|---|---|
| Time from payment to collection | `invoice.paid` → `collection.released` |
| Slot use and no-shows | `collection.slot_booked`, `collection.slot_reminder` |
| Delivery uptake and reliability | `delivery.booked`, `delivery.status_changed` (with proof) |
| Storage charged (when enabled) | `storage.charged` |

## 10. Evidence

| Behaviour | Test |
|---|---|
| Slots from branch hours in CAT: 12 on a weekday, 6 on Saturday, none on Sunday; started slots left out | `logistics.test.ts` (pure) |
| Storage free until the later of collection deadline and free hours; a part day counts; zero when disabled | pure |
| Bundled delivery is the dearest lot delivery from quoteLot; vehicles refused; cut-off date | pure |
| A paid invoice has one ready collection bundling its lots | database |
| Slot generation is idempotent; capacity holds under four simultaneous bookings of two places | database |
| Book, idempotent retry, rebook; a full slot leaves the old booking; wrong branch and someone else's collection refused | database |
| Reminders once per offset | database |
| Storage refused when the wallet is short (nothing moves), then charged once through the ledger at release | database |
| Delivery: price re-checked, charged once, idempotent; hand-over releases and schedules payouts; proof required; events in order | database |
| Cancelled delivery refunded in full; goods back to ready | database |
| My purchases: lines, collection, gate pass, storage clock, title progress | database and `apps/api/src/logistics.test.ts` |
| Books reconcile after storage, delivery and refunds | database |
| Slot capacity, one live booking, courier-only delivery, proof required, append-only history | `db/tests/invariants.sql` |
| API: session and staff role required; slots; delivery quote and booking; gate release; courier proof | `apps/api/src/logistics.test.ts` |

## 11. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| Q4: storage fees | ABC Operations | `storage.enabled = false`; the clock shows the deadline only |
| A24: delivery towns and prices | ABC Operations | Rate card empty: every delivery quote is "unavailable" |
| A50: slot length, capacity, horizon, reminders | ABC Operations | As in §3 |
| A51: storage counted per day or part day, charged at release | ABC Operations / Finance | As in §5 |
| A52: bundle priced as the dearest lot delivery; ABC pays couriers outside the System | ABC Operations / Finance | As in §6 |
| Courier booking API | ABC Operations | Couriers are told through `delivery.booked`; staff record their updates |
| Failed deliveries | ABC Operations | Recorded with a reason; the goods return to the branch, and rebooking is a staff task |
| Branch cash banking to the trust account | Finance | Payouts need trust-account funds; banking is not yet a recipe ([08 §11](08-wallet-ledger.md#11-open-items)) |
