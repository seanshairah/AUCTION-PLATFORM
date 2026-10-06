import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { demoPhotoCount } from '@/lib/media';

/**
 * Serves demo media keys (demo/<lot>/v/<set>/photo-NN.jpg) from the credited demo photo
 * set. The standard 38-photo set maps onto the few real photos per vehicle in order;
 * production media never reaches this route (MEDIA_BASE_URL points at the object store).
 */
export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const parts = (await ctx.params).path;
  const width = new URL(req.url).searchParams.get('w') === '800' ? 800 : 1600;
  let file: string | null = null;
  if (parts[0] === 'demo' && parts[2] === 'v' && parts.length === 5) {
    const set = parts[3]!;
    const count = demoPhotoCount(set);
    const n = /^photo-(\d+)\.jpg$/.exec(parts[4]!);
    if (count > 0 && n) file = path.join(set, `${((Number(n[1]) - 1) % count) + 1}-${width}.jpg`);
  } else if (parts[0] === 'demo' && parts[1] === 'vehicles' && parts.length === 4 && /^\d+-(800|1600)\.jpg$/.test(parts[3]!)) {
    file = path.join(parts[2]!, parts[3]!);
  }
  if (!file || file.includes('..')) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(path.join(process.cwd(), 'public', 'media', 'demo', 'vehicles', file));
    return new Response(new Uint8Array(body), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400, immutable' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
