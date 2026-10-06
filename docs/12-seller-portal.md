# 12 — Seller Portal

| | |
|---|---|
| Phase | 4 — Supply (deliverable 13) |
| Source of truth | Blueprint gap 5 ("Sellers work by email, see a weekly report, and must bring goods to Harare or Bulawayo. Commission rates are an image. Self-serve seller screens show 'Soon'"), §6 module 9, principle 8 ("Sellers are customers"), §7 (sellers outside the two cities; WhatsApp); [00 Assumptions register](00-assumptions-register.md) Q3, Q5 |
| Code | [`packages/seller`](../packages/seller/src): `intake.ts` (valuation, bulk upload, consignment note, statements), `whatsapp-intake.ts` (chat intake), `service.ts` (`SellerService`) · commission calculator: `sellerProceeds` in [`packages/quote`](../packages/quote/src/quote.ts) |
| Related | [05 Catalogue](05-catalogue-lot-page.md) (lot data, readiness) · [08 Wallet and ledger §7](08-wallet-ledger.md#7-payouts) (payouts) · [04 Fee engine §9](04-fee-tax-engine.md#9-seller-side-commission) |

## 1. Purpose

Today ABC's sellers email seller support, bring goods to a branch, sign a paper consignment note and wait for a weekly Sellers Report. Commission is published as an image (CONFIRMED), and the app's seller screens say "Soon" (*Reported*, Q5).

Blueprint principle 8: **sellers are customers**. They get a portal showing live bids, reserve status, statements and payout dates, not a weekly email.

**Acceptance test.** Sellers see exactly what they will receive before consigning, which lowers regret on the seller side too. They follow their lots live and know their payout date, and institutions list hundreds of lots in one upload. Both shorten time to cash.

## 2. What sellers can do

| Need (module 9) | How | Code |
|---|---|---|
| Consign by app or WhatsApp | A consignment holds draft lots; WhatsApp intake produces a draft for staff to review | `createConsignment`, `addLot`, `handleIntakeMessage` |
| Know what they'll get | Commission as text plus a calculator using the published schedule | `sellerProceeds`, rule `commission.schedule` |
| A valuation range | From comparable past sales | `valuation`, `valuationRange` |
| Set a reserve | On each draft lot; shown back on the note and in the live view | `addLot` |
| E-sign the consignment note | The note is generated from the lots and the rulebook; the signature binds its hash | `previewNote`, `sign` |
| Watch live bids | Price, bids, unique bidders, own reserve and reserve status, end time | `liveLots` |
| Statements and payout dates | Every payout with its due date and status; totals per currency | `statement`, `statementTotals` |
| Bulk upload (institutions) | One CSV per batch, all-or-nothing, idempotent | `bulkUpload`, `validateBulkUpload` |

## 3. Consigning and the consignment note

1. **Create a consignment:** commission sale, outright purchase or advance (CONFIRMED options), with the intake channel and branch.
2. **Add lots** as drafts: title, description, category, item state and condition from the fixed vocabulary, currency, starting bid, optional reserve and estimate. The tax class comes from the category. Lots can be added only before signing.
3. **Preview the note.** `consignmentNote` writes the note from the consignment, its lots and the rulebook:
   - each lot's reserve and currency
   - commission in plain words
   - when the seller is paid
   - the buyer's claim window
   - what happens if the reserve is not met

   The rule set version is printed on it.
4. **Sign.** The app sends the SHA-256 of the note it displayed. The service regenerates the note, and if anything changed since the preview (a lot added, a reserve edited, a new rule set), **the hashes differ and nothing is signed** (`note_changed`, tested). The database stores the hash, the signature reference, the stored note and the rule version, and refuses `signed` without all four.

**Commission must be published before anyone signs** (consequence of Q3). A commission consignment note cannot be generated while `commission.schedule` is unset (`CommissionNotPublishedError`), so no seller ever signs terms that say "to be confirmed".

## 4. Valuation range

`valuationRange` takes comparable hammer prices (same category and currency, last 12 months, from `catalogue.v_realised_price`) and returns the **middle half**: low = 25th percentile, median, high = 75th percentile. With fewer than `seller.valuation_min_comparables` (5, PROPOSED) comparables it returns nothing, and staff value the item instead. A range is shown as a guide, never a guarantee; the blueprint confirms there is no guaranteed price today.

## 5. WhatsApp intake

Blueprint §7: many sellers live outside Harare and Bulawayo, and WhatsApp is where people read messages. `handleIntakeMessage` is a conversation state machine. The communications layer (deliverable 16) carries the messages; this code decides them.

```
category (numbered list) → title → condition (numbered list) → photos (count against catalogue.min_photos; DONE)
  → reserve ("300", "ZiG 5000" or NONE) → confirm (YES / NO) → draft for staff review
STOP at any point cancels; nothing is saved.
```

Vehicles ask for 35 photos (category rule), and a ZiG reserve is understood. The result is a **draft**: intake staff review it, send a valuation range, and the seller signs the note in the app. Nothing goes live from chat. Tested end to end, including invalid answers.

## 6. Live view and statements

- **Live lots** (`liveLots`): each lot's state, current price, accepted bids, unique bidders, the seller's own reserve, whether it is met, and the end time. Sellers see their reserve; bidders never do.
- **Statement** (`statement`): every payout with its due date, gross, deductions and net, plus per-currency totals of paid, upcoming (with the next due date) and held. "Held" covers payouts waiting for a payout destination or blocked on unpublished commission ([08 §7](08-wallet-ledger.md#7-payouts)).
- **Changing payout details** needs re-authentication and a cooling-off period before the next payout (rule `security.payout_destination_cooling_off_hours`).

## 7. Bulk upload for institutions

Module 9 names banks, insurers and customs sales: ZIMRA lots sold through ABC are priced in USD or ZiG lot by lot (blueprint §7).

| Rule | Behaviour |
|---|---|
| Format | CSV with columns `external_ref, title, description, category, item_state, condition, condition_notes, currency, starting_bid, reserve, estimate_low, estimate_high, quantity`; quoted fields supported |
| Per-lot currency | `currency` is `USD` or `ZWG` per row |
| All or nothing | If any row fails, nothing is created and **every** error is returned with its row and column, so the file is fixed in one pass |
| Idempotent per batch | The same batch reference returns the first result |
| No duplicates, ever | `external_ref` (the institution's own lot number) is unique per seller in the database, so a re-upload under a new batch reference skips existing lots |
| Size | Up to `seller.bulk_upload_max_rows` (2,000, PROPOSED) rows per file |

Uploaded lots are drafts. They go live only after the listing-readiness gate ([05 §4](05-catalogue-lot-page.md#4-listing-readiness-the-gate)): photos, condition evidence and an all-in price.

## 8. Evidence

| Behaviour | Test (`seller.test.ts`) |
|---|---|
| Valuation as the middle half; none with too few comparables | Pure |
| CSV parsing (quotes, commas, line breaks); clean customs file with USD and ZiG lots; every error reported; missing columns | Pure |
| Note refused without commission; terms in plain words; any change alters the hash | Pure |
| Statement totals | Pure |
| WhatsApp intake: full flow, photo minimums, ZiG reserve, STOP | Pure |
| Stale preview refused; fresh preview signs; no lots added after signing; only the owner signs | Database |
| Bulk upload: errors create nothing; clean file creates lots with the right tax class and vehicle flag; repeat and re-upload never duplicate | Database |
| Live view with bids and the seller's own reserve | Database |
| Statement from payouts | Database |

## 9. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| Q3: commission schedule | ABC Commercial | No commission consignment note can be signed; payouts blocked |
| Q5: what the current "Soon" screens were meant to do | ABC Product | This portal replaces them |
| Remote valuation and branch drop-off for sellers outside the two cities | ABC Operations | WhatsApp and app intake exist; collection points and couriers come with deliverable 15 |
| E-signature provider (or in-app signature with hash) | ABC / counsel | In-app signature bound to the note's hash |
