import type { MetadataRoute } from 'next';
import type { LotCard } from '@/lib/types';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/** Lot pages are crawlable (blueprint gap 10): every live lot is in the sitemap. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000';
  const lots = await fetch(`${API_URL}/lots`, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<{ lots: LotCard[] }>) : { lots: [] }))
    .catch(() => ({ lots: [] as LotCard[] }));
  return [
    { url: `${base}/`, changeFrequency: 'hourly', priority: 1 },
    { url: `${base}/auctions`, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${base}/rules`, changeFrequency: 'weekly' },
    { url: `${base}/sell`, changeFrequency: 'monthly' },
    { url: `${base}/help`, changeFrequency: 'monthly' },
    ...lots.lots.map((l) => ({ url: `${base}/lots/${encodeURIComponent(l.ref)}`, changeFrequency: 'hourly' as const, lastModified: new Date() })),
  ];
}
