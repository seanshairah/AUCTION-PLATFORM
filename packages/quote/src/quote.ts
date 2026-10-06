import { applyBasisPoints, type Currency } from '@abc/domain';
import {
  RuleMissingError,
  type CommissionBands,
  type RuleSnapshot,
  type ScopeContext,
  type TaxCode,
  type TaxRateRecord,
} from '@abc/rules';

/**
 * The QuoteService: one pure function for every figure a buyer or seller sees
 * about a lot's price (architecture rule R2). The lot page, the commit screen,
 * the invoice engine and the seller's calculator all call these functions with
 * the same rule snapshot, so the screen can never disagree with the bill.
 *
 * Specification: docs/04-fee-tax-engine.md
 */

export type QuoteErrorCode =
  | 'RULE_MISSING'
  | 'TAX_CLASS_UNKNOWN'
  | 'TAX_RATE_MISSING'
  | 'DELIVERY_UNAVAILABLE'
  | 'COMMISSION_NOT_SET'
  | 'NEGATIVE_AMOUNT';

export class QuoteError extends Error {
  constructor(
    readonly code: QuoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'QuoteError';
  }
}

export type BuyerLineType = 'hammer' | 'buyers_premium' | TaxCode | 'delivery';

export interface QuoteLine {
  type: BuyerLineType;
  description: string;
  amountMinor: bigint;
  baseMinor?: bigint;
  rateBp?: number;
  taxRateId?: string;
  /** Which priced item the line belongs to: the lot or its delivery. */
  appliesTo: 'lot' | 'delivery';
}

export interface Quote {
  currency: Currency;
  lines: QuoteLine[];
  totalMinor: bigint;
  ruleVersionId: string;
  /** The moment whose tax rates were used (hammer time for invoices, now for previews). */
  taxedAt: string;
}

export type DeliveryChoice =
  | { method: 'collect' }
  | { method: 'delivery'; town: string; sizeClass: 'small' | 'medium' | 'large' };

export interface LotPricing {
  currency: Currency;
  taxClass: string;
  /** Category codes from root to leaf. */
  categoryPath: readonly string[];
  isVehicle: boolean;
}

export interface QuoteInput {
  lot: LotPricing;
  hammerMinor: bigint;
  snapshot: RuleSnapshot;
  /** Effective tax rates; only active rows covering `at` are used. */
  taxRates: readonly TaxRateRecord[];
  at: Date;
  delivery?: DeliveryChoice;
  /** Tax codes this buyer is exempt from, with evidence held elsewhere. None by default. */
  buyerExemptTaxCodes?: readonly TaxCode[];
}

const LINE_LABEL: Record<TaxCode, string> = {
  purchasers_levy: "Purchaser's levy",
  vat: 'VAT',
  imtt: 'IMTT',
  transfer_tax: 'Transfer tax',
};

/** Taxes charged on money transfers, not on goods: not part of a lot's price. */
const TRANSFER_TAXES: readonly TaxCode[] = ['imtt', 'transfer_tax'];

function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RuleMissingError) throw new QuoteError('RULE_MISSING', e.message);
    throw e;
  }
}

function formatRate(bp: number): string {
  return `${(bp / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

export function findTaxRate(
  rates: readonly TaxRateRecord[],
  code: TaxCode,
  taxClass: string,
  currency: Currency,
  at: Date,
): TaxRateRecord | undefined {
  const t = at.getTime();
  return rates.find(
    (r) =>
      r.active &&
      r.taxCode === code &&
      r.taxClass === taxClass &&
      r.currency === currency &&
      Date.parse(r.effectiveFrom) <= t &&
      (!r.effectiveTo || Date.parse(r.effectiveTo) > t),
  );
}

/**
 * Tax lines for one priced item. `chargeMinor` is the item's price before tax,
 * `premiumMinor` is its buyer's premium (0 for delivery).
 */
function taxLines(
  input: QuoteInput,
  taxClass: string,
  chargeMinor: bigint,
  premiumMinor: bigint,
  appliesTo: QuoteLine['appliesTo'],
): QuoteLine[] {
  const { lot, snapshot } = input;
  const ctx: ScopeContext = { currency: lot.currency, categoryPath: lot.categoryPath };
  const classCodes = rule(() => snapshot.get('tax.class_codes', ctx));
  const codes = classCodes[taxClass];
  if (!codes) throw new QuoteError('TAX_CLASS_UNKNOWN', `Tax class ${taxClass} is not defined in the rulebook`);
  const order = rule(() => snapshot.get('tax.calculation_order', ctx));
  const exempt = new Set(input.buyerExemptTaxCodes ?? []);

  const lines: QuoteLine[] = [];
  let priorTaxes = 0n;
  for (const code of order) {
    if (!codes.includes(code) || TRANSFER_TAXES.includes(code) || exempt.has(code)) continue;
    const rate = findTaxRate(input.taxRates, code, taxClass, lot.currency, input.at);
    if (!rate) {
      throw new QuoteError(
        'TAX_RATE_MISSING',
        `No active ${code} rate for tax class ${taxClass} in ${lot.currency} at ${input.at.toISOString()}`,
      );
    }
    const base =
      rate.base === 'hammer'
        ? chargeMinor
        : rate.base === 'hammer_plus_premium'
          ? chargeMinor + premiumMinor
          : chargeMinor + premiumMinor + priorTaxes; // 'gross': includes taxes calculated before this one
    const amount = applyBasisPoints(base, rate.rateBp);
    lines.push({
      type: code,
      description: `${LINE_LABEL[code]} ${formatRate(rate.rateBp)}${appliesTo === 'delivery' ? ' on delivery' : ''}`,
      amountMinor: amount,
      baseMinor: base,
      rateBp: rate.rateBp,
      ...(rate.id ? { taxRateId: rate.id } : {}),
      appliesTo,
    });
    priorTaxes += amount;
  }
  return lines;
}

/**
 * The all-in price a buyer pays for one lot at a given hammer price.
 * Used with the typed amount on the commit screen and with the final hammer
 * price by the invoice engine.
 */
export function quoteLot(input: QuoteInput): Quote {
  const { lot, snapshot, hammerMinor } = input;
  if (hammerMinor < 0n) throw new QuoteError('NEGATIVE_AMOUNT', 'A hammer price cannot be negative');
  const ctx: ScopeContext = { currency: lot.currency, categoryPath: lot.categoryPath };

  const lines: QuoteLine[] = [{ type: 'hammer', description: 'Hammer price', amountMinor: hammerMinor, appliesTo: 'lot' }];

  const premiumBp = rule(() => snapshot.get('fees.buyers_premium_bp', ctx));
  const premium = applyBasisPoints(hammerMinor, premiumBp);
  if (premiumBp > 0) {
    lines.push({
      type: 'buyers_premium',
      description: `Buyer's premium ${formatRate(premiumBp)}`,
      amountMinor: premium,
      baseMinor: hammerMinor,
      rateBp: premiumBp,
      appliesTo: 'lot',
    });
  }

  lines.push(...taxLines(input, lot.taxClass, hammerMinor, premium, 'lot'));

  if (input.delivery?.method === 'delivery') {
    const { town, sizeClass } = input.delivery;
    const excluded = rule(() => snapshot.get('delivery.excluded_categories', ctx));
    if (lot.isVehicle || lot.categoryPath.some((c) => excluded.includes(c))) {
      throw new QuoteError('DELIVERY_UNAVAILABLE', 'This lot cannot be delivered; it must be collected');
    }
    const card = rule(() => snapshot.get('delivery.rate_card', ctx))[lot.currency];
    const price = card[town]?.[sizeClass];
    if (price === undefined) {
      throw new QuoteError('DELIVERY_UNAVAILABLE', `No ${sizeClass} delivery price to ${town} in ${lot.currency}`);
    }
    const deliveryMinor = BigInt(price);
    lines.push({ type: 'delivery', description: `Delivery to ${town}`, amountMinor: deliveryMinor, appliesTo: 'delivery' });
    const deliveryClass = rule(() => snapshot.get('delivery.tax_class', ctx));
    lines.push(...taxLines(input, deliveryClass, deliveryMinor, 0n, 'delivery'));
  }

  return {
    currency: lot.currency,
    lines,
    totalMinor: lines.reduce((acc, l) => acc + l.amountMinor, 0n),
    ruleVersionId: snapshot.versionId,
    taxedAt: input.at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Seller side
// ---------------------------------------------------------------------------

export interface SellerLine {
  type: 'hammer' | 'commission';
  description: string;
  amountMinor: bigint; // + proceeds, − deductions
}

export interface SellerProceeds {
  currency: Currency;
  lines: SellerLine[];
  netMinor: bigint;
  ruleVersionId: string;
}

function commissionFor(hammer: bigint, basis: 'marginal' | 'flat_band', bands: CommissionBands): bigint {
  if (basis === 'flat_band') {
    let rate = 0;
    for (const b of bands) if (BigInt(b.from) <= hammer) rate = b.rateBp;
    return applyBasisPoints(hammer, rate);
  }
  // Marginal: each band's rate applies only to the part of the price inside that band.
  let total = 0n;
  for (let i = 0; i < bands.length; i++) {
    const from = BigInt(bands[i]!.from);
    if (hammer <= from) break;
    const to = i + 1 < bands.length ? BigInt(bands[i + 1]!.from) : hammer;
    const slice = (hammer < to ? hammer : to) - from;
    total += slice * BigInt(bands[i]!.rateBp);
  }
  // Round once on the total, half up, to avoid accumulating per-band rounding.
  return (total + 5000n) / 10000n;
}

/** What a seller receives for a lot at a given hammer price: the published commission calculator. */
export function sellerProceeds(input: {
  lot: Pick<LotPricing, 'currency' | 'categoryPath'>;
  hammerMinor: bigint;
  snapshot: RuleSnapshot;
}): SellerProceeds {
  const { lot, hammerMinor, snapshot } = input;
  if (hammerMinor < 0n) throw new QuoteError('NEGATIVE_AMOUNT', 'A hammer price cannot be negative');
  const schedule = rule(() => snapshot.get('commission.schedule', { currency: lot.currency, categoryPath: lot.categoryPath }));
  const bands = schedule?.bands[lot.currency];
  if (!schedule || !bands) {
    throw new QuoteError('COMMISSION_NOT_SET', `Commission for ${lot.currency} is not yet published, so proceeds cannot be calculated`);
  }
  let commission = commissionFor(hammerMinor, schedule.basis, bands);
  const minimum = schedule.minimumPerLot[lot.currency];
  if (minimum !== null && hammerMinor > 0n && commission < BigInt(minimum)) commission = BigInt(minimum);
  if (commission > hammerMinor) commission = hammerMinor; // never more than the lot sold for

  const lines: SellerLine[] = [
    { type: 'hammer', description: 'Hammer price', amountMinor: hammerMinor },
    { type: 'commission', description: 'Commission', amountMinor: -commission },
  ];
  return {
    currency: lot.currency,
    lines,
    netMinor: hammerMinor - commission,
    ruleVersionId: snapshot.versionId,
  };
}
