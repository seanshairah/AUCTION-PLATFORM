import { createHash } from 'node:crypto';
import { formatMinor, parseAmountInput, type Currency } from '@abc/domain';
import { RULES, type RuleSnapshot } from '@abc/rules';

/**
 * Seller portal, pure parts (docs/12-seller-portal.md): valuation ranges from the
 * realised-price archive, institutional bulk uploads, the consignment note sellers
 * e-sign, and statements.
 */

// --- Valuation ------------------------------------------------------------------

export interface ValuationRange {
  lowMinor: bigint;
  medianMinor: bigint;
  highMinor: bigint;
  comparables: number;
}

function quantile(sorted: readonly bigint[], q: number): bigint {
  // Nearest-rank on the sorted list; good enough for a range shown to sellers.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx]!;
}

/**
 * A range from comparable hammer prices (same category and currency, last 12
 * months): the middle half of past results. Null when there are too few
 * comparables: staff value the item instead (rule seller.valuation_min_comparables).
 */
export function valuationRange(hammerPrices: readonly bigint[], snapshot: RuleSnapshot): ValuationRange | null {
  const min = snapshot.get('seller.valuation_min_comparables');
  if (hammerPrices.length < min) return null;
  const sorted = [...hammerPrices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { lowMinor: quantile(sorted, 0.25), medianMinor: quantile(sorted, 0.5), highMinor: quantile(sorted, 0.75), comparables: sorted.length };
}

// --- Bulk upload ------------------------------------------------------------------

export const BULK_COLUMNS = [
  'external_ref',
  'title',
  'description',
  'category',
  'item_state',
  'condition',
  'condition_notes',
  'currency',
  'starting_bid',
  'reserve',
  'estimate_low',
  'estimate_high',
  'quantity',
] as const;

export interface LotDraft {
  externalRef?: string;
  title: string;
  description: string;
  category: string;
  itemState: string;
  condition: string;
  conditionNotes?: string;
  currency: Currency;
  startingBidMinor: bigint;
  reserveMinor: bigint | null;
  estimateLowMinor: bigint | null;
  estimateHighMinor: bigint | null;
  quantity: number;
}

export interface RowError {
  row: number; // 1-based data row (header excluded)
  field: string;
  message: string;
}

/** Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

export interface BulkContext {
  categories: readonly string[];
  itemStates: readonly string[];
  conditions: readonly string[];
  snapshot: RuleSnapshot;
}

function money(raw: string, row: number, field: string, errors: RowError[], required: boolean): bigint | null {
  if (raw.trim() === '') {
    if (required) errors.push({ row, field, message: 'is required' });
    return null;
  }
  const parsed = parseAmountInput(raw);
  if (!parsed.ok) {
    errors.push({ row, field, message: `"${raw}" is not an amount` });
    return null;
  }
  return parsed.minor;
}

/**
 * Validates a whole file. All or nothing: if any row has an error, no lot is
 * created, and every error is reported with its row and column so the
 * institution can fix the file in one pass.
 */
export function validateBulkUpload(csv: string, ctx: BulkContext): { lots: LotDraft[]; errors: RowError[] } {
  const rows = parseCsv(csv);
  const errors: RowError[] = [];
  if (rows.length === 0) return { lots: [], errors: [{ row: 0, field: 'file', message: 'is empty' }] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  for (const col of ['external_ref', 'title', 'description', 'category', 'item_state', 'condition', 'currency', 'starting_bid']) {
    if (!header.includes(col)) errors.push({ row: 0, field: col, message: 'column is missing' });
  }
  if (errors.length) return { lots: [], errors };
  const max = ctx.snapshot.get('seller.bulk_upload_max_rows');
  if (rows.length - 1 > max) return { lots: [], errors: [{ row: 0, field: 'file', message: `has ${rows.length - 1} rows; the limit is ${max}` }] };

  const col = (r: string[], name: string) => (header.indexOf(name) >= 0 ? (r[header.indexOf(name)] ?? '').trim() : '');
  const seen = new Set<string>();
  const lots: LotDraft[] = [];
  rows.slice(1).forEach((r, i) => {
    const row = i + 1;
    const before = errors.length;
    const ref = col(r, 'external_ref');
    if (!ref) errors.push({ row, field: 'external_ref', message: 'is required' });
    else if (seen.has(ref)) errors.push({ row, field: 'external_ref', message: `"${ref}" appears more than once in this file` });
    seen.add(ref);
    const title = col(r, 'title');
    if (title.length < 5) errors.push({ row, field: 'title', message: 'needs at least 5 characters' });
    const category = col(r, 'category');
    if (!ctx.categories.includes(category)) errors.push({ row, field: 'category', message: `"${category}" is not a category` });
    const itemState = col(r, 'item_state');
    if (!ctx.itemStates.includes(itemState)) errors.push({ row, field: 'item_state', message: `"${itemState}" is not in the item state vocabulary` });
    const condition = col(r, 'condition');
    if (!ctx.conditions.includes(condition)) errors.push({ row, field: 'condition', message: `"${condition}" is not in the condition vocabulary` });
    const currency = col(r, 'currency').toUpperCase();
    if (currency !== 'USD' && currency !== 'ZWG') errors.push({ row, field: 'currency', message: 'must be USD or ZWG (ZiG)' });
    const starting = money(col(r, 'starting_bid'), row, 'starting_bid', errors, true);
    const reserve = money(col(r, 'reserve'), row, 'reserve', errors, false);
    const low = money(col(r, 'estimate_low'), row, 'estimate_low', errors, false);
    const high = money(col(r, 'estimate_high'), row, 'estimate_high', errors, false);
    if (reserve !== null && starting !== null && reserve <= starting) errors.push({ row, field: 'reserve', message: 'must be above the starting bid, or left empty' });
    if (low !== null && high !== null && low > high) errors.push({ row, field: 'estimate_low', message: 'is above estimate_high' });
    const qtyRaw = col(r, 'quantity') || '1';
    const quantity = Number(qtyRaw);
    if (!Number.isInteger(quantity) || quantity < 1) errors.push({ row, field: 'quantity', message: 'must be a whole number of 1 or more' });
    if (errors.length === before) {
      const notes = col(r, 'condition_notes');
      lots.push({
        externalRef: ref,
        title,
        description: col(r, 'description'),
        category,
        itemState,
        condition,
        ...(notes ? { conditionNotes: notes } : {}),
        currency: currency as Currency,
        startingBidMinor: starting!,
        reserveMinor: reserve,
        estimateLowMinor: low,
        estimateHighMinor: high,
        quantity,
      });
    }
  });
  return errors.length ? { lots: [], errors } : { lots, errors };
}

// --- Consignment note ------------------------------------------------------------------

export class CommissionNotPublishedError extends Error {
  constructor() {
    super('Commission rates are not published yet, so a consignment note cannot be signed (Q3)');
    this.name = 'CommissionNotPublishedError';
  }
}

export interface NoteInput {
  consignmentId: string;
  sellerName: string;
  consignmentType: 'commission' | 'outright_purchase' | 'advance';
  branch: string;
  lots: ReadonlyArray<{ lotRef: string; title: string; condition: string; currency: Currency; reserveMinor: bigint | null }>;
  snapshot: RuleSnapshot;
  date: Date;
}

/**
 * The consignment note the seller e-signs. The text is generated from the
 * consignment and the rulebook, so the commission and payout terms the seller signs
 * are exactly the published ones. The SHA-256 of the text is what the signature binds.
 */
export function consignmentNote(input: NoteInput): { text: string; sha256: string } {
  const schedule = input.snapshot.get('commission.schedule');
  if (input.consignmentType === 'commission' && schedule === null) throw new CommissionNotPublishedError();
  const describe = <K extends keyof typeof RULES>(key: K) =>
    (RULES[key].describe as (v: unknown, c: { categoryName: (c: string) => string }) => string)(input.snapshot.get(key), { categoryName: (c) => c });
  const lines = [
    'ABC AUCTIONS: CONSIGNMENT NOTE',
    `Consignment: ${input.consignmentId}`,
    `Seller: ${input.sellerName}`,
    `Type: ${input.consignmentType.replace('_', ' ')}`,
    `Branch: ${input.branch}`,
    `Date: ${input.date.toISOString().slice(0, 10)}`,
    `Rules: version ${input.snapshot.label}`,
    '',
    'LOTS',
    ...input.lots.map(
      (l) => `- ${l.lotRef}: ${l.title} (${l.condition}); reserve ${l.reserveMinor === null ? 'none' : formatMinor(l.reserveMinor, l.currency)}; sold in ${l.currency === 'USD' ? 'USD' : 'ZiG'}`,
    ),
    '',
    'TERMS',
    `Commission: ${describe('commission.schedule')}`,
    `When you are paid: ${describe('payout.processing_hours')}`,
    `Claims by buyers: ${describe('dispute.claim_window_hours_after_release')}`,
    `If the reserve is not met: ${describe('reserve.offer_window_hours')}`,
    '',
    'By signing, the seller confirms they own these goods or are authorised to sell them, and that the descriptions are true to the best of their knowledge.',
  ];
  const text = lines.join('\n');
  return { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

// --- Statements -----------------------------------------------------------------------

export interface PayoutRow {
  payoutId: string;
  currency: Currency;
  status: 'scheduled' | 'approved' | 'processing' | 'paid' | 'failed' | 'held' | 'cancelled';
  dueDate: string;
  grossMinor: bigint;
  deductionsMinor: bigint;
  netMinor: bigint;
}

export interface StatementTotals {
  currency: Currency;
  paidMinor: bigint;
  upcomingMinor: bigint;
  heldMinor: bigint;
  nextDueDate: string | null;
}

/** Totals per currency for the seller's statement: paid, upcoming (with the next due date) and held. */
export function statementTotals(payouts: readonly PayoutRow[]): StatementTotals[] {
  const by = new Map<Currency, StatementTotals>();
  for (const p of payouts) {
    const t = by.get(p.currency) ?? { currency: p.currency, paidMinor: 0n, upcomingMinor: 0n, heldMinor: 0n, nextDueDate: null };
    if (p.status === 'paid') t.paidMinor += p.netMinor;
    else if (p.status === 'held' || p.status === 'failed') t.heldMinor += p.netMinor;
    else if (p.status !== 'cancelled') {
      t.upcomingMinor += p.netMinor;
      if (t.nextDueDate === null || p.dueDate < t.nextDueDate) t.nextDueDate = p.dueDate;
    }
    by.set(p.currency, t);
  }
  return [...by.values()];
}
