# 08 — Wallet and Ledger

| | |
|---|---|
| Phase | 3 — Money (deliverable 9) |
| Source of truth | Blueprint §6 module 3 ("one double-entry ledger with USD and ZiG sub-ledgers. Holds, top-ups, invoices, refunds, payouts, fees"), principle 2, §9 build-or-buy ("Wallet ledger: Build … money logic is core and must be exact"); [00 Assumptions register](00-assumptions-register.md) Q7 |
| Code | [`packages/ledger`](../packages/ledger/src): `recipes.ts` (every journal), `store.ts` (write path, holds, wallet, reconciliation) · schema `ledger.*` in [`db/schema.sql`](../db/schema.sql) |
| Related | [02 Data model §4](02-data-model.md#4-wallet-and-ledger) (chart of accounts, posting recipes) · [09 Payments](09-payments.md) · [11 Close and settlement](11-close-settlement.md) |

## 1. Purpose

Today online deposits are cash at an office or a courier pickup (gap 1). The blueprint's second principle is **money on local rails, with one ledger**:

> "Deposits, winnings, fees, refunds and payouts all run through a single wallet ledger in USD and ZiG, funded by mobile money, bank transfer and card. Cash stays as a fallback and is posted to the same ledger."

This module is that ledger. It is the only place money is recorded, and nothing else in the System keeps a balance of its own (architecture rule R1).

**Acceptance test.** Buyers fund deposits and pay from their phones, which lowers regret. Sellers' proceeds are known to the cent the moment the buyer pays, so payouts can be scheduled at once, which shortens time to cash.

## 2. The write path

```
recipe (pure, balanced)  →  postJournal()  →  ledger.post_journal()  →  triggers
packages/ledger/recipes     packages/ledger     database function         balance cache, checks
```

1. **Recipes** (`recipes.ts`) are pure functions, one per kind of money movement. Each returns a journal that already balances, or throws `UnbalancedJournalError`.
2. **`postJournal`** resolves each line's book account, creating it on first use from the chart of accounts, then calls the database function.
3. **`ledger.post_journal()`** is idempotent on the journal's key: a repeat returns the original journal and posts nothing (R4).
4. **The database refuses** any journal that is unbalanced, mixes currencies or would overdraw a non-negative account. It also refuses any update or delete of journals and postings ([02 §8](02-data-model.md#8-invariants-and-where-they-are-enforced)).

The database is the last line of defence, not the only one: a bug in a recipe is caught before it reaches the database, and a bug that slips past the recipe is refused by the database.

## 3. Recipes

Each journal has a stable idempotency key, so a retried request, a duplicate callback or a re-run job can never post twice.

| Movement | Recipe | Debit | Credit | Idempotency key |
|---|---|---|---|---|
| Top-up through a gateway | `topUp` | gateway clearing | wallet available | `payment:<payment id>` |
| Cash at a branch | `branchCash` | branch cash | wallet available | `payment:<payment id>` |
| Gateway settles to the trust account | `gatewaySettlement` | trust bank | gateway clearing | `settlement:<id>` |
| Deposit held | `placeHold` | wallet available | wallet held | `hold:<id>:place` |
| Deposit released | `releaseHold` | wallet held | wallet available | `hold:<id>:close` |
| Deposit forfeited | `forfeitHold` | wallet held | forfeiture income (and seller share, if the rule allows) | `hold:<id>:close` |
| Invoice issued at the hammer | `invoiceIssued` | customer receivable | seller payable · tax payable per tax · fee income (premium) · delivery income | `invoice:<id>:issue` |
| Invoice paid from wallet | `invoicePayment` | wallet available | customer receivable | `payment:<payment id>` |
| Commission on a paid lot | `commission` | seller payable | commission income | `commission:<invoice>:<lot>` |
| Unpaid invoice cancelled | `invoiceCredit` | mirror of the issue journal | | `invoice:<id>:credit` |
| Relist fee after a default | `relistFee` | wallet available (or receivable if short) | fee income | `invoice:<id>:relist_fee` |
| Seller payout | `payout` | seller payable | trust bank or gateway clearing | `payout:<id>` |
| Refund after an upheld claim | `refundToWallet` | seller payable (or platform suspense once paid out) | wallet available | `dispute:<id>:refund` |
| Money back to its source | `refundToSource` | wallet available | gateway clearing | `refund:<id>` |
| Correction | `reversal` | mirror of the original | | `reversal:<journal id>` |

Release and forfeit share one key per hold (`hold:<id>:close`), so a deposit can be closed only once, either way. The database's `ledger.hold` status check backs this up.

## 4. Available and held

A customer's wallet in each currency is two book accounts: **available** (can be spent or sent back to source) and **held** (deposits securing bids). `ledger.v_wallet` reads both straight from the ledger.

**Deposit lifecycle** (rule `deposit.release_on = auction_settled`):

| Moment | What happens | Where |
|---|---|---|
| Join a deposit auction | The chosen deposit moves from available to held, recorded as a hold referencing the registration | [10 §5](10-registration-limits.md#5-deposits) |
| Add a deposit | Another hold on the same registration | `RegistrationService.addDeposit` |
| Auction settled, bidder won nothing | Hold released to available | `SettlementService.settleClosedAuction` |
| Bidder won | Hold released **as part of the one-tap payment**, so the deposit counts towards the invoice | `SettlementService.payFromWallet` |
| Winner defaults | Hold forfeited at the ladder's forfeit step | `SettlementService.runDefaultLadder` |

**Concurrency.** Every posting updates its book account's cached balance in the same transaction, which locks that row. Two simultaneous holds on one wallet therefore queue, and the second is refused if it would overdraw. This is tested by firing two holds at once against one wallet: exactly one succeeds.

## 5. From deposit to spending limit

The ledger supplies the held-deposit figure; the formula lives in the registration and limits service ([10 §4](10-registration-limits.md#4-limits)). Deposits count **account-wide per currency** towards the limit (A34). A deposit-required auction still needs its own minimum deposit to join, so the free allowance never stands in for a required deposit.

## 6. Refunds

- **To the wallet** after an upheld claim (deliverable 17). It is funded from the seller's payable if the seller hasn't been paid yet, otherwise from platform suspense for finance to recover.
- **Out of the wallet** only back to where the money came from (`refundToSource`). The System never sends a customer's balance to a new destination. That keeps the wallet a record of obligations, not a transferable e-money balance, which is the default stance on Q7 (§9).

## 7. Payouts

| Step | Rule / behaviour |
|---|---|
| When | Scheduled at release. Due after the buyer's claim window plus processing time: `dispute.claim_window_hours_after_release` (48 h) + `payout.processing_hours` (24 h), both PROPOSED |
| How much | Hammer minus commission per lot (`sellerProceeds`, the same calculator sellers see), grouped per seller and currency. The payout header must equal its lines (database check) |
| Where to | The seller's active payout destination in that currency, past its cooling-off period (rule `security.payout_destination_cooling_off_hours`). With no usable destination the payout is **held**, not lost |
| Blocked | While commission is unpublished (Q3) no payout is calculated; a `payout.blocked` event tells finance and the seller why |
| Paid | Finance marks it paid with the transfer reference. That posts the `payout` journal from the trust account and moves the lots to `paid_out` |

Automated payouts through a gateway's payout API come later; the interface has a place for them (`PaymentGateway`, [09 §3](09-payments.md#3-the-gateway-abstraction)).

## 8. Daily reconciliation

`reconcileLedger()` returns an empty list when the books are sound. It checks:

1. **Holds equal held balances.** The sum of active holds per customer and currency equals that customer's held balance.
2. **Safeguarding.** Customer money is covered by cash and clearing, per currency:

   *wallets (available + held) + seller payables already funded by paid invoices ≤ trust bank + gateway clearing + branch cash*

   A seller payable created by a still-unpaid invoice isn't funded yet, so unpaid hammer amounts are subtracted. A breach means customer money was used for something else, and it raises a finance alert.

Gateway statements are reconciled separately, line by line, against recorded payments ([09 §9](09-payments.md#9-daily-reconciliation)). Every integration test ends by asserting `reconcileLedger()` is empty, including after defaults, forfeits and payouts.

## 9. Regulatory structure (Q7)

**Legal review is required before Phase 3 opens to the public.** Holding customer balances may need authorisation from the Reserve Bank of Zimbabwe. The default design avoids issuing e-money:

| Design choice | Why it matters |
|---|---|
| Funds sit in a **designated trust account** (or with the licensed gateway); `trust_bank` is its ledger mirror | Customer money is never ABC's operating cash |
| No transfers between customers | Not a payment service between users |
| Refunds only to source | No cash-out channel to new destinations |
| No interest; deposits tied to auction participation | The balance exists to secure and settle auction obligations |
| Daily safeguarding check (§8) | Evidence for regulators and auditors |

If counsel prefers a gateway-held structure, `trust_bank` maps to the gateway's settlement account instead; nothing else changes.

## 10. Evidence

| Behaviour | Test |
|---|---|
| Every recipe balances; the invoice journal matches the data-model example | `ledger.test.ts` (pure) |
| Top-up credits once, even when repeated | `ledger.test.ts` (database) |
| Holds release or forfeit exactly once | `ledger.test.ts` |
| Overdrawing holds and payments are refused by the database | `ledger.test.ts` |
| Two concurrent holds cannot overdraw | `ledger.test.ts` |
| Full money path ends with clean reconciliation | `money-path.test.ts` scenarios A, B and C |

## 11. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| Q7: authorisation for holding balances | Counsel | Public launch of Phase 3 waits; build proceeds on the trust-account default |
| Gateway fee accounting (net settlements) | Finance | Settlements assumed gross; a fee expense account is added when gateway terms are known |
| Branch cash banking journal (till → trust account) | Finance | Branch cash stays in `branch_cash` until a banking journal recipe is added |
| A34: deposits count account-wide | ABC Risk | As described in §5 |
