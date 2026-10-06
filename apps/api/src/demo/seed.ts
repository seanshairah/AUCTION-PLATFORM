import { createHash, randomUUID } from 'node:crypto';
import { BiddingService } from '@abc/bidding';
import { checkListingReadiness } from '@abc/catalogue';
import { readRuleSetDocument, RulebookStore, SYSTEM, type Actor, type Db } from '@abc/db';
import { lotPricing, RegistrationService } from '@abc/limits';
import { PaymentService } from '@abc/payments';
import { quoteLot } from '@abc/quote';
import type { RuleRecord } from '@abc/rules';
import { CHECKLISTS, VehicleService, type InspectionInput } from '@abc/vehicles';

/**
 * DEMO DATA for development and staging databases only: a Harare vehicle auction
 * with inspected cars, three bidders with deposits, and some bids, created
 * through the same services production uses (so every invariant holds).
 *
 * Two decisions ABC has not made yet are filled in for the demo, and labelled
 * as such wherever they are stored (assumption A41):
 *   - commission (Q3): an illustrative flat 10 % in a rule set labelled "-demo"
 *   - tax rates (Q9): the initial rule set's rates, activated with a DEMO note
 * The seed refuses to run when APP_ENV=production, and it never touches the
 * rulebook if a non-demo rule set has been published.
 */

export const DEMO_EMAIL_DOMAIN = 'demo.abc-auctions.test';
const DEMO_SOURCE = 'DEMO ONLY: illustrative value for the demo environment, pending ABC decision';
const HOUR = 3_600_000;
// The standard vehicle photo set (rule catalogue.required_photo_roles for vehicles), then details.
const VEHICLE_PHOTO_ROLES = ['front', 'rear', 'left_side', 'right_side', 'interior_front', 'interior_rear', 'dashboard_odometer', 'engine_bay', 'chassis_plate', 'tyres', 'boot'];
const photoRole = (k: number): string => VEHICLE_PHOTO_ROLES[k] ?? 'detail';
const MINUTE = 60_000;

export const DEMO_COMMISSION: RuleRecord = {
  key: 'commission.schedule',
  scope: { type: 'global', ref: '*' },
  value: { basis: 'flat_band', bands: { USD: [{ from: 0, rateBp: 1000 }], ZWG: null }, minimumPerLot: { USD: 0, ZWG: null } },
  provenance: 'assumption',
  source: `${DEMO_SOURCE} (Q3)`,
} as RuleRecord;

interface DemoPerson {
  key: string;
  name: string;
  phone: string;
  verification: 'partial' | 'full';
  staffRole?: string;
}

const PEOPLE: DemoPerson[] = [
  { key: 'staff', name: 'Chipo Moyo (ABC staff, demo)', phone: '+263770000101', verification: 'full', staffRole: 'ops' },
  { key: 'approver', name: 'Tawanda Ncube (ABC finance, demo)', phone: '+263770000102', verification: 'full', staffRole: 'finance' },
  { key: 'seller', name: 'Borrowdale Motors (demo seller)', phone: '+263770000201', verification: 'full' },
  { key: 'tendai', name: 'Tendai M.', phone: '+263770000301', verification: 'full' },
  { key: 'rudo', name: 'Rudo K.', phone: '+263770000302', verification: 'full' },
  { key: 'farai', name: 'Farai C.', phone: '+263770000303', verification: 'full' },
];

export const DEMO_BIDDERS = ['tendai', 'rudo', 'farai'] as const;

interface DemoVehicle {
  make: string;
  model: string;
  year: number;
  odometerKm: number;
  zimbabweRegistered: boolean;
  startingBid: number; // whole US dollars
  reserve: number | null;
  note?: { item: string; answer: 'attention' | 'fail'; note: string };
  body: 'sedan' | 'hatchback' | 'suv' | 'pickup';
  transmission: 'manual' | 'automatic';
  fuel: 'diesel' | 'petrol' | 'hybrid';
  drive: '2wd' | '4wd';
  colour: string;
}

const VEHICLES: DemoVehicle[] = [
  { make: 'Toyota', model: 'Hilux 2.4 GD-6 Double Cab', year: 2019, odometerKm: 118_400, zimbabweRegistered: true, startingBid: 18_000, reserve: 24_000, body: 'pickup', transmission: 'manual', drive: '4wd', colour: 'White', fuel: 'diesel', note: { item: 'tyres', answer: 'attention', note: 'Rear tyres at 3 mm' } },
  { make: 'Toyota', model: 'Fortuner 2.8 GD-6 4x4', year: 2018, odometerKm: 142_000, zimbabweRegistered: true, startingBid: 20_000, reserve: 27_500, body: 'suv', transmission: 'automatic', drive: '4wd', colour: 'Silver', fuel: 'diesel' },
  { make: 'Honda', model: 'Fit Hybrid', year: 2014, odometerKm: 96_300, zimbabweRegistered: true, startingBid: 3_500, reserve: null, body: 'hatchback', transmission: 'automatic', drive: '2wd', colour: 'Blue', fuel: 'hybrid', note: { item: 'paint', answer: 'attention', note: 'Fading on roof and bonnet' } },
  { make: 'Toyota', model: 'Aqua', year: 2015, odometerKm: 88_900, zimbabweRegistered: false, startingBid: 4_200, reserve: 5_500, body: 'hatchback', transmission: 'automatic', drive: '2wd', colour: 'Red', fuel: 'hybrid' },
  { make: 'Isuzu', model: 'D-Max 250 Extended Cab', year: 2020, odometerKm: 74_500, zimbabweRegistered: true, startingBid: 14_000, reserve: 19_000, body: 'pickup', transmission: 'manual', drive: '2wd', colour: 'Grey', fuel: 'diesel' },
  { make: 'Ford', model: 'Ranger 2.2 XLS Double Cab', year: 2019, odometerKm: 131_200, zimbabweRegistered: true, startingBid: 13_500, reserve: null, body: 'pickup', transmission: 'manual', drive: '4wd', colour: 'Black', fuel: 'diesel', note: { item: 'air_conditioning', answer: 'fail', note: 'Compressor not engaging' } },
  { make: 'Mercedes-Benz', model: 'C200 Avantgarde', year: 2015, odometerKm: 109_800, zimbabweRegistered: false, startingBid: 9_000, reserve: 12_500, body: 'sedan', transmission: 'automatic', drive: '2wd', colour: 'Obsidian black', fuel: 'petrol' },
  { make: 'Nissan', model: 'NP300 Hardbody 2.5 TDi', year: 2018, odometerKm: 156_700, zimbabweRegistered: true, startingBid: 8_500, reserve: null, body: 'pickup', transmission: 'manual', drive: '2wd', colour: 'White', fuel: 'diesel' },
  { make: 'Volkswagen', model: 'Polo Vivo 1.4 Trendline', year: 2019, odometerKm: 64_100, zimbabweRegistered: true, startingBid: 6_000, reserve: 8_000, body: 'hatchback', transmission: 'manual', drive: '2wd', colour: 'Silver', fuel: 'petrol' },
  { make: 'Toyota', model: 'Land Cruiser 79 4.5 V8 Single Cab', year: 2016, odometerKm: 201_300, zimbabweRegistered: true, startingBid: 28_000, reserve: 36_000, body: 'pickup', transmission: 'manual', drive: '4wd', colour: 'Beige', fuel: 'diesel', note: { item: 'leaks', answer: 'attention', note: 'Minor oil weep at rear main seal' } },
];

/** Bids placed after opening, as (bidder, lot index, maximum in dollars). */
const BIDS: Array<[(typeof DEMO_BIDDERS)[number], number, number]> = [
  ['tendai', 0, 19_000],
  ['rudo', 0, 21_500],
  ['farai', 1, 21_000],
  ['tendai', 2, 3_800],
  ['rudo', 2, 4_100],
  ['farai', 4, 15_000],
  ['tendai', 6, 9_600],
  ['rudo', 8, 6_500],
  ['farai', 9, 29_000],
  ['tendai', 9, 30_500],
];

export interface DemoSeedResult {
  auctionId: string | null;
  auctionCode: string | null;
  created: boolean;
  ruleVersionId: string;
  accounts: Record<string, string>;
  lots: number;
  bids: number;
  notes: string[];
}

function dollars(n: number): bigint {
  return BigInt(n) * 100n;
}

function chassisFor(code: string, i: number): string {
  return `DEMO${createHash('sha256').update(`${code}-${i}`).digest('hex').slice(0, 13).toUpperCase()}`;
}

async function ensureAccounts(db: Db): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const p of PEOPLE) {
    const email = `${p.key}@${DEMO_EMAIL_DOMAIN}`;
    const found = await db.query<{ id: string }>('SELECT id FROM identity.account WHERE email = $1', [email]);
    if (found.rows[0]) {
      ids[p.key] = found.rows[0].id;
      continue;
    }
    const id = randomUUID();
    await db.tx({ ...SYSTEM, reason: 'demo seed: demo account' }, async (c) => {
      await c.query(
        `INSERT INTO identity.account (id, account_type, email, phone_e164, email_verified_at, phone_verified_at, display_name,
                                       verification_level, tier, national_id_hmac, national_id_enc)
         VALUES ($1, $2, $3, $4, now(), now(), $5, $6, 'verified', $7, $8)`,
        [id, p.key === 'seller' ? 'organisation' : 'individual', email, p.phone, p.name, p.verification,
         p.verification === 'full' ? createHash('sha256').update(`demo-id-${p.key}`).digest() : null,
         p.verification === 'full' ? Buffer.from(`demo-enc-${p.key}`) : null],
      );
    });
    ids[p.key] = id;
  }
  // Each staff role is granted by the other demo staff member (a role is never self-granted).
  for (const p of PEOPLE.filter((x) => x.staffRole)) {
    const grantor = p.key === 'staff' ? ids.approver : ids.staff;
    await db.tx({ ...SYSTEM, reason: 'demo seed: staff role' }, (c) =>
      c.query(`INSERT INTO identity.staff_role (account_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [ids[p.key], p.staffRole, grantor]),
    );
  }
  return ids;
}

/** DEMO partners (deliverable 15): a towing firm and a courier for each branch, labelled as demo data (A41). */
const DEMO_PARTNERS: Array<{ kind: 'towing' | 'courier'; name: string; phone: string; branches: string[] }> = [
  { kind: 'towing', name: 'Harare Tow and Recovery (demo)', phone: '+263770000401', branches: ['HRE'] },
  { kind: 'towing', name: 'Bulawayo Breakdown Services (demo)', phone: '+263770000402', branches: ['BYO'] },
  { kind: 'courier', name: 'Swift Parcels Harare (demo)', phone: '+263770000411', branches: ['HRE'] },
  { kind: 'courier', name: 'Matabeleland Couriers (demo)', phone: '+263770000412', branches: ['BYO'] },
];

async function ensurePartners(db: Db): Promise<void> {
  await db.tx({ ...SYSTEM, reason: 'demo seed: partners' }, async (c) => {
    for (const p of DEMO_PARTNERS) {
      await c.query(
        `INSERT INTO logistics.partner (kind, name, phone_e164, branches, notes) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (kind, name) DO NOTHING`,
        [p.kind, p.name, p.phone, p.branches, 'DEMO ONLY: not a real partner (A41)'],
      );
    }
  });
}

/** A published rule set the demo can price with: the real one if ABC has published, otherwise a labelled demo copy. */
async function ensureRuleSet(db: Db, ids: Record<string, string>, notes: string[]): Promise<string> {
  const published = await db.query<{ id: string; label: string }>(
    `SELECT id, label FROM rulebook.rule_set_version WHERE status = 'published' AND effective_from <= now() ORDER BY effective_from DESC LIMIT 1`,
  );
  if (published.rows[0]) {
    if (!published.rows[0].label.endsWith('-demo')) notes.push(`Using the published rule set ${published.rows[0].label}; the rulebook was not changed.`);
    return published.rows[0].id;
  }
  const doc = readRuleSetDocument();
  const label = `${doc.label}-demo`;
  const actor: Actor = { type: 'staff', id: ids.approver!, name: 'Demo approver', reason: 'demo seed: publish demo rule set (A41)' };
  const versionId = await db.tx(actor, async (c) => {
    const v = await c.query<{ id: string }>(
      `INSERT INTO rulebook.rule_set_version (label, effective_from, status, authored_by, notes)
       VALUES ($1, now() - interval '1 minute', 'draft', $2, $3) RETURNING id`,
      [label, ids.staff, 'DEMO rule set: the initial rule set plus an illustrative commission (Q3). Not a decision by ABC.'],
    );
    const id = v.rows[0]!.id;
    const records = [...doc.rules.filter((r) => !(r.key === DEMO_COMMISSION.key && r.scope.type === 'global')), DEMO_COMMISSION];
    for (const r of records) {
      await c.query(
        `INSERT INTO rulebook.rule_value (version_id, rule_key, scope_type, scope_ref, value, provenance, source_note)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [id, r.key, r.scope.type, r.scope.ref, JSON.stringify(r.value), r.provenance, r.source],
      );
    }
    await c.query(`UPDATE rulebook.rule_set_version SET status = 'published', approved_by = $2, published_at = now() WHERE id = $1`, [id, ids.approver]);
    for (const t of doc.taxRates) {
      const active = await c.query(
        `SELECT 1 FROM rulebook.tax_rate WHERE active AND tax_code = $1 AND tax_class = $2 AND currency = $3
            AND tstzrange(effective_from, effective_to) && tstzrange($4::timestamptz, $5::timestamptz)`,
        [t.taxCode, t.taxClass, t.currency, t.effectiveFrom, t.effectiveTo ?? null],
      );
      if (active.rowCount) continue;
      await c.query(
        `INSERT INTO rulebook.tax_rate (tax_code, tax_class, currency, rate_bp, base, effective_from, effective_to, active, provenance, owner, approved_by, source_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, 'finance', $9, $10)`,
        [t.taxCode, t.taxClass, t.currency, t.rateBp, t.base, t.effectiveFrom, t.effectiveTo ?? null, t.provenance, ids.approver, `${DEMO_SOURCE} (Q9)`],
      );
    }
    return id;
  });
  notes.push(`Published demo rule set ${label} with illustrative commission and activated tax rates (A41).`);
  return versionId;
}

function inspectionFor(v: DemoVehicle, chassis: string, engine: string): InspectionInput {
  const answers: InspectionInput['answers'] = {};
  for (const item of CHECKLISTS['vehicle-v1']!) answers[item.id] = { answer: 'ok' };
  if (v.zimbabweRegistered) answers.zimra_clearance = { answer: 'not_applicable' };
  if (v.note) answers[v.note.item] = { answer: v.note.answer, note: v.note.note };
  return { checklistVersion: 'vehicle-v1', answers, photoCount: 38, hasVideo: true, chassisNumberSeen: chassis, engineNumberSeen: engine, odometerKm: v.odometerKm };
}

export async function seedDemo(
  db: Db,
  options: { hours?: number; force?: boolean; now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<DemoSeedResult> {
  const env = options.env ?? process.env;
  if (env.APP_ENV === 'production') throw new Error('Refusing to seed demo data with APP_ENV=production.');
  const now = options.now ?? new Date();
  const notes: string[] = [];
  const ids = await ensureAccounts(db);
  const ruleVersionId = await ensureRuleSet(db, ids, notes);
  await ensurePartners(db);

  // A demo auction still 'scheduled' is left over from a seed run that failed part-way: cancel it.
  await db.tx({ ...SYSTEM, reason: 'demo seed: cancel a half-created demo auction' }, async (c) => {
    const stale = await c.query<{ id: string }>(`UPDATE auction.auction SET status = 'cancelled' WHERE code LIKE 'DEMO-%' AND status = 'scheduled' RETURNING id`);
    for (const a of stale.rows) {
      await c.query(
        `UPDATE catalogue.lot SET state = 'withdrawn' WHERE state = 'listed' AND id IN (SELECT lot_id FROM auction.auction_lot WHERE auction_id = $1)`,
        [a.id],
      );
    }
  });
  const open = await db.query<{ id: string; code: string }>(
    `SELECT id, code FROM auction.auction WHERE code LIKE 'DEMO-%' AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
  );
  if (open.rows[0] && !options.force) {
    notes.push(`Demo auction ${open.rows[0].code} is still open; nothing new created (use --force to add another).`);
    return { auctionId: open.rows[0].id, auctionCode: open.rows[0].code, created: false, ruleVersionId, accounts: ids, lots: 0, bids: 0, notes };
  }

  const rulebook = new RulebookStore(db);
  const registrations = new RegistrationService(rulebook);
  const bidding = new BiddingService(db, rulebook, registrations);
  const payments = new PaymentService(db, rulebook, []);
  const vehicles = new VehicleService(db, rulebook);
  const staff = { type: 'staff' as const, id: ids.staff!, name: 'Chipo Moyo', reason: 'demo seed' };

  // Wallets: branch cash at the Harare counter, one receipt per bidder per seed run.
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  for (const b of DEMO_BIDDERS) {
    const w = await db.query<{ available: bigint }>(
      `SELECT coalesce(sum(available_minor), 0)::bigint AS available FROM ledger.v_wallet WHERE account_id = $1 AND currency = 'USD'`,
      [ids[b]],
    );
    if ((w.rows[0]?.available ?? 0n) < dollars(9_000)) {
      await payments.recordBranchCash(staff, { cashierId: ids.staff!, branch: 'HRE', accountId: ids[b]!, currency: 'USD', amountMinor: dollars(10_000), receiptNumber: `DEMO-${stamp}-${b}` });
    }
  }

  // The auction and its lots, each through intake, inspection and the readiness gate.
  const hours = options.hours ?? 72;
  const code = `DEMO-HRE-${stamp}`;
  const auctionId = randomUUID();
  const snapshot = await rulebook.snapshot(ruleVersionId);
  const taxRates = await rulebook.taxRates();
  const vocab = await db.query<{ kind: string; code: string }>(
    `SELECT 'state' AS kind, code FROM catalogue.item_state_term UNION ALL SELECT 'condition', code FROM catalogue.condition_term`,
  );
  const vocabulary = {
    itemStates: vocab.rows.filter((r) => r.kind === 'state').map((r) => r.code),
    conditions: vocab.rows.filter((r) => r.kind === 'condition').map((r) => r.code),
  };
  const firstEnd = new Date(now.getTime() + hours * HOUR);
  const staggerSeconds = 120;
  await db.tx(staff, (c) =>
    c.query(
      `INSERT INTO auction.auction (id, code, title, format, branch_code, status, opens_at, first_close_at, stagger_seconds, deposit_required, created_by)
       VALUES ($1, $2, 'Vehicles: Harare (demo)', 'timed_online', 'HRE', 'scheduled', $3, $4, $5, true, $6)`,
      [auctionId, code, new Date(now.getTime() - 5 * MINUTE), firstEnd, staggerSeconds, ids.staff],
    ),
  );

  const auctionLots: string[] = [];
  for (const [i, v] of VEHICLES.entries()) {
    const n = i + 1;
    const lotId = randomUUID();
    const category = v.zimbabweRegistered ? 'vehicles_used_zw' : 'vehicles';
    const cat = (await db.query<{ tax_class: string }>('SELECT tax_class FROM catalogue.category WHERE code = $1', [category])).rows[0]!;
    const title = `${v.year} ${v.make} ${v.model}`;
    const description =
      `${title}, ${v.colour.toLowerCase()}, ${v.transmission}, ${v.fuel}, ${v.drive.toUpperCase()}, ${v.odometerKm.toLocaleString('en-US')} km. ` +
      `${v.zimbabweRegistered ? 'Zimbabwe-registered.' : 'Imported; ZIMRA clearance on file.'} Inspected on the standard checklist; report and 38 photos on this page. ` +
      'Viewing at ABC Harare by appointment.';
    const chassis = chassisFor(code, n);
    const engine = `ENG${chassis.slice(4, 12)}`;
    await db.tx(staff, async (c) => {
      const consignment = randomUUID();
      await c.query(`INSERT INTO seller.consignment (id, seller_account_id, consignment_type, intake_channel, branch_code) VALUES ($1, $2, 'commission', 'branch', 'HRE')`, [consignment, ids.seller]);
      await c.query(
        `INSERT INTO catalogue.lot (id, lot_ref, consignment_id, seller_account_id, category_code, is_vehicle, title, description,
                                    item_state, condition, condition_notes, location_branch, settlement_currency, tax_class, starting_bid_minor, reserve_minor)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, 'used', 'working', $8, 'HRE', 'USD', $9, $10, $11)`,
        [lotId, `${code}-${n}`, consignment, ids.seller, category, title, description, v.note ? `${v.note.note}.` : null, cat.tax_class,
         dollars(v.startingBid).toString(), v.reserve === null ? null : dollars(v.reserve).toString()],
      );
      const media: string[] = [];
      const params: unknown[] = [lotId];
      for (let k = 0; k < 38; k++) {
        params.push(photoRole(k), `demo/${code}-${n}/photo-${String(k + 1).padStart(2, '0')}.jpg`, k);
        media.push(`($1, 'photo', $${params.length - 2}, $${params.length - 1}, $${params.length})`);
      }
      params.push(`demo/${code}-${n}/walkaround.mp4`);
      media.push(`($1, 'video', 'walkaround', $${params.length}, 100)`);
      await c.query(`INSERT INTO catalogue.lot_media (lot_id, kind, role, object_key, sort) VALUES ${media.join(', ')}`, params);
    });
    await vehicles.setDetails(staff, lotId, {
      make: v.make, model: v.model, year: v.year, chassisNumber: chassis, engineNumber: engine,
      registrationNumber: v.zimbabweRegistered ? `AF${String(1000 + n * 37).slice(0, 4)}` : undefined,
      zimbabweRegistered: v.zimbabweRegistered, odometerKm: v.odometerKm, documentsStatus: 'complete',
      fuel: v.fuel, transmission: v.transmission, colour: v.colour, bodyStyle: v.body, drive: v.drive,
    });
    const { reportId } = await vehicles.submitInspection(staff, lotId, inspectionFor(v, chassis, engine));
    const pub = await vehicles.publishInspection(staff, reportId);
    if (!pub.published) throw new Error(`Demo inspection for ${title} did not publish: ${pub.issues.map((x) => x.code).join(', ')}`);

    const readiness = checkListingReadiness({
      lot: { title, description, categoryPath: (await lotPricing(db, lotId)).categoryPath, itemState: 'used', condition: 'working', conditionNotes: v.note?.note ?? null,
             currency: 'USD', taxClass: cat.tax_class, isVehicle: true, startingBidMinor: dollars(v.startingBid), reserveMinor: v.reserve === null ? null : dollars(v.reserve) },
      media: (await db.query<{ kind: 'photo' | 'video' | 'document'; role: string }>('SELECT kind, role FROM catalogue.lot_media WHERE lot_id = $1', [lotId])).rows,
      vehicle: { chassisNumber: chassis, zimbabweRegistered: v.zimbabweRegistered },
      inspection: { published: true, photoCount: 38, hasVideo: true, chassisVerified: true },
      vocabulary, snapshot, taxRates, at: now,
    });
    if (!readiness.ready) throw new Error(`Demo lot ${title} is not ready to list: ${readiness.blockers.map((x) => x.code).join(', ')}`);

    const auctionLotId = randomUUID();
    const endsAt = new Date(firstEnd.getTime() + i * staggerSeconds * 1000);
    await db.tx(staff, async (c) => {
      await c.query(`UPDATE catalogue.lot SET state = 'listed' WHERE id = $1`, [lotId]);
      await c.query(
        `INSERT INTO auction.auction_lot (id, auction_id, lot_id, currency, lot_number, starting_bid_minor, reserve_minor, scheduled_end_at, current_end_at)
         VALUES ($1, $2, $3, 'USD', $4, $5, $6, $7, $7)`,
        [auctionLotId, auctionId, lotId, n, dollars(v.startingBid).toString(), v.reserve === null ? null : dollars(v.reserve).toString(), endsAt],
      );
      await c.query('UPDATE catalogue.lot SET current_auction_lot_id = $2 WHERE id = $1', [lotId, auctionLotId]);
    });
    auctionLots.push(auctionLotId);
  }

  await bidding.openAuction({ ...staff, reason: 'demo seed: open demo auction' }, auctionId, now);

  // One-tap registration with a deposit held from each bidder's wallet.
  for (const b of DEMO_BIDDERS) {
    await db.tx({ type: 'account', id: ids[b]!, name: b, reason: 'demo seed: join auction' }, (c) =>
      registrations.join(c, { accountId: ids[b]!, auctionId, deposit: { USD: dollars(8_000) } }),
    );
  }

  let bids = 0;
  for (const [who, lotIndex, max] of BIDS) {
    const auctionLotId = auctionLots[lotIndex]!;
    const lotId = (await db.query<{ lot_id: string }>('SELECT lot_id FROM auction.auction_lot WHERE id = $1', [auctionLotId])).rows[0]!.lot_id;
    const pricing = await lotPricing(db, lotId);
    const quote = quoteLot({ lot: pricing, hammerMinor: dollars(max), snapshot, taxRates, at: new Date() });
    const out = await bidding.placeBid({ type: 'account', id: ids[who]!, name: who, reason: 'demo seed: bid' }, {
      accountId: ids[who]!, auctionLotId, maxMinor: dollars(max), clientRequestId: randomUUID(),
      quotedTotalMinor: quote.totalMinor, quotedRuleVersionId: ruleVersionId, channel: 'web',
    });
    if (out.accepted) bids++;
    else notes.push(`Demo bid by ${who} on lot ${lotIndex + 1} was not accepted: ${out.reason}`);
  }

  return { auctionId, auctionCode: code, created: true, ruleVersionId, accounts: ids, lots: VEHICLES.length, bids, notes };
}
