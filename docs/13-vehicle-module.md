# 13 — Vehicle Module

| | |
|---|---|
| Phase | 4 — Supply (deliverable 14) |
| Source of truth | Blueprint gap 4 ("Vehicles, the highest-value lots, are sold through phone and email viewings. No delivery. No condition report"), §6 module 8, §4 (Ritchie Bros inspections and assurance; Hammer and Tongues title flow), §7 ("Vehicle sales end at three agencies"), §8 (misdescribed lots) |
| Code | [`packages/vehicles`](../packages/vehicles/src): `inspection.ts` (checklist, validation, gross-inaccuracy check, title steps), `service.ts` (`VehicleService`) · schema: `catalogue.vehicle`, `catalogue.inspection_report`, `catalogue.viewing_slot`/`viewing_booking`, `logistics.title_case`/`title_step`, `logistics.partner` |
| Related | [05 Catalogue §4](05-catalogue-lot-page.md#4-listing-readiness-the-gate) (vehicles can't go live without a published report) · [11 Close and settlement §7](11-close-settlement.md#7-the-gate-pass) (release blocked until title complete) |

## 1. Purpose

Vehicles are ABC's highest-value category, yet they sell through phone and email viewings, with no condition report in the help material (gap 4). The benchmark answers:
- Ritchie Bros publishes inspection reports with at least 35 photos and refunds substantial inaccuracies.
- Hammer and Tongues holds each vehicle until police, tax and registry formalities are complete.

This module brings both to ABC, plus bookable viewings and listed towing partners.

**Acceptance test.** Remote buyers can bid on evidence instead of a phone call, which brings more bidders and higher prices, so sellers get cash sooner. A gross inaccuracy has a defined remedy, and the vehicle isn't released before its papers are done, which lowers buyer regret.

## 2. Vehicle details

`setDetails` records make, model, year, chassis and engine numbers, registration number, whether the vehicle is Zimbabwe-registered, odometer and document status. Chassis and engine numbers are stored normalised (no spaces or dashes, upper case), so comparisons are reliable. *Zimbabwe-registered* drives the tax class: Hammer and Tongues exempts registered second-hand vehicles from VAT (BENCHMARK, Q9).

## 3. Inspection report on a standard checklist

Checklist **`vehicle-v1`** (PROPOSED; rule `vehicle.inspection_checklist_version`) has 29 items in seven sections:

| Section | Items (★ = material) |
|---|---|
| Identity | chassis plate legible · engine number legible · number plates |
| Documents | registration book ★ · police clearance obtainable ★ · ZIMRA clearance for imports ★ · service history |
| Exterior | body panels · paint · glass · lights · tyres · spare wheel |
| Interior | seats · warning lights · air conditioning · electrics |
| Mechanical | engine starts ★ · runs smoothly · gearbox ★ · clutch · brakes ★ · steering ★ · suspension · leaks |
| Structure | chassis and frame ★ · no major accident repair ★ · no flood or fire damage ★ |
| Road test | drives under its own power ★ |

Each item is answered **ok, attention, fail** or (only where allowed) **not applicable**. Attention and fail need a note.

**Publishing a report** (`validateInspection`) requires:
- every item answered
- at least the category's photo minimum (35, BENCHMARK, D2) and the video (`vehicle.require_video`)
- the odometer reading
- the chassis and engine numbers **read off the vehicle**

If a number read off the vehicle doesn't match the record, the report is still **filed** (so the finding is kept) but **cannot be published** until the vehicle desk resolves it (tested). `summariseInspection` produces the plain text shown above the bid button, for example *"27 checks fine, 1 need attention, 0 failed. Odometer 142,000 km. Tyres: Rear tyres at 3 mm"*.

**A published report never changes.** The database refuses edits and deletes once `published_at` is set, because the report is the evidence the remedy (§4) relies on. A re-inspection is a new report, and the lot page shows the latest.

## 4. The gross-inaccuracy remedy

At collection, or within the claim window (`dispute.claim_window_hours_after_release`), staff verify the buyer's findings. `assessGrossInaccuracy` compares them with the published report. **A gross inaccuracy is any of:**

| Finding | Threshold |
|---|---|
| Chassis or engine number differs from the report | Any difference (after normalising) |
| Odometer differs | More than `vehicle.odometer_tolerance_bp` (10 %, PROPOSED) of the reported reading |
| A material item (★) reported fine or not applicable is failing | Any |

Minor items (paint, tyres and the like) never qualify on their own, because the buyer could see them in the photos and video. A qualifying assessment supports a refund through the disputes module (deliverable 17), using the ledger's `refundToWallet` recipe, with the lot returned to the seller. All of this is tested.

## 5. Viewing slots instead of phone calls

- Staff create consecutive slots per branch, optionally tied to a lot. Default length and capacity come from `viewing.slot_defaults` (30 minutes, 4 people, PROPOSED).
- Buyers book in the app (`bookViewing`) and can cancel. Results are `booked`, `full`, `already_booked` or `past`.
- **Capacity holds even under simultaneous bookings.** The database locks the slot row and counts active bookings before inserting, and a partial unique index allows one active booking per person per slot. In the test, six people book a four-person slot at the same moment and exactly four get in.

## 6. Title tracker

Paying for a vehicle opens a **title case** with three steps, owned by ABC's vehicle desk and due by `vehicle.title_deadline_days` (14, BENCHMARK) ([11 §6](11-close-settlement.md#6-one-tap-payment)):

```
ZRP police clearance  →  ZIMRA clearance  →  CVR change of ownership  →  case complete  →  release at the gate
```

| Rule | Enforced by |
|---|---|
| Steps happen in order | Database trigger: a step can't be marked done before the earlier ones (insert or update) |
| A step needs evidence | Database check: `done` requires an evidence document, who did it, and when |
| A case completes only with all three steps done | Database trigger |
| The vehicle is released only when the case is complete | Lot-state trigger (`title_hold → released`) and the gate service |
| Overdue steps alert the vehicle desk, once each | `alertOverdueTitleSteps` emits `title.step_overdue` per step |

`completeTitleStep` records each step with its evidence and moves the case to `in_progress`, then to `complete` with a `title.complete` event. The agencies have no API (A18): staff record the outcome and upload the evidence.

## 7. Towing partners

Vehicles are not delivered (CONFIRMED). The lot page and the gate pass list active towing partners for the branch, from `logistics.partner` (kind `towing`), with their phone numbers. Partners are listed, not booked, so ABC takes no liability for the tow; booking integration may come with deliverable 15.

## 8. Evidence

| Behaviour | Test (`vehicles.test.ts`) |
|---|---|
| Complete report passes; numbers compared without spaces, dashes or case | Pure |
| Unanswered items, missing notes, disallowed not-applicable answers | Pure |
| Photo, video and odometer requirements | Pure |
| Mismatched or unread numbers block publication | Pure and database |
| Plain summary | Pure |
| Remedy: odometer over 10 %, material item failing, differing engine number; minor items don't qualify | Pure and database |
| Title order and overdue detection | Pure |
| Published report can't change | Database |
| Viewing capacity under simultaneous bookings; one booking per person; cancel frees a place | Database |
| Title steps only in order; case completes after CVR; overdue alerts once | Database |
| Towing partners by branch | Database |
| Paid vehicle held at the gate until title complete | `money-path.test.ts` scenario C |

## 9. Open items

| Item | Owner | Effect until decided |
|---|---|---|
| A37: checklist `vehicle-v1` and its material items | ABC Vehicle Sales | As in §3 |
| A38: gross-inaccuracy thresholds (odometer 10 %, material items) | ABC Commercial / counsel | As in §4 |
| A18: agencies have no API | ABC Vehicle Sales | Staff record steps with evidence |
| Export documents for overseas buyers (blueprint §7: diaspora demand) | ABC Vehicle Sales / counsel | Not yet modelled |
