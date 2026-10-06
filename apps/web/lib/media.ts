import credits from '@/public/media/demo/vehicles/credits.json';

/**
 * Demo media. Development has no object store, so the demo seed stores keys like
 * demo/<lot>/v/<photo-set>/photo-07.jpg and the /media route serves them from a small,
 * credited photo set (Wikimedia Commons). Production serves every key from MEDIA_BASE_URL.
 */
export interface PhotoCredit {
  file: string;
  title: string;
  artist: string;
  license: string;
  licenseUrl: string | null;
  source: string;
}

const CREDITS = credits as Record<string, PhotoCredit[]>;

export function demoSet(url: string | null | undefined): string | null {
  const m = url ? /\/demo\/[^/]+\/v\/([a-z0-9-]+)\//.exec(decodeURIComponent(url)) : null;
  return m && CREDITS[m[1]!] ? m[1]! : null;
}

/** Distinct real photos available for a demo set (the rest of the standard set are role slots). */
export function demoPhotoCount(set: string): number {
  return CREDITS[set]?.length ?? 0;
}

export function demoCredits(set: string): PhotoCredit[] {
  return CREDITS[set] ?? [];
}

export function sized(url: string, width: 800 | 1600): string {
  return url.startsWith('/media/') ? `${url}?w=${width}` : url;
}

export const HERO_PHOTO = '/media/demo/vehicles/hero/1-1600.jpg';
export const HERO_CREDIT = CREDITS.hero?.[0] ?? null;
