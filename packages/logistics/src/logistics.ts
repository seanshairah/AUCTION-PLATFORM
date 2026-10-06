import { applyBasisPoints, type Currency } from '@abc/domain';
import { quoteLot, type DeliveryChoice, type LotPricing, type QuoteLine } from '@abc/quote';
import type { RuleSnapshot, TaxRateRecord } from '@abc/rules';

/**
 * Logistics, pure parts (docs/15-logistics.md): collection slots cut from branch
 * opening hours, the storage clock, and the bundled delivery quote. Every figure
 * comes from the rulebook, and delivery prices come from quoteLot, the function the
 * commit screen and the invoice use (R2).
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Branch clocks run on Central Africa Time (UTC+2). Zimbabwe has no daylight saving. */
export const BRANCH_UTC_OFFSET_MINUTES = 120;

/** core.branch.opening_hours, e.g. {"mon_fri": "09:00-15:00", "sat": "09:00-12:00"} (CONFIRMED hours). */
export type OpeningHours = Partial<Record<'mon_fri' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', string>>;

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function windowFor(hours: OpeningHours, weekday: number): { open: number; close: number } | null {
  const key = DAY_KEYS[weekday]!;
  const text = hours[key] ?? (weekday >= 1 && weekday <= 5 ? hours.mon_fri : undefined);
  const m = text?.match(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const open = Number(m[1]) * 60 + Number(m[2]);
  const close = Number(m[3]) * 60 + Number(m[4]);
  return close > open ? { open, close } : null;
}

/** The local calendar date (at the branch) of an instant, as UTC midnight of that date. */
function localDate(at: Date): Date {
  const local = new Date(at.getTime() + BRANCH_UTC_OFFSET_MINUTES * MINUTE);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

export interface SlotTime {
  startsAt: Date;
  endsAt: Date;
}

/**
 * Collection slots for `days` branch days starting with the day containing `from`:
 * consecutive slots of `minutes` inside each day's opening hours. A slot never runs
 * past closing time. Slots that have already started are left out.
 */
export function slotTimes(hours: OpeningHours, from: Date, days: number, minutes: number): SlotTime[] {
  const out: SlotTime[] = [];
  const first = localDate(from);
  for (let d = 0; d < days; d++) {
    const day = new Date(first.getTime() + d * DAY);
    const w = windowFor(hours, day.getUTCDay());
    if (!w) continue;
    for (let t = w.open; t + minutes <= w.close; t += minutes) {
      const startsAt = new Date(day.getTime() + (t - BRANCH_UTC_OFFSET_MINUTES) * MINUTE);
      if (startsAt.getTime() <= from.getTime()) continue;
      out.push({ startsAt, endsAt: new Date(startsAt.getTime() + minutes * MINUTE) });
    }
  }
  return out;
}

/** When slot reminders fall due (rule logistics.slot_reminder_hours), latest first. */
export function slotReminderTimes(startsAt: Date, snapshot: RuleSnapshot): Array<{ hoursBefore: number; at: Date }> {
  return snapshot
    .get('logistics.slot_reminder_hours')
    .map((h) => ({ hoursBefore: h, at: new Date(startsAt.getTime() - h * HOUR) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

// --- The storage clock ------------------------------------------------------------------

export interface StorageAccrual {
  /** storage.enabled: when false nothing is ever charged, but the deadlines still show. */
  enabled: boolean;
  /** When the clock started: the moment the invoice was paid. */
  clockFrom: Date;
  /** Collect by this time (settlement.collect_window_hours after payment). */
  collectBy: Date;
  /** Storage is free until this time: the later of the collection deadline and storage.free_hours. */
  freeUntil: Date;
  /** Chargeable days so far, counting a part day as a day. */
  days: number;
  dailyFeeMinor: bigint;
  accruedMinor: bigint;
  asOf: Date;
}

/**
 * The storage clock (blueprint module 10, Q4). Free hours run from payment and never
 * end before the collection deadline (the rulebook validator refuses a shorter free
 * period). After that each day or part day costs storage.daily_rate_bp of the hammer
 * of every lot still in store. With storage.enabled = false (the default) the
 * accrual is always zero.
 */
export function storageAccrual(p: { clockFrom: Date; hammersMinor: readonly bigint[]; snapshot: RuleSnapshot; asOf: Date }): StorageAccrual {
  const { snapshot } = p;
  const enabled = snapshot.get('storage.enabled');
  const collectHours = snapshot.get('settlement.collect_window_hours');
  const freeHours = Math.max(snapshot.get('storage.free_hours'), collectHours);
  const collectBy = new Date(p.clockFrom.getTime() + collectHours * HOUR);
  const freeUntil = new Date(p.clockFrom.getTime() + freeHours * HOUR);
  const rate = snapshot.get('storage.daily_rate_bp');
  const dailyFeeMinor = p.hammersMinor.reduce((a, h) => a + applyBasisPoints(h, rate), 0n);
  const over = p.asOf.getTime() - freeUntil.getTime();
  const days = over > 0 ? Math.ceil(over / DAY) : 0;
  return {
    enabled,
    clockFrom: p.clockFrom,
    collectBy,
    freeUntil,
    days,
    dailyFeeMinor,
    accruedMinor: enabled ? dailyFeeMinor * BigInt(days) : 0n,
    asOf: p.asOf,
  };
}

// --- Delivery -------------------------------------------------------------------------------

export interface DeliveryQuote {
  currency: Currency;
  town: string;
  sizeClass: 'small' | 'medium' | 'large';
  /** The delivery lines from quoteLot (the charge and any tax on it), unchanged. */
  lines: QuoteLine[];
  totalMinor: bigint;
  ruleVersionId: string;
}

/**
 * One trip delivers the whole collection, so a bundle is priced as the single most
 * expensive lot delivery at the declared size (A52). Every lot is quoted with
 * quoteLot, the function the commit screen uses, which also refuses vehicles and
 * excluded categories (DELIVERY_UNAVAILABLE).
 */
export function bundleDeliveryQuote(p: {
  lots: ReadonlyArray<{ pricing: LotPricing; hammerMinor: bigint }>;
  choice: Extract<DeliveryChoice, { method: 'delivery' }>;
  snapshot: RuleSnapshot;
  taxRates: readonly TaxRateRecord[];
  at: Date;
}): DeliveryQuote {
  if (p.lots.length === 0) throw new RangeError('A delivery needs at least one lot');
  let best: QuoteLine[] | null = null;
  let bestTotal = -1n;
  for (const lot of p.lots) {
    const q = quoteLot({ lot: lot.pricing, hammerMinor: lot.hammerMinor, snapshot: p.snapshot, taxRates: p.taxRates, at: p.at, delivery: p.choice });
    const lines = q.lines.filter((l) => l.appliesTo === 'delivery');
    const total = lines.reduce((a, l) => a + l.amountMinor, 0n);
    if (total > bestTotal) {
      best = lines;
      bestTotal = total;
    }
  }
  return {
    currency: p.lots[0]!.pricing.currency,
    town: p.choice.town,
    sizeClass: p.choice.sizeClass,
    lines: best!,
    totalMinor: bestTotal,
    ruleVersionId: p.snapshot.versionId,
  };
}

/** Next-day delivery when booked before the cut-off (rule delivery.cutoff_local_time), otherwise the day after. */
export function expectedDeliveryDate(bookedAt: Date, snapshot: RuleSnapshot): string {
  const [hh, mm] = snapshot.get('delivery.cutoff_local_time').split(':').map(Number) as [number, number];
  const local = new Date(bookedAt.getTime() + BRANCH_UTC_OFFSET_MINUTES * MINUTE);
  const minutesNow = local.getUTCHours() * 60 + local.getUTCMinutes();
  const addDays = minutesNow < hh * 60 + mm ? 1 : 2;
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + addDays * DAY);
  return day.toISOString().slice(0, 10);
}

export const DELIVERY_TRANSITIONS: Record<string, readonly string[]> = {
  booked: ['collected', 'cancelled'],
  collected: ['in_transit', 'delivered', 'failed'],
  in_transit: ['delivered', 'failed'],
  delivered: [],
  failed: [],
  cancelled: [],
};
