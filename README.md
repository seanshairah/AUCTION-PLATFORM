# ABC Auctions — the System

An enterprise auction platform for ABC Auctions (Harare and Bulawayo), built to the target specification in *The Perfect Bidding System: ABC Auctions Survey, Benchmark and Blueprint* (5 Oct 2026).

The System keeps ABC's timed auction (proxy bids, soft close, staggered ends) and rebuilds what surrounds it: how bidders are admitted, what they see before a binding bid, how money moves, and how sellers watch their goods sell. It is built around **one wallet ledger** (USD and ZiG kept apart), **one rulebook** and **one append-only audit log**.

Every feature must pass one test: *does it shorten time to cash for the seller, or lower regret for the buyer?*

## Architecture rules

1. **One ledger.** Double-entry, append-only, USD and ZiG kept apart. Every movement of money is a journal.
2. **One rulebook.** Every figure a user sees comes from the same versioned rules the invoice uses.
3. **Append-only audit.** Every state change has a server time, actor and reason; staff overrides above a threshold need a second person.
4. **Idempotency everywhere.** Payments by gateway reference, bids by client request ID, notifications by (message, channel, recipient).

Rules 1, 3 and 4 are enforced in the database schema itself ([`db/tests/invariants.sql`](db/tests/invariants.sql)). Rule 2 is enforced by one rule registry and one quote function shared by every screen and the invoice ([`packages/rules`](packages/rules/src), [`packages/quote`](packages/quote/src)).

## Deliverables

Statements are tagged **CONFIRMED** (stated by the blueprint about ABC), **BENCHMARK** (about another platform), **PROPOSED** (a configurable starting value) or **ASSUMPTION** (listed with an owner in the register).

| # | Deliverable | Phase | Status |
|---|---|---|---|
| 1 | [Assumptions register](docs/00-assumptions-register.md) | 0 Foundations | Done |
| 2 | [Solution architecture](docs/01-solution-architecture.md) | 0 Foundations | Done |
| 3 | [Data model](docs/02-data-model.md) + [DDL](db/schema.sql) | 0 Foundations | Done |
| 4 | [Rulebook service](docs/03-rulebook-service.md) + [initial rule set](rulebook/initial-rule-set.json) + [`packages/rules`](packages/rules/src) | 1 Fix the rules | Done |
| 5 | [Fee and tax engine](docs/04-fee-tax-engine.md) + [`packages/quote`](packages/quote/src) | 1 Fix the rules | Done |
| 6 | [Lot page and catalogue](docs/05-catalogue-lot-page.md) + [`packages/catalogue`](packages/catalogue/src) | 2 Informed bids | Done |
| 7 | [Commit screen](docs/06-commit-screen.md) + `commitPreview` in [`packages/quote`](packages/quote/src/commit.ts) | 2 Informed bids | Done |
| 8 | [Bidding engine integration](docs/07-bidding-engine.md) + [`packages/engine`](packages/engine/src) + [`packages/bidding`](packages/bidding/src) | 2 Informed bids | Done (bidding service persisted in Phase 3) |
| 9 | [Wallet and ledger](docs/08-wallet-ledger.md) + [`packages/ledger`](packages/ledger/src) | 3 Money | Done |
| 10 | [Payments integration](docs/09-payments.md) + [`packages/payments`](packages/payments/src) | 3 Money | Done (Paynow adapter unverified: A32) |
| 11 | [Registration and limits](docs/10-registration-limits.md) + [`packages/limits`](packages/limits/src) | 3 Money | Done |
| 12 | [Close and settlement](docs/11-close-settlement.md) + [`packages/settlement`](packages/settlement/src) | 3 Money | Done |
| 13 | [Seller portal](docs/12-seller-portal.md) + [`packages/seller`](packages/seller/src) | 4 Supply | Ready for review |
| 14 | [Vehicle module](docs/13-vehicle-module.md) + [`packages/vehicles`](packages/vehicles/src) | 4 Supply | Ready for review |
| 15 | Logistics module | 5 Reach | Not started |
| 16 | Communications layer | 5 Reach | Not started |
| 17 | Support and disputes | 5 Reach | Not started |
| 18 | Admin and operations console | 5 Reach | Not started |
| 19 | Analytics | 5 Reach (instrumented from Phase 1) | Not started |

## Repository layout

```
docs/               numbered deliverables
db/schema.sql       canonical PostgreSQL 16 schema, one schema per module
db/seed.sql         reference data: branches, condition vocabulary, example categories
db/tests/           database invariant tests and runner
rulebook/           rule set documents (the initial rule set, transcribed from the blueprint)
packages/domain     money: integer minor units, USD and ZiG, formatting, parsing typed amounts
packages/rules      rule registry, scope resolution, validation, increment ladder, plain-language rendering
packages/quote      the QuoteService: all-in buyer price, seller proceeds, commit-screen preview
packages/engine     reference bidding engine: proxy bids, soft close, reserve, closing, replay, bid history
packages/catalogue  listing readiness (the "all-in price on every lot" gate), structured data, saved searches
packages/db         transactions with audit actor, rulebook store, test databases and fixtures
packages/ledger     posting recipes, the ledger write path, holds, wallets, daily reconciliation
packages/limits     spending limits, exposure, one-tap registration with deposits
packages/payments   gateway interface and routing, payment service, reconciliation, Paynow (unverified), fake gateway
packages/bidding    bidding service: server checks, engine under the lot lock, bid log, closing
packages/settlement invoices at close, one-tap payment, QR gate pass, release, payouts, reminders, default ladder
packages/seller     consignments, e-signed consignment note, valuation, live bids view, statements, bulk upload, WhatsApp intake
packages/vehicles   inspection checklist and reports, gross-inaccuracy check, viewing slots, title tracker, towing partners
```

## Working on it

Requires Node 22+, pnpm 10 and, for the database tests, PostgreSQL 16 reachable through the usual `PG*` environment variables. Database integration tests run only when `PGHOST` is set (each creates and drops its own database); CI always sets it and fails if any are skipped.

```sh
pnpm install
pnpm typecheck
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres pnpm test   # all packages, including the end-to-end money path
db/tests/run.sh           # schema + seed + invariant tests in a temporary database
pnpm rulebook:sql | psql  # validate the initial rule set and load it as a draft version
```

CI runs all of these on every push.
