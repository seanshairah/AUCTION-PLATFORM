import type { Currency } from '@abc/domain';

/**
 * Structured data for a server-rendered lot page (schema.org Product + Offer), so
 * search engines can index lots (blueprint gap 10, Q10). Emitted as JSON-LD in the
 * page head. Prices are the current bid in the lot's own currency; schema.org has
 * no auction type, so the offer's end time is availabilityEnds.
 */

const ITEM_CONDITION: Record<string, string> = {
  new: 'https://schema.org/NewCondition',
  new_open_box: 'https://schema.org/NewCondition',
  used: 'https://schema.org/UsedCondition',
  renewed: 'https://schema.org/RefurbishedCondition',
};

const DAMAGED_CONDITIONS = new Set(['damaged', 'broken', 'not_working']);

export interface LotForSeo {
  lotRef: string;
  title: string;
  description: string;
  itemState: string;
  condition: string;
  categoryName: string;
  currency: Currency;
  /** Current bid, or the starting bid when there are no bids. */
  priceMinor: bigint;
  endAt: Date;
  status: 'listed' | 'live' | 'closed';
  url: string;
  imageUrls: readonly string[];
  branchCity: string;
}

function decimal(minor: bigint): string {
  const abs = minor < 0n ? -minor : minor;
  return `${minor < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export function lotStructuredData(lot: LotForSeo): Record<string, unknown> {
  const itemCondition = DAMAGED_CONDITIONS.has(lot.condition)
    ? 'https://schema.org/DamagedCondition'
    : (ITEM_CONDITION[lot.itemState] ?? 'https://schema.org/UsedCondition');
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: lot.title,
    description: lot.description.slice(0, 5000),
    sku: lot.lotRef,
    category: lot.categoryName,
    image: lot.imageUrls,
    itemCondition,
    offers: {
      '@type': 'Offer',
      url: lot.url,
      priceCurrency: lot.currency, // ISO 4217: USD or ZWG
      price: decimal(lot.priceMinor),
      availability: lot.status === 'closed' ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock',
      availabilityEnds: lot.endAt.toISOString(),
      seller: { '@type': 'Organization', name: 'ABC Auctions' },
      availableAtOrFrom: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: lot.branchCity, addressCountry: 'ZW' } },
    },
  };
}
