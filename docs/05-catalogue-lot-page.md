# 05 — Catalogue and Lot Page

| | |
|---|---|
| Phase | 2 — Informed bids (deliverable 6) |
| Source of truth | Blueprint §6 module 4, principles 1, 6 and 7, gaps 2, 4 and 10, §7 (data costs, two currencies); [00 Assumptions register](00-assumptions-register.md) Q10, A28 |
| Code | [`packages/catalogue`](../packages/catalogue/src): `checkListingReadiness`, `lotStructuredData`, `matchesSavedSearch` · bid history: [`packages/engine/src/history.ts`](../packages/engine/src/history.ts) |
| Related | [06 Commit screen](06-commit-screen.md) · [07 Bidding engine](07-bidding-engine.md) · [02 Data model](02-data-model.md) (`catalogue.*`) |

## 1. Purpose

Blueprint principle 6: **evidence for goods unseen.** *"Every lot carries a standard photo set and a condition statement drawn from a fixed vocabulary."* Principle 1: **inform before binding.** The lot page is where a bidder decides whether to commit, so it must show four things before any bid:
- the all-in price
- the condition evidence
- the time left, by server time
- the rules in force

The Phase 2 gate is **"all-in price on every lot"**. That gate is enforced in code: a lot that can't show an all-in price can't go live (§4).

**Acceptance test.** Bidders know what they are buying and what it will cost, which lowers regret. Crawlable, shareable lot pages bring more bidders per lot, which the blueprint ties to better hammer prices and so a shorter time to cash for sellers.

## 2. Structured lot data

Every lot is structured data in `catalogue.lot` and its child tables, never free text alone ([02 §1](02-data-model.md#1-the-twelve-entities-and-where-they-live)).

| Field | Required | Set by | Notes |
|---|---|---|---|
| Lot reference (`HRE-26-004512`) | Yes | System | Stable public URL `/lots/{lotRef}` |
| Title | Yes, ≥ 5 characters | Intake staff / seller | What it is: make, model, size |
| Description | Yes, ≥ `catalogue.min_description_chars` (40) | Intake staff / seller | Specifications, accessories, known history |
| Category | Yes | Intake staff | Drives tax class, deposit rule, photo set and vehicle flag |
| Item state | Yes, fixed vocabulary | Intake staff | New · New–Open Box · Used · Renewed |
| Condition | Yes, fixed vocabulary | Intake staff | See §3 |
| Condition notes | Required for conditions with faults | Intake staff | Each fault, written down |
| Photos and video | Minimum set per category | Intake staff / seller app | See §5 |
| Location (branch) | Yes | System | Harare or Bulawayo today (CONFIRMED) |
| Viewing times | Optional | Operations | Viewing times per lot are CONFIRMED today; bookable slots for vehicles come in deliverable 14 |
| Settlement currency | Yes | Intake staff / institutional seller | USD or ZiG; fixed once the lot is in an auction (database foreign key) |
| Starting bid, reserve, estimate | Starting bid yes; reserve and estimate optional | Seller with staff | The reserve is never shown; only its status (§6.3) |
| Vehicle details and inspection report | Vehicles only | Vehicle desk | Chassis and engine numbers, document status; report spec in deliverable 14 |

## 3. Condition vocabulary

The vocabulary is seed data (`db/seed.sql`), not free text (D1: ABC to confirm the list matches its glossary). The lot page shows each term **with its definition**, so "Untested" can never be read as "Working".

| Item state | Definition shown to bidders |
|---|---|
| New | Unused, in original packaging. |
| New – Open Box | Unused, but the packaging has been opened. |
| Used | Previously used. |
| Renewed | Previously used and restored to working order. |

| Condition | Definition shown to bidders | Fault photo and notes required |
|---|---|---|
| As Is | Sold in its current state with no claim about condition or function. | — |
| Working | Tested and working at intake. | — |
| Untested | Not tested. Function unknown. | — |
| Partly Working | Some functions work; faults are described in the notes. | Yes |
| Damaged | Visible damage, described and photographed. | Yes |
| Broken | Does not work because of physical damage. | Yes |
| Incomplete | Parts or accessories are missing, listed in the notes. | Yes |
| Sealed Packing | In unopened sealed packing; contents not inspected. | — |
| Not Working | Tested and does not work. | — |

The conditions needing fault evidence are a rule (`catalogue.defect_photo_conditions`, PROPOSED). Each term will carry a **remedy class** in deliverable 17, tying "not as described" claims to the vocabulary (blueprint module 12). For example, a lot listed *Working* that does not work at collection supports a claim; a lot listed *As Is* or *Untested* does not support a claim about function.

## 4. Listing readiness: the gate

`checkListingReadiness` runs whenever a lot is saved, and again when its auction is scheduled and opens. A lot with any **blocker** cannot move from `listed` to `live`. Staff see the blockers in plain language on the intake screen.

| Check | Code | Rule / source |
|---|---|---|
| Title of at least 5 characters | `title_missing` | — |
| Description at least the minimum length | `description_too_short` | `catalogue.min_description_chars` |
| Item state and condition from the fixed vocabulary | `unknown_item_state`, `unknown_condition` | Module 11 |
| Notes for each fault, where the condition requires them | `condition_notes_required` | `catalogue.defect_photo_conditions` |
| At least the minimum number of photos (4 for goods, 35 for vehicles) | `too_few_photos` | `catalogue.min_photos` |
| Every required angle present | `missing_photo_roles` | `catalogue.required_photo_roles` |
| A photo of each fault, where the condition requires one | `defect_photo_missing` | `catalogue.defect_photo_conditions` |
| **An all-in price can be computed** at the starting bid | `all_in_price_unavailable` | `QuoteService`; tax rates active (Q9) |
| An increment ladder exists in the lot's currency | `bidding_not_open_in_currency` | `bidding.increment_ladder` |
| Vehicles: details with chassis number | `vehicle_details_missing` | Module 8 |
| Vehicles: published inspection report, enough photos, video, chassis checked | `inspection_missing`, `inspection_too_few_photos`, `inspection_video_missing`, `inspection_chassis_unverified` | Module 8; `vehicle.require_video` |
| *Warning:* reserve at or below the starting bid has no effect | `reserve_below_starting_bid` | — |

With the initial rule set, **every lot is blocked by `all_in_price_unavailable`**, because finance has not activated tax rates (Q9). That is intended: no lot goes live on guessed tax. ZiG lots are also blocked by the missing ZiG ladder (A23). All of this is tested in `packages/catalogue/src/catalogue.test.ts`.

## 5. Photos and lite mode

| Standard | Value | Status |
|---|---|---|
| Goods: minimum photos | 4, including *the whole item* and *the label, model or serial number* | PROPOSED (A28) |
| Vehicles: minimum photos | 35, including front, rear, both sides, front and rear interior, dashboard with odometer, engine bay, chassis plate, tyres, boot | BENCHMARK count (D2); angles PROPOSED |
| Faults | One photo per fault, role `defect` | PROPOSED |

**Processing** (blueprint §7: data is costly):

- Every upload is re-encoded into WebP variants: **320 px thumbnail (target ≤ 25 KB)**, 800 px (≤ 90 KB) and 1,600 px. The original is kept privately for disputes.
- **All EXIF metadata is stripped**, including GPS location. Photos taken at a seller's home must not publish where they live, which also matters for Q8.
- **Lite mode** (on by default on slow connections, and switchable) shows thumbnails only and loads larger images on tap. Video never autoplays.
- Images are lazy-loaded and served from the CDN with long cache lifetimes, because variants are immutable.

## 6. The lot page

Mobile first, 320 px wide upwards, readable on a mid-range Android phone in lite mode.

```
┌──────────────────────────────────────┐
│ ◀ Auction HRE-26-11 · Lot 42         │
│ Dell Latitude 5420 laptop            │
│ [photo strip: 320 px thumbnails]     │
│                                      │
│ Current bid      US$85.00            │
│ All-in at this bid  about US$110.93  │  ← quoteLot(current price)
│ Reserve met · 7 bids · 3 bidders     │
│ Ends 18:42:10 (server time) · 12m 4s │
│ You are leading · your max US$200.00 │  ← only to the bidder
│ [ Bid ]   [ Watch ]                  │
│                                      │
│ Condition: Used · Working            │
│   "Tested and working at intake."    │
│   Notes: small scratch on the lid.   │
│ Location: Harare branch              │
│ Viewing: Thu 9:00–15:00              │
│ Collect within 48 h of paying, or    │
│   delivery to Harare from US$5.00    │
│ Bid history (newest first)           │
│   Bidder 1  US$85.00  auto           │
│   Bidder 2  US$80.00                 │
│ Rules in force: version 2026.11-r1 › │
│ Similar lots sold: US$70–US$140 ›    │
└──────────────────────────────────────┘
```

### 6.1 Price block

- **Current bid** in the lot's settlement currency. With no bids yet: "Starting bid US$50.00".
- **All-in at this bid**: `quoteLot` at the current price, using the auction's pinned rule version and the current tax rates. It is labelled "about" because delivery depends on the bidder's choice; tapping it opens the line-by-line breakdown.
- **The other currency** appears only if `fx.indicative_display.enabled`, labelled "approximately ZiG …" and never used for bidding (blueprint §7). Off by default.
- The amount shown is never computed on the client alone. The server renders the figure, and live updates arrive through the realtime channel ([07 §7](07-bidding-engine.md#7-realtime-updates-and-reconnecting)).

### 6.2 Time

- "Ends 18:42:10 (server time)" plus a countdown driven by the measured server-clock offset, never the device clock.
- When a soft-close extension happens, the new end time is shown with a short note: "Extended: a bid came in near the end."
- Staggered closing: lot pages within an auction show their own end time; the auction page lists lots in closing order.

### 6.3 Reserve status

| Status | Copy |
|---|---|
| No reserve | "No reserve: the highest bid wins." |
| Not met | "Reserve not yet met." |
| Met | "Reserve met: the highest bid will win." |

The reserve amount is never shown. Because the price jumps to the reserve when a maximum covers it (`bidding.price_jumps_to_reserve`, PROPOSED), the moment the reserve is met reveals roughly where it was. That trade-off is accepted because the indicator stays truthful; it is listed as A30.

### 6.4 Your status

Shown only to the signed-in bidder: leading, with their (secret) maximum; outbid, with the minimum next bid; or not bidding. Their limit appears on the commit screen, not on the lot page.

### 6.5 Bid history

`publicHistory` shows amounts and times, newest first. Bidders appear as "Bidder 1, 2, …" and the viewer as "You". Auto-bids are marked "auto", and maximums are never shown. Rejected attempts are not listed publicly but stay in the immutable log.

### 6.6 Rules and evidence links

- A link to the rule set version pinned by this auction (`GET /rulebook/{label}`, [03 §7](03-rulebook-service.md#7-read-interface)), so the bidder can check exactly which rules apply.
- Vehicles: the inspection report (deliverable 14) sits above the bid button, not behind a tab.
- **Similar lots sold**: realised prices from the past-results archive (§9).

## 7. Catalogue, search and crawlability

| Page | URL | Content |
|---|---|---|
| Auction | `/auctions/{code}` | Lots in closing order, filters, auction rules (soft close, deposit needed) |
| Category | `/c/{category}` | Live and upcoming lots, newest auctions first |
| Search | `/search?q=…` | Keyword search with filters: category, branch, currency, price band, item state, condition |
| Lot | `/lots/{lotRef}` | §6 |
| Realised prices | `/sold/{category}` | §9 |

- **Server-side rendering** for every public page. The HTML carries the lot's facts, so search engines and WhatsApp link previews see them without JavaScript (gap 10, Q10).
- **JSON-LD** from `lotStructuredData`: schema.org `Product` with an `Offer` in USD or ZWG, with `availabilityEnds` set to the lot's end time and the item condition mapped from the vocabulary (damaged, broken and not-working lots marked `DamagedCondition`).
- **Open Graph** tags (title, first photo, current bid, end time), so a lot shared on WhatsApp shows a useful preview card.
- A **sitemap** per auction and category; canonical URLs; `robots.txt` allows search crawlers; scrapers are rate-limited.
- **Caching:** lot HTML is cached at the CDN for 30 seconds (PROPOSED). The price block updates live through the realtime channel, so a cached page never shows a stale price for long.
- **Search** starts with PostgreSQL full-text search over title, description and category. At A19's 5,000 live lots that's enough; a dedicated search service is a later decision if needed.

## 8. Watch list, saved searches and alerts

- **Watch list.** A heart on every lot card and on the lot page saves the lot to `catalogue.watch` (one row per person and lot; personal and reversible, so not audited). Watchers get the ending-soon alert as well as bidders; someone who watched but has not bid gets the watch-list version of the message (docs/16). `GET/PUT/DELETE /me/watch[/:ref]`; lot cards and the lot page carry `viewer.watching`. The account's Watching page lists live watched lots first, then the ones that closed.
- **Saved searches.** "Save this search" on the docket stores the docket's own filter (the same query-string parameters as `GET /lots`, parsed by `apps/api/src/lots/filters.ts`) in `catalogue.saved_search`, one name per person, up to 20 per account (PROPOSED). `GET/PUT/PATCH/DELETE /me/saved-searches`.
- **Alerts.** Lots already on the page when a search is saved are recorded as seen, so they are not news. A worker step then runs each search with alerts on, records new matches in `catalogue.saved_search_hit` and raises one `saved_search.matched` event per batch, in the same transaction: a lot is named at most once per search, however often the step runs (R4). Messages use the `saved_searches` preference category (default: app notification and email, A65).
- Because alerts run the docket's own filter, an alert never names a lot the saved link would not show. The `matchesSavedSearch` function in `packages/catalogue` (keywords, category trees, a price limit compared only within its own currency) remains for the richer query shape this table was designed for; the web docket does not yet offer those filters.

## 9. Past realised prices

- Public, as the blueprint requires: `catalogue.v_realised_price` exposes lot reference, title, category, state, condition, branch, currency, hammer price and date. It never exposes buyer or seller.
- Shown on lot pages as "Similar lots sold" (same category, last 12 months, same currency) and on archive pages by category.
- Sellers' valuation ranges in the seller portal (deliverable 13) draw on the same archive.

## 10. Accessibility and resilience

- Readable at 320 px, base font 16 px, contrast to WCAG AA, and states never shown by colour alone. Countdown and price changes are announced through an ARIA live region.
- The page works on a slow 3G connection: under 150 KB for first render in lite mode (PROPOSED budget), with no blocking web fonts.
- Pages render on the server, so content shows while scripts load; bidding itself needs the app or PWA (deliverable 7 covers the no-script form fallback).

## 11. Analytics events (baseline from Phase 1)

| Event | Feeds the blueprint measure |
|---|---|
| `lot.viewed` (lot, auction, channel, lite mode on/off) | Conversion by step |
| `lot.breakdown_opened` | Is the all-in price being read? |
| `lot.watched`, `saved_search.created`, `saved_search.alert_sent` | Reach |
| `lot.listed` with photo count and inspection flag | Share of vehicle lots with an inspection report |
| `lot.readiness_blocked` with blocker codes | Where intake gets stuck |

## 12. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| D1: confirm the condition vocabulary matches ABC's glossary | ABC Operations | The brief's list is used |
| A28: minimum photo set for goods | ABC Operations | 4 photos, whole item plus label |
| A30: accept that the reserve jump reveals roughly where the reserve sits | ABC Commercial | Jump on (`bidding.price_jumps_to_reserve`) |
| Q10: ABC's WAF rules versus search crawlers | ABC IT | New pages allow-list crawlers |
