import { CURRENCIES, type Currency } from '@abc/domain';
import { DEFAULT_LADDER_STEPS, RULES, isRuleKey, type RuleKey, type RuleValue } from './registry';
import { PROVENANCES, SCOPE_TYPES, TAX_CODES, type RuleRecord, type RuleSetDocument, type TaxRateRecord } from './types';

/**
 * Publish-time validation: the Phase 1 gate "one rulebook, no contradictions".
 * Errors block publishing. Warnings must be acknowledged by the approver
 * (docs/03-rulebook-service.md §6).
 */

export interface Issue {
  code: string;
  message: string;
  key?: string;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
}

export interface CatalogueContext {
  categories: ReadonlyArray<{ code: string; taxClass: string }>;
}

function globalValue<K extends RuleKey>(records: RuleRecord[], key: K): RuleValue<K> | undefined {
  const r = records.find((x) => x.key === key && x.scope.type === 'global');
  if (!r) return undefined;
  const parsed = RULES[key].schema.safeParse(r.value);
  return parsed.success ? (parsed.data as RuleValue<K>) : undefined;
}

function valuesOf<K extends RuleKey>(records: RuleRecord[], key: K): Array<{ record: RuleRecord; value: RuleValue<K> }> {
  return records
    .filter((r) => r.key === key)
    .flatMap((record) => {
      const parsed = RULES[key].schema.safeParse(record.value);
      return parsed.success ? [{ record, value: parsed.data as RuleValue<K> }] : [];
    });
}

function scopeLabel(r: RuleRecord): string {
  return r.scope.type === 'global' ? 'global' : `${r.scope.type}=${r.scope.ref}`;
}

function checkBands(
  bands: ReadonlyArray<{ from: number }>,
  key: string,
  label: string,
  errors: Issue[],
): void {
  if (bands[0]?.from !== 0) {
    errors.push({ code: 'bands_must_start_at_zero', key, message: `${label}: the first band must start at 0` });
  }
  for (let i = 1; i < bands.length; i++) {
    if (bands[i]!.from <= bands[i - 1]!.from) {
      errors.push({ code: 'bands_not_ascending', key, message: `${label}: bands must be in strictly ascending order` });
      break;
    }
  }
}

function rangesOverlap(a: TaxRateRecord, b: TaxRateRecord): boolean {
  const aEnd = a.effectiveTo ? Date.parse(a.effectiveTo) : Infinity;
  const bEnd = b.effectiveTo ? Date.parse(b.effectiveTo) : Infinity;
  return Date.parse(a.effectiveFrom) < bEnd && Date.parse(b.effectiveFrom) < aEnd;
}

export function validateRuleSet(
  doc: RuleSetDocument,
  options: { catalogue?: CatalogueContext; asOf?: Date } = {},
): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const { rules } = doc;

  if (Number.isNaN(Date.parse(doc.effectiveFrom))) {
    errors.push({ code: 'bad_effective_from', message: `effectiveFrom "${doc.effectiveFrom}" is not a date` });
  }

  // --- Record-level checks ---------------------------------------------------
  const seen = new Set<string>();
  for (const r of rules) {
    if (!isRuleKey(r.key)) {
      errors.push({ code: 'unknown_key', key: r.key, message: `${r.key} is not a registered rule` });
      continue;
    }
    const def = RULES[r.key];
    if (!(SCOPE_TYPES as readonly string[]).includes(r.scope.type) || !def.scopes.includes(r.scope.type)) {
      errors.push({
        code: 'scope_not_allowed',
        key: r.key,
        message: `${r.key} cannot be set per ${r.scope.type} (allowed: ${def.scopes.join(', ')})`,
      });
    }
    if ((r.scope.type === 'global') !== (r.scope.ref === '*')) {
      errors.push({ code: 'bad_scope_ref', key: r.key, message: `${r.key}: global scope uses ref "*" and only global does` });
    }
    if (!(PROVENANCES as readonly string[]).includes(r.provenance)) {
      errors.push({ code: 'bad_provenance', key: r.key, message: `${r.key}: unknown provenance ${r.provenance}` });
    }
    if (!r.source || r.source.trim().length < 5) {
      errors.push({ code: 'missing_source', key: r.key, message: `${r.key} (${scopeLabel(r)}) needs a source note` });
    }
    const id = `${r.key}|${r.scope.type}|${r.scope.ref}`;
    if (seen.has(id)) errors.push({ code: 'duplicate', key: r.key, message: `${r.key} is set twice for ${scopeLabel(r)}` });
    seen.add(id);

    const parsed = def.schema.safeParse(r.value);
    if (!parsed.success) {
      errors.push({
        code: 'invalid_value',
        key: r.key,
        message: `${r.key} (${scopeLabel(r)}): ${parsed.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')}`,
      });
    }

    if (r.provenance === 'benchmark' || r.provenance === 'assumption') {
      warnings.push({
        code: `provenance_${r.provenance}`,
        key: r.key,
        message: `${r.key} (${scopeLabel(r)}) uses ${r.provenance === 'assumption' ? 'an' : 'a'} ${r.provenance} value, not a confirmed ABC rule: ${r.source}`,
      });
    }
  }

  // Every registered rule needs a global default.
  for (const key of Object.keys(RULES) as RuleKey[]) {
    if (!rules.some((r) => r.key === key && r.scope.type === 'global')) {
      errors.push({ code: 'missing_default', key, message: `${key} has no global default` });
    }
  }

  // --- Cross-rule consistency ------------------------------------------------
  const payWindow = globalValue(rules, 'settlement.pay_window_hours');
  const reminders = globalValue(rules, 'settlement.reminder_offsets_hours');
  if (payWindow !== undefined && reminders !== undefined) {
    if (reminders.some((h) => h >= payWindow)) {
      errors.push({
        code: 'reminder_after_deadline',
        key: 'settlement.reminder_offsets_hours',
        message: `Reminders (${reminders.join(', ')} h) must all come before the ${payWindow} h payment deadline`,
      });
    }
    if (reminders.some((h, i) => i > 0 && h <= reminders[i - 1]!)) {
      errors.push({ code: 'reminders_not_ascending', key: 'settlement.reminder_offsets_hours', message: 'Reminder times must be ascending' });
    }
  }

  const ladder = globalValue(rules, 'settlement.default_ladder');
  if (ladder) {
    const order = ladder.map((s) => DEFAULT_LADDER_STEPS.indexOf(s.step));
    if (order.some((o, i) => i > 0 && o <= order[i - 1]!)) {
      errors.push({
        code: 'ladder_order',
        key: 'settlement.default_ladder',
        message: `Default ladder steps must be unique and in the order ${DEFAULT_LADDER_STEPS.join(' → ')}`,
      });
    }
    if (ladder.some((s, i) => i > 0 && s.afterDueHours < ladder[i - 1]!.afterDueHours)) {
      errors.push({ code: 'ladder_time_order', key: 'settlement.default_ladder', message: 'Default ladder steps cannot go back in time' });
    }
  }

  const allowed = globalValue(rules, 'bidding.soft_close_allowed_seconds');
  if (allowed) {
    for (const { record, value } of valuesOf(rules, 'bidding.soft_close_seconds')) {
      if (!allowed.includes(value)) {
        errors.push({
          code: 'soft_close_not_allowed',
          key: 'bidding.soft_close_seconds',
          message: `Soft close ${value}s (${scopeLabel(record)}) is not one of the allowed values ${allowed.join(', ')}`,
        });
      }
    }
  }

  const collect = globalValue(rules, 'settlement.collect_window_hours');
  const freeStorage = globalValue(rules, 'storage.free_hours');
  if (collect !== undefined && freeStorage !== undefined && freeStorage < collect) {
    errors.push({
      code: 'storage_before_collection_deadline',
      key: 'storage.free_hours',
      message: `Free storage (${freeStorage} h) is shorter than the time allowed to collect (${collect} h): buyers would be charged before their deadline`,
    });
  }

  for (const { record, value } of valuesOf(rules, 'bidding.increment_ladder')) {
    for (const c of CURRENCIES) {
      const bands = value[c];
      if (bands === null) {
        warnings.push({
          code: 'currency_not_set',
          key: 'bidding.increment_ladder',
          message: `No ${c} increment ladder (${scopeLabel(record)}): ${c} auctions cannot open`,
        });
      } else {
        checkBands(bands, 'bidding.increment_ladder', `${c} increment ladder (${scopeLabel(record)})`, errors);
        if (bands.some((b, i) => i > 0 && b.increment < bands[i - 1]!.increment)) {
          // The proxy engine relies on this: a higher price never has a smaller step (docs/07 §3).
          errors.push({
            code: 'increments_decrease',
            key: 'bidding.increment_ladder',
            message: `${c} increment ladder (${scopeLabel(record)}): increments must not get smaller as the price rises`,
          });
        }
      }
    }
  }

  for (const { record, value } of valuesOf(rules, 'commission.schedule')) {
    if (value === null) {
      warnings.push({
        code: 'commission_not_set',
        key: 'commission.schedule',
        message: `Commission schedule (${scopeLabel(record)}) is not set: seller payouts cannot be calculated (Q3)`,
      });
      continue;
    }
    for (const c of CURRENCIES) {
      const bands = value.bands[c];
      if (bands) checkBands(bands, 'commission.schedule', `${c} commission bands (${scopeLabel(record)})`, errors);
    }
  }

  // Money values not yet set in a currency.
  const moneyKeys: RuleKey[] = ['limit.history_uplift_cap', 'deposit.minimum', 'override.two_person_threshold', 'payments.reconciliation_tolerance'];
  for (const key of moneyKeys) {
    for (const r of rules.filter((x) => x.key === key)) {
      const v = r.value as Record<string, unknown> | null;
      for (const c of CURRENCIES) {
        if (v && v[c] === null) {
          warnings.push({ code: 'currency_not_set', key, message: `${key} (${scopeLabel(r)}) has no ${c} value yet` });
        }
      }
    }
  }
  const base = globalValue(rules, 'limit.base');
  if (base) {
    for (const level of ['partial', 'full'] as const) {
      for (const c of CURRENCIES) {
        if (base[level][c] === null) {
          warnings.push({ code: 'currency_not_set', key: 'limit.base', message: `limit.base ${level} has no ${c} value yet` });
        }
      }
    }
  }

  // Taxes: classes, order and rates.
  const classCodes = globalValue(rules, 'tax.class_codes');
  const calcOrder = globalValue(rules, 'tax.calculation_order');
  const deliveryClass = globalValue(rules, 'delivery.tax_class');
  if (classCodes && calcOrder) {
    for (const [cls, codes] of Object.entries(classCodes)) {
      for (const code of codes) {
        if (!calcOrder.includes(code)) {
          errors.push({
            code: 'tax_code_not_ordered',
            key: 'tax.calculation_order',
            message: `Tax class ${cls} uses ${code}, which is missing from tax.calculation_order`,
          });
        }
      }
    }
  }
  if (classCodes && deliveryClass && !(deliveryClass in classCodes)) {
    errors.push({ code: 'unknown_tax_class', key: 'delivery.tax_class', message: `Delivery tax class ${deliveryClass} is not in tax.class_codes` });
  }
  if (classCodes && options.catalogue) {
    for (const cat of options.catalogue.categories) {
      if (!(cat.taxClass in classCodes)) {
        errors.push({
          code: 'unknown_tax_class',
          key: 'tax.class_codes',
          message: `Category ${cat.code} uses tax class ${cat.taxClass}, which tax.class_codes does not define`,
        });
      }
    }
    const required = globalValue(rules, 'deposit.required_categories') ?? [];
    for (const code of required) {
      if (!options.catalogue.categories.some((c) => c.code === code)) {
        errors.push({ code: 'unknown_category', key: 'deposit.required_categories', message: `Unknown category ${code}` });
      }
    }
  }

  validateTaxRates(doc.taxRates, classCodes, options.asOf ?? new Date(doc.effectiveFrom), errors, warnings);

  return { errors, warnings };
}

function validateTaxRates(
  rates: readonly TaxRateRecord[],
  classCodes: Record<string, readonly string[]> | undefined,
  asOf: Date,
  errors: Issue[],
  warnings: Issue[],
): void {
  for (const r of rates) {
    const label = `${r.taxCode}/${r.taxClass}/${r.currency} from ${r.effectiveFrom}`;
    if (!(TAX_CODES as readonly string[]).includes(r.taxCode)) {
      errors.push({ code: 'unknown_tax_code', message: `Tax rate ${label}: unknown tax code` });
    }
    if (r.effectiveTo && Date.parse(r.effectiveTo) <= Date.parse(r.effectiveFrom)) {
      errors.push({ code: 'bad_tax_dates', message: `Tax rate ${label}: effectiveTo must be after effectiveFrom` });
    }
    if (classCodes && !(r.taxClass in classCodes)) {
      errors.push({ code: 'unknown_tax_class', message: `Tax rate ${label}: tax class is not in tax.class_codes` });
    }
    if (r.provenance !== 'confirmed' && r.active) {
      warnings.push({ code: `provenance_${r.provenance}`, message: `Tax rate ${label} is active but ${r.provenance}, not confirmed by finance` });
    }
  }

  const active = rates.filter((r) => r.active);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      if (a.taxCode === b.taxCode && a.taxClass === b.taxClass && a.currency === b.currency && rangesOverlap(a, b)) {
        errors.push({
          code: 'tax_rate_overlap',
          message: `Active ${a.taxCode} rates for ${a.taxClass}/${a.currency} overlap (${a.effectiveFrom} and ${b.effectiveFrom})`,
        });
      }
    }
  }

  // Q9 safe default: a class whose taxes have no active rate blocks lots in that class.
  if (classCodes) {
    for (const [cls, codes] of Object.entries(classCodes)) {
      for (const code of codes) {
        if (code === 'imtt' || code === 'transfer_tax') continue; // charged on payments, not lots
        for (const c of CURRENCIES as readonly Currency[]) {
          const covered = active.some(
            (r) =>
              r.taxCode === code &&
              r.taxClass === cls &&
              r.currency === c &&
              Date.parse(r.effectiveFrom) <= asOf.getTime() &&
              (!r.effectiveTo || Date.parse(r.effectiveTo) > asOf.getTime()),
          );
          if (!covered) {
            warnings.push({
              code: 'tax_rate_inactive',
              key: 'tax.class_codes',
              message: `No active ${code} rate for ${cls} in ${c}: lots in this class cannot go live in ${c} until finance activates one (Q9)`,
            });
          }
        }
      }
    }
  }
}
