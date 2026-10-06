import type { Currency } from '@abc/domain';

/**
 * Saved searches and alerts (blueprint module 4). When a lot is listed, the alert
 * job checks it against every saved search with alerts on and sends one message
 * per match through the communications layer, deduplicated by
 * (saved search, lot, channel).
 */

export interface SavedSearchQuery {
  /** Every word must appear in the title or description (case-insensitive). */
  text?: string;
  /** Matches the lot's category or any of its parents. */
  categories?: readonly string[];
  branches?: readonly string[];
  currency?: Currency;
  /** Upper bound on the starting bid or current price, in the query's currency. */
  maxPriceMinor?: bigint;
  itemStates?: readonly string[];
  conditions?: readonly string[];
}

export interface LotForSearch {
  title: string;
  description: string;
  categoryPath: readonly string[];
  branch: string;
  currency: Currency;
  priceMinor: bigint;
  itemState: string;
  condition: string;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

export function matchesSavedSearch(query: SavedSearchQuery, lot: LotForSearch): boolean {
  if (query.text) {
    const haystack = new Set(words(`${lot.title} ${lot.description}`));
    if (!words(query.text).every((w) => haystack.has(w))) return false;
  }
  if (query.categories?.length && !query.categories.some((c) => lot.categoryPath.includes(c))) return false;
  if (query.branches?.length && !query.branches.includes(lot.branch)) return false;
  if (query.currency && query.currency !== lot.currency) return false;
  // A price limit only applies in its own currency: never compare across USD and ZiG.
  if (query.maxPriceMinor !== undefined) {
    if (!query.currency || query.currency !== lot.currency || lot.priceMinor > query.maxPriceMinor) return false;
  }
  if (query.itemStates?.length && !query.itemStates.includes(lot.itemState)) return false;
  if (query.conditions?.length && !query.conditions.includes(lot.condition)) return false;
  return true;
}
