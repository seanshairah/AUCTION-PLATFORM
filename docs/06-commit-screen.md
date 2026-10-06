# 06 — Commit Screen

| | |
|---|---|
| Phase | 2 — Informed bids (deliverable 7) |
| Source of truth | Blueprint §6 module 6 ("show the all-in price … before a bid is confirmed; check the limit against the all-in figure"), principle 1, gap 2, §7 (weak connections) |
| Code | [`packages/quote/src/commit.ts`](../packages/quote/src/commit.ts) (`commitPreview`) · ladder: [`packages/rules/src/increments.ts`](../packages/rules/src/increments.ts) · receipts: [`packages/engine`](../packages/engine/src/engine.ts) |
| Related | [04 Fee and tax engine §8](04-fee-tax-engine.md#8-the-commit-screen-calculation) · [05 Lot page](05-catalogue-lot-page.md) · [07 Bidding engine](07-bidding-engine.md) |

## 1. Purpose

Today the buyer learns the total cost from an email the morning after a binding bid (gap 2). The commit screen is new (blueprint module 6). It is the last moment before a binding commitment, and it must answer three questions **while the bidder types**:

1. *What will I pay if I win?* The all-in total: hammer, premium, levy, VAT and delivery.
2. *Am I allowed to bid this much?* The increment ladder, and the spending limit **checked against the all-in figure**.
3. *What happens when I press confirm?* It's binding, it's a maximum (proxy) bid, and the receipt proves it.

**Acceptance test.** No winning bidder is surprised by their invoice, which lowers regret. Invoices match what was shown, so they are paid sooner, which shortens time to cash.

## 2. Screen

Opened from the lot page's **Bid** button as a bottom sheet, so the lot stays visible behind it.

```
┌──────────────────────────────────────┐
│ Lot 42 · Dell Latitude 5420          │
│ Current bid US$85.00 · ends 18:42:10 │
│                                      │
│ Your maximum bid                     │
│ ┌──────────────────────────────────┐ │
│ │ US$ 200                          │ │  ← numeric keypad
│ └──────────────────────────────────┘ │
│ [US$90] [US$95] [US$100]             │  ← next ladder steps
│                                      │
│ If you win at US$200.00 you pay      │
│ US$261.00 in total. You may win for  │
│ less.                       Details ▾│
│   Hammer          US$200.00          │
│   Purchaser's levy 15%  US$30.00     │
│   VAT 15.5%       US$31.00           │
│ Collection: Harare branch    Change ›│
│                                      │
│ You can bid up to US$500.00 in total │
│                                      │
│ [        Review bid        ]         │
└──────────────────────────────────────┘
```

The figures above use the BENCHMARK placeholder tax rates, for illustration only (Q9).

### 2.1 Elements

| Element | Source | Notes |
|---|---|---|
| Lot line: current bid and end time | Live lot state (realtime) | End time by server clock ([07 §7](07-bidding-engine.md#7-realtime-updates-and-reconnecting)) |
| Amount field | Bidder | `inputmode="decimal"`, currency prefix fixed to the lot's currency, no decimals beyond 2 |
| Quick-bid buttons | `ladderSteps(state, ladder, 3)` | Fill the field; they do not place a bid |
| Total sentence and breakdown | `commitPreview` → `quoteLot` | Breakdown collapsed by default; one tap opens it |
| Delivery choice | `delivery.rate_card` | Default is collection. Choosing delivery re-quotes. Unavailable for vehicles and unlisted towns |
| Limit line | Registration and limits service: limit − exposure, all-in | "You can bid up to US$X in total" |
| Review button | Enabled only when the preview status is `ok` | |

## 3. Behaviour as the bidder types

`commitPreview` runs on each keystroke (debounced to 150 ms) against the snapshot of the auction's pinned rule version and the current tax rates, cached on the device. It returns one of six statuses:

| Status | Message (exact copy) | Review button |
|---|---|---|
| `empty` | Enter your maximum bid. | Disabled |
| `invalid` | Enter an amount in numbers, for example 250 or 250.50. · Use at most two decimal places. · A bid cannot be negative. | Disabled |
| `below_minimum` | The lowest bid you can place is US$90.00. | Disabled; "Use US$90.00" shortcut |
| `unavailable` | Bidding in this currency is not open yet. · We cannot show the full price for this lot right now, so bidding is paused. · Delivery is not available for this lot and address. Choose collection instead. | Disabled |
| `over_limit` | At US$1,000.00 you would pay US$1,305.00 in total. You can bid up to US$1,200.00 in total. Add a deposit to bid higher. | Disabled; "Add a deposit" link |
| `ok` | If you win at US$1,000.00, you pay US$1,305.00 in total. You may win for less. | Enabled |

Rules that keep the screen honest:

- **The limit check uses the all-in total** at the bidder's maximum, because the engine may bid up to that maximum without asking again (A21, `limit.exposure_basis = proxy_ceiling`). A US$1,000 bid that fits a US$1,200 limit at hammer but costs US$1,305 all-in is refused (tested).
- **Never guess.** If any input is missing (a tax rate, a ladder, a delivery price), the screen pauses bidding instead of showing a partial figure.
- Raising a maximum on a lot the bidder already leads replaces that lot's old maximum in the exposure calculation, so the bidder isn't counted twice.

**Limits before Phase 3.** The registration and limits service arrives in Phase 3 (deliverable 11). Until then, the limit line uses whatever limit source ABC's current system provides through the integration (A11, A31). If none is available, the line is hidden and the server still enforces the limit.

## 4. Review and confirm

**Review bid** opens a summary, a second deliberate step, because the bid is binding:

```
┌──────────────────────────────────────┐
│ Confirm your bid                     │
│                                      │
│ Your maximum      US$200.00          │
│ If you win at your maximum, you pay  │
│                   US$261.00          │
│   (hammer 200.00 · levy 30.00 ·      │
│    VAT 31.00)                        │
│ Collection        Harare branch      │
│                                      │
│ We bid for you, one step at a time,  │
│ only as high as needed to keep you   │
│ in the lead. Your maximum stays      │
│ secret.                              │
│                                      │
│ This bid is binding. You cannot      │
│ withdraw it.                         │
│ Rules: version 2026.11-r1 ›          │
│                                      │
│ [ Confirm bid ]      [ Change ]      │
└──────────────────────────────────────┘
```

Copy comes from the rulebook rendering ([03 §8](03-rulebook-service.md#8-one-rulebook-rendered-everywhere)), so the binding and proxy explanations match the public rules word for word.

## 5. Submitting

1. **Confirm bid** creates a `clientRequestId` (a UUID) for this confirmation, once.
2. The client sends `POST /lots/{id}/bids` with `{ maxAmount, currency, clientRequestId, quotedTotal, ruleVersionId, delivery }`.
3. **The server re-checks everything** with the same code and fresh data:
   - registration
   - seller-linked bar
   - limit
   - `commitPreview`
   - the engine
4. If the server's all-in total differs from `quotedTotal` (a rate changed, or the device's snapshot was stale), the bid is **not placed**. The server returns `price_changed` with the new figures, and the bidder confirms again. This is how the screen can never disagree with the bill (R2).
5. The accepted bid row stores `quoted_total_minor` and `quoted_rule_version_id` (database check), so "the screen said X" can always be proven.

**Retries without double bids.** If the network fails after Confirm, the client retries with the **same** `clientRequestId` up to 3 times with back-off. The database's unique key `(account_id, client_request_id)` guarantees at most one bid, and a repeat returns the original receipt. If retries fail, the screen says: *"We could not confirm your bid. Check My bids before trying again."* When the connection returns, the client asks `GET /bids?clientRequestId=…`, which settles whether the bid exists. A new ID is never generated automatically for the same confirmation.

## 6. The receipt

| Outcome | Copy |
|---|---|
| Leading | You are leading at US$85.00. Your maximum of US$200.00 stays secret. Receipt 3 · 17:42:10 server time. |
| Outbid at once | Another bidder's maximum is higher. The price is now US$205.00. Bid at least US$215.00 to lead. Receipt 4 · 17:42:15. |
| Raised own maximum | Your maximum is now US$400.00. You are still leading at US$85.00. Receipt 5. |
| Rejected | (See §7.) Nothing was placed. |

The receipt's sequence number and server time are what count (rule `bidding.dropped_connection_policy`). They are kept in **My bids** with the total shown at the time.

## 7. Errors from the server

| Code | Source | Copy |
|---|---|---|
| `below_minimum` | Engine | The price has moved. The lowest bid you can place is now US$95.00. |
| `not_above_your_max` | Engine | You are already leading with a maximum of US$200.00. Enter a higher amount to raise it. |
| `lot_closed` | Engine | Bidding on this lot has ended. |
| `price_changed` | Server re-check | The total has changed: if you win at US$200.00 you now pay US$262.00. Please confirm again. |
| `over_limit` | Limits | You can bid up to US$500.00 in total. Add a deposit to bid higher. |
| `not_registered` | Registration | Join this auction to bid. It takes one tap. |
| `registration_pending` | Registration | Your registration is being checked. We aim to finish within 5 minutes during office hours. |
| `seller_linked` | Risk | You cannot bid on this lot because your account is linked to its seller. |
| `rate_limited` | API | Too many attempts. Wait a moment and try again. |

## 8. Weak connections

- **Offline banner** when the connection drops: *"You're offline. Your maximum bids keep bidding for you."*
- **Confirm is disabled while offline. Bids are never queued** for later sending: a bid sent minutes late would be ambiguous, and the bidder must see the price at the moment of commitment.
- On reconnect, the client resubscribes with its last seen sequence number, receives the current state and missed events ([07 §7](07-bidding-engine.md#7-realtime-updates-and-reconnecting)), and settles any in-flight bid by its `clientRequestId`.
- The countdown keeps running from the last known server-clock offset and is marked "reconnecting…" until fresh state arrives.
- **No-script fallback:** the lot page has a plain HTML form (amount plus delivery). Submitting it shows a server-rendered review page with the same total and a Confirm button that carries the same hidden `clientRequestId`. Very old browsers can still bid safely, just without the live total.

## 9. Accessibility

- The amount field has a visible label, numeric keypad and a large touch target (≥ 48 px).
- The total sentence sits in an ARIA live region (polite), so screen readers announce the new total after typing pauses.
- Errors are text next to the field, not colour alone. Works at 320 px wide and at 200 % text size.
- Times show both the clock time and the countdown.

## 10. Analytics events

| Event | Purpose |
|---|---|
| `commit.opened` | Funnel: lot view → commit |
| `commit.status_shown` (`below_minimum`, `over_limit`, `unavailable`) | Where bidders are blocked; over-limit rate feeds the deposit and tier review |
| `commit.breakdown_opened` | Is the all-in price read? |
| `commit.review_opened`, `commit.confirmed` | Funnel to confirmation |
| `bid.accepted`, `bid.rejected` (reason) | Bids per lot; time from registration to first bid (blueprint §9) |
| `commit.price_changed` | How often device snapshots go stale |

## 11. Acceptance scenarios

| # | Given | When | Then | Covered by |
|---|---|---|---|---|
| 1 | Current bid US$100, USD ladder | Bidder types 101 | "The lowest bid you can place is US$105.00." | `quote.test.ts` (commitPreview) |
| 2 | Active rates; goods lot | Bidder types 1,000 | "If you win at US$1,000.00, you pay US$1,305.00 in total." | `quote.test.ts` |
| 3 | Limit US$1,200 all-in | Bidder types 1000 | Over-limit message with US$1,305.00 and US$1,200.00 | `quote.test.ts` |
| 4 | Tax rates inactive | Bidder types any amount | Bidding paused, no figure shown | `quote.test.ts` |
| 5 | ZiG lot, no ZiG ladder | Bidder opens commit | "Bidding in this currency is not open yet." | `quote.test.ts` |
| 6 | Bid confirmed; response lost | Client retries with the same ID | One bid; the original receipt returned | DB unique key: `invariants.sql` |
| 7 | Rates changed after the device cached them | Bidder confirms | `price_changed`; new total; nothing placed | API test (Phase 3 build) |
| 8 | Bidder leads with max US$200 | Bidder confirms US$150 | "You are already leading with a maximum of US$200.00 …" | `engine.test.ts` |
| 9 | Bidder offline | Bidder taps Confirm | Button disabled; offline banner | UI test (app build) |
