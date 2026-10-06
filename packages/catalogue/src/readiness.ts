import type { Currency } from '@abc/domain';
import { QuoteError, quoteLot } from '@abc/quote';
import { ladderFor, RuleMissingError, type RuleSnapshot, type TaxRateRecord } from '@abc/rules';

/**
 * Can this lot go live? The Phase 2 gate is "all-in price on every lot"
 * (blueprint §9), and principle 6 is "evidence for goods unseen". A lot with any
 * blocker stays in draft or listed and cannot open for bids.
 * Specification: docs/05-catalogue-lot-page.md §4.
 */

export interface ReadinessInput {
  lot: {
    title: string;
    description: string;
    categoryPath: readonly string[];
    itemState: string;
    condition: string;
    conditionNotes?: string | null;
    currency: Currency;
    taxClass: string;
    isVehicle: boolean;
    startingBidMinor: bigint;
    reserveMinor: bigint | null;
  };
  media: ReadonlyArray<{ kind: 'photo' | 'video' | 'document'; role: string }>;
  vehicle?: { chassisNumber: string; zimbabweRegistered: boolean } | null;
  inspection?: { published: boolean; photoCount: number; hasVideo: boolean; chassisVerified: boolean } | null;
  vocabulary: { itemStates: readonly string[]; conditions: readonly string[] };
  snapshot: RuleSnapshot;
  taxRates: readonly TaxRateRecord[];
  at: Date;
}

export type ReadinessCode =
  | 'title_missing'
  | 'description_too_short'
  | 'unknown_item_state'
  | 'unknown_condition'
  | 'condition_notes_required'
  | 'too_few_photos'
  | 'missing_photo_roles'
  | 'defect_photo_missing'
  | 'all_in_price_unavailable'
  | 'bidding_not_open_in_currency'
  | 'vehicle_details_missing'
  | 'inspection_missing'
  | 'inspection_too_few_photos'
  | 'inspection_video_missing'
  | 'inspection_chassis_unverified'
  | 'reserve_below_starting_bid';

export interface ReadinessIssue {
  code: ReadinessCode;
  message: string;
}

export interface Readiness {
  ready: boolean;
  blockers: ReadinessIssue[];
  warnings: ReadinessIssue[];
}

export function checkListingReadiness(input: ReadinessInput): Readiness {
  const { lot, snapshot } = input;
  const ctx = { currency: lot.currency, categoryPath: lot.categoryPath };
  const blockers: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];
  const block = (code: ReadinessCode, message: string) => blockers.push({ code, message });

  // Words
  if (lot.title.trim().length < 5) block('title_missing', 'Give the lot a title that says what it is.');
  const minChars = snapshot.get('catalogue.min_description_chars', ctx);
  if (lot.description.trim().length < minChars) {
    block('description_too_short', `The description needs at least ${minChars} characters.`);
  }

  // Fixed vocabulary (blueprint module 11)
  if (!input.vocabulary.itemStates.includes(lot.itemState)) {
    block('unknown_item_state', `"${lot.itemState}" is not in the item state vocabulary.`);
  }
  if (!input.vocabulary.conditions.includes(lot.condition)) {
    block('unknown_condition', `"${lot.condition}" is not in the condition vocabulary.`);
  }
  const defectConditions = snapshot.get('catalogue.defect_photo_conditions', ctx);
  const hasFaults = defectConditions.includes(lot.condition);
  if (hasFaults && !(lot.conditionNotes && lot.conditionNotes.trim().length >= 10)) {
    block('condition_notes_required', 'Describe each fault in the condition notes.');
  }

  // Photos (principle 6)
  const photos = input.media.filter((m) => m.kind === 'photo');
  const minPhotos = snapshot.get('catalogue.min_photos', ctx);
  if (photos.length < minPhotos) block('too_few_photos', `Add photos: ${photos.length} of at least ${minPhotos}.`);
  const roles = new Set(photos.map((p) => p.role));
  const missingRoles = snapshot.get('catalogue.required_photo_roles', ctx).filter((r) => !roles.has(r));
  if (missingRoles.length > 0) {
    block('missing_photo_roles', `Missing required photos: ${missingRoles.map((r) => r.replaceAll('_', ' ')).join(', ')}.`);
  }
  if (hasFaults && !roles.has('defect')) block('defect_photo_missing', 'Add a photo of each fault (role "defect").');

  // The all-in price must be computable (Phase 2 gate)
  try {
    ladderFor(snapshot, lot.currency, ctx);
  } catch (e) {
    if (!(e instanceof RuleMissingError)) throw e;
    block('bidding_not_open_in_currency', `Bidding in ${lot.currency} is not open yet: no increment ladder.`);
  }
  try {
    quoteLot({
      lot: { currency: lot.currency, taxClass: lot.taxClass, categoryPath: lot.categoryPath, isVehicle: lot.isVehicle },
      hammerMinor: lot.startingBidMinor,
      snapshot,
      taxRates: input.taxRates,
      at: input.at,
    });
  } catch (e) {
    if (!(e instanceof QuoteError)) throw e;
    block('all_in_price_unavailable', `The all-in price cannot be shown: ${e.message}.`);
  }

  // Vehicles (blueprint module 8)
  if (lot.isVehicle) {
    if (!input.vehicle || input.vehicle.chassisNumber.trim() === '') {
      block('vehicle_details_missing', 'Add the vehicle details, including the chassis number.');
    }
    const inspection = input.inspection;
    if (!inspection || !inspection.published) {
      block('inspection_missing', 'Publish the inspection report before the vehicle goes live.');
    } else {
      if (inspection.photoCount < minPhotos) {
        block('inspection_too_few_photos', `The inspection report has ${inspection.photoCount} photos; at least ${minPhotos} are needed.`);
      }
      if (snapshot.get('vehicle.require_video', ctx) && !inspection.hasVideo) {
        block('inspection_video_missing', 'Add the inspection video.');
      }
      if (!inspection.chassisVerified) {
        block('inspection_chassis_unverified', 'The inspector must check the chassis number against the vehicle.');
      }
    }
  }

  // Warnings
  if (lot.reserveMinor !== null && lot.reserveMinor <= lot.startingBidMinor) {
    warnings.push({
      code: 'reserve_below_starting_bid',
      message: 'The reserve is at or below the starting bid, so it has no effect. Remove it or raise it.',
    });
  }

  return { ready: blockers.length === 0, blockers, warnings };
}
