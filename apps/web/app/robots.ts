import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base = process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000';
  return { rules: [{ userAgent: '*', allow: '/', disallow: ['/account/', '/api/', '/sign-in'] }], sitemap: `${base}/sitemap.xml` };
}
