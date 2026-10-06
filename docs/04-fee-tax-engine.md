# 04 — Fee and Tax Engine

| | |
|---|---|
| Phase | 1 — Fix the rules (deliverable 5) |
| Source of truth | Blueprint §6 modules 6 and 7, §7 (two currencies, taxes stack), §8 "Tax and currency errors"; [00 Assumptions register](00-assumptions-register.md) Q3, Q9, A12 |
| Code | [`packages/quote`](../packages/quote/src) (`quoteLot`, `sellerProceeds`, `commitPreview`) · [`packages/domain`](../packages/domain/src/money.ts) (money arithmetic) |
| Related | [03 Rulebook service](03-rulebook-service.md) · [02 Data model §4.3](02-data-model.md#43-posting-recipes) |

## 1. Purpose

Today the all-in price, with VAT and levy, reaches the buyer **the morning after** a binding bid (gap 2). The blueprint's first principle is **inform before binding**: *"A bid is binding, so the bidder must see the all-in price, the condition evidence and their own limit before placing it."*

The fee and tax engine is the **QuoteService** named in [01 §4.3](01-solution-architecture.md#43-the-quote-service-one-figure-everywhere). It is a small set of **pure functions**: no database, no clock, no network. Given a lot, an amount, a rule snapshot and the tax rates, they return itemised lines and a total. Every place that shows or charges a price calls them with the same inputs:

| Caller | Function | Amount used | Rules and tax rates used |
|---|---|---|---|
| Lot page ("about US$X all-in at the current bid") | `quoteLot` | current price | auction's pinned version, rates now |
| Commit screen | `commitPreview` → `quoteLot` | the amount being typed | auction's pinned version, rates now |
| Bid acceptance (server) | `quoteLot` | the bidder's maximum | same; stored on the bid (`quoted_total_minor`, `quoted_rule_version_id`) |
| Invoice engine at the hammer | `quoteLot` | hammer price | auction's pinned version, tax rates effective at the hammer; frozen on the invoice |
| Seller commission calculator, consignment note, statements | `sellerProceeds` | estimate or hammer | same rule logic |

**Acceptance test.** The buyer sees exactly what they will owe before committing, which lowers regret. Invoices are ready at the hammer instead of the next morning, which shortens time to cash.

## 2. Inputs and outputs

```ts
quoteLot({
  lot: { currency: 'USD' | 'ZWG', taxClass, categoryPath, isVehicle },
  hammerMinor: bigint,               // integer minor units
  snapshot: RuleSnapshot,            // one rule set version (deliverable 4)
  taxRates: TaxRateRecord[],         // rows from rulebook.tax_rate
  at: Date,                          // the moment whose tax rates apply
  delivery?: { method: 'collect' } | { method: 'delivery', town, sizeClass },
  buyerExemptTaxCodes?: TaxCode[],   // none by default
}) => {
  currency, lines: [{ type, description, amountMinor, baseMinor?, rateBp?, taxRateId?, appliesTo }],
  totalMinor, ruleVersionId, taxedAt
}
```

Every output carries the rule version and the tax moment, plus the tax-rate row ID on each tax line. The invoice stores all three, so any invoice can be recomputed exactly ([02 §3](02-data-model.md#3-module-ownership-and-schemas)).

## 3. Line order

For one lot, in this order:

1. **Hammer price.**
2. **Buyer's premium**, if `fees.buyers_premium_bp` > 0. It is 0 today because none is published (CONFIRMED absence, Q3), so the line is omitted.
3. **Taxes on the lot.** Codes come from `tax.class_codes[lot.taxClass]`, processed in `tax.calculation_order`. Each needs an active rate for (code, class, currency) effective at `at`.
4. **Delivery**, if chosen. The price comes from `delivery.rate_card[currency][town][sizeClass]`.
5. **Taxes on delivery**, using `tax.class_codes[delivery.tax_class]`.
6. **Total** = sum of all lines.

### 3.1 Tax bases

Each tax-rate row says what it is charged on:

| `base` | Charged on |
|---|---|
| `hammer` | the hammer price |
| `hammer_plus_premium` | hammer + buyer's premium |
| `gross` | hammer + premium + every tax calculated earlier in `tax.calculation_order` |
| `transfer_amount` | a money transfer, not goods (IMTT): **never part of a lot quote**; applied by the payments layer (deliverable 10) if finance decides ABC must levy it |

The placeholder rates follow Hammer and Tongues (BENCHMARK): a 15 % levy on the hammer, then 15.5 % VAT. Hammer and Tongues says VAT is charged "on the gross price", which could include the levy or not. The engine supports both readings (`hammer_plus_premium` or `gross`), and finance picks one (Q9). Both are tested.

## 4. Rounding

- Each line is rounded **separately** to the minor unit, half away from zero, using integer arithmetic (`applyBasisPoints`): `(base × rate_bp + 5000) ÷ 10000`. Rule `money.rounding = half_up` (PROPOSED, finance to confirm).
- The total is **the sum of the rounded lines**, never a separately rounded figure. That is exactly the database invariant on invoices (`invoice.total_minor` = Σ lines, checked at commit), so a quote copied line by line onto an invoice always satisfies it.
- Floats never appear: amounts are `bigint` from the moment text is parsed (`parseAmountInput`) to the moment a line is stored.

## 5. Currency behaviour

| Rule | How |
|---|---|
| Every lot has one settlement currency | `lot.currency`; the database ties bids, invoice lines and payments to it with composite foreign keys |
| Nothing converts silently | The engine only ever looks up rates, delivery prices, premiums and ladders **in the lot's currency**. Money rules are stored per currency, and `null` means "not set": the quote then fails rather than borrowing the other currency's figure (tested: a ZiG lot with only USD rates is refused) |
| Indicative other-currency figures | Only if `fx.indicative_display.enabled`, labelled "approximately", never stored on a bid or invoice. Off by default |
| Payment methods per currency | Only methods valid for the invoice currency are offered, e.g. InnBucks for USD only (blueprint §7; enforced in `payment.payment` and the gateway router, deliverable 10) |

## 6. Tax applicability

- **Tax class** is set per category (`catalogue.category.tax_class`) and can be overridden per lot (`catalogue.lot.tax_class`) by staff, with the change audited. Initial classes: `goods_standard`, `vehicle_standard`, `vehicle_used_zw` (Zimbabwe-registered second-hand vehicle) and `delivery_service`. These are BENCHMARK placeholders (Q9).
- **What each class pays** is the rule `tax.class_codes`. A class with an empty list is untaxed. Zimbabwe-registered used vehicles pay the levy only (BENCHMARK: Hammer and Tongues exempts them from VAT).
- **Missing rate means no price.** If a class requires a tax and no **active** rate covers the moment, `quoteLot` throws `TAX_RATE_MISSING`. A lot that cannot be quoted cannot go live, and the commit screen pauses bidding with a plain message instead of showing a total built on a guess. This is Q9's safe default: placeholder rates are imported **inactive**, so nothing is priced until finance activates real rates.
- **Buyer exemptions** (`buyerExemptTaxCodes`) exist for cases finance may define, such as exempt institutions with evidence. None are defined by default.
- **Effective dating.** The rate used is the one effective at `at`. Previews use "now". Invoices use **the hammer time**, so an invoice issued just after a rate change keeps the rate in force when the lot sold (tested). That is blueprint §8's "invoices freeze the rates used at close".

## 7. Delivery in the quote

- Delivery is optional. Collection is the default and adds nothing.
- The price comes from `delivery.rate_card`, by town and size class. Vehicles and `delivery.excluded_categories` cannot be delivered (CONFIRMED: no vehicle delivery). An unknown town returns `DELIVERY_UNAVAILABLE`, and the commit screen offers collection instead.
- The rate card is **empty** in the initial rule set because ABC's town list conflicts (nine towns or seven) and no prices are published (A24). Until operations fills it in, quotes are collection-only.
- **Never charge more than quoted** (`delivery.never_exceed_quote`, PROPOSED). When bundling several lots to one address (deliverable 15) lowers the delivery charge, the invoice uses the lower figure. The invoice may never show more delivery than the bidder saw at commit.

## 8. The commit screen calculation

`commitPreview` (`packages/quote/src/commit.ts`) is the calculation behind the commit screen. The screen's design comes in deliverable 7. On each keystroke it:

1. **Parses** the typed text into minor units ("1,250", "US$ 40", "1250.5"). Mistakes get plain answers: *"Use at most two decimal places."*
2. **Checks the increment ladder** (`checkBidAmount`): *"The lowest bid you can place is US$105.00."*
3. **Quotes the all-in total** at the typed amount: *"If you win at US$1,000.00, you pay US$1,305.00 in total. You may win for less."*
4. **Checks the limit against the all-in total**, not the hammer price (blueprint module 6): *"At US$1,000.00 you would pay US$1,305.00 in total. You can bid up to US$1,200.00 in total. Add a deposit to bid higher."*
5. **Refuses to guess.** If a rate, ladder or delivery price is missing, the screen says bidding is paused and doesn't show a figure.

The same function runs on the device, using the cached snapshot for instant offline feedback, and on the server before a bid is accepted. **The server's result is authoritative.** The accepted bid records the total and rule version the bidder saw.

## 9. Seller side: commission

`sellerProceeds` computes what a seller receives. It's the "commission published as text with a calculator" from blueprint module 9.

| Schedule basis | Calculation |
|---|---|
| `marginal` | Each band's rate applies only to the part of the price inside that band (like income-tax bands). Rounded once on the total |
| `flat_band` | The whole price is charged at the rate of the band it falls in |

A per-lot minimum applies (`minimumPerLot`), and commission never exceeds the hammer price. The commission schedule is **not set** in the initial rule set, because ABC publishes it as an image (Q3). Until finance publishes it, `sellerProceeds` throws `COMMISSION_NOT_SET`, so no payout is ever calculated on a guessed rate.

Worked example (illustrative bands, not ABC's): marginal 15 % to US$1,000, then 10 %, minimum US$5. On a US$1,500 hammer: 15 % × 1,000 + 10 % × 500 = **US$200 commission, US$1,300 to the seller**.

## 10. Worked examples

Placeholder rates (BENCHMARK, Q9): levy 15 % on hammer, VAT 15.5 % on hammer + premium; delivery Harare medium US$10 (test rate card). All of these are tests in `packages/quote/src/quote.test.ts`.

| Lot | Hammer | Lines | Total |
|---|---|---|---|
| IT goods, collect | US$1,000.00 | levy 150.00 · VAT 155.00 | **US$1,305.00** |
| IT goods, delivered to Harare | US$1,000.00 | levy 150.00 · VAT 155.00 · delivery 10.00 | **US$1,315.00** (matches [02 §4.3](02-data-model.md#43-posting-recipes)) |
| ZW-registered used vehicle | US$5,000.00 | levy 750.00 | **US$5,750.00** |
| IT goods, VAT on `gross` | US$1,000.00 | levy 150.00 · VAT 178.25 | **US$1,328.25** |
| IT goods with a 5 % premium | US$1,000.00 | premium 50.00 · levy 150.00 · VAT 162.75 | **US$1,362.75** |
| Rounding | US$3.33 | levy 0.50 (0.4995) · VAT 0.52 (0.51615) | **US$4.35** |
| Any lot, rates inactive | — | `TAX_RATE_MISSING`: bidding paused | — |
| ZiG lot, USD rates only | — | `TAX_RATE_MISSING`: never borrows USD | — |

## 11. Errors

| Code | Meaning | What the person sees |
|---|---|---|
| `TAX_RATE_MISSING` | A required tax has no active rate in this currency at this time | Bidding paused: "We cannot show the full price for this lot right now" |
| `TAX_CLASS_UNKNOWN` | The lot's tax class is not defined | Same; staff see the configuration error |
| `RULE_MISSING` | A rule has no value for this situation, e.g. no ZiG ladder | "Bidding in this currency is not open yet" |
| `DELIVERY_UNAVAILABLE` | No price for that town and size, or the lot can't be delivered | "Delivery is not available for this lot and address. Choose collection instead." |
| `COMMISSION_NOT_SET` | No commission schedule in this currency | Sellers see "Commission rates are being confirmed"; payouts wait |
| `NEGATIVE_AMOUNT` | A negative hammer price | Rejected input |

## 12. Guarantees and how they are tested

| Guarantee | Test |
|---|---|
| Total = sum of lines, for every amount | Property test over a range of hammer prices |
| A higher bid never costs less | Monotonicity test over 0–US$200 in 7-cent steps |
| Same inputs give the same quote | Determinism test |
| Invoice at hammer time keeps the old rate after a rate change | Effective-dating tests |
| No silent currency borrowing | ZiG lot with USD-only rates is refused |
| Screen equals bill | `commitPreview` and the invoice call the same `quoteLot`; the bid stores the quoted total and version (database check requires both on every bidder's bid) |

Run: `pnpm test` (76 tests across `domain`, `rules` and `quote`).

## 13. Open items for finance

| # | Decision | Effect until decided |
|---|---|---|
| Q9 | Which taxes apply to which classes; rates; whether VAT's base includes the levy; delivery's tax treatment | Lots cannot go live |
| Q9 | Whether ABC must levy IMTT on wallet top-ups, payments or refunds, and who bears it | IMTT not applied |
| Q3 | Commission schedule (basis, bands, minimum) per currency | Payouts cannot be calculated |
| A29 | Rounding rule (half up per line proposed) | Half up per line |
| A12 | A display-only ZiG/USD rate for indicative prices | Only the lot's own currency shown |
