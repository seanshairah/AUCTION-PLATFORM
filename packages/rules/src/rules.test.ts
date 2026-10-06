import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkBidAmount,
  ladderFor,
  ladderSteps,
  minimumNextBid,
  RULES,
  RuleMissingError,
  RuleSnapshot,
  renderRulebook,
  validateRuleSet,
  type RuleKey,
  type RuleSetDocument,
} from './index';

const INITIAL: RuleSetDocument = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../rulebook/initial-rule-set.json', import.meta.url)), 'utf8'),
);

/** Seed categories (db/seed.sql). */
const CATALOGUE = {
  categories: [
    { code: 'vehicles', taxClass: 'vehicle_standard' },
    { code: 'vehicles_used_zw', taxClass: 'vehicle_used_zw' },
    { code: 'it', taxClass: 'goods_standard' },
    { code: 'catering', taxClass: 'goods_standard' },
    { code: 'furniture', taxClass: 'goods_standard' },
    { code: 'general', taxClass: 'goods_standard' },
    { code: 'special', taxClass: 'goods_standard' },
  ],
};

function clone(doc: RuleSetDocument): RuleSetDocument {
  return structuredClone(doc);
}

function setGlobal(doc: RuleSetDocument, key: RuleKey, value: unknown): RuleSetDocument {
  const d = clone(doc);
  const r = d.rules.find((x) => x.key === key && x.scope.type === 'global');
  if (!r) throw new Error(`no global ${key}`);
  r.value = value;
  return d;
}

const snapshot = new RuleSnapshot('v-initial', INITIAL.label, INITIAL.rules, INITIAL.taxRates);

describe('initial rule set', () => {
  const result = validateRuleSet(INITIAL, { catalogue: CATALOGUE });

  it('has no errors: the rulebook does not contradict itself', () => {
    expect(result.errors).toEqual([]);
  });

  it('has a global default for every registered rule', () => {
    for (const key of Object.keys(RULES) as RuleKey[]) {
      expect(INITIAL.rules.some((r) => r.key === key && r.scope.type === 'global'), key).toBe(true);
    }
  });

  it('flags every placeholder for acknowledgement before publishing', () => {
    const codes = new Set(result.warnings.map((w) => w.code));
    expect(codes).toContain('provenance_benchmark');
    expect(codes).toContain('provenance_assumption');
    expect(codes).toContain('commission_not_set');
    expect(codes).toContain('tax_rate_inactive');
    expect(codes).toContain('currency_not_set');
    // Each benchmark or assumption record produces exactly one acknowledgement.
    const placeholders = INITIAL.rules.filter((r) => r.provenance === 'benchmark' || r.provenance === 'assumption');
    expect(result.warnings.filter((w) => w.code.startsWith('provenance_')).length).toBe(placeholders.length);
  });

  it('carries the CONFIRMED ABC values unchanged', () => {
    expect(snapshot.get('settlement.pay_window_hours')).toBe(48);
    expect(snapshot.get('settlement.collect_window_hours')).toBe(48);
    expect(snapshot.get('limit.deposit_multiplier')).toBe(10);
    expect(snapshot.get('limit.base')).toEqual({ partial: { USD: 10000, ZWG: null }, full: { USD: 50000, ZWG: null } });
    expect(snapshot.get('bidding.soft_close_seconds')).toBe(600);
    expect(snapshot.get('fees.buyers_premium_bp')).toBe(0);
    expect(snapshot.get('delivery.cutoff_local_time')).toBe('14:30');
    expect(snapshot.resolve('settlement.pay_window_hours').provenance).toBe('confirmed');
  });
});

describe('validation catches contradictions', () => {
  const errorsOf = (doc: RuleSetDocument) => validateRuleSet(doc, { catalogue: CATALOGUE }).errors.map((e) => e.code);

  it('rejects a reminder after the payment deadline', () => {
    expect(errorsOf(setGlobal(INITIAL, 'settlement.reminder_offsets_hours', [12, 50]))).toContain('reminder_after_deadline');
  });

  it('rejects reminders out of order', () => {
    expect(errorsOf(setGlobal(INITIAL, 'settlement.reminder_offsets_hours', [36, 12]))).toContain('reminders_not_ascending');
  });

  it('rejects a default ladder out of order', () => {
    const ladder = [
      { step: 'deposit_forfeit', afterDueHours: 0 },
      { step: 'warning', afterDueHours: 24 },
    ];
    expect(errorsOf(setGlobal(INITIAL, 'settlement.default_ladder', ladder))).toContain('ladder_order');
  });

  it('rejects a soft close that is not one of the allowed test values', () => {
    expect(errorsOf(setGlobal(INITIAL, 'bidding.soft_close_seconds', 900))).toContain('soft_close_not_allowed');
  });

  it('rejects storage charges that start before the collection deadline', () => {
    expect(errorsOf(setGlobal(INITIAL, 'storage.free_hours', 24))).toContain('storage_before_collection_deadline');
  });

  it('rejects an increment ladder that does not start at zero or is not ascending', () => {
    const notZero = { USD: [{ from: 100, increment: 100 }], ZWG: null };
    const notAscending = { USD: [{ from: 0, increment: 100 }, { from: 5000, increment: 500 }, { from: 5000, increment: 900 }], ZWG: null };
    expect(errorsOf(setGlobal(INITIAL, 'bidding.increment_ladder', notZero))).toContain('bands_must_start_at_zero');
    expect(errorsOf(setGlobal(INITIAL, 'bidding.increment_ladder', notAscending))).toContain('bands_not_ascending');
  });

  it('rejects values that do not match the rule type', () => {
    expect(errorsOf(setGlobal(INITIAL, 'settlement.pay_window_hours', -1))).toContain('invalid_value');
    expect(errorsOf(setGlobal(INITIAL, 'limit.base', { partial: { USD: 100 } }))).toContain('invalid_value');
  });

  it('rejects unknown keys, missing defaults, disallowed scopes and duplicates', () => {
    const d = clone(INITIAL);
    d.rules.push({ key: 'bidding.made_up', scope: { type: 'global', ref: '*' }, value: 1, provenance: 'proposed', source: 'test entry' });
    d.rules.push({ key: 'settlement.pay_window_hours', scope: { type: 'tier', ref: 'trusted' }, value: 72, provenance: 'proposed', source: 'test entry' });
    d.rules.push({ ...d.rules.find((r) => r.key === 'bidding.proxy_enabled')! });
    d.rules = d.rules.filter((r) => r.key !== 'storage.enabled');
    const codes = errorsOf(d);
    expect(codes).toEqual(expect.arrayContaining(['unknown_key', 'scope_not_allowed', 'duplicate', 'missing_default']));
  });

  it('rejects a category whose tax class has no tax definition', () => {
    const codes = validateRuleSet(INITIAL, {
      catalogue: { categories: [...CATALOGUE.categories, { code: 'art', taxClass: 'art_special' }] },
    }).errors.map((e) => e.code);
    expect(codes).toContain('unknown_tax_class');
  });

  it('rejects overlapping active tax rates', () => {
    const d = clone(INITIAL);
    d.taxRates = [
      { ...d.taxRates[0]!, active: true },
      { ...d.taxRates[0]!, active: true, rateBp: 1400, effectiveFrom: '2026-06-01T00:00:00+02:00' },
    ];
    expect(errorsOf(d)).toContain('tax_rate_overlap');
  });
});

describe('scope resolution', () => {
  it('uses the global default when nothing more specific matches', () => {
    expect(snapshot.get('limit.deposit_multiplier', { tier: 'verified' })).toBe(10);
  });

  it('prefers a tier value for that tier', () => {
    expect(snapshot.get('limit.deposit_multiplier', { tier: 'restricted' })).toBe(1);
    expect(snapshot.get('limit.history_uplift_bp', { tier: 'trusted' })).toBe(2500);
  });

  it('applies a category value to its sub-categories', () => {
    expect(snapshot.get('catalogue.min_photos', { categoryPath: ['general'] })).toBe(4);
    expect(snapshot.get('catalogue.min_photos', { categoryPath: ['vehicles'] })).toBe(35);
    expect(snapshot.get('catalogue.min_photos', { categoryPath: ['vehicles', 'vehicles_used_zw'] })).toBe(35);
  });

  it('lets a deeper category beat its parent', () => {
    const s = new RuleSnapshot('v', 'v', [
      ...INITIAL.rules,
      { key: 'catalogue.min_photos', scope: { type: 'category', ref: 'vehicles_used_zw' }, value: 40, provenance: 'proposed', source: 'test entry' },
    ]);
    expect(s.get('catalogue.min_photos', { categoryPath: ['vehicles', 'vehicles_used_zw'] })).toBe(40);
    expect(s.get('catalogue.min_photos', { categoryPath: ['vehicles'] })).toBe(35);
  });

  it('throws when a rule has no value at all', () => {
    const s = new RuleSnapshot('v', 'v', []);
    expect(() => s.get('settlement.pay_window_hours')).toThrow(RuleMissingError);
  });

  it('refuses to load an invalid value', () => {
    expect(
      () =>
        new RuleSnapshot('v', 'v', [
          { key: 'settlement.pay_window_hours', scope: { type: 'global', ref: '*' }, value: 'two days', provenance: 'proposed', source: 'x' },
        ]),
    ).toThrow();
  });
});

describe('increment ladder', () => {
  const usd = ladderFor(snapshot, 'USD');

  it('starts at the starting bid when there are no bids', () => {
    expect(minimumNextBid({ startingBidMinor: 2_500n, currentPriceMinor: null }, usd)).toBe(2_500n);
  });

  it('adds the increment for the current price band', () => {
    expect(minimumNextBid({ startingBidMinor: 0n, currentPriceMinor: 4_900n }, usd)).toBe(5_000n);   // US$49 + US$1
    expect(minimumNextBid({ startingBidMinor: 0n, currentPriceMinor: 5_000n }, usd)).toBe(5_500n);   // US$50 + US$5
    expect(minimumNextBid({ startingBidMinor: 0n, currentPriceMinor: 120_000n }, usd)).toBe(125_000n); // US$1,200 + US$50
  });

  it('accepts any maximum at or above the minimum and explains a rejection', () => {
    const state = { startingBidMinor: 0n, currentPriceMinor: 10_000n };
    // US$100.00 is in the US$5 band, so the minimum is US$105.00
    expect(checkBidAmount(10_500n, state, usd)).toEqual({ ok: true });
    expect(checkBidAmount(11_234n, state, usd)).toEqual({ ok: true });
    expect(checkBidAmount(10_400n, state, usd)).toEqual({ ok: false, reason: 'below_minimum', minimumMinor: 10_500n });
  });

  it('lists the next steps for quick-bid buttons across a band boundary', () => {
    expect(ladderSteps({ startingBidMinor: 0n, currentPriceMinor: 19_000n }, usd, 3)).toEqual([19_500n, 20_000n, 21_000n]);
  });

  it('refuses ZiG bidding until a ZiG ladder is set', () => {
    expect(() => ladderFor(snapshot, 'ZWG')).toThrow(RuleMissingError);
  });
});

describe('public rulebook rendering', () => {
  const book = renderRulebook(snapshot);
  const all = book.sections.flatMap((s) => s.rules);
  const text = (key: RuleKey) => all.find((r) => r.key === key)?.text;

  it('renders every rule in plain language under its version label', () => {
    expect(book.versionLabel).toBe('2026.11-r1');
    expect(text('settlement.pay_window_hours')).toBe('Pay within 48 hours of the invoice.');
    expect(text('bidding.soft_close_seconds')).toBe("A bid near the end extends the lot's closing time by 10 minutes.");
    expect(text('limit.base')).toBe(
      'Email and phone verified: US$100.00 (ZiG amount not yet set). ID verified as well: US$500.00 (ZiG amount not yet set).',
    );
    expect(text('bidding.increment_ladder')).toBe(
      'Each bid must beat the current price by at least US$1.00 under US$50.00, US$5.00 from US$50.00, US$10.00 from US$200.00, ' +
        'US$50.00 from US$1,000.00, US$100.00 from US$5,000.00, US$250.00 from US$20,000.00. ZiG increments are not yet set.',
    );
    expect(text('settlement.default_ladder')).toBe(
      'When the time to pay runs out, you get a warning; 24 hours after that, your deposit is forfeited and the lot is offered again; 24 hours after that, a relisting fee is charged; 24 hours after that, your account becomes Restricted.',
    );
  });

  it('shows overrides next to the default', () => {
    const photos = all.find((r) => r.key === 'catalogue.min_photos');
    expect(photos?.overrides).toEqual([{ scope: { type: 'category', ref: 'vehicles' }, text: 'Every lot has at least 35 photos.' }]);
  });

  it('keeps internal rules and switched-off rules off the public page', () => {
    expect(text('tax.calculation_order')).toBeUndefined();
    expect(text('bidding.soft_close_allowed_seconds')).toBeUndefined();
    expect(text('storage.daily_rate_bp')).toBeUndefined();
    expect(text('storage.enabled')).toBe('There is no storage charge.');
    const staffView = renderRulebook(snapshot, { includeInternal: true }).sections.flatMap((s) => s.rules);
    expect(staffView.some((r) => r.key === 'tax.calculation_order')).toBe(true);
  });

  it('uses catalogue names and handles singular amounts', () => {
    const named = renderRulebook(snapshot, { context: { categoryName: (c) => ({ it: 'IT and electronics' })[c] ?? c } });
    const t = (k: RuleKey) => named.sections.flatMap((s) => s.rules).find((r) => r.key === k)?.text;
    expect(t('deposit.required_categories')).toBe('You need a deposit to bid in these auctions: vehicles, IT and electronics, catering, special.');
    const restricted = all.find((r) => r.key === 'limit.deposit_multiplier')?.overrides[0]?.text;
    expect(restricted).toBe('Your limit equals your deposit, all-in.');
  });

  it('says plainly when commission is not yet published', () => {
    expect(text('commission.schedule')).toBe('Commission rates are being confirmed and will be published here.');
  });
});
