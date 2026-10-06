# 00 — Assumptions Register

| | |
|---|---|
| Phase | 0 — Foundations (deliverable 1) |
| Source of truth | *The Perfect Bidding System: ABC Auctions Survey, Benchmark and Blueprint* (5 Oct 2026), referred to as **the blueprint**; section numbers (§) refer to it |
| Status | Defaults adopted by the product owner on 2026-10-06. Every item marked **Decision needed** is still open with ABC, counsel or finance |
| Related | [01 Solution architecture](01-solution-architecture.md) · [02 Data model](02-data-model.md) |

## How to read this register

Every statement in this repository carries one of four tags:

| Tag | Meaning |
|---|---|
| **CONFIRMED** | The blueprint states it as documented fact about ABC (its grade *Documented*) |
| **BENCHMARK** | The blueprint states it about another platform (Copart, Bring a Trailer, Ritchie Bros, Catawiki, Hammer and Tongues). Never a fact about ABC |
| **PROPOSED** | The blueprint or this design proposes it as a starting value. It becomes a rulebook entry or a configurable default, never a hardcoded constant |
| **ASSUMPTION** | This design assumes it in order to proceed. Each one is listed below with an owner |

The blueprint's *Reported* grade (a second reader's unverified notes on the live app) is treated as **ASSUMPTION**: nothing in the design depends on a *Reported* claim being true.

Each open item has a **safe default**: what the System does until someone answers. Defaults are chosen so that a wrong default is cheap to reverse, usually by changing a rulebook entry rather than code.

---

## Part A — The blueprint's ten open questions

### Q1. Do in-person floor auctions still run, or is everything online?

| | |
|---|---|
| Status | **Decision needed** |
| Evidence | ABC's auction-process page describes in-person registration and a buyer's card (CONFIRMED, search-indexed). The second reader says all auctions are online (*Reported*). Blueprint §3 lists this as an unresolved conflict |
| Recommendation | Model the auction format as data: `timed_online`, `floor`, `out_of_hand`. A floor sale is a cashier posting to the same ledger, so supporting it costs a format value, a cashier screen and a branch-cash journal, all of which exist anyway for branch deposits |
| Safe default | All three formats exist in the schema. Floor-specific screens (buyer's card, hammer entry by clerk) are deferred until ABC confirms |
| Owner | ABC Operations |
| Blocks | Nothing before Phase 5. Changes the admin console scope |

### Q2. How do online winners pay today: bank transfer, mobile money, cash, or several?

| | |
|---|---|
| Status | **Decision needed** |
| Evidence | The floor page lists cash, swipe, transfer and EcoCash (CONFIRMED). The online-win article names no method (CONFIRMED absence). The second reader claims bank transfer (*Reported*) |
| Recommendation | For the target system the answer does not change the design: every payment goes through the wallet ledger, and every rail sits behind the gateway abstraction ([01 §7](01-solution-architecture.md#7-integration-abstraction-layers)). It matters for **migration** (which habit we replace first) and **launch order** of rails |
| Safe default | Launch order: mobile money (EcoCash, OneMoney, InnBucks) → card via redirect with 3-D Secure → Zimswitch / Omari → bank transfer → branch cash as fallback. Each rail is enabled per currency in the rulebook |
| Owner | ABC Finance |
| Blocks | Phase 3 launch order only |

### Q3. What are the commission rates and any buyer's premium?

| | |
|---|---|
| Status | **Decision needed** |
| Evidence | ABC publishes commission as an image the blueprint could not read (CONFIRMED). No buyer's premium was found (CONFIRMED absence) |
| Recommendation | Transcribe the image into rulebook entries of type `commission_schedule` and publish them as text with a calculator (blueprint module 9). Keep a `buyers_premium` rule type at **0 %**: introducing a premium is a commercial decision for ABC, not a design default |
| Safe default | `commission_schedule` is a placeholder that **blocks payout calculation** until populated, so no seller is paid on a guessed rate. `buyers_premium = 0 %` |
| Owner | ABC Commercial |
| Blocks | Phase 1 gate ("one rulebook, no contradictions") and every payout |

### Q4. Do storage fees apply after the 48-hour collection window?

| | |
|---|---|
| Status | **Decision needed** |
| Evidence | 48 hours to collect is CONFIRMED. ABC's pages mention only resale, a Bad Bidder flag and deposit forfeiture; the storage-fee claim is *Reported*. BENCHMARK: Hammer and Tongues charges 1 % a day; Copart gives 3 free storage days |
| Recommendation | Rulebook entry `storage.fee` with `free_hours` and `daily_rate` (percentage of hammer or flat per lot, per category). Show the storage clock on the invoice either way (blueprint module 10) |
| Safe default | `storage.fee.enabled = false`. The storage clock still shows the collection deadline |
| Owner | ABC Operations |
| Blocks | Nothing. Changing the default is a rulebook edit |

### Q5. What do the three "Soon" seller screens do, and is the Android 10 limit real?

| | |
|---|---|
| Status | **Decision needed** (low impact) |
| Evidence | Both claims are *Reported* only |
| Recommendation | Largely superseded. The seller portal is built new (blueprint §9 build-or-buy: *Build*), and the product owner's requirement is that the replacement must not exclude Android 10 or below, whatever the current app does. The answer matters only for **migrating existing users** off the current app |
| Safe default | Native app minimum Android 7.0 (API 24); a PWA for anything older or for users who will not install |
| Owner | ABC Product |
| Blocks | Nothing |

### Q6. Which bidding engine does ABC run, and can its soft-close time, audit log and proxy rules be configured?

| | |
|---|---|
| Status | **Decision needed — critical gate** |
| Evidence | The blueprint could not see the engine (§9 build-or-buy: "Keep ABC's if proxy bidding, soft-close settings and an audit log can be configured. Otherwise rebuild"). Max bid with auto-bidding, a 10-minute extension and staggered ends are CONFIRMED features |
| Recommendation | Two-week technical discovery with ABC IT against three pass/fail tests: (1) proxy bidding with a secret ceiling, (2) soft-close duration configurable per auction, (3) an exportable, immutable bid log with server timestamps. In parallel, this repository builds a **reference engine** behind an `AuctionEngine` adapter, because a greenfield repository needs an engine to test the commit screen, limits and settlement against. If ABC's engine fails any test, the reference engine becomes the production engine |
| Safe default | Reference engine in use; adapter interface ready to wrap ABC's engine ([01 §7.4](01-solution-architecture.md#74-auctionengine-adapter)) |
| Owner | ABC IT with the System's tech lead |
| Blocks | Phase 2 gate. Without an answer the reference engine ships |

### Q7. Does holding customer balances in a wallet need regulatory authorisation?

| | |
|---|---|
| Status | **Decision needed — legal review required before Phase 3 goes live** |
| Evidence | Blueprint §9 risks table: "Confirm with counsel and the central bank first. A gateway-held or trust-account structure may avoid it (open question)" |
| Recommendation | Default to a **gateway-held or trust-account structure**: customer funds sit in a designated trust account or are held by the licensed gateway, never in ABC's operating account. The ledger records ABC's **obligations** to each customer; it does not issue e-money. To stay inside that structure: no peer-to-peer transfers between customers, no cash-out to a destination other than the original source (refund to source), no interest, deposits tied to auction participation. Counsel confirms the structure with the Reserve Bank of Zimbabwe before Phase 3 opens to the public |
| Safe default | Trust-account structure modelled in the chart of accounts ([02 §4](02-data-model.md#4-wallet-and-ledger)); P2P transfer is not built |
| Owner | Counsel |
| Blocks | Phase 3 public launch (not its build) |

### Q8. What data-protection duties apply to stored ID images and location data?

| | |
|---|---|
| Status | **Decision needed — counsel** |
| Evidence | ABC's iOS listing declares location data linked to the user, with no stated purpose (CONFIRMED). The blueprint flags Zimbabwe's data-protection law as an open question |
| Recommendation | ASSUMPTION, to be confirmed by counsel: the Cyber and Data Protection Act (2021) applies, with POTRAZ as the data-protection authority. Counsel to confirm controller licensing or registration, cross-border transfer rules (which decide hosting, A16), retention limits and breach-notification duties |
| Safe default | ID images in a separate encrypted store with every access logged and a stated purpose; ID numbers stored only as a keyed hash for uniqueness checks plus an encrypted copy; **no location collection** unless a purpose is stated in the app (e.g. delivery quote by address); retention periods as PROPOSED in [02 §9](02-data-model.md#9-personal-data-classification-and-retention) |
| Owner | Counsel |
| Blocks | Hosting decision (A16); production launch of ID capture |

### Q9. Which tax lines apply to which lots (levy, VAT, transfer tax), and who owns that table?

| | |
|---|---|
| Status | **Decision needed — finance** |
| Evidence | ABC's buyer pays VAT and a purchasing levy "where they apply" (CONFIRMED). BENCHMARK: Hammer and Tongues adds a 15 % purchaser's levy and 15.5 % VAT on the gross price, exempts Zimbabwe-registered second-hand vehicles from VAT, and notes the Intermediated Money Transfer Tax (IMTT) on deposits, payments and refunds |
| Recommendation | Finance owns an **effective-dated tax table** keyed by tax class (assigned per category, overridable per lot). Hammer and Tongues' figures are loaded as **benchmark placeholders, not ABC facts**. The IMTT rate, base and who bears it come from finance |
| Safe default | Tax rates are loaded **inactive**. A lot cannot go live until finance has published an active tax-table version covering its tax class, so no bidder ever sees an all-in price built on a guessed rate |
| Owner | ABC Finance |
| Blocks | Phase 1 gate and Phase 2 commit screen |

### Q10. Why does the main site refuse automated access, and does that also block search crawlers?

| | |
|---|---|
| Status | **Decision needed** |
| Evidence | The corporate site refused the blueprint author's fetcher, and the bidding app returns only a loading screen without JavaScript (Inferred, blueprint gap 10) |
| Recommendation | ABC IT audits its WAF / bot rules. The new System renders catalogue and lot pages on the server, publishes a sitemap and structured data, and allow-lists verified search crawlers while still rate-limiting scrapers |
| Safe default | Server-side rendering plus crawler allow-list in the new System |
| Owner | ABC IT |
| Blocks | Phase 2 SEO measures; domain consolidation (blueprint principle 10) |

---

## Part B — Assumptions introduced by this design

| # | Assumption | Status | Safe default / note | Owner |
|---|---|---|---|---|
| A11 | The build is greenfield with no access to ABC's systems, data or engine. Migration of existing accounts, lots and history is out of scope until access exists | ASSUMPTION | Import interfaces designed; no migration built | Product owner |
| A12 | Spending limits are calculated **per currency**. A USD deposit does not fund ZiG bids, and vice versa | **Decision needed** | Per-currency limits. A rulebook entry `limit.cross_currency_reference_rate` may later publish a limit-only reference rate. It is never used for settlement, which always happens in the lot's currency (blueprint §7) | ABC Finance |
| A13 | Money is stored as signed 64-bit integer minor units plus an ISO 4217 code: `USD` and `ZWG` (ZiG), both with 2 decimal places. Floats are never used for money | ASSUMPTION | Confirm ZWG minor-unit practice with finance | Tech lead |
| A14 | The trust-tier table and limit-composition formula in [02 §6](02-data-model.md#6-account-tiers-and-limit-composition) | PROPOSED | The blueprint gives the 10× multiplier and the $100 / $500 verification limits (CONFIRMED) but no tier table. All other values are proposed rulebook entries | ABC Commercial |
| A15 | Two-person approval applies to staff overrides above **USD 500** (ZiG threshold set by finance) | **Decision needed** | The blueprint proposes two-person approval "above a set amount" with no figure. USD 500 equals the full-verification limit, so any override larger than what a fully verified newcomer may bid needs a second person | ABC Finance |
| A16 | Production hosting in AWS `af-south-1` (Cape Town) | **Decision needed** | Depends on Q8's cross-border transfer answer. The architecture is cloud-portable (containers, Postgres, S3-compatible storage) | Counsel / ABC IT |
| A17 | Payment gateways: Paynow as primary, ContiPay as failover (both named in the blueprint). Pesepay held as an alternative | PROPOSED | Commercial terms, settlement accounts and per-transaction limits to be confirmed | ABC Finance |
| A18 | Vehicle title agencies (ZRP, ZIMRA, CVR) expose **no API**. Title steps are tracked manually by staff, with evidence uploads | ASSUMPTION | Title tracker built as a staff workflow | ABC Vehicle Sales |
| A19 | Peak load for capacity planning: 2,000 concurrent bidders, 50 bids per second at a staggered close, 5,000 live lots | ASSUMPTION | No ABC traffic figures exist; the Android app's 100,000+ installs (CONFIRMED) is the only reach signal. Re-baseline in Phase 1 | Tech lead |
| A20 | Rules in force **when an auction opens** govern bidding in that auction (increments, soft close, limits). Tax and fee rates in force **at the hammer** are frozen into the invoice (blueprint §8: "Invoices freeze the rates used at close") | PROPOSED | Rulebook versions are pinned per auction at opening ([02 §3](02-data-model.md#3-module-ownership-and-schemas)) | Product owner |
| A21 | Spending-limit exposure is counted at the bidder's **proxy ceiling** (all-in), not the current price, because the engine may execute up to the ceiling without further consent | PROPOSED | Rulebook entry `limit.exposure_basis = proxy_ceiling`; alternative `current_price` | ABC Commercial |
| A22 | No second-chance offer to the under-bidder after a default unless ABC enables it | PROPOSED | Not offered after a default. The blueprint's reserve-not-met branch does include "offer to top bidder" (`reserve.offer_window_hours`) | ABC Operations |
| A23 | ABC's bid-increment table and soft-close trigger window are not in the blueprint | **Decision needed** | Placeholder USD ladder (US$1 under US$50 up to US$250 above US$20,000) and a 10-minute trigger window, both tagged assumption in the rulebook. No ZiG ladder, so ZiG auctions cannot open | ABC Operations |
| A24 | Delivery towns and prices: the town list conflicts (nine or seven, gap 6) and prices are not published | **Decision needed** | `delivery.rate_card` empty, so quotes are collection-only until operations publishes towns and prices | ABC Operations |
| A25 | Timing of the default ladder | PROPOSED | Warning when the 48-hour window ends; deposit forfeit, relist fee and tier drop 24 hours later. The order comes from blueprint module 7 | ABC Operations / Risk |
| A26 | Relist fee amount | **Decision needed** | 10 % of hammer, minimum US$10 (PROPOSED); the blueprint names the fee but no amount | ABC Commercial |
| A27 | Minimum deposit per category | **Decision needed** | Hammer and Tongues' US$500 goods / US$3,000 vehicles as BENCHMARK placeholders | ABC Risk |
| A28 | Minimum photo set for goods | PROPOSED | 4 photos per lot (vehicles 35, D2). Blueprint principle 6 gives no number | ABC Operations |
| A29 | Rounding of fees and taxes | PROPOSED | Each line rounded half up to the cent; the total is the sum of the lines ([04 §4](04-fee-tax-engine.md#4-rounding)) | ABC Finance |

---

## Part C — Differences between the build brief and the blueprint (resolved)

The product owner approved these resolutions on 2026-10-06.

| # | Build brief says | Blueprint says | Resolution |
|---|---|---|---|
| D1 | Condition vocabulary: State = New / New–Open Box / Used / Renewed; Condition = As Is, Working, Untested, Partly Working, Damaged, Broken, Incomplete, Sealed Packing, Not Working | Lists "New, Used, As Is, Untested, Not Working and others" (CONFIRMED, module 11) | Use the brief's fuller list, treated as ABC's glossary. **ABC to confirm the list matches its help desk.** Vocabulary is stored as seed data, not an enum, so additions are a data change |
| D2 | Vehicle inspection: minimum 35 photos plus video | 35 photos is a Ritchie Bros BENCHMARK, not an ABC rule | Rulebook `vehicle.inspection.min_photos = 35`, tagged PROPOSED |
| D3 | Deposit multiplier "tier-adjusted per blueprint table" | No tier/multiplier table exists | Table proposed in [02 §6](02-data-model.md#6-account-tiers-and-limit-composition) (A14) |
| D4 | WhatsApp templates in Phase 5 | "WhatsApp alerts" are in Phase 2 (Informed bids) | The template library and outbid / won / invoice alerts ship in Phase 2; the full communications layer (preference centre, all templates, fallbacks) completes in Phase 5 |
| D5 | QR gate pass in Phase 3 | "Collection QR" is in Phase 5 (Reach) | A basic QR pass is issued on payment in Phase 3; slot booking and bundling come in Phase 5 |
| D6 | Soft-close A/B plan in Phase 2 | "Soft-close test" is in Phase 5 | Plan written and soft-close made configurable per auction in Phase 2; the test runs in Phase 5 |
| D7 | Two-person approval above a configurable amount | Proposed, no figure | See A15 |

---

## Change log

| Date | Change |
|---|---|
| 2026-10-06 | Register created. All defaults adopted by the product owner. Q1–Q10, A12, A15, A16 remain open with their owners |
| 2026-10-06 | Phase 1: added A23–A29 found while transcribing the rule set ([03 §10](03-rulebook-service.md#10-the-initial-rule-set)). Every placeholder is tagged in `rulebook/initial-rule-set.json` and must be acknowledged before a rule set is published |
