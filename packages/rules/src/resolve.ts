import { RULES, isRuleKey, type RuleKey, type RuleValue } from './registry';
import type { Provenance, RuleRecord, ScopeContext, ScopeType, TaxRateRecord } from './types';

export class RuleMissingError extends Error {
  constructor(
    readonly key: string,
    detail?: string,
  ) {
    super(`Rule ${key} has no value for this situation${detail ? `: ${detail}` : ''}`);
    this.name = 'RuleMissingError';
  }
}

/** Higher wins. Category depth is added on top, so a sub-category beats its parent. */
const SPECIFICITY: Record<ScopeType, number> = {
  global: 0,
  currency: 10,
  tier: 20,
  auction_format: 30,
  branch: 40,
  category: 50,
};

function matchScore(record: RuleRecord, ctx: ScopeContext): number | null {
  const { type, ref } = record.scope;
  switch (type) {
    case 'global':
      return SPECIFICITY.global;
    case 'currency':
      return ctx.currency === ref ? SPECIFICITY.currency : null;
    case 'tier':
      return ctx.tier === ref ? SPECIFICITY.tier : null;
    case 'auction_format':
      return ctx.auctionFormat === ref ? SPECIFICITY.auction_format : null;
    case 'branch':
      return ctx.branch === ref ? SPECIFICITY.branch : null;
    case 'category': {
      const depth = ctx.categoryPath?.indexOf(ref) ?? -1;
      return depth >= 0 ? SPECIFICITY.category + depth : null;
    }
  }
}

export interface ResolvedRule<K extends RuleKey> {
  value: RuleValue<K>;
  provenance: Provenance;
  source: string;
  scope: RuleRecord['scope'];
}

/**
 * One immutable rule set version, ready to answer "what is the rule here?".
 * The same snapshot (by version id) feeds the commit screen and the invoice engine (R2).
 */
export class RuleSnapshot {
  private readonly byKey = new Map<string, RuleRecord[]>();

  constructor(
    readonly versionId: string,
    readonly label: string,
    records: readonly RuleRecord[],
    readonly taxRates: readonly TaxRateRecord[] = [],
  ) {
    for (const record of records) {
      if (!isRuleKey(record.key)) throw new Error(`Unknown rule key ${record.key}`);
      const parsed = RULES[record.key].schema.parse(record.value);
      const list = this.byKey.get(record.key) ?? [];
      list.push({ ...record, value: parsed });
      this.byKey.set(record.key, list);
    }
  }

  resolve<K extends RuleKey>(key: K, ctx: ScopeContext = {}): ResolvedRule<K> {
    let best: { record: RuleRecord; score: number } | undefined;
    for (const record of this.byKey.get(key) ?? []) {
      const score = matchScore(record, ctx);
      if (score !== null && (best === undefined || score > best.score)) best = { record, score };
    }
    if (!best) throw new RuleMissingError(key);
    return {
      value: best.record.value as RuleValue<K>,
      provenance: best.record.provenance,
      source: best.record.source,
      scope: best.record.scope,
    };
  }

  get<K extends RuleKey>(key: K, ctx: ScopeContext = {}): RuleValue<K> {
    return this.resolve(key, ctx).value;
  }

  /** Every record for a key, for rendering overrides on the public rulebook page. */
  records(key: RuleKey): readonly RuleRecord[] {
    return this.byKey.get(key) ?? [];
  }
}
