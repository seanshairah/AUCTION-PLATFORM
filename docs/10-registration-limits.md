# 10 — Registration and Limits

| | |
|---|---|
| Phase | 3 — Money (deliverable 11) |
| Source of truth | Blueprint gap 3 ("every auction needs manual approval, which takes 30 minutes to two hours"), §6 modules 1–2, principles 3–4, §8 (shill bidding, fake identity, account takeover); [00 Assumptions register](00-assumptions-register.md) A12, A14, A21 |
| Code | [`packages/limits`](../packages/limits/src): `limits.ts` (pure: `computeLimit`, `exposure`, `capacity`, `decideRegistration`), `service.ts` (`RegistrationService`) · bid-time checks: [`packages/bidding`](../packages/bidding/src/service.ts) |
| Related | [02 Data model §6](02-data-model.md#6-account-tiers-and-limit-composition) (tiers, formula, worked examples) · [08 Wallet and ledger](08-wallet-ledger.md) · [06 Commit screen §3](06-commit-screen.md#3-behaviour-as-the-bidder-types) |

## 1. Purpose

Today a bidder registers for each auction and waits for staff approval, said to take 30 minutes in one article and two hours in another (gap 3). Blueprint module 2 replaces this: **approve the account once; joining an auction is one tap.** Principle 4: humans handle exceptions, not the happy path.

**Acceptance test.** Time from registration to first bid falls from hours to seconds, which brings more bidders per lot and so shortens sellers' time to cash. Limits are explained before a bidder hits them, which lowers regret.

## 2. Verify once

| Level | How it is reached | Tier | Status |
|---|---|---|---|
| None | Signed up | Guest: browse, watch, save searches | — |
| Partial | Email **and** phone OTP (WhatsApp or SMS for phone) | Verified | CONFIRMED levels and US$100 limit |
| Full | Partial **plus** an ID document checked through the `KycProvider` interface: a provider, or the manual staff queue that implements the same interface | Verified (full) | CONFIRMED US$500 limit; staff review of ID copies is today's practice |

The schema and checks for these levels exist and are tested. The sign-up, OTP and ID-capture screens and endpoints are specified here and built with the API app.

ID numbers are stored as a keyed hash, so the database refuses a second account with the same ID (blueprint §8: fake or duplicate identity). ID images go to the encrypted vault with a stated purpose ([01 §6.4](01-solution-architecture.md#64-security)).

Tier changes are automatic:
- **Trusted:** promotion by the nightly job once `tier.trusted_criteria` is met.
- **Restricted:** the default ladder's tier drop, or a risk flag.

Every change is audited by database trigger. A staff-initiated tier change is an override with a reason.

## 3. One tap to join

`RegistrationService.join` calls the pure `decideRegistration`, then records the outcome. Joining is **idempotent**: a second tap returns the same registration.

| Outcome | When | What the bidder sees |
|---|---|---|
| **Approved** (automatic) | Verified or Trusted, active, no review trigger, and the minimum deposit offered where the auction needs one | "You're in. You can bid up to US$500.00 in total." |
| **Pending review** | A review trigger from `registration.manual_review_triggers` applies: Restricted tier, linked to a seller in the auction, open risk flag, or an ID check still pending for a deposit auction | "Your registration is being checked. We aim to finish within 5 minutes during office hours." |
| **Refused** | Not verified, account inactive, or deposit below the minimum (or deposits not yet configured in that currency) | The specific reason and the next step, e.g. "This auction needs a deposit of at least US$3,000.00." |

The registration row stores the **limit at the time**, with its composition, as the blueprint asks (`limit_snapshot`). The database requires a reason for every pending registration, and an approver for every staff decision.

**The review queue** (admin console, deliverable 18) shows each pending registration with its reasons, the linked accounts that triggered it, and the bidder's history. The target is under 5 minutes (`registration.target_decision_minutes`, PROPOSED). Approval is audited with the reviewer's name.

## 4. Limits

The formula ([02 §6.2](02-data-model.md#62-spending-limit)) is implemented in `computeLimit` and tested against every worked example:

```
limit = max(free allowance, deposit × multiplier) + history bonus
```

| Part | Rule | Initial value |
|---|---|---|
| Free allowance | `limit.base` by verification level, per currency | US$100 partial, US$500 full (CONFIRMED); ZiG not set |
| Deposit multiplier | `limit.deposit_multiplier` by tier | 10× (CONFIRMED); Restricted 1× (PROPOSED) |
| History bonus | `limit.history_uplift_bp`, `limit.history_uplift_cap` | Trusted: 25 % of 12-month paid total, up to US$5,000 (PROPOSED) |
| No free allowance | Deposit-required auctions and Restricted accounts | — |
| Staff override | `registration.limit_override`, valid only with an approved override (database trigger) | Two-person above the A15 threshold |

- **Per currency** (A12). A USD deposit does not raise a ZiG limit. With no ZiG allowance set, ZiG bidding needs a ZiG deposit.
- **Deposits count account-wide** (A34). Every active deposit hold in a currency counts towards the limit, wherever it was placed. Deposit-required auctions still need their own minimum deposit to join.

**Exposure and room to bid** (checked at every bid, inside the bid transaction):

```
room = limit − (every live lot the bidder leads, at their maximum, all-in  +  unpaid invoices)
```

The lot being bid on is excluded, because the new maximum replaces it. The new bid's all-in total, from `QuoteService`, must fit in that room. Otherwise the bid is refused with `over_limit` and the room is returned, so the commit screen can say *"You can bid up to US$X in total. Add a deposit to bid higher."* (tested in `bidding.test.ts`).

## 5. Deposits

| Step | Behaviour |
|---|---|
| Choose an amount at join | Any amount at or above the auction's minimum. The minimum is the highest `deposit.minimum` among the auction's categories, per currency (BENCHMARK placeholders, A27). More deposit means a higher limit |
| Held | The ledger moves it from available to held (`createHold`), so it can't be spent while it secures bids |
| Add later | `addDeposit` places another hold on the same registration, for "Add a deposit to bid higher" |
| Returned | When the auction is settled, if the bidder won nothing ([11 §5](11-close-settlement.md#5-deposits-at-settlement)) |
| Used | Counted towards the winner's payment in the one-tap pay |
| Forfeited | At the default ladder's forfeit step |

## 6. Shill bidding controls

Blueprint §8: *"Link accounts by device, phone number, ID and payment source. Bar accounts linked to the seller from bidding on that seller's lots."* Two layers:

1. **At registration.** An account that is the seller of, or shares a link signal with the seller of, any lot in the auction goes to review (`linked_to_seller`), not straight in (tested).
2. **At every bid.** Being linked to that lot's seller is a hard refusal (`seller_linked`), **even if a reviewer approved the registration**. A seller may legitimately bid on other sellers' lots in the same auction, but never on their own (tested).

Link signals are keyed hashes in `identity.link_signal` (device, phone, national ID, payment source, payout destination, address, IP range). The writers for device and phone signals come with sign-in; payment-source and payout-destination signals come with deliverable 18.

## 7. Security around limits

- Raising a limit is done by **adding a deposit** (money in, no risk to the bidder) or by a **staff override** with a reason and a second approver above the threshold. There is no self-service limit raise without money.
- Changes that could move money out (payout destination, 2FA settings) need re-authentication and a cooling-off period ([01 §6.4](01-solution-architecture.md#64-security), rule `security.payout_destination_cooling_off_hours`).

## 8. Evidence

| Behaviour | Test |
|---|---|
| Worked examples 1–6 from the data model, cap, overrides, inactive and guest accounts | `limits.test.ts` (pure) |
| Exposure at maximum, all-in; excluding the lot being bid on; room never negative | `limits.test.ts` |
| Approve, review and refuse decisions | `limits.test.ts` |
| One-tap join with free allowance; idempotent second tap | `limits.test.ts` (database) |
| Deposit auction: too little refused, enough held, limit = deposit × 10 | `limits.test.ts` (database) |
| Device shared with the seller → review | `limits.test.ts` (database) |
| Over-limit bid refused with the room returned; seller barred from own lot after approval | `bidding.test.ts` |
| A Restricted defaulter's limit drops to their deposit | `money-path.test.ts` scenario B |

## 9. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| A12: cross-currency limits | ABC Finance | Per currency |
| A14: tier criteria and history bonus | ABC Commercial | As proposed |
| A27: minimum deposits per category | ABC Risk | Hammer and Tongues' figures as placeholders |
| A34: deposits count account-wide | ABC Risk | As described in §4 |
| KYC provider choice (Zimbabwe ID coverage) | ABC / tech lead | Manual staff review behind the same interface |
