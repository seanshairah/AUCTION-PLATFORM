import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RuleSnapshot, type RuleRecord, type RuleSetDocument, type TaxRateRecord } from '@abc/rules';
import { commitPreview, QuoteError, quoteLot, sellerProceeds, type LotPricing, type Quote } from './index';

const INITIAL: RuleSetDocument = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../rulebook/initial-rule-set.json', import.meta.url)), 'utf8'),
);

/** Test-only overrides on top of the initial rule set. Never shipped as rules. */
function snapshotWith(overrides: RuleRecord[] = []): RuleSnapshot {
  const rules = INITIAL.rules.filter(
    (r) => !overrides.some((o) => o.key === r.key && o.scope.type === r.scope.type && o.scope.ref === r.scope.ref),
  );
  return new RuleSnapshot('v-test', 'test', [...rules, ...overrides]);
}

function override(key: string, value: unknown, scope: RuleRecord['scope'] = { type: 'global', ref: '*' }): RuleRecord {
  return { key, scope, value, provenance: 'proposed', source: 'test override' };
}

const RATE_CARD = override('delivery.rate_card', { USD: { Harare: { small: 500, medium: 1000, large: 2500 } }, ZWG: {} });

/** The benchmark placeholders, activated for testing the arithmetic only. */
const ACTIVE_RATES: TaxRateRecord[] = INITIAL.taxRates.map((r, i) => ({ ...r, id: `rate-${i}`, active: true }));

const snapshot = snapshotWith([RATE_CARD]);
const AT = new Date('2026-11-15T10:00:00+02:00');

const GOODS: LotPricing = { currency: 'USD', taxClass: 'goods_standard', categoryPath: ['it'], isVehicle: false };
const ZW_VEHICLE: LotPricing = {
  currency: 'USD',
  taxClass: 'vehicle_used_zw',
  categoryPath: ['vehicles', 'vehicles_used_zw'],
  isVehicle: true,
};

function lineAmounts(q: Quote): Record<string, bigint> {
  return Object.fromEntries(q.lines.map((l) => [`${l.type}${l.appliesTo === 'delivery' && l.type !== 'delivery' ? '@delivery' : ''}`, l.amountMinor]));
}

describe('quoteLot: golden examples (placeholder rates, BENCHMARK)', () => {
  it('goods at US$1,000.00: levy 15 % + VAT 15.5 % on hammer', () => {
    const q = quoteLot({ lot: GOODS, hammerMinor: 100_000n, snapshot, taxRates: ACTIVE_RATES, at: AT });
    expect(lineAmounts(q)).toEqual({ hammer: 100_000n, purchasers_levy: 15_000n, vat: 15_500n });
    expect(q.totalMinor).toBe(130_500n);
    expect(q.ruleVersionId).toBe('v-test');
    expect(q.lines.find((l) => l.type === 'vat')).toMatchObject({ description: 'VAT 15.5%', baseMinor: 100_000n, rateBp: 1550, taxRateId: 'rate-1' });
  });

  it('adds delivery with its own tax class (untaxed placeholder): matches the data-model example of US$1,315.00', () => {
    const q = quoteLot({
      lot: GOODS,
      hammerMinor: 100_000n,
      snapshot,
      taxRates: ACTIVE_RATES,
      at: AT,
      delivery: { method: 'delivery', town: 'Harare', sizeClass: 'medium' },
    });
    expect(lineAmounts(q)).toEqual({ hammer: 100_000n, purchasers_levy: 15_000n, vat: 15_500n, delivery: 1_000n });
    expect(q.totalMinor).toBe(131_500n);
  });

  it('Zimbabwe-registered used vehicle: levy only', () => {
    const q = quoteLot({ lot: ZW_VEHICLE, hammerMinor: 500_000n, snapshot, taxRates: ACTIVE_RATES, at: AT });
    expect(lineAmounts(q)).toEqual({ hammer: 500_000n, purchasers_levy: 75_000n });
    expect(q.totalMinor).toBe(575_000n);
  });

  it('a "gross" VAT base includes the levy calculated before it', () => {
    const rates = ACTIVE_RATES.map((r) => (r.taxCode === 'vat' ? { ...r, base: 'gross' as const } : r));
    const q = quoteLot({ lot: GOODS, hammerMinor: 100_000n, snapshot, taxRates: rates, at: AT });
    expect(lineAmounts(q).vat).toBe(17_825n); // 15.5 % of US$1,150.00
    expect(q.totalMinor).toBe(132_825n);
  });

  it("includes a buyer's premium when one is set, and VAT on hammer + premium", () => {
    const s = snapshotWith([RATE_CARD, override('fees.buyers_premium_bp', 500, { type: 'category', ref: 'it' })]);
    const q = quoteLot({ lot: GOODS, hammerMinor: 100_000n, snapshot: s, taxRates: ACTIVE_RATES, at: AT });
    expect(lineAmounts(q)).toEqual({ hammer: 100_000n, buyers_premium: 5_000n, purchasers_levy: 15_000n, vat: 16_275n });
    expect(q.totalMinor).toBe(136_275n);
  });

  it('rounds each line half up to the cent; the total is the sum of the lines', () => {
    const q = quoteLot({ lot: GOODS, hammerMinor: 333n, snapshot, taxRates: ACTIVE_RATES, at: AT });
    expect(lineAmounts(q)).toEqual({ hammer: 333n, purchasers_levy: 50n, vat: 52n }); // 49.95 → 50, 51.615 → 52
    expect(q.totalMinor).toBe(435n);
  });
});

describe('quoteLot: safe defaults refuse to guess', () => {
  it('refuses while tax rates are inactive (Q9: lots cannot go live)', () => {
    expect(() => quoteLot({ lot: GOODS, hammerMinor: 100_000n, snapshot, taxRates: INITIAL.taxRates, at: AT })).toThrow(
      expect.objectContaining({ code: 'TAX_RATE_MISSING' }),
    );
  });

  it('never borrows a USD rate for a ZiG lot', () => {
    const zig: LotPricing = { ...GOODS, currency: 'ZWG' };
    expect(() => quoteLot({ lot: zig, hammerMinor: 100_000n, snapshot, taxRates: ACTIVE_RATES, at: AT })).toThrow(
      expect.objectContaining({ code: 'TAX_RATE_MISSING' }),
    );
  });

  it('refuses an unknown tax class', () => {
    const lot = { ...GOODS, taxClass: 'art_special' };
    expect(() => quoteLot({ lot, hammerMinor: 1n, snapshot, taxRates: ACTIVE_RATES, at: AT })).toThrow(
      expect.objectContaining({ code: 'TAX_CLASS_UNKNOWN' }),
    );
  });

  it('refuses delivery for vehicles and for towns without a price', () => {
    expect(() =>
      quoteLot({
        lot: ZW_VEHICLE,
        hammerMinor: 1n,
        snapshot,
        taxRates: ACTIVE_RATES,
        at: AT,
        delivery: { method: 'delivery', town: 'Harare', sizeClass: 'large' },
      }),
    ).toThrow(expect.objectContaining({ code: 'DELIVERY_UNAVAILABLE' }));
    expect(() =>
      quoteLot({
        lot: GOODS,
        hammerMinor: 1n,
        snapshot,
        taxRates: ACTIVE_RATES,
        at: AT,
        delivery: { method: 'delivery', town: 'Mutare', sizeClass: 'small' },
      }),
    ).toThrow(expect.objectContaining({ code: 'DELIVERY_UNAVAILABLE' }));
  });

  it('refuses a negative hammer price', () => {
    expect(() => quoteLot({ lot: GOODS, hammerMinor: -1n, snapshot, taxRates: ACTIVE_RATES, at: AT })).toThrow(QuoteError);
  });
});

describe('quoteLot: effective dating', () => {
  const vatChange: TaxRateRecord[] = [
    ...ACTIVE_RATES.filter((r) => !(r.taxCode === 'vat' && r.taxClass === 'goods_standard')),
    { ...ACTIVE_RATES[1]!, id: 'vat-old', effectiveTo: '2026-12-01T00:00:00+02:00' },
    { ...ACTIVE_RATES[1]!, id: 'vat-new', rateBp: 1600, effectiveFrom: '2026-12-01T00:00:00+02:00' },
  ];

  it('uses the rate in force at the given moment', () => {
    const before = quoteLot({ lot: GOODS, hammerMinor: 100_000n, snapshot, taxRates: vatChange, at: new Date('2026-11-30T23:59:59+02:00') });
    const after = quoteLot({ lot: GOODS, hammerMinor: 100_000n, snapshot, taxRates: vatChange, at: new Date('2026-12-01T00:00:00+02:00') });
    expect(before.lines.find((l) => l.type === 'vat')).toMatchObject({ amountMinor: 15_500n, taxRateId: 'vat-old' });
    expect(after.lines.find((l) => l.type === 'vat')).toMatchObject({ amountMinor: 16_000n, taxRateId: 'vat-new' });
  });

  it('an invoice quoted at hammer time keeps the old rate even if issued after the change', () => {
    const hammerTime = new Date('2026-11-30T20:00:00+02:00');
    const q = quoteLot({ lot: GOODS, hammerMinor: 100_000n, snapshot, taxRates: vatChange, at: hammerTime });
    expect(q.taxedAt).toBe(hammerTime.toISOString());
    expect(q.lines.find((l) => l.type === 'vat')?.taxRateId).toBe('vat-old');
  });
});

describe('quoteLot: properties', () => {
  const amounts = [0n, 1n, 99n, 333n, 4_999n, 5_000n, 12_345n, 100_000n, 999_999n, 25_000_000n];

  it('total always equals the sum of the lines (the invoice constraint)', () => {
    for (const hammerMinor of amounts) {
      const q = quoteLot({ lot: GOODS, hammerMinor, snapshot, taxRates: ACTIVE_RATES, at: AT });
      expect(q.totalMinor).toBe(q.lines.reduce((a, l) => a + l.amountMinor, 0n));
    }
  });

  it('a higher bid never costs less', () => {
    let previous = -1n;
    for (let h = 0n; h <= 20_000n; h += 7n) {
      const total = quoteLot({ lot: GOODS, hammerMinor: h, snapshot, taxRates: ACTIVE_RATES, at: AT }).totalMinor;
      expect(total >= previous).toBe(true);
      previous = total;
    }
  });

  it('is deterministic: the same inputs give the same quote', () => {
    const a = quoteLot({ lot: GOODS, hammerMinor: 12_345n, snapshot, taxRates: ACTIVE_RATES, at: AT });
    const b = quoteLot({ lot: GOODS, hammerMinor: 12_345n, snapshot, taxRates: ACTIVE_RATES, at: AT });
    expect(a).toEqual(b);
  });
});

describe('sellerProceeds', () => {
  it('refuses to calculate until commission is published (Q3)', () => {
    expect(() => sellerProceeds({ lot: GOODS, hammerMinor: 100_000n, snapshot })).toThrow(
      expect.objectContaining({ code: 'COMMISSION_NOT_SET' }),
    );
  });

  const marginal = snapshotWith([
    override('commission.schedule', {
      basis: 'marginal',
      bands: { USD: [{ from: 0, rateBp: 1500 }, { from: 100_000, rateBp: 1000 }], ZWG: null },
      minimumPerLot: { USD: 500, ZWG: null },
    }),
  ]);

  it('marginal bands charge each portion of the price at its own rate', () => {
    const p = sellerProceeds({ lot: GOODS, hammerMinor: 150_000n, snapshot: marginal });
    // 15 % of the first US$1,000 + 10 % of the next US$500
    expect(p.lines).toEqual([
      { type: 'hammer', description: 'Hammer price', amountMinor: 150_000n },
      { type: 'commission', description: 'Commission', amountMinor: -20_000n },
    ]);
    expect(p.netMinor).toBe(130_000n);
  });

  it('flat bands charge the whole price at the band it falls in', () => {
    const flat = snapshotWith([
      override('commission.schedule', {
        basis: 'flat_band',
        bands: { USD: [{ from: 0, rateBp: 1500 }, { from: 100_000, rateBp: 1000 }], ZWG: null },
        minimumPerLot: { USD: 0, ZWG: null },
      }),
    ]);
    expect(sellerProceeds({ lot: GOODS, hammerMinor: 150_000n, snapshot: flat }).netMinor).toBe(135_000n);
  });

  it('applies the minimum commission, but never more than the hammer price', () => {
    expect(sellerProceeds({ lot: GOODS, hammerMinor: 1_000n, snapshot: marginal }).netMinor).toBe(500n); // US$5 minimum
    expect(sellerProceeds({ lot: GOODS, hammerMinor: 300n, snapshot: marginal }).netMinor).toBe(0n);
  });

  it('refuses ZiG until ZiG bands are published', () => {
    expect(() => sellerProceeds({ lot: { ...GOODS, currency: 'ZWG' }, hammerMinor: 1_000n, snapshot: marginal })).toThrow(
      expect.objectContaining({ code: 'COMMISSION_NOT_SET' }),
    );
  });
});

describe('commitPreview: the total as the amount is typed', () => {
  const base = {
    lot: GOODS,
    snapshot,
    taxRates: ACTIVE_RATES,
    at: AT,
    lotState: { startingBidMinor: 5_000n, currentPriceMinor: 10_000n }, // US$100.00 now, next US$105.00
  };

  it('asks for an amount when the field is empty', () => {
    expect(commitPreview({ ...base, typed: '' })).toMatchObject({ status: 'empty', message: 'Enter your maximum bid.' });
  });

  it('explains a typing mistake in plain words', () => {
    expect(commitPreview({ ...base, typed: '12.345' })).toMatchObject({ status: 'invalid', message: 'Use at most two decimal places.' });
  });

  it('shows the minimum when the amount is too low', () => {
    expect(commitPreview({ ...base, typed: '101' })).toMatchObject({
      status: 'below_minimum',
      minimumMinor: 10_500n,
      message: 'The lowest bid you can place is US$105.00.',
    });
  });

  it('shows the all-in total for a valid amount', () => {
    const p = commitPreview({ ...base, typed: '1,000' });
    expect(p).toMatchObject({
      status: 'ok',
      amountMinor: 100_000n,
      message: 'If you win at US$1,000.00, you pay US$1,305.00 in total. You may win for less.',
    });
  });

  it('checks the limit against the all-in total, not the hammer price', () => {
    // US$1,000 hammer fits a US$1,200 limit, but US$1,305 all-in does not.
    const p = commitPreview({ ...base, typed: '1000', availableToBidMinor: 120_000n });
    expect(p).toMatchObject({
      status: 'over_limit',
      message: 'At US$1,000.00 you would pay US$1,305.00 in total. You can bid up to US$1,200.00 in total. Add a deposit to bid higher.',
    });
  });

  it('pauses bidding rather than show a total it cannot compute', () => {
    expect(commitPreview({ ...base, taxRates: INITIAL.taxRates, typed: '1000' })).toMatchObject({
      status: 'unavailable',
      message: 'We cannot show the full price for this lot right now, so bidding is paused.',
    });
  });

  it('says ZiG bidding is not open while there is no ZiG ladder', () => {
    expect(commitPreview({ ...base, lot: { ...GOODS, currency: 'ZWG' }, typed: '1000' })).toMatchObject({ status: 'unavailable' });
  });
});
