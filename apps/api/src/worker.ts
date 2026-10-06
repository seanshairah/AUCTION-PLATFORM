import { BiddingService } from '@abc/bidding';
import { connectUrl, loadDotEnv, RulebookStore } from '@abc/db';
import { RegistrationService } from '@abc/limits';
import { SettlementService } from '@abc/settlement';
import { VehicleService } from '@abc/vehicles';
import { buildCommsRuntime } from './comms/runtime';

/**
 * The worker: closes lots whose (possibly extended) end time has passed, issues
 * invoices for auctions that have fully closed, queues payment reminders, ending-soon
 * and overdue-title alerts, and dispatches messages (docs/16).
 * Each step is idempotent, so running two workers or restarting one is safe.
 * Usage: pnpm --filter @abc/api worker [--once]
 */
loadDotEnv();
const db = connectUrl(undefined, { max: 3 });
const rulebook = new RulebookStore(db);
const bidding = new BiddingService(db, rulebook, new RegistrationService(rulebook));
const gatePassSecret = process.env.GATE_PASS_SECRET ?? (process.env.APP_ENV === 'production' ? '' : 'dev-only-gate-pass-secret');
if (!gatePassSecret) throw new Error('GATE_PASS_SECRET is required in production.');
const settlement = new SettlementService(db, rulebook, { gatePassSecret });
const vehicles = new VehicleService(db, rulebook);
const comms = buildCommsRuntime(db, rulebook);
const intervalMs = Number(process.env.WORKER_INTERVAL_MS ?? 5_000);

export async function tick(now = new Date()): Promise<void> {
  const closed = await bidding.closeDueLots(now);
  for (const c of closed) console.log(`closed ${c.auctionLotId}: ${c.result.result}`);
  const ready = await db.query<{ id: string }>(
    `SELECT a.id FROM auction.auction a WHERE a.status = 'closed'
        AND EXISTS (SELECT 1 FROM auction.auction_lot al WHERE al.auction_id = a.id AND al.result = 'sold'
                      AND NOT EXISTS (SELECT 1 FROM settlement.invoice_line il WHERE il.auction_lot_id = al.id))`,
  );
  for (const a of ready.rows) {
    const issued = await settlement.settleClosedAuction(a.id);
    if (issued.length) console.log(`auction ${a.id}: ${issued.length} invoice(s) issued`);
  }
  await settlement.queueDueReminders(now);
  await vehicles.alertOverdueTitleSteps(now);
  await comms.endingSoon.queue(now);
  await comms.intake.resumeSubmissions(now);
  const sent = await comms.dispatcher.run(now);
  if (sent.queued || sent.sent || sent.failed) console.log(`messages: ${sent.queued} queued, ${sent.sent} sent, ${sent.failed} failed, ${sent.fallbacks} fallbacks`);
}

const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));
do {
  try {
    await tick();
  } catch (e) {
    console.error('worker tick failed:', e instanceof Error ? e.message : e);
  }
  if (!once && !stopping) await new Promise((r) => setTimeout(r, intervalMs));
} while (!once && !stopping);
await db.close();
