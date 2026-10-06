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
| A20 | The rule set in force **when an auction opens** governs that auction end to end: increments, soft close, limits **and the fees on its invoices**, so the commit screen and the bill always use the same rules. **Tax rates** in force **at the hammer** are frozen into the invoice (blueprint §8: "Invoices freeze the rates used at close"). *Corrected in Phase 3:* the first version said invoices use the rule set active at the hammer, which could make the bill disagree with the commit screen if rules changed mid-auction | PROPOSED | Rulebook versions are pinned per auction at opening ([02 §3](02-data-model.md#3-module-ownership-and-schemas)) | Product owner |
| A21 | Spending-limit exposure is counted at the bidder's **proxy ceiling** (all-in), not the current price, because the engine may execute up to the ceiling without further consent | PROPOSED | Rulebook entry `limit.exposure_basis = proxy_ceiling`; alternative `current_price` | ABC Commercial |
| A22 | No second-chance offer to the under-bidder after a default unless ABC enables it | PROPOSED | Not offered after a default. The blueprint's reserve-not-met branch does include "offer to top bidder" (`reserve.offer_window_hours`) | ABC Operations |
| A23 | ABC's bid-increment table and soft-close trigger window are not in the blueprint | **Decision needed** | Placeholder USD ladder (US$1 under US$50 up to US$250 above US$20,000) and a 10-minute trigger window, both tagged assumption in the rulebook. No ZiG ladder, so ZiG auctions cannot open | ABC Operations |
| A24 | Delivery towns and prices: the town list conflicts (nine or seven, gap 6) and prices are not published | **Decision needed** | `delivery.rate_card` empty, so quotes are collection-only until operations publishes towns and prices | ABC Operations |
| A25 | Timing of the default ladder | PROPOSED | Warning when the 48-hour window ends; deposit forfeit, relist fee and tier drop 24 hours later. The order comes from blueprint module 7 | ABC Operations / Risk |
| A26 | Relist fee amount | **Decision needed** | 10 % of hammer, minimum US$10 (PROPOSED); the blueprint names the fee but no amount | ABC Commercial |
| A27 | Minimum deposit per category | **Decision needed** | Hammer and Tongues' US$500 goods / US$3,000 vehicles as BENCHMARK placeholders | ABC Risk |
| A28 | Minimum photo set for goods | PROPOSED | 4 photos per lot (vehicles 35, D2). Blueprint principle 6 gives no number | ABC Operations |
| A29 | Rounding of fees and taxes | PROPOSED | Each line rounded half up to the cent; the total is the sum of the lines ([04 §4](04-fee-tax-engine.md#4-rounding)) | ABC Finance |
| A30 | Proxy details: the price jumps to the reserve as soon as a maximum covers it (which reveals roughly where the reserve is), and only bids that change the price or leader extend the closing time | PROPOSED | `bidding.price_jumps_to_reserve = true`, `bidding.extend_on = price_or_leader_change` ([07 §3–4](07-bidding-engine.md#3-proxy-bidding)) | ABC Commercial |
| A32 | The Paynow adapter is written from Paynow's public integration format but has not been run against Paynow's sandbox from this repository | **Decision needed** (verification) | Not registered in production until it passes sandbox tests in USD and ZiG ([09 §3](09-payments.md#3-the-gateway-abstraction)) | Tech lead |
| A33 | ContiPay is the failover gateway, but no adapter is built because its API documentation and sandbox are not available here | **Decision needed** | No failover gateway in production until built; routing skips unregistered gateways | ABC Finance / tech lead |
| A34 | Deposits count **account-wide** per currency towards the spending limit, wherever they were placed; deposit-required auctions still need their own minimum deposit to join | PROPOSED | As implemented in `RegistrationService.limit` ([10 §4](10-registration-limits.md#4-limits)) | ABC Risk |
| A35 | Every payment from outside lands in the wallet as a top-up; invoices are paid from the wallet. An "EcoCash invoice payment" is top-up then pay, in one flow on the phone | PROPOSED | One crediting path ([09 §2](09-payments.md#2-one-path-for-money-in)) | Product owner |
| A36 | Seller payouts are sent by finance (bank or mobile money) and marked paid in the System, which posts the ledger journal; gateway payout APIs are a later automation | PROPOSED | Manual payout marking ([08 §7](08-wallet-ledger.md#7-payouts)) | ABC Finance |
| A37 | Vehicle inspection checklist `vehicle-v1` (29 items, 11 marked material) | PROPOSED | As in [13 §3](13-vehicle-module.md#3-inspection-report-on-a-standard-checklist); versioned so ABC can revise it | ABC Vehicle Sales |
| A38 | A gross inaccuracy is a differing chassis or engine number, an odometer off by more than 10 %, or a failing material item that the report called fine | PROPOSED | Rule `vehicle.odometer_tolerance_bp = 1000` ([13 §4](13-vehicle-module.md#4-the-gross-inaccuracy-remedy)) | ABC Commercial / counsel |
| A39 | No commission consignment note can be signed until commission is published (a consequence of Q3), so no seller signs "to be confirmed" terms | PROPOSED | `CommissionNotPublishedError` ([12 §3](12-seller-portal.md#3-consigning-and-the-consignment-note)) | ABC Commercial |
| A40 | Valuation ranges are the middle half (25th to 75th percentile) of at least 5 comparable sales in the last 12 months | PROPOSED | Rule `seller.valuation_min_comparables = 5` ([12 §4](12-seller-portal.md#4-valuation-range)) | ABC Operations |
| A41 | Development and staging databases may hold **demo data**: a rule set labelled `-demo` with an illustrative 10 % commission (Q3) and the initial rule set's tax rates activated (Q9), plus demo accounts, a vehicle auction and bids. Every such value is labelled "DEMO ONLY" where it is stored. The seed refuses `APP_ENV=production` and never changes the rulebook once a real rule set is published. Because the ledger and audit log are append-only, demo data is removed only by `db reset` (drops every System schema) | PROPOSED | `apps/api/src/demo/seed.ts`, `pnpm db:reset` ([14 §5](14-apps-and-environments.md#5-demo-data)) | ABC Product |
| A42 | Until the identity module ships (email and phone OTP, KYC), development and staging may sign in as a demo bidder (`DEMO_SIGN_IN=1`). The session token and every check after sign-in are the production ones; the switch is refused in production | PROPOSED | [14 §3](14-apps-and-environments.md#3-sessions-and-sign-in) | ABC Product / security |
| A50 | Collection slots are 30 minutes with 6 buyers each, bookable up to 7 days ahead, cut from the CONFIRMED branch hours in Central Africa Time (UTC+2, no daylight saving); reminders go 24 h and 2 h before the slot | PROPOSED | Rules `logistics.collection_slot`, `logistics.slot_reminder_hours` ([15 §3](15-logistics.md#3-collection-slots)) | ABC Operations |
| A51 | If storage is switched on (Q4), each day or part day after the free period costs `storage.daily_rate_bp` of the hammer of every lot still in store, using the invoice's pinned rule set; it is charged once, from the wallet, before the goods leave | PROPOSED | `storage.enabled = false`, so nothing is charged; the clock shows the deadline ([15 §5](15-logistics.md#5-the-storage-clock)) | ABC Operations / Finance |
| A52 | One courier trip carries a whole collection, priced as the single most expensive lot delivery from `quoteLot` at the buyer's declared size; charged from the wallet at booking and refunded in full if cancelled before pickup. ABC pays couriers outside the System | PROPOSED | Rate card empty until A24 is answered, so delivery shows as unavailable ([15 §6](15-logistics.md#6-door-delivery-not-vehicles)) | ABC Operations / Finance |
| A53 | An open claim holds the seller's whole payout for that invoice until decided. A full refund returns everything the invoice charged for the lot (hammer, premium, taxes, delivery on the invoice), with ABC's commission reversed; storage and delivery charges booked later are not refunded | PROPOSED | As described ([17 §3, §6](17-support-disputes.md#6-refunds-payouts-and-clawbacks)) | ABC Commercial / counsel |
| A54 | If the seller was already paid when a claim is upheld, ABC fronts the refund from platform suspense and recovers the seller's share from their next payouts in that currency; the lot may then move `paid_out → refunded` | PROPOSED | Clawback recorded and recovered automatically; until then the safeguarding check shows the gap for finance to fund ([17 §6](17-support-disputes.md#6-refunds-payouts-and-clawbacks)) | ABC Finance |
| A55 | Refunds above US$500 need a second staff approver (same figure as A15); with no ZiG figure, every ZiG refund needs one. A refund on a vehicle inspection claim needs a qualifying gross-inaccuracy assessment (A38) | **Decision needed** | Rule `dispute.refund_second_approver_threshold` ([17 §5](17-support-disputes.md#5-decisions-and-remedies)) | ABC Finance / Commercial |
| A56 | Support targets in clock hours: first response 1 / 4 / 8 / 24 h and resolution 8 / 24 / 72 / 120 h for urgent / high / normal / low; a claim gets an owner within 24 h and a decision within 120 h | PROPOSED | Rules `support.ticket_targets`, `dispute.decision_target_hours`; breaches flagged by the worker ([17 §7](17-support-disputes.md#7-support-tickets)) | ABC Operations |
| A57 | Staff permissions follow one matrix of actions by role (ops, finance, risk, support, cashier, vehicle desk, admin, auditor). The auditor reads everything and changes nothing; anything not listed for a role is refused | PROPOSED | `PERMISSIONS` in `packages/admin/src/permissions.ts` ([18 §3](18-admin-operations.md#3-staff-authorisation)) | ABC Operations / security |
| A58 | Overrides with no money amount (tier changes, tax rate activation) and all reconciliation write-offs always need a second person; an amount in a currency with no threshold set also needs two; an unapproved request lapses after 72 hours | PROPOSED | Rule `override.request_expiry_hours = 72` ([18 §4](18-admin-operations.md#4-overrides-and-two-person-approval)) | ABC Risk |
| A59 | The person who publishes a rule set must hold the owning role of every rule that changed against the version in force (product-owned rules need admin), or be an admin; that same person acknowledges each warning by name; publication cannot be back-dated; superseded versions are retired | PROPOSED | [18 §5](18-admin-operations.md#5-rule-set-publication-and-tax-rates); the 7-day notice period (docs/03 §5) is not yet checked automatically | ABC Product |
| A60 | Bid anomaly thresholds: a bidder on 3 or more of one seller's closed lots in 90 days who won none; 3 or more accounts that bid in 30 days sharing a device or network (IPv4 /24, IPv6 /48) | PROPOSED | Rules `risk.bid_up_pattern`, `risk.shared_signal_pattern` (internal, not published) ([18 §6](18-admin-operations.md#6-risk-console)) | ABC Risk |
| A61 | Reconciliation tolerance is zero (exact match). Only shortfalls (money credited that a gateway will never settle) may be written off, to a new `write_off` expense account, by two finance people; surpluses belong to payers and are matched or credited | **Decision needed** | Rule `payments.reconciliation_tolerance = {USD: 0, ZWG: 0}` ([18 §7](18-admin-operations.md#7-reconciliation-queue)) | ABC Finance |
| A62 | Waiving a deposit forfeit on appeal returns the deposit, but the unpaid invoice stays cancelled and the lot relisted. A waiver after a step ran reverses it with ledger journals (or restores the previous tier); the case closes as `waived` when every waivable step is waived | PROPOSED | [18 §8](18-admin-operations.md#8-default-appeals-and-waivers) | ABC Operations / Risk |
| A63 | Analytics definitions: "time to" cohorts by start event; "in the app" means not branch cash; default means the forfeit stage; recovery means sold again and paid; the branch is the auction's branch | PROPOSED | [19 §2–3](19-analytics.md#2-the-measures) | ABC Product |
| A64 | Until the support module ships, ticket measures are read from outbox events `ticket.opened` and `ticket.first_reply` (branch from the event payload) and are NULL, not zero, while no such event exists | PROPOSED | [19 §6](19-analytics.md#6-support-measures-before-the-support-module) | ABC Product / support build |
| A43 | The WhatsApp Cloud API adapter is written from Meta's public documentation (template messages, X-Hub-Signature-256 webhooks, the verify-token handshake) but has not been run against Meta from this repository. Every template must be approved by Meta under its provider name, and the sign-in code as an AUTHENTICATION template | **Decision needed** (verification) | Fake channel in development; not registered in production until it passes a test on a real WhatsApp Business number ([16 §5](16-communications.md#5-channels-and-fallback)) | Tech lead / ABC Product |
| A44 | No SMS aggregator has been chosen. The generic HTTP SMS adapter (configurable fields, HMAC-signed delivery reports) is untested against any provider. SMS is always one GSM-7 segment of 160 characters | **Decision needed** | SMS fallback absent in production until an aggregator is configured and tested ([16 §5](16-communications.md#5-channels-and-fallback)) | ABC IT / ABC Finance |
| A45 | Quiet hours are 21:00–07:00 Harare time. WhatsApp, SMS and push messages wait until 07:00, except sign-in codes, chat replies and alerts for lots that close before 07:00. Email and the in-app feed are never held | ASSUMPTION | Rule `comms.quiet_hours` ([16 §7](16-communications.md#7-quiet-hours)) | ABC Product |
| A46 | A channel may be used only with a recorded legal consent for it (`identity.contact_consent`; no row means no consent), taken at sign-up. Sign-in codes and replies in a chat the person started are sent without prior consent, because the person asked. Marketing also needs its preference switched on | **Decision needed** (counsel, with Q8) | As described; consent recorded per channel at sign-up ([16 §6](16-communications.md#6-preferences-and-consent)) | Counsel |
| A47 | One-time codes: 6 digits, valid 10 minutes, 5 wrong tries, resend after 60 seconds, the same code sent at most 3 times, 5 new codes per contact and 20 per network per hour. Codes are never stored: an HMAC-derived code is re-derived at send time. Zimbabwe numbers typed locally (0 77…) become +263; only Zimbabwe mobile prefixes 71, 73, 77, 78 can receive codes | PROPOSED | Rules `identity.otp_*` ([16 §9](16-communications.md#9-sign-in-by-one-time-code)) | ABC Risk |
| A48 | Default message settings (outbid by WhatsApp, push and SMS; ending soon by WhatsApp and push; everything about money and goods on every channel; marketing off). Transactional messages also go by email for the record. No push or email provider is chosen yet, and push tokens are not stored | ASSUMPTION | Rule `comms.preference_defaults`; push and email not registered in production until configured ([16 §6](16-communications.md#6-preferences-and-consent)) | ABC Product / ABC IT |
| A49 | WhatsApp intake starts when someone whose verified phone is the chat number sends SELL. A chat consignment lands at the Harare branch as a draft lot with item state "used" and starting bid 0, for intake staff to complete; photos stay as WhatsApp media ids until staff fetch them | PROPOSED | `WHATSAPP_INTAKE_BRANCH=HRE`; nothing goes live from chat ([16 §10](16-communications.md#10-whatsapp-intake)) | ABC Operations |
| A31 | Until the registration and limits service ships (Phase 3), the commit screen's limit line uses whatever limit ABC's current system can provide through the integration; the server still enforces a limit | ASSUMPTION | Limit line hidden if no source is available ([06 §3](06-commit-screen.md#3-behaviour-as-the-bidder-types)) | Tech lead / ABC IT |

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
| 2026-10-06 | Phase 5: added A50–A56 with the logistics module (deliverable 15) and support and disputes (deliverable 17) |
| 2026-10-06 | Deliverables 18 and 19: added A57–A64 with the admin and operations services and analytics |
| 2026-10-06 | Deliverable 16: added A43–A49 with the communications layer and sign-in by one-time code ([16](16-communications.md)) |
| 2026-10-06 | Apps layer: added A41 (demo data) and A42 (demo sign-in) with the API, worker and web app |
| 2026-10-06 | Register created. All defaults adopted by the product owner. Q1–Q10, A12, A15, A16 remain open with their owners |
| 2026-10-06 | Phase 4: added A37–A40 with the seller portal and vehicle module |
| 2026-10-06 | Phase 3: corrected A20 (invoices use the auction's pinned rule set, so the bill always matches the commit screen); added A32–A36 |
| 2026-10-06 | Phase 2: added A30–A31 with the bidding engine and commit screen specs |
| 2026-10-06 | Phase 1: added A23–A29 found while transcribing the rule set ([03 §10](03-rulebook-service.md#10-the-initial-rule-set)). Every placeholder is tagged in `rulebook/initial-rule-set.json` and must be acknowledged before a rule set is published |
