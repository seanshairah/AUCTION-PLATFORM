# 14 — Apps and Environments

| | |
|---|---|
| Phase | After Phase 4: the first runnable System (API, worker, web) over the Phase 0–4 modules |
| Code | [`apps/api`](../apps/api/src) (NestJS API, worker, demo seed) · [`apps/web`](../apps/web) (Next.js buyer screens) · [`packages/db`](../packages/db/src) (`connect-url.ts`, `migrate.ts`, `cli/db.ts`) · [`db/migrations`](../db/migrations) |
| Design | Provisional. Visual language follows the "Vehically" car-auction dashboard reference and will be revised |
| Related | [01 Architecture §8](01-solution-architecture.md#8-technology-decisions) (ADRs 004, 005, 012, 013) · [06 Commit screen](06-commit-screen.md) · [10 Registration and limits](10-registration-limits.md) · [13 Vehicle module](13-vehicle-module.md) |

## 1. What runs

| Process | Command | Does |
|---|---|---|
| API | `pnpm --filter @abc/api start` | HTTP API on `PORT` (4000). Thin NestJS controllers over the domain packages |
| Worker | `pnpm --filter @abc/api worker` | Every `WORKER_INTERVAL_MS`: closes lots whose current end time has passed, issues invoices for fully closed auctions, queues payment reminders. Every step is idempotent, so two workers or a restart are safe. A loop for now; jobs move to pg-boss (ADR 003) with the communications layer |
| Web | `pnpm --filter @abc/web dev` / `build` + `start` | Server-rendered buyer screens on port 3000. The browser calls only this origin; `/api/*` is forwarded to the API, so the session cookie stays first-party |

**Acceptance test.** A buyer sees the full price on every card, the lot page and the commit screen before bidding, from the same quote function as the invoice. That lowers regret. Lots close and invoice by themselves on time, which shortens time to cash.

## 2. API

Money always travels as `{ minor: "1910000", currency: "USD", text: "US$19,100.00" }`, so no client formats or rounds money.

| Method and path | Auth | What |
|---|---|---|
| `GET /health` | — | Server time, latest migration, whether demo sign-in is on |
| `GET /lots` | optional | Live lots. Filters: `q, category (vehicles/other), make, model, yearFrom, yearTo, bodyStyle, transmission, fuel, drive, branch, maxPrice, noReserve, endingWithinHours, sort`. Each card has the current price, next minimum bid and **all-in price at the next minimum** |
| `GET /lots/facets` | — | Filter values with live-lot counts |
| `GET /lots/:ref` | optional | Lot page: vehicle details, the published inspection report by section, the public bid history ("Bidder 1, 2…", never anyone's maximum), the price breakdown, the rules that apply (soft close, pay and collect windows, claim window, minimum deposit), towing partners, and the viewer's registration, leading status and own maximum |
| `POST /lots/:ref/preview` `{typed}` | optional | The commit screen: `commitPreview` with the auction's pinned rule set. When signed in and registered it includes room left to bid (limit minus exposure) |
| `POST /lots/:ref/bids` `{maxMinor, quotedTotalMinor, quotedRuleVersionId, clientRequestId}` | required | `BiddingService.placeBid`. The server re-checks the quoted total and rule version (`price_changed` otherwise). The client request ID makes retries idempotent (R4). Every outcome comes back as a plain sentence |
| `POST /auctions/:id/join` `{depositMinor?}` | required | One-tap registration, holding the deposit from the wallet |
| `GET /me`, `/me/bids`, `/me/wallet` | required | Account; lots bid on (leading, outbid, won, not won); balances, held deposits and payments |
| `GET /rules` | — | The public rulebook in plain language from the active published rule set |
| `GET /session/demo-accounts`, `POST /session/demo`, `POST /session/sign-out` | — | Demo sign-in (§3) |
| `POST /auth/otp/start`, `/auth/otp/verify`; `GET/PUT /me/preferences`; `GET /me/notifications`, `POST /me/notifications/:id/read`; `GET/POST /webhooks/whatsapp`, `POST /webhooks/sms-status` | varies | Sign-in by one-time code, preference centre, in-app feed and provider webhooks ([16 §11](16-communications.md#11-api-worker-and-configuration)) |

Requests are validated with zod; a bad query is a 400 with a readable message.

## 3. Sessions and sign-in

A session is an HttpOnly, SameSite=Lax cookie holding `accountId.expiry.HMAC-SHA256`. It is signed with `SESSION_SECRET` (32+ characters, required in production), lasts 12 hours, and is `Secure` outside development and test.

Sign-in by one-time code to a phone or email address is built ([16 §9](16-communications.md#9-sign-in-by-one-time-code)) and sets this same cookie; KYC for full verification is not built yet. Meanwhile, development and staging can set `DEMO_SIGN_IN=1` to sign in as one of the demo bidders (**A42**). The flag is refused in production. Only accounts with the demo email domain can sign in this way, and everything after sign-in is the production path.

## 4. Database connection and migrations

**Connection.** `connectUrl()` reads `DATABASE_URL` and `DB_DRIVER`:

| `DB_DRIVER` | Transport | Use |
|---|---|---|
| `pg` (default) | node-postgres, TCP 5432 | Production, CI, local Postgres |
| `neon-ws` | Neon's driver: the Postgres wire protocol over a WebSocket on 443, through `HTTPS_PROXY` if set | Networks that allow only HTTPS (ADR 013) |

Both give the same `Db` (transactions with the audit actor, int8 as `bigint`). **The connection string is a secret.** It lives in the untracked `.env` (see [`.env.example`](../.env.example)) or the secrets manager, and is never written to the repository, CI files or docs.

**Migrations** (ADR 012). `pnpm db:migrate` applies, in order and each in its own transaction with a checksum record in `public.schema_migration`:
1. `0000_baseline`: `db/schema.sql` then `db/seed.sql`, on an empty database only. A database built this way records every existing migration as applied, because `schema.sql` already contains them.
2. `db/migrations/NNNN_name.sql`: forward-only changes, also folded into `schema.sql`. They contain no `BEGIN`/`COMMIT`.

Refusals:
- an applied migration whose file has since been edited
- the baseline over a database that already has the System's schemas
- concurrent migrators (serialised by an advisory lock)

`pnpm db:status` lists applied and pending steps. `pnpm db:rulebook` validates the initial rule set and loads it as a **draft**; publishing is the two-person step in [03 §6](03-rulebook-service.md).

| Migration | Change |
|---|---|
| `0001_vehicle_body_and_drive` | `catalogue.vehicle.body_style` and `drive` (with checks) for the dashboard filters; index on make and model. `VehicleService.setDetails` now records fuel, transmission, colour, body style and drive |
| `0002_comms_identity` | One-time code challenges (`identity.otp_challenge`); message delivery fields, fallbacks, quiet-hours scheduling and the in-app feed on `comms.message`; template subjects and the GSM-7 check; preference categories with a channel always kept for money messages; inbound WhatsApp messages and chat conversations; the seeded template library ([16](16-communications.md)) |

## 5. Demo data

`pnpm demo:seed` (A41) builds a believable environment **through the production services**, so every gate is exercised:

1. Demo staff (two people, each granting the other's role), a dealer seller and three bidders.
2. A published rule set `<label>-demo`: the initial rule set plus an illustrative 10 % commission (Q3), with its tax rates activated (Q9). Both are labelled "DEMO ONLY". The rulebook is skipped if a real rule set is already published.
3. Branch-cash top-ups at the Harare counter, posted to the ledger.
4. A timed Harare vehicle auction with staggered ends (72 hours by default, `--hours`) and 10 vehicles. Each goes through intake, vehicle details, a `vehicle-v1` inspection report with 38 photos in the standard roles plus video, publication, and the listing-readiness gate.
5. Opening, which pins the rule set. One-tap registration with US$8,000 deposits. Ten bids through `BiddingService`.

The seed is idempotent while a demo auction is open; `--force` adds another. A run that fails part-way leaves its auction `scheduled`, and the next run cancels it. The seed refuses `APP_ENV=production`.

Removing demo data. The ledger and audit log are append-only, so rows cannot be deleted. `pnpm db:reset --confirm <database>` drops every System schema (refused in production; the database name must match), then `db:migrate` rebuilds. **Reset any database that held demo data before it is used for real.**

## 6. Web screens

| Screen | Path | Notes |
|---|---|---|
| Auctions dashboard | `/auctions` | Summary tiles (live lots, ending in 24 h, leading/outbid, wallet), filter chips, sort, a lot-card grid and the filter panel (make, years, body style, transmission, fuel, drive, price, branch, no reserve). Filters are a plain GET form, so they work without JavaScript and give shareable URLs |
| Lot page | `/lots/:ref` | Gallery (placeholder art until photos come from object storage), vehicle details, inspection report with flagged items first, description, bid history, towing partners, and the rule set version |
| Commit screen | on the lot page | Not signed in: the all-in breakdown and "Sign in to bid". Not registered: join with deposit. Registered: type a maximum and see the itemised total as you type, then "Review bid", then "Confirm bid". The confirmation states the binding total. Each confirmed bid carries one client request ID |
| My bids | `/bids` | Outbid lots first, with "Bid again" |
| Wallet | `/wallet` | Per-currency available and held, held deposits, payments in |
| Fees and rules | `/rules` | The public rulebook |
| Sign in | `/sign-in` | Demo picker when enabled, otherwise an honest "not available yet" |

The sidebar lists only screens that exist. The current app's "Soon" screens are a blueprint finding (gap 5), so nothing here is a placeholder. The layout collapses to a top bar and single column on phones.

## 7. Environments

| Environment | Database | Driver | Demo data | Demo sign-in |
|---|---|---|---|---|
| Local | Local Postgres 16, or the Neon development database | `pg` / `neon-ws` | Yes | Yes |
| CI | Throwaway Postgres 16 service | `pg` | Yes (the `apps` job) | Yes |
| Development (hosted) | Neon, PostgreSQL 18 (schema and invariants verified there) | `pg`, or `neon-ws` from HTTPS-only networks | Yes | Yes |
| Staging / production | Per ADR 007 (pending Q8) | `pg` | Staging only | Staging only |

CI's `apps` job:
- migrates an empty database (twice, proving idempotence)
- loads the rule set and seeds demo data
- builds the web app, starts the API and web
- requests the dashboard, a filtered view, a lot page, the rulebook and sign-in, and checks the lot page shows its inspection report

## 8. Evidence

| Behaviour | Test |
|---|---|
| Baseline on an empty database records later migrations; re-running is a no-op | `packages/db/src/migrate.test.ts` |
| New migration applied once; edited migration refused; failing migration leaves nothing; baseline refused over existing schemas | same |
| Reset needs the database name, is refused in production, and leaves a rebuildable database | same |
| Sessions: tampered, re-signed or expired tokens refused; production refuses demo sign-in and weak secrets | `apps/api/src/api.test.ts` |
| Demo seed passes the real gates (published inspections, readiness, deposits, limits); refused in production | same |
| Lot list: all-in price at the next minimum equals hammer plus 15 % levy for a ZW-registered vehicle; filters; bad query is 400 | same |
| Lot page: inspection, anonymised history, no maximum or reserve leaked, rules shown, breakdown equals the card's all-in | same |
| Preview → stale quote refused (`price_changed`) → bid accepted → retry is idempotent → appears in My bids | same |
| Bidding needs a session; demo sign-in only for demo accounts; forged cookie refused | same |
| Wallet from the ledger; public rulebook | same |
| Schema and all 69 SQL invariants pass on the Neon development database (PostgreSQL 18) | `db/tests/invariants.sql`, run once against Neon (rolled back) |

## 9. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| Visual design (this is the provisional "Vehically" direction) | ABC Product / design | Tokens live in one block in `apps/web/app/globals.css` |
| Identity module (OTP sign-in, KYC) | Build (next) | Demo sign-in in development and staging only (A42) |
| Lot photos from object storage (S3-compatible) | Build | Placeholder vehicle art and photo-role tiles |
| Realtime price updates (Socket.IO per ADR 001) | Build | Pages refresh after each action; countdowns tick locally |
| Mobile-money top-ups in the web app | Q7, A32 | Branch cash only in the demo |
| Reset the Neon development database before any real use | ABC / build | It holds demo data (A41) |
