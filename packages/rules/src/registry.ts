import { z } from 'zod';
import { formatMinor, type Currency } from '@abc/domain';
import { AUCTION_FORMATS, TAX_CODES, TIERS, type ScopeType } from './types';

/**
 * The registry of every rule the System reads. A rule that is not registered here
 * cannot be published, and every registered rule must have a global default.
 * Semantics: docs/03-rulebook-service.md §4 and §10.
 */

export const OWNERS = ['finance', 'operations', 'risk', 'product'] as const;
export type Owner = (typeof OWNERS)[number];

export const SECTIONS = [
  'Bidding',
  'Registration and limits',
  'Deposits',
  'Paying and collecting',
  'Fees, commission and tax',
  'Delivery and storage',
  'Lots and vehicles',
  'Messages',
  'Security and overrides',
  'Disputes',
] as const;
export type Section = (typeof SECTIONS)[number];

/** Names the renderer may need (category display names come from the catalogue). */
export interface RenderContext {
  categoryName: (code: string) => string;
}

interface RuleDefinition<S extends z.ZodType> {
  title: string;
  section: Section;
  owner: Owner;
  schema: S;
  /** Scope types this rule may be set for. Always includes 'global'. */
  scopes: readonly ScopeType[];
  /** false for internal rules that staff see but the public rulebook does not. */
  public: boolean;
  /** Plain-language sentence for the public rulebook and help pages. */
  describe: (value: z.infer<S>, ctx: RenderContext) => string;
}

function rule<S extends z.ZodType>(
  def: Omit<RuleDefinition<S>, 'scopes' | 'public'> & { scopes?: readonly ScopeType[]; public?: boolean },
): RuleDefinition<S> {
  return { ...def, public: def.public ?? true, scopes: ['global', ...(def.scopes ?? [])] };
}

// ---------------------------------------------------------------------------
// Shared value schemas
// ---------------------------------------------------------------------------

const minor = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();
const basisPoints = z.number().int().min(0).max(100_000);

/** An amount per currency. null = not yet set; anything needing it in that currency is blocked. */
export const moneyByCurrency = z.object({ USD: minor.nullable(), ZWG: minor.nullable() }).strict();
export type MoneyByCurrency = z.infer<typeof moneyByCurrency>;

/** Ascending bands: from this price upward, apply this increment (minor units). */
export const incrementBands = z.array(z.object({ from: minor, increment: positiveInt }).strict()).min(1);
export type IncrementBands = z.infer<typeof incrementBands>;

export const commissionBands = z.array(z.object({ from: minor, rateBp: basisPoints }).strict()).min(1);
export type CommissionBands = z.infer<typeof commissionBands>;

export const commissionSchedule = z
  .object({
    basis: z.enum(['marginal', 'flat_band']),
    bands: z.object({ USD: commissionBands.nullable(), ZWG: commissionBands.nullable() }).strict(),
    minimumPerLot: moneyByCurrency,
  })
  .strict()
  .nullable();
export type CommissionSchedule = z.infer<typeof commissionSchedule>;

const deliverySizeClass = z.enum(['small', 'medium', 'large']);
/** currency → town → size class → price in minor units. An empty town map means no delivery offered. */
export const deliveryRateCard = z
  .object({
    USD: z.record(z.string(), z.partialRecord(deliverySizeClass, minor)),
    ZWG: z.record(z.string(), z.partialRecord(deliverySizeClass, minor)),
  })
  .strict();
export type DeliveryRateCard = z.infer<typeof deliveryRateCard>;

export const DEFAULT_LADDER_STEPS = ['warning', 'deposit_forfeit', 'relist_fee', 'tier_drop'] as const;

const channel = z.enum(['whatsapp', 'push', 'sms', 'email', 'in_app']);

// ---------------------------------------------------------------------------
// Plain-language helpers
// ---------------------------------------------------------------------------

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

function hours(h: number): string {
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** "US$500.00 or ZiG 9,000.00" · "US$500.00 (ZiG amount not yet set)" */
export function describeMoneyByCurrency(value: MoneyByCurrency): string {
  const usd = value.USD === null ? null : formatMinor(BigInt(value.USD), 'USD');
  const zwg = value.ZWG === null ? null : formatMinor(BigInt(value.ZWG), 'ZWG');
  if (usd && zwg) return `${usd} or ${zwg}`;
  if (usd) return `${usd} (ZiG amount not yet set)`;
  if (zwg) return `${zwg} (USD amount not yet set)`;
  return 'not yet set';
}

const TIER_LABEL: Record<string, string> = { guest: 'Guest', verified: 'Verified', trusted: 'Trusted', restricted: 'Restricted' };
const TAX_LABEL: Record<string, string> = {
  purchasers_levy: "purchaser's levy",
  vat: 'VAT',
  imtt: 'IMTT',
  transfer_tax: 'transfer tax',
};
const TAX_CLASS_LABEL: Record<string, string> = {
  goods_standard: 'Most goods',
  vehicle_standard: 'Vehicles',
  vehicle_used_zw: 'Zimbabwe-registered used vehicles',
  delivery_service: 'Delivery',
};
const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  push: 'app notification',
  sms: 'SMS',
  email: 'email',
  in_app: 'in the app',
};
const REVIEW_TRIGGER_LABEL: Record<string, string> = {
  tier_restricted: 'Restricted accounts',
  linked_to_seller: 'accounts linked to a seller in the auction',
  risk_flag: 'accounts with an open risk flag',
  kyc_pending_for_deposit_auction: 'deposit auctions while an ID check is still pending',
};
const ALERT_LABEL: Record<string, string> = {
  outbid: 'outbid',
  ending_soon: 'ending soon',
  won: 'you won',
  invoice: 'invoice',
  payment_reminder: 'payment reminder',
  collection_ready: 'ready to collect',
};

function increments(bands: IncrementBands, c: Currency): string {
  return bands
    .map((b, i) => {
      const inc = formatMinor(BigInt(b.increment), c);
      if (i === 0 && bands.length > 1) return `${inc} under ${formatMinor(BigInt(bands[1]!.from), c)}`;
      return `${inc} from ${formatMinor(BigInt(b.from), c)}`;
    })
    .join(', ');
}

function percent(bp: number): string {
  return `${(bp / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

function list(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.join(', ');
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const RULES = {
  // Bidding ---------------------------------------------------------------
  'bidding.soft_close_seconds': rule({
    title: 'Soft-close extension',
    section: 'Bidding',
    owner: 'operations',
    schema: positiveInt,
    scopes: ['auction_format', 'category'],
    describe: (v) => `A bid near the end extends the lot's closing time by ${duration(v)}.`,
  }),
  'bidding.soft_close_allowed_seconds': rule({
    title: 'Soft-close values allowed per auction',
    section: 'Bidding',
    owner: 'operations',
    public: false,
    schema: z.array(positiveInt).min(1),
    describe: (v) => `An auction may use a soft close of ${v.map(duration).join(', ')}.`,
  }),
  'bidding.soft_close_trigger_seconds': rule({
    title: 'Soft-close trigger window',
    section: 'Bidding',
    owner: 'operations',
    schema: positiveInt,
    scopes: ['auction_format', 'category'],
    describe: (v) => `A bid placed in the last ${duration(v)} before a lot closes triggers the extension.`,
  }),
  'bidding.stagger_seconds': rule({
    title: 'Staggered end times',
    section: 'Bidding',
    owner: 'operations',
    schema: z.number().int().nonnegative(),
    scopes: ['auction_format'],
    describe: (v) =>
      v === 0 ? 'All lots in an auction close at the same time.' : `Lots close one after another, ${duration(v)} apart.`,
  }),
  'bidding.proxy_enabled': rule({
    title: 'Maximum (proxy) bids',
    section: 'Bidding',
    owner: 'operations',
    schema: z.boolean(),
    describe: (v) =>
      v
        ? 'You can set a maximum bid. The system bids for you, one increment at a time, up to your maximum. Your maximum is never shown to others.'
        : 'Maximum bids are not available.',
  }),
  'bidding.increment_ladder': rule({
    title: 'Bid increments',
    section: 'Bidding',
    owner: 'operations',
    schema: z.object({ USD: incrementBands.nullable(), ZWG: incrementBands.nullable() }).strict(),
    scopes: ['category'],
    describe: (v) => {
      const parts = (['USD', 'ZWG'] as Currency[]).flatMap((c) => (v[c] === null ? [] : [increments(v[c]!, c)]));
      const missing = (['USD', 'ZWG'] as Currency[]).filter((c) => v[c] === null).map((c) => (c === 'USD' ? 'USD' : 'ZiG'));
      return (
        (parts.length ? `Each bid must beat the current price by at least ${parts.join('; in ZiG: ')}.` : '') +
        (missing.length ? ` ${missing.join(' and ')} increments are not yet set.` : '')
      ).trim();
    },
  }),
  'bidding.bid_withdrawal': rule({
    title: 'Withdrawing a bid',
    section: 'Bidding',
    owner: 'operations',
    schema: z.enum(['never', 'admin_with_reason']),
    describe: (v) =>
      v === 'never'
        ? 'Bids are binding and cannot be withdrawn.'
        : 'Bids are binding. You cannot withdraw a bid yourself. Only ABC staff can remove a bid, with a recorded reason and a second staff member’s approval above the override limit.',
  }),
  'bidding.dropped_connection_policy': rule({
    title: 'If your connection drops',
    section: 'Bidding',
    owner: 'operations',
    schema: z.enum(['server_log_stands']),
    describe: () =>
      'Only bids confirmed with a bid receipt (sequence number and server time) count. If your connection drops, your maximum bid keeps bidding for you; a bid without a receipt was not placed.',
  }),
  'bidding.seller_linked_accounts_barred': rule({
    title: 'Bidding on your own lots',
    section: 'Bidding',
    owner: 'risk',
    schema: z.boolean(),
    describe: (v) =>
      v
        ? 'Sellers, and accounts linked to a seller, cannot bid on that seller’s lots.'
        : 'Linked-account bidding is not restricted.',
  }),

  // Registration and limits ------------------------------------------------
  'registration.auto_approve': rule({
    title: 'Joining an auction',
    section: 'Registration and limits',
    owner: 'risk',
    schema: z.boolean(),
    describe: (v) =>
      v
        ? 'Verified accounts in good standing join an auction in one tap, with no waiting for approval.'
        : 'Every registration is reviewed by staff.',
  }),
  'registration.target_decision_minutes': rule({
    title: 'Review time for flagged registrations',
    section: 'Registration and limits',
    owner: 'risk',
    schema: positiveInt,
    describe: (v) => `If your registration needs a staff review, we aim to decide within ${v} minutes during office hours.`,
  }),
  'registration.manual_review_triggers': rule({
    title: 'When a registration is reviewed',
    section: 'Registration and limits',
    owner: 'risk',
    schema: z.array(z.enum(['tier_restricted', 'linked_to_seller', 'risk_flag', 'kyc_pending_for_deposit_auction'])),
    describe: (v) =>
      v.length === 0
        ? 'No registration needs a staff review.'
        : `A registration is reviewed by staff only for ${list(v.map((t) => REVIEW_TRIGGER_LABEL[t] ?? t))}.`,
  }),
  'limit.formula': rule({
    title: 'How your bidding limit is worked out',
    section: 'Registration and limits',
    owner: 'risk',
    schema: z.enum(['max_of_base_and_deposit']),
    describe: () =>
      'Your limit is the larger of your free allowance and your deposit times the multiplier, plus any history bonus. Auctions that need a deposit have no free allowance.',
  }),
  'limit.base': rule({
    title: 'Free allowance by verification',
    section: 'Registration and limits',
    owner: 'risk',
    schema: z.object({ partial: moneyByCurrency, full: moneyByCurrency }).strict(),
    describe: (v) =>
      `Email and phone verified: ${describeMoneyByCurrency(v.partial)}. ID verified as well: ${describeMoneyByCurrency(v.full)}.`,
  }),
  'limit.deposit_multiplier': rule({
    title: 'Deposit multiplier',
    section: 'Registration and limits',
    owner: 'risk',
    schema: positiveInt,
    scopes: ['tier'],
    describe: (v) =>
      v === 1
        ? 'Your limit equals your deposit, all-in.'
        : `Your deposit counts ${v} times towards your limit, all-in: a US$100 deposit lets you bid up to US$${(100 * v).toLocaleString('en-US')} in total.`,
  }),
  'limit.history_uplift_bp': rule({
    title: 'History bonus',
    section: 'Registration and limits',
    owner: 'risk',
    schema: z.number().int().min(0).max(10_000),
    scopes: ['tier'],
    describe: (v) =>
      v === 0 ? 'No history bonus.' : `Your limit grows by ${percent(v)} of what you have paid in full over the last 12 months.`,
  }),
  'limit.history_uplift_cap': rule({
    title: 'History bonus cap',
    section: 'Registration and limits',
    owner: 'risk',
    schema: moneyByCurrency,
    describe: (v) => `The history bonus is capped at ${describeMoneyByCurrency(v)}.`,
  }),
  'limit.exposure_basis': rule({
    title: 'What counts against your limit',
    section: 'Registration and limits',
    owner: 'risk',
    schema: z.enum(['proxy_ceiling', 'current_price']),
    describe: (v) =>
      v === 'proxy_ceiling'
        ? 'Lots you are leading count against your limit at your maximum bid, all-in, plus any unpaid invoices.'
        : 'Lots you are leading count against your limit at the current price, all-in, plus any unpaid invoices.',
  }),
  'limit.cross_currency_reference_rate': rule({
    title: 'Using a deposit in the other currency',
    section: 'Registration and limits',
    owner: 'finance',
    schema: z.object({ zwgPerUsd: z.string().regex(/^\d+(\.\d+)?$/) }).strict().nullable(),
    describe: (v) =>
      v === null
        ? 'Limits are worked out separately in USD and ZiG. A USD deposit does not count towards ZiG bids, or the other way round.'
        : `For limits only, US$1 counts as ZiG ${v.zwgPerUsd}. Payments are always made in the lot's own currency.`,
  }),
  'tier.trusted_criteria': rule({
    title: 'Becoming Trusted',
    section: 'Registration and limits',
    owner: 'risk',
    schema: z
      .object({
        minPaidInvoices12m: z.number().int().nonnegative(),
        maxDefaults12m: z.number().int().nonnegative(),
        minAccountAgeDays: z.number().int().nonnegative(),
        requireMfa: z.boolean(),
      })
      .strict(),
    describe: (v) =>
      `You become Trusted after ${v.minPaidInvoices12m} invoices paid on time in 12 months, with ${v.maxDefaults12m === 0 ? 'no' : `at most ${v.maxDefaults12m}`} missed payments, an account at least ${v.minAccountAgeDays} days old, your ID verified${v.requireMfa ? ', and two-step sign-in turned on' : ''}.`,
  }),
  'tier.restricted_review_after_months': rule({
    title: 'Leaving Restricted',
    section: 'Registration and limits',
    owner: 'risk',
    schema: positiveInt,
    describe: (v) => `A Restricted account can ask for a review after ${v} months without a missed payment.`,
  }),

  // Deposits ------------------------------------------------------------------
  'deposit.required_categories': rule({
    title: 'Auctions that need a deposit',
    section: 'Deposits',
    owner: 'risk',
    schema: z.array(z.string().min(1)),
    describe: (v, ctx) => `You need a deposit to bid in these auctions: ${list(v.map(ctx.categoryName))}.`,
  }),
  'deposit.minimum': rule({
    title: 'Minimum deposit',
    section: 'Deposits',
    owner: 'risk',
    schema: moneyByCurrency,
    scopes: ['category'],
    describe: (v) => `The minimum deposit is ${describeMoneyByCurrency(v)}.`,
  }),

  // Paying and collecting -----------------------------------------------------
  'settlement.invoice_timing': rule({
    title: 'When you get your invoice',
    section: 'Paying and collecting',
    owner: 'operations',
    schema: z.enum(['at_close']),
    describe: () => 'Your invoice is ready in the app and on WhatsApp as soon as the lot closes.',
  }),
  'settlement.pay_window_hours': rule({
    title: 'Time to pay',
    section: 'Paying and collecting',
    owner: 'operations',
    schema: positiveInt,
    describe: (v) => `Pay within ${hours(v)} of the invoice.`,
  }),
  'settlement.collect_window_hours': rule({
    title: 'Time to collect',
    section: 'Paying and collecting',
    owner: 'operations',
    schema: positiveInt,
    describe: (v) => `Collect within ${hours(v)} of paying.`,
  }),
  'settlement.reminder_offsets_hours': rule({
    title: 'Payment reminders',
    section: 'Paying and collecting',
    owner: 'operations',
    schema: z.array(positiveInt),
    describe: (v) =>
      v.length === 0 ? 'No payment reminders are sent.' : `We remind you ${v.map(hours).join(' and ')} after the invoice is issued.`,
  }),
  'settlement.default_ladder': rule({
    title: 'If you do not pay in time',
    section: 'Paying and collecting',
    owner: 'risk',
    schema: z
      .array(z.object({ step: z.enum(DEFAULT_LADDER_STEPS), afterDueHours: z.number().int().nonnegative() }).strict())
      .min(1),
    describe: (v) =>
      v
        .map((s) => {
          const when = s.afterDueHours === 0 ? 'when the time to pay runs out' : `${hours(s.afterDueHours)} after that`;
          const what = {
            warning: 'you get a warning',
            deposit_forfeit: 'your deposit is forfeited and the lot is offered again',
            relist_fee: 'a relisting fee is charged',
            tier_drop: 'your account becomes Restricted',
          }[s.step];
          return `${when}, ${what}`;
        })
        .join('; ')
        .replace(/^./, (c) => c.toUpperCase()) + '.',
  }),
  'settlement.relist_fee': rule({
    title: 'Relisting fee after a missed payment',
    section: 'Paying and collecting',
    owner: 'finance',
    schema: z.object({ rateBp: basisPoints, minimum: moneyByCurrency }).strict(),
    describe: (v) => `The relisting fee is ${percent(v.rateBp)} of the hammer price, at least ${describeMoneyByCurrency(v.minimum)}.`,
  }),
  'settlement.forfeit_seller_share_bp': rule({
    title: 'Share of a forfeited deposit paid to the seller',
    section: 'Paying and collecting',
    owner: 'finance',
    schema: z.number().int().min(0).max(10_000),
    describe: (v) => (v === 0 ? 'Forfeited deposits are kept by ABC.' : `${percent(v)} of a forfeited deposit goes to the seller.`),
  }),
  'reserve.offer_window_hours': rule({
    title: 'Offer when the reserve is not met',
    section: 'Paying and collecting',
    owner: 'operations',
    schema: positiveInt,
    describe: (v) =>
      `If the top bid is below the reserve, the seller may offer the lot to the top bidder, who has ${hours(v)} to accept.`,
  }),

  // Fees, commission and tax --------------------------------------------------
  'fees.buyers_premium_bp': rule({
    title: "Buyer's premium",
    section: 'Fees, commission and tax',
    owner: 'finance',
    schema: basisPoints,
    scopes: ['category'],
    describe: (v) => (v === 0 ? "There is no buyer's premium." : `A buyer's premium of ${percent(v)} of the hammer price is added.`),
  }),
  'commission.schedule': rule({
    title: 'Seller commission',
    section: 'Fees, commission and tax',
    owner: 'finance',
    schema: commissionSchedule,
    scopes: ['category'],
    describe: (v) =>
      v === null
        ? 'Commission rates are being confirmed and will be published here.'
        : (['USD', 'ZWG'] as Currency[])
            .map((c) =>
              v.bands[c] === null
                ? `${c === 'USD' ? 'USD' : 'ZiG'}: not yet set`
                : `${v.basis === 'marginal' ? 'Charged on each portion of the price' : 'Charged on the whole price'}: ` +
                  v.bands[c]!.map((b) => `from ${formatMinor(BigInt(b.from), c)} ${percent(b.rateBp)}`).join(', '),
            )
            .join(' · ') + `. Minimum per lot: ${describeMoneyByCurrency(v.minimumPerLot)}.`,
  }),
  'tax.class_codes': rule({
    title: 'Which taxes apply to which goods',
    section: 'Fees, commission and tax',
    owner: 'finance',
    schema: z.record(z.string().min(1), z.array(z.enum(TAX_CODES))),
    describe: (v) =>
      Object.entries(v)
        .map(([cls, codes]) => `${TAX_CLASS_LABEL[cls] ?? cls}: ${codes.length ? list(codes.map((c) => TAX_LABEL[c] ?? c)) : 'no tax'}`)
        .join('. ') + '.',
  }),
  'tax.calculation_order': rule({
    title: 'Order in which taxes are worked out',
    section: 'Fees, commission and tax',
    owner: 'finance',
    public: false,
    schema: z.array(z.enum(TAX_CODES)).min(1),
    describe: (v) => `Taxes are worked out in this order: ${list(v.map((c) => TAX_LABEL[c] ?? c))}.`,
  }),
  'money.rounding': rule({
    title: 'Rounding',
    section: 'Fees, commission and tax',
    owner: 'finance',
    schema: z.enum(['half_up']),
    describe: () => 'Each fee and tax line is rounded to the nearest cent (half a cent rounds up). The total is the sum of the lines.',
  }),
  'fx.indicative_display': rule({
    title: 'Showing the other currency',
    section: 'Fees, commission and tax',
    owner: 'finance',
    schema: z.object({ enabled: z.boolean(), zwgPerUsd: z.string().regex(/^\d+(\.\d+)?$/).nullable() }).strict(),
    describe: (v) =>
      v.enabled && v.zwgPerUsd
        ? `Lot pages may show an approximate price in the other currency at US$1 = ZiG ${v.zwgPerUsd}. You always pay in the lot's own currency.`
        : "Prices are shown only in the lot's own currency.",
  }),

  // Delivery and storage --------------------------------------------------------
  'delivery.rate_card': rule({
    title: 'Delivery prices',
    section: 'Delivery and storage',
    owner: 'operations',
    schema: deliveryRateCard,
    describe: (v) => {
      const towns = Object.keys(v.USD);
      return towns.length === 0 ? 'Delivery prices are being confirmed.' : `Door delivery is available to: ${list(towns)}.`;
    },
  }),
  'delivery.cutoff_local_time': rule({
    title: 'Next-day delivery cut-off',
    section: 'Delivery and storage',
    owner: 'operations',
    schema: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    describe: (v) => `Pay and book delivery by ${v} for delivery the next day.`,
  }),
  'delivery.excluded_categories': rule({
    title: 'Goods we cannot deliver',
    section: 'Delivery and storage',
    owner: 'operations',
    schema: z.array(z.string().min(1)),
    describe: (v, ctx) => `We do not deliver ${list(v.map((c) => ctx.categoryName(c).toLowerCase()))}; these must be collected.`,
  }),
  'delivery.tax_class': rule({
    title: 'Tax on delivery',
    section: 'Delivery and storage',
    owner: 'finance',
    public: false,
    schema: z.string().min(1),
    describe: (v) => `Delivery is taxed as: ${v.replaceAll('_', ' ')}.`,
  }),
  'delivery.never_exceed_quote': rule({
    title: 'Delivery price promise',
    section: 'Delivery and storage',
    owner: 'operations',
    schema: z.boolean(),
    describe: (v) => (v ? 'Your invoice never charges more for delivery than the price shown when you bid.' : ''),
  }),
  'storage.enabled': rule({
    title: 'Storage charges',
    section: 'Delivery and storage',
    owner: 'operations',
    schema: z.boolean(),
    describe: (v) => (v ? 'Storage is charged on goods not collected in time.' : 'There is no storage charge.'),
  }),
  'storage.free_hours': rule({
    title: 'Free storage',
    section: 'Delivery and storage',
    owner: 'operations',
    schema: positiveInt,
    describe: (v) => `Goods are stored free for ${hours(v)} after payment.`,
  }),
  'storage.daily_rate_bp': rule({
    title: 'Daily storage charge',
    section: 'Delivery and storage',
    owner: 'finance',
    schema: basisPoints,
    describe: (v) => `After the free period, storage costs ${percent(v)} of the hammer price per day.`,
  }),

  // Lots and vehicles ------------------------------------------------------------
  'catalogue.min_photos': rule({
    title: 'Minimum photos per lot',
    section: 'Lots and vehicles',
    owner: 'operations',
    schema: positiveInt,
    scopes: ['category'],
    describe: (v) => `Every lot has at least ${v} photos.`,
  }),
  'vehicle.require_video': rule({
    title: 'Vehicle video',
    section: 'Lots and vehicles',
    owner: 'operations',
    schema: z.boolean(),
    describe: (v) => (v ? 'Every vehicle inspection report includes a video.' : 'Vehicle videos are optional.'),
  }),
  'vehicle.title_deadline_days': rule({
    title: 'Vehicle change of ownership',
    section: 'Lots and vehicles',
    owner: 'operations',
    schema: positiveInt,
    describe: (v) =>
      `A vehicle is released once police clearance, ZIMRA clearance and change of ownership are complete. We aim to finish these within ${v} days of payment.`,
  }),

  // Messages -----------------------------------------------------------------------
  'comms.fallback': rule({
    title: 'How we reach you',
    section: 'Messages',
    owner: 'product',
    schema: z.record(
      z.enum(['outbid', 'ending_soon', 'won', 'invoice', 'payment_reminder', 'collection_ready']),
      z.object({ channels: z.array(channel).min(1), fallbackAfterSeconds: positiveInt }).strict(),
    ),
    describe: (v) =>
      'We send alerts on WhatsApp first. If a message is not delivered, we try the next way of reaching you: ' +
      Object.entries(v)
        .map(([k, p]) => `${ALERT_LABEL[k] ?? k} (${p.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(' → ')})`)
        .join('; ') +
      '. We also email you a copy for your records.',
  }),
  'comms.ending_soon_minutes': rule({
    title: '"Ending soon" alert',
    section: 'Messages',
    owner: 'product',
    schema: positiveInt,
    describe: (v) => `For lots you watch or bid on, we alert you ${v} minutes before they close.`,
  }),

  // Security and overrides --------------------------------------------------------------
  'override.two_person_threshold': rule({
    title: 'Second approval for staff overrides',
    section: 'Security and overrides',
    owner: 'finance',
    schema: moneyByCurrency,
    describe: (v) =>
      `A staff refund, bid removal or limit change above ${describeMoneyByCurrency(v)} needs a second staff member's approval. Every override is recorded with a name and reason.`,
  }),
  'security.payout_destination_cooling_off_hours': rule({
    title: 'Changing payout details',
    section: 'Security and overrides',
    owner: 'risk',
    schema: z.number().int().nonnegative(),
    describe: (v) => `After you change where payouts go, you must sign in again, and no payout is sent there for ${hours(v)}.`,
  }),
  'security.mfa_required_tiers': rule({
    title: 'Two-step sign-in',
    section: 'Security and overrides',
    owner: 'risk',
    schema: z.array(z.enum(TIERS)),
    describe: (v) =>
      v.length === 0
        ? 'Two-step sign-in is optional for customers and required for all ABC staff.'
        : `Two-step sign-in is required for ${list(v.map((t) => TIER_LABEL[t] ?? t))} accounts and for all ABC staff.`,
  }),
  'operations.outage_extension': rule({
    title: 'If the system goes down during a close',
    section: 'Security and overrides',
    owner: 'operations',
    schema: z.enum(['outage_plus_soft_close']),
    describe: () => 'Lots that were due to close during an outage are extended by the length of the outage plus the soft-close time.',
  }),

  // Disputes -------------------------------------------------------------------------------
  'dispute.claim_window_hours_after_release': rule({
    title: 'Claims for goods not as described',
    section: 'Disputes',
    owner: 'operations',
    schema: z.number().int().nonnegative(),
    describe: (v) =>
      `Check your goods at collection. You can also make a claim up to ${hours(v)} after collection if they do not match the listed condition.`,
  }),
  'dispute.response_target_hours': rule({
    title: 'Response time for claims',
    section: 'Disputes',
    owner: 'operations',
    schema: positiveInt,
    describe: (v) => `Every claim gets a named owner and a reply within ${hours(v)}.`,
  }),
} as const;

export type RuleKey = keyof typeof RULES;
export type RuleValue<K extends RuleKey> = z.infer<(typeof RULES)[K]['schema']>;

export function isRuleKey(key: string): key is RuleKey {
  return Object.prototype.hasOwnProperty.call(RULES, key);
}

// Keep the enums referenced so the registry and DB stay aligned.
export const KNOWN_TIERS = TIERS;
export const KNOWN_AUCTION_FORMATS = AUCTION_FORMATS;
