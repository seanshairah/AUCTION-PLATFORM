import { z } from 'zod';
import type { LotFilters } from './catalogue-reader';

/** The docket's filters, as query-string parameters (GET /lots and saved searches). */
export const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.enum(['vehicles', 'other']).optional(),
  make: z.string().max(60).optional(),
  model: z.string().max(100).optional(),
  yearFrom: z.coerce.number().int().min(1900).max(2100).optional(),
  yearTo: z.coerce.number().int().min(1900).max(2100).optional(),
  bodyStyle: z.string().max(20).optional(),
  transmission: z.string().max(20).optional(),
  fuel: z.string().max(20).optional(),
  drive: z.string().max(5).optional(),
  branch: z.string().max(5).optional(),
  maxPrice: z.string().regex(/^\d{1,9}$/).optional(), // whole currency units
  noReserve: z.enum(['1', 'true']).optional(),
  endingWithinHours: z.coerce.number().int().min(1).max(720).optional(),
  sort: z.enum(['ending_soon', 'newest', 'price_low', 'price_high', 'most_bids']).optional(),
});

/** The docket's query string as catalogue filters (also what a saved search stores). */
export function filtersFrom(q: z.infer<typeof ListQuery>): LotFilters {
  const filters: LotFilters = {
    ...q,
    noReserve: q.noReserve !== undefined,
    ...(q.maxPrice !== undefined ? { maxPriceMinor: BigInt(q.maxPrice) * 100n } : {}),
  };
  delete (filters as { maxPrice?: string }).maxPrice;
  return filters;
}
