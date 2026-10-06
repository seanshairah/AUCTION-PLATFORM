import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RuleSnapshot, type RuleSetDocument, type TaxRateRecord } from '@abc/rules';
import { checkListingReadiness, lotStructuredData, matchesSavedSearch, type ReadinessInput } from './index';

const INITIAL: RuleSetDocument = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../rulebook/initial-rule-set.json', import.meta.url)), 'utf8'),
);
const snapshot = new RuleSnapshot('v', INITIAL.label, INITIAL.rules);
const ACTIVE: TaxRateRecord[] = INITIAL.taxRates.map((r) => ({ ...r, active: true }));
const VOCAB = {
  itemStates: ['new', 'new_open_box', 'used', 'renewed'],
  conditions: ['as_is', 'working', 'untested', 'partly_working', 'damaged', 'broken', 'incomplete', 'sealed_packing', 'not_working'],
};

function photos(...roles: string[]) {
  return roles.map((role) => ({ kind: 'photo' as const, role }));
}

const GOOD_LOT: ReadinessInput = {
  lot: {
    title: 'Dell Latitude 5420 laptop',
    description: 'Intel i5, 16 GB RAM, 512 GB SSD. Charger included. Small scratch on the lid.',
    categoryPath: ['it'],
    itemState: 'used',
    condition: 'working',
    currency: 'USD',
    taxClass: 'goods_standard',
    isVehicle: false,
    startingBidMinor: 5_000n,
    reserveMinor: null,
  },
  media: photos('overall', 'label', 'detail', 'detail'),
  vocabulary: VOCAB,
  snapshot,
  taxRates: ACTIVE,
  at: new Date('2026-11-15T10:00:00+02:00'),
};

const codes = (input: ReadinessInput) => checkListingReadiness(input).blockers.map((b) => b.code);

describe('listing readiness: the Phase 2 gate', () => {
  it('passes a complete goods lot', () => {
    expect(checkListingReadiness(GOOD_LOT)).toEqual({ ready: true, blockers: [], warnings: [] });
  });

  it('blocks every lot while tax rates are inactive: no all-in price, no listing (Q9)', () => {
    expect(codes({ ...GOOD_LOT, taxRates: INITIAL.taxRates })).toEqual(['all_in_price_unavailable']);
  });

  it('blocks a ZiG lot while there is no ZiG ladder or ZiG tax rate', () => {
    expect(codes({ ...GOOD_LOT, lot: { ...GOOD_LOT.lot, currency: 'ZWG' } })).toEqual([
      'bidding_not_open_in_currency',
      'all_in_price_unavailable',
    ]);
  });

  it('requires the minimum photo set and the required angles', () => {
    expect(codes({ ...GOOD_LOT, media: photos('overall', 'detail') })).toEqual(['too_few_photos', 'missing_photo_roles']);
  });

  it('requires a fault photo and notes for lots with faults', () => {
    const damaged = { ...GOOD_LOT, lot: { ...GOOD_LOT.lot, condition: 'damaged' } };
    expect(codes(damaged)).toEqual(['condition_notes_required', 'defect_photo_missing']);
    expect(
      codes({
        ...damaged,
        lot: { ...damaged.lot, conditionNotes: 'Cracked screen corner, bottom left.' },
        media: photos('overall', 'label', 'defect', 'detail'),
      }),
    ).toEqual([]);
  });

  it('only accepts the fixed vocabulary', () => {
    expect(codes({ ...GOOD_LOT, lot: { ...GOOD_LOT.lot, condition: 'like new' } })).toContain('unknown_condition');
    expect(codes({ ...GOOD_LOT, lot: { ...GOOD_LOT.lot, itemState: 'mint' } })).toContain('unknown_item_state');
  });

  it('requires a real title and description', () => {
    expect(codes({ ...GOOD_LOT, lot: { ...GOOD_LOT.lot, title: 'Lot', description: 'Laptop.' } })).toEqual([
      'title_missing',
      'description_too_short',
    ]);
  });

  it('warns when a reserve has no effect', () => {
    const r = checkListingReadiness({ ...GOOD_LOT, lot: { ...GOOD_LOT.lot, reserveMinor: 5_000n } });
    expect(r.ready).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['reserve_below_starting_bid']);
  });
});

describe('listing readiness: vehicles', () => {
  const VEHICLE_ROLES = ['front', 'rear', 'left_side', 'right_side', 'interior_front', 'interior_rear', 'dashboard_odometer', 'engine_bay', 'chassis_plate', 'tyres', 'boot'];
  const vehicle: ReadinessInput = {
    ...GOOD_LOT,
    lot: {
      ...GOOD_LOT.lot,
      title: 'Toyota Hilux 2.4 GD-6 2019',
      description: 'Double cab, manual, 142,000 km. Registered in Zimbabwe. Sold as is.',
      categoryPath: ['vehicles', 'vehicles_used_zw'],
      condition: 'as_is',
      taxClass: 'vehicle_used_zw',
      isVehicle: true,
      startingBidMinor: 1_000_000n,
    },
    media: photos(...VEHICLE_ROLES, ...Array.from({ length: 24 }, () => 'detail')),
    vehicle: { chassisNumber: 'AHTKB8CD802912345', zimbabweRegistered: true },
    inspection: { published: true, photoCount: 40, hasVideo: true, chassisVerified: true },
  };

  it('passes a vehicle with 35 photos, all angles, and a published inspection report', () => {
    expect(codes(vehicle)).toEqual([]);
  });

  it('blocks a vehicle without a published inspection report', () => {
    expect(codes({ ...vehicle, inspection: null })).toEqual(['inspection_missing']);
    expect(codes({ ...vehicle, inspection: { ...vehicle.inspection!, published: false } })).toEqual(['inspection_missing']);
  });

  it('requires the inspection video, enough photos and a checked chassis number', () => {
    expect(codes({ ...vehicle, inspection: { published: true, photoCount: 20, hasVideo: false, chassisVerified: false } })).toEqual([
      'inspection_too_few_photos',
      'inspection_video_missing',
      'inspection_chassis_unverified',
    ]);
  });

  it('needs 35 photos for a vehicle lot, not the goods minimum of 4', () => {
    expect(codes({ ...vehicle, media: photos(...VEHICLE_ROLES) })).toEqual(['too_few_photos']);
  });
});

describe('structured data for search engines', () => {
  it('describes a live lot as a Product with an Offer in its own currency', () => {
    const data = lotStructuredData({
      lotRef: 'HRE-26-004512',
      title: 'Dell Latitude 5420 laptop',
      description: 'Intel i5, 16 GB RAM.',
      itemState: 'used',
      condition: 'working',
      categoryName: 'IT and electronics',
      currency: 'ZWG',
      priceMinor: 123_450n,
      endAt: new Date('2026-11-20T18:00:00Z'),
      status: 'live',
      url: 'https://example.test/lots/HRE-26-004512',
      imageUrls: ['https://example.test/i/1.webp'],
      branchCity: 'Harare',
    });
    expect(data).toMatchObject({
      '@type': 'Product',
      sku: 'HRE-26-004512',
      itemCondition: 'https://schema.org/UsedCondition',
      offers: { priceCurrency: 'ZWG', price: '1234.50', availability: 'https://schema.org/InStock', availabilityEnds: '2026-11-20T18:00:00.000Z' },
    });
  });

  it('marks damaged goods and sold lots honestly', () => {
    const data = lotStructuredData({
      lotRef: 'x', title: 'x', description: 'x', itemState: 'used', condition: 'broken', categoryName: 'x',
      currency: 'USD', priceMinor: 5n, endAt: new Date(0), status: 'closed', url: 'x', imageUrls: [], branchCity: 'Bulawayo',
    }) as { itemCondition: string; offers: { price: string; availability: string } };
    expect(data.itemCondition).toBe('https://schema.org/DamagedCondition');
    expect(data.offers.price).toBe('0.05');
    expect(data.offers.availability).toBe('https://schema.org/SoldOut');
  });
});

describe('saved searches', () => {
  const lot = {
    title: 'Toyota Hilux double cab',
    description: 'Manual, diesel, Harare branch.',
    categoryPath: ['vehicles', 'vehicles_used_zw'],
    branch: 'HRE',
    currency: 'USD' as const,
    priceMinor: 1_000_000n,
    itemState: 'used',
    condition: 'as_is',
  };

  it('matches every word, the category tree and the branch', () => {
    expect(matchesSavedSearch({ text: 'hilux diesel', categories: ['vehicles'], branches: ['HRE'] }, lot)).toBe(true);
    expect(matchesSavedSearch({ text: 'hilux petrol' }, lot)).toBe(false);
    expect(matchesSavedSearch({ categories: ['it'] }, lot)).toBe(false);
    expect(matchesSavedSearch({ branches: ['BYO'] }, lot)).toBe(false);
  });

  it('applies a price limit only within its own currency', () => {
    expect(matchesSavedSearch({ currency: 'USD', maxPriceMinor: 1_200_000n }, lot)).toBe(true);
    expect(matchesSavedSearch({ currency: 'USD', maxPriceMinor: 900_000n }, lot)).toBe(false);
    expect(matchesSavedSearch({ currency: 'ZWG', maxPriceMinor: 99_000_000n }, lot)).toBe(false);
    expect(matchesSavedSearch({ maxPriceMinor: 99_000_000n }, lot)).toBe(false); // no currency, no comparison
  });
});
