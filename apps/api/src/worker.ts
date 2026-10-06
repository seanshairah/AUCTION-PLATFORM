import { createAdminServices } from '@abc/admin';
import { BiddingService } from '@abc/bidding';
import { connectUrl, loadDotEnv, RulebookStore } from '@abc/db';
import { RegistrationService } from '@abc/limits';
import { LogisticsService } from '@abc/logistics';
import { SettlementService } from '@abc/settlement';
import { SupportService } from '@abc/support';
import { VehicleService } from '@abc/vehicles';
import { buildCommsRuntime } from './comms/runtime';

/**
 * The worker: closes lots whose (possibly extended) end time has passed, issues
 * invoices for auctions that have fully closed, queues payment reminders, ending-soon
 * and overdue-title alerts, and dispatches messages (docs/16). It also keeps collection
 * slots generated, queues slot reminders and flags missed ticket and claim deadlines
 * (deliverables 15 and 17), and lapses override requests and retires superseded rule
 * sets (deliverable 18). Each step is idempotent, so running two workers or restarting one is safe.
 * Usage: pnpm --filter @abc/api worker [--once]
 */
loadDotEnv();
const db = connectUrl(undefined, { max: 3 });
const rulebook = new RulebookStore(db);
const registrations = new RegistrationService(rulebook);
const bidding = new BiddingService(db, rulebook, registrations);
const admin = createAdminServices(db, rulebook, { registrations, bidding });
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
  // Deliverable 18: lapse unapproved overrides; retire rule sets superseded by one now in force.
  const lapsed = await admin.overrides.expireLapsed(now);
  if (lapsed) console.log(`${lapsed} override request(s) lapsed`);
  const retired = await admin.rulebook.retireSuperseded(now);
  if (retired.length) console.log(`retired superseded rule set(s): ${retired.join(', ')}`);
  await vehicles.alertOverdueTitleSteps(now);
  await comms.endingSoon.queue(now);
  await comms.intake.resumeSubmissions(now);
  await logisticsAndSupportTick(now);
  // Last, so messages raised by every step above go out in the same tick.
  const sent = await comms.dispatcher.run(now);
  if (sent.queued || sent.sent || sent.failed) console.log(`messages: ${sent.queued} queued, ${sent.sent} sent, ${sent.failed} failed, ${sent.fallbacks} fallbacks`);
}

// Deliverables 15 and 17: collection slots (hourly), slot reminders, ticket and claim deadline flags.
const logistics = new LogisticsService(db, rulebook, settlement);
const support = new SupportService(db, rulebook, new VehicleService(db, rulebook));
let slotsEnsuredAt = 0;
async function logisticsAndSupportTick(now: Date): Promise<void> {
  if (now.getTime() - slotsEnsuredAt >= 3_600_000) {
    const created = await logistics.ensureSlots(now);
    if (created) console.log(`collection slots: ${created} created`);
    slotsEnsuredAt = now.getTime();
  }
  await logistics.queueSlotReminders(now);
  const flags = await support.flagSlaBreaches(now);
  if (flags.firstResponse + flags.resolution + flags.disputes) console.log(`support: ${JSON.stringify(flags)} deadline flag(s) raised`);
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
