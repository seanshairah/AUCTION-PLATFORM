/**
 * Seeds demo data into DATABASE_URL (development and staging only; see seed.ts).
 * Usage: pnpm --filter @abc/api demo:seed [--hours 72] [--force]
 */
import { connectUrl, loadDotEnv } from '@abc/db';
import { seedDemo } from './seed';

loadDotEnv();
const argv = process.argv.slice(2);
const hoursAt = argv.indexOf('--hours');
const db = connectUrl(undefined, { max: 2 });
try {
  const r = await seedDemo(db, { force: argv.includes('--force'), ...(hoursAt >= 0 ? { hours: Number(argv[hoursAt + 1]) } : {}) });
  console.log(r.created ? `created ${r.auctionCode}: ${r.lots} lots, ${r.bids} bids` : `no new auction (${r.auctionCode ?? 'none'})`);
  for (const n of r.notes) console.log(`note: ${n}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await db.close();
}
