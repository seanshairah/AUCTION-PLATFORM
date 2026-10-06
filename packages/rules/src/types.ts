import type { Currency } from '@abc/domain';

/** Where a value comes from (docs/00-assumptions-register.md, "How to read this register"). */
export const PROVENANCES = ['confirmed', 'benchmark', 'proposed', 'assumption'] as const;
export type Provenance = (typeof PROVENANCES)[number];

/**
 * Dimensions a rule value can be scoped to. When several records match, the most
 * specific wins (see SPECIFICITY in resolve.ts). Matches rulebook.rule_value.scope_type.
 */
export const SCOPE_TYPES = ['global', 'currency', 'tier', 'auction_format', 'branch', 'category'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const TIERS = ['guest', 'verified', 'trusted', 'restricted'] as const;
export type Tier = (typeof TIERS)[number];

export const AUCTION_FORMATS = ['timed_online', 'floor', 'out_of_hand'] as const;
export type AuctionFormat = (typeof AUCTION_FORMATS)[number];

export const TAX_CODES = ['purchasers_levy', 'vat', 'imtt', 'transfer_tax'] as const;
export type TaxCode = (typeof TAX_CODES)[number];

export const TAX_BASES = ['hammer', 'hammer_plus_premium', 'gross', 'transfer_amount'] as const;
export type TaxBase = (typeof TAX_BASES)[number];

export interface RuleScope {
  type: ScopeType;
  ref: string; // '*' for global
}

export interface RuleRecord {
  key: string;
  scope: RuleScope;
  value: unknown;
  provenance: Provenance;
  source: string;
}

export interface TaxRateRecord {
  id?: string;
  taxCode: TaxCode;
  taxClass: string;
  currency: Currency;
  rateBp: number;
  base: TaxBase;
  effectiveFrom: string;
  effectiveTo?: string | null;
  active: boolean;
  provenance: Provenance;
  source: string;
}

/** The file format of rulebook/*.json and the shape of one rule set version. */
export interface RuleSetDocument {
  label: string;
  effectiveFrom: string;
  notes?: string;
  rules: RuleRecord[];
  taxRates: TaxRateRecord[];
}

/** What is known about the situation a rule is read for. */
export interface ScopeContext {
  currency?: Currency;
  tier?: Tier;
  auctionFormat?: AuctionFormat;
  branch?: string;
  /** Category codes from root to leaf, e.g. ['vehicles', 'vehicles_used_zw']. Deeper wins. */
  categoryPath?: readonly string[];
}
