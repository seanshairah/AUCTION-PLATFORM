# 18 — Admin and Operations

| | |
|---|---|
| Phase | 5 — Reach (deliverable 18) |
| Source of truth | Blueprint §6 module 13 (admin and operations: intake, scheduling, risk console, reconciliation, fraud alerts), §8 risk controls (two-person approval "above a set amount", shill bidding, payment fraud), principle 4 (humans handle exceptions, not the happy path); [00 Assumptions register](00-assumptions-register.md) A15, A57–A62 |
| Code | [`packages/admin`](../packages/admin/src): `permissions.ts`, `overrides.ts`, `rulebook.ts`, `risk.ts`, `reconciliation.ts`, `defaults.ts`, `auctions.ts`, `dashboard.ts` · API: [`apps/api/src/admin`](../apps/api/src/admin) · schema: migration [`0004_admin_analytics`](../db/migrations/0004_admin_analytics.sql), folded into [`db/schema.sql`](../db/schema.sql) |
| Related | [03 Rulebook §6](03-rulebook-service.md#6-publishing-workflow) (publication) · [09 Payments §9](09-payments.md#9-daily-reconciliation) · [10 Registration §3](10-registration-limits.md#3-one-tap-to-join) (review queue) · [11 Close and settlement §9](11-close-settlement.md) (default ladder) · [19 Analytics](19-analytics.md) |

## 1. Purpose

Blueprint principle 4 says staff should handle exceptions, not the happy path. Deliverables 4 to 14 automated the happy path: one-tap registration, the commit screen, invoices at the close, one-tap payment and the ladder for missed payments. This deliverable gives staff the tools for the exceptions, and makes every exception leave a trail:

- a registration flagged for review
- a draft rule set waiting for a second person
- a gateway statement that does not match
- a buyer appealing a forfeited deposit
- an auction to schedule
- the day's closing lots, unpaid invoices, payouts and title cases

The console is a set of services over the modules' own interfaces (docs/01 §4.1, module 13). It owns no schema of its own: each record it adds lives in the schema of the module it concerns (`audit`, `rulebook`, `registration`, `settlement`, `payment`).

**Acceptance test.** A flagged registration, a mismatched payment or an appeal is decided in minutes, by a named person with a reason, so sellers are not kept waiting by back-office queues (shorter time to cash). No price, refund, limit or rule changes quietly: anything above the threshold needs a second person, and a buyer can see why a decision was made (lower buyer regret).

## 2. Services

| Service | Does | Writes (through) |
|---|---|---|
| `OverrideService` | Raise, approve, reject and lapse staff overrides; applies the approved action in the same transaction | `audit.override_request`, then the action's own tables |
| `RuleSetPublication` | Drafts, validation with named warnings, acknowledgement, publication, retirement; tax rate list | `rulebook.rule_set_version`, `rulebook.warning_acknowledgement` |
| `RiskConsole` | Registration review queue, linked-account clusters, bid anomalies, restricted accounts | `RegistrationService.decideReview` |
| `ReconciliationQueue` | Unresolved reconciliation exceptions and their resolution | `payment.reconciliation_item` |
| `DefaultAppeals` | Default cases, buyer appeals, appeal decisions | `settlement.default_appeal` |
| `AuctionScheduler` | Create auctions with staggered ends, attach ready lots, open | `auction.*`, `catalogue.lot`, `BiddingService.openAuction` |
| `opsDashboard` | The day's operational picture | Read-only |

`createAdminServices(db, rulebook, { registrations, bidding })` wires them and registers the five override kinds (§4).

## 3. Staff authorisation

Roles come from `identity.staff_role`: ops, finance, risk, support, cashier, vehicle desk, admin and auditor (docs/01 §6.4). Each console action names one permission, and `PERMISSIONS` in `permissions.ts` says which roles hold it. Anything not listed for a role is refused, with a sentence naming the roles that can (PROPOSED, **A57**).

| Permission | ops | finance | risk | support | cashier | vehicle desk | admin | auditor |
|---|---|---|---|---|---|---|---|---|
| Dashboard | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| View overrides | ✔ | ✔ | ✔ | ✔ | | | ✔ | ✔ |
| Request a limit change | | | ✔ | | | | ✔ | |
| Approve a limit change | | ✔ | ✔ | | | | ✔ | |
| Request / approve a tier change | | | ✔ | | | | ✔ | |
| View tax rates | | ✔ | | | | | ✔ | ✔ |
| Request / approve tax rate activation (Q9) | | ✔ | | | | | | |
| View rule sets | ✔ | ✔ | ✔ | | | | ✔ | ✔ |
| Acknowledge warnings and publish a rule set ¹ | ✔ | ✔ | ✔ | | | | ✔ | |
| Risk console (view) | | | ✔ | | | | ✔ | ✔ |
| Decide a flagged registration | | | ✔ | | | | ✔ | |
| Reconciliation (view) | | ✔ | | | | | ✔ | ✔ |
| Resolve a reconciliation item; request a write-off | | ✔ | | | | | | |
| Approve a write-off | | ✔ | | | | | ✔ | |
| Default cases (view) | | ✔ | ✔ | ✔ | | | ✔ | ✔ |
| Record an appeal for a buyer | | | ✔ | ✔ | | | | |
| Decide an appeal | | | ✔ | | | | ✔ | |
| Request / approve a default waiver | | ✔ | ✔ | | | | ✔ | |
| Schedule and open auctions | ✔ | | | | | | ✔ | |
| Analytics (view) | ✔ | ✔ | ✔ | | | | ✔ | ✔ |
| Freeze an analytics baseline | | ✔ | | | | | ✔ | |

¹ Also needs the owning role of every rule that changed (§5).

The auditor reads everything and changes nothing. The cashier and vehicle desk work through their own modules (branch cash, title steps) and see only the dashboard here.

## 4. Overrides and two-person approval

Blueprint §8: *"Staff overrides need a name and reason, and a second approver above a set amount."* Every override goes through one workflow on `audit.override_request`:

```
raise (name, reason, what it will do)
  ├─ below the threshold ─────────────► approved and applied at once, by the requester
  └─ above it, or a kind that always needs two ─► pending
        ├─ a different staff member with the approving role approves ─► applied, in the same transaction
        ├─ rejected with a reason (the requester may withdraw)
        └─ not approved within override.request_expiry_hours ─► expired
```

| Kind | Database action type | Amount compared with the threshold | Applies |
|---|---|---|---|
| `limit_change` | `limit_change` | The new limit | `registration.limit_override` (the database refuses one without an approved request) |
| `tier_change` | `tier_change` | None: always two people | Restrict an account (with `restricted_until` from `tier.restricted_review_after_months`) or lift a restriction |
| `tax_rate_activation` | `tax_rate_activation` | None: always two people | `rulebook.tax_rate.active` (§5) |
| `default_waiver` | `deposit_forfeit_waiver`, `fee_waiver` or `tier_change` | Money moved or prevented; tier drop always two | §8 |
| `reconciliation_write_off` | `ledger_adjustment` | None: always two people | A ledger journal (§7) |

**The threshold** is the rule `override.two_person_threshold`: US$500, ZiG not yet set (A15, **Decision needed**). An amount in a currency with no threshold needs two people, and so does any override with no money amount whose kind is marked "always" (PROPOSED, **A58**). Requests lapse after `override.request_expiry_hours` (72, PROPOSED, A58), so an old approval can never be used later.

**Idempotency (R4).** A repeated request with the same client key returns the first. A second request for the same thing while one is open (same entity and purpose) returns the open one. Approving a request you already approved returns it unchanged.

**Enforced by the database** (tested): the requester cannot be the approver; an override above the threshold needs an approver; every request needs a reason of at least ten characters. From migration 0004, also: a request is never edited or deleted; status moves only `pending → approved | rejected | expired` and `approved → executed | expired`; nothing is approved or executed after it lapses; a rejection needs a note; execution is time-stamped.

## 5. Rule set publication and tax rates

Drafts are loaded by `pnpm db:rulebook` (docs/03 §6). Publication:

1. **Validate.** `validateRuleSet` runs on the draft plus every tax rate row. Errors block publication.
2. **Name every warning.** Each warning gets a stable name, `<code>:<rule key>:<hash of the sentence>`, so the same warning on the same draft always has the same name.
3. **The second person acknowledges each warning by name, with a reason.** Acknowledgements are stored in `rulebook.warning_acknowledgement` (append-only). The database refuses one from the draft's author, and refuses any on a version that is no longer a draft.
4. **The approver publishes** with an effective time, which cannot be in the past. The approver must hold the **owning role of every rule that changed** against the version in force (finance, ops or risk; product rules need admin), or be an admin (docs/03 §6; PROPOSED, **A59**). The database's existing check, `approved_by <> authored_by`, still applies.
5. **One version in force.** A unique index means two published versions can never share an effective time, so exactly one is in force at any moment. Versions superseded by one now in force are retired, at publication and by the worker for future-dated versions. Retired versions stay readable, because auctions and invoices pin them (A20).

The 7-day notice period for changes that make things worse (docs/03 §5) is not checked automatically yet: the approver chooses the effective time.

**Tax rates (Q9).** Finance requests `tax_rate_activation` for an inactive row, and a second finance person approves it. The database refuses to activate a rate unless an approved `tax_rate_activation` override for that row exists and its approver is the one recorded on the rate. Overlapping active rates are still refused by the exclusion constraint.

## 6. Risk console

| View | What it shows | Rules |
|---|---|---|
| Registration queue | Pending registrations with their flag reasons, waiting time against `registration.target_decision_minutes`, accounts sharing a link signal (and whether they sell in the auction), paid invoices and defaults | Decide `approved` or `rejected` with a reason (at least ten characters, database-enforced). Approval records the limit at the time of the decision; refusal returns any deposit held for it. The database allows `pending_review → approved | rejected` and `approved → revoked` only |
| Linked accounts | Clusters of accounts connected by any shared signal (device, phone, ID, payment source, payout destination, address, network), with signal types, tiers and whether any is a seller | — |
| Bid anomalies | (1) A bidder who, within the window, bid on at least *N* closed lots from one seller and won at most *M*, flagged if also linked to that seller. (2) Groups of at least *K* accounts that bid within the window and share a device or network, from link signals and from the bid network log (IPv4 /24, IPv6 /48) | `risk.bid_up_pattern` = 90 days, 3 lots, 0 wins; `risk.shared_signal_pattern` = 30 days, 3 accounts, device and IP range (PROPOSED, **A60**). Both internal (not in the public rulebook), so they cannot be gamed |
| Restricted accounts | Restricted or suspended accounts, since when, why (from the audit log) and until when | Restricting or lifting is a `tier_change` override |

Signals are keyed hashes; the console shows only the first 12 hex characters, enough to tell groups apart. The network view shows the IP range, which is personal data visible to the risk role only.

## 7. Reconciliation queue

Every non-matched line from a daily run (docs/09 §9) waits in the queue until finance resolves it:

| Resolution | When | Money |
|---|---|---|
| `matched_manually` | The statement line belongs to a payment the System holds under another reference: same currency and amount | None |
| `gateway_error` | The gateway confirms its statement line is wrong | None |
| `within_tolerance` | An amount difference no larger than `payments.reconciliation_tolerance` (US$0 and ZiG 0, exact match: PROPOSED, **A61**) | None |
| `written_off` | A **shortfall**: money the System credited that the gateway will never settle (missing at source, or statement below the System) | Journal `adjustment`: debit `write_off` (a new platform expense account), credit `gateway_clearing`. Always two finance people |

A surplus (the gateway took money the System never credited) is never written off. It belongs to a payer, so finance matches or credits it. After a write-off, ABC must fund the trust account from its own money. Until it does, the daily safeguarding check (docs/02 §4.2) reports the gap. That is deliberate.

**Enforced by the database** (tested): a resolution is final; matched items need none; a resolution needs a note; a write-off needs a journal and an approved `ledger_adjustment` override (with an approver) for that item; statement facts cannot be edited; items are never deleted.

## 8. Default appeals and waivers

Docs/11 designed the appeal; this builds it. A buyer appeals one or more ladder steps from their own account (`POST /me/defaults/:case/appeal`), or support or risk record the appeal for them. One appeal can be open per case. Risk or finance staff then waive a step with a reason, through a `default_waiver` override:

| Step | Not yet applied: **prevented** | Already applied: **reversed** |
|---|---|---|
| Deposit forfeit | The ladder skips it. The invoice is still cancelled and the lot relisted, but the deposit is returned instead of forfeited | Each forfeit journal is reversed (`reversal`, mirror lines), then the deposit moves from held to available (`hold_release`) |
| Relist fee | The ladder skips it | The fee journal is reversed (refused, with a plain message, if a fee charged to the receivable has since been paid) |
| Tier drop | The ladder skips it | The account goes back to the tier it had before (from the audit log) |

The amount compared with the threshold is the money moved, or that would have moved: the deposit, or the relist fee. A tier drop has no amount and always needs two people. When every waivable step is waived, the case closes as `waived` (PROPOSED, **A62**).

**Integration with the ladder.** `SettlementService.runDefaultLadder` reads `settlement.default_waiver` and never applies a waived step. Independently, the database refuses a `default_step` row for a waived step, whoever runs the ladder. A waiver locks the invoice row as the ladder does, so the two cannot interleave. Waivers are append-only and need an approved override of the matching type for that case (database-enforced).

## 9. Auction scheduling

1. **Create** (`POST /staff/auctions`): code, title, branch, format, opening and first closing time, deposit requirement. The stagger defaults to `bidding.stagger_seconds`. A per-auction soft close must be one of `bidding.soft_close_allowed_seconds` (docs/03 §4). The code is the idempotency key.
2. **Attach lots**: each lot in draft, listed (and not in another open auction), unsold, reserve-not-met or refunded must pass `checkListingReadiness` against the rule set in force. A lot that fails is reported with its blockers and not attached. Lot *n* closes at first close + (*n* − 1) × stagger. The lot moves to `listed` and an outbox event `lot.listed` is written (analytics).
3. **Open**: `BiddingService.openAuction`, which pins the rule set (A20) and puts the lots live. An auction with no lots cannot open.

## 10. Operations dashboard

`GET /staff/dashboard?branch=HRE`. "Today" is the Harare calendar day (CAT, UTC+2). Money is grouped per currency.

| Panel | Contents |
|---|---|
| Closing today | Open lots whose current end time is today: price, reserve met, bids |
| Unpaid invoices by age | Count and total per currency: within the pay window, overdue under 24 h, 24–72 h, over 72 h |
| Payouts due | Scheduled, approved or held payouts due by tomorrow, per currency, and how many are overdue (payouts are not branch-bound) |
| Title cases overdue | Cases past their deadline or with an overdue step, with the next step |
| Viewings | Today's viewing slots with bookings against capacity |

## 11. API

All under `/staff/...`, behind `StaffGuard`: a session from `session.ts` whose account holds a staff role. Each action then checks its permission (§3). Bodies and queries are validated with zod. Money travels as `{ minor, currency, text }`: every `<name>Minor` field becomes `<name>`. Service errors map to 400, 403, 404 or 409 with a plain sentence.

| Method and path | What |
|---|---|
| `POST /session/demo-staff` `{accountId}`, `GET /session/demo-staff-accounts` | Development and staging only, same switch as `DEMO_SIGN_IN` (A42): sign in as a demo staff member. The ordinary session token |
| `GET /staff/overrides?status&kind`, `GET /staff/overrides/:id`, `POST /staff/overrides` `{kind, payload, reason, clientKey?}`, `POST /staff/overrides/:id/approve` `{note?}`, `POST /staff/overrides/:id/reject` `{note}` | §4 |
| `GET /staff/rule-sets`, `GET /staff/rule-sets/:id/validation?effectiveFrom`, `POST /staff/rule-sets/:id/acknowledgements` `{warningId, reason}`, `POST /staff/rule-sets/:id/publish` `{effectiveFrom}`, `GET /staff/tax-rates` | §5. Tax activation is `POST /staff/overrides` with kind `tax_rate_activation` |
| `GET /staff/risk/registrations`, `POST /staff/risk/registrations/:id/decision` `{decision, reason}`, `GET /staff/risk/link-clusters`, `GET /staff/risk/anomalies`, `GET /staff/risk/restricted` | §6 |
| `GET /staff/reconciliation`, `POST /staff/reconciliation/:item/resolve` `{resolution, note, paymentId?}`, `POST /staff/reconciliation/:item/write-off` `{reason}` | §7 |
| `GET /staff/defaults?status`, `GET /staff/defaults/:case`, `POST /staff/defaults/:case/appeals`, `POST /staff/defaults/:case/waivers` `{step, reason, appealId?}`, `POST /staff/appeals/:id/decision` `{decision, note}`; buyer: `GET /me/defaults`, `POST /me/defaults/:case/appeal` `{steps, grounds}` | §8 |
| `GET /staff/me` | The signed-in staff member, their roles and the permissions those roles hold (the console hides what a role cannot open) |
| `GET /staff/auctions`, `GET /staff/lots/offerable`, `POST /staff/auctions`, `POST /staff/auctions/:id/lots` `{lotIds}`, `POST /staff/auctions/:id/open` | §9: the scheduling board and the lots that can still be offered |
| `GET /staff/dashboard?branch` | §10 |
| `GET /staff/analytics/...` | [19 §9](19-analytics.md#9-api) |

The demo seed adds ops, finance, risk, support and admin staff members, a WhatsApp ticket and a limit increase waiting for a second person, so every console screen has real work to show in the demo environment. The worker lapses unapproved overrides and retires superseded rule sets on every tick.

## 11a. The console (apps/web `/staff`)

A separate area of the web app with its own night sidebar, so staff never mistake it for the public site. `/staff/sign-in` offers the demo staff members where demo sign-in is on (A66); every other `/staff` page redirects there without a staff session. The sidebar lists only the screens the role can open (`GET /staff/me`); the API checks every action again.

| Screen | Path | What it does |
|---|---|---|
| Today | `/staff` | KPI band (live auctions, closing today, unpaid invoices, approvals waiting for you, payouts due), closing-today table with live countdowns, approvals waiting, unpaid invoices by age (an aging strip plus the table), auctions, viewings, overdue titles (§10) |
| Approvals | `/staff/approvals` | Override requests by status. Each shows the amount, what it will do and the reason, and a two-step sign-off rail: raised by, then the second person. The requester sees "someone else must approve"; a role without the kind's approve permission sees why it cannot; the "waiting for you" count only counts what you may approve (§4) |
| Tickets | `/staff/tickets` | Inbox with reply-by status per ticket, a thread view, "Take it" and reply (docs/17) |
| Claims | `/staff/claims` | Claims with listed versus claimed condition, evidence count, the report assessment, take it, and a decision form. A refund that needs a second person turns into "Ask finance to approve" (docs/17) |
| Late payments | `/staff/defaults` | Cases with the steps applied, appeals, decide appeal, waive a step (§8) |
| Risk | `/staff/risk` | Registrations for review with reasons, linked accounts and history; approve or reject with a reason; link clusters, anomalies, restricted accounts (§6) |
| Reconciliation | `/staff/money` | Exceptions with statement, system and difference; resolve, mark as gateway error, raise a write-off for a second person (§7) |
| Rulebook | `/staff/rulebook` | Rule sets, the selected draft's errors and warnings with an acknowledgement progress bar, acknowledge one or all remaining with a written reason (one audit row per warning), then approve and publish from a date; tax rates with "Request activation" (§5) |
| Gate release | `/staff/gate` | Scans the QR pass with the device camera where the browser has `BarcodeDetector`, or from a USB scanner or pasted text; a full-height verdict: release, or do not release with the reason and any storage due (docs/15) |
| Auctions | `/staff/auctions` | All auctions with status, lots and bids; open a scheduled auction; schedule a new one with a lot picker that reports each lot's readiness blockers (§9) |
| Analytics | `/staff/analytics` | Period and branch filter in one row; sell-through as the one hero figure; timing tiles; sell-through by category (bars) and realised hammer prices (low–high range with the median), each with a hover tooltip and a table view; paid in the app; revenue; freeze a baseline (docs/19) |

Charts follow one series colour (`#4b48a8`, inside the lightness band and above 3:1 against the surface, checked with the dataviz validator), 20 px bars with 4 px rounded data ends on a hairline grid, and text in text colours only.

## 12. Evidence

| Behaviour | Test |
|---|---|
| Permission matrix; the auditor never changes anything; plain refusals | `packages/admin/src/admin.test.ts` (pure) |
| Two people above the threshold, always for kinds without an amount, and for a currency with no threshold | same (pure) |
| Below the threshold an override applies at once; above it, the requester and a wrong role cannot approve; a second person applies it; repeats return the first; rejection; lapse | same (database) |
| A tier change always needs two people; restricted accounts listed with their reason | same |
| Draft validation, changed keys and approver roles; author and wrong role refused; publication needs every warning acknowledged; no back-dating; previous version retired | same |
| Tax rate activation only with a second finance approver | same |
| Review queue with reasons and linked accounts; decision with a reason, once | same |
| Link clusters; bid-up anomaly; shared-device anomaly | same |
| Waivers before the ladder prevent the steps (deposit returned, no fee); the ladder never re-applies them; a tier drop reversed with two people; the case closes as waived; appeal decided | same |
| Waivers after the ladder reverse forfeit and fee through `reversal` and `hold_release` journals; the books reconcile | same |
| Reconciliation queue: tolerance refused, gateway error resolved once, surplus cannot be written off, shortfall written off by a second person to `write_off` | same |
| Auction created once per code; unready lots refused with blockers; staggered ends; opened with the rule set pinned; dashboard closing today, by branch | same |
| Override, append-only, transition, lapse, acknowledgement, single-effective-version, tax activation, write-off account, registration decision, waiver and reconciliation rules | `db/tests/invariants.sql` (33 checks added, prefixed "Admin") |
| Staff roles and permissions (`/staff/me`), the scheduling board, offerable lots refused to support, and the seeded queues | `apps/api/src/api.test.ts` |
| Staff sign-in and guard; limit override across two people over HTTP; rule set publication over HTTP; risk, reconciliation, defaults, auctions and dashboard endpoints | `apps/api/src/admin.test.ts` |

## 13. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| A15: the two-person threshold (US$500; ZiG not set) | ABC Finance | Every ZiG override needs two people |
| A57: the permission matrix | ABC Operations / security | As in §3 |
| A58: overrides without an amount always need two people; requests lapse after 72 h | ABC Risk | As in §4 |
| A59: the approver needs the owning role of every changed rule (product rules: admin) | ABC Product | As in §5 |
| A60: anomaly thresholds | ABC Risk | As in §6 |
| A61: exact-match reconciliation; write-offs only for shortfalls, to a `write_off` expense account | ABC Finance | As in §7 |
| A62: waiving a forfeit returns the deposit but the invoice stays cancelled and the lot relisted | ABC Operations / Risk | As in §8 |
| 7-day notice period for worse changes (docs/03 §5) | ABC Product | The approver chooses the effective time |
| Staff 2FA (docs/01 §6.4) | Identity module | Staff sign in like anyone else until the identity module ships |
| Staff console screens in the web app | Build | The API is complete; screens come with the staff web app |
