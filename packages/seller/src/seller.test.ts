import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BiddingService } from '@abc/bidding';
import {
  createAccount,
  createAuction,
  createTestDatabase,
  DB_TESTS_ENABLED,
  loadPublishedRuleSetForTests,
  readRuleSetDocument,
  RulebookStore,
  SYSTEM,
  type TestDatabase,
} from '@abc/db';
import { RegistrationService } from '@abc/limits';
import { quoteLot } from '@abc/quote';
import { RuleSnapshot, type RuleRecord } from '@abc/rules';
import {
  CommissionNotPublishedError,
  consignmentNote,
  handleIntakeMessage,
  parseCsv,
  SellerService,
  startIntake,
  statementTotals,
  validateBulkUpload,
  valuationRange,
  type IntakeOptions,
  type IntakeState,
} from './index';

const DOC = readRuleSetDocument();
const COMMISSION: RuleRecord = {
  key: 'commission.schedule',
  scope: { type: 'global', ref: '*' },
  value: { basis: 'flat_band', bands: { USD: [{ from: 0, rateBp: 1000 }], ZWG: null }, minimumPerLot: { USD: 0, ZWG: null } },
  provenance: 'assumption',
  source: 'TEST ONLY: illustrative commission pending Q3',
};
const plain = new RuleSnapshot('v', DOC.label, DOC.rules);
const withCommission = new RuleSnapshot('v', DOC.label, [...DOC.rules.filter((r) => r.key !== 'commission.schedule'), COMMISSION]);

const VOCAB = {
  categories: ['vehicles', 'vehicles_used_zw', 'it', 'catering', 'furniture', 'general', 'special'],
  itemStates: ['new', 'new_open_box', 'used', 'renewed'],
  conditions: ['as_is', 'working', 'untested', 'partly_working', 'damaged', 'broken', 'incomplete', 'sealed_packing', 'not_working'],
};

const HEADER = 'external_ref,title,description,category,item_state,condition,condition_notes,currency,starting_bid,reserve,estimate_low,estimate_high,quantity';

describe('valuation range', () => {
  it('is the middle half of comparable results', () => {
    const prices = [100n, 200n, 300n, 400n, 500n, 600n, 700n, 800n, 900n].map((p) => p * 100n);
    expect(valuationRange(prices, plain)).toEqual({ lowMinor: 30_000n, medianMinor: 50_000n, highMinor: 70_000n, comparables: 9 });
  });

  it('needs at least 5 comparables; otherwise staff value it', () => {
    expect(valuationRange([1n, 2n, 3n, 4n], plain)).toBeNull();
  });
});

describe('bulk upload validation', () => {
  it('parses quoted CSV fields with commas, quotes and line breaks', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
  });

  it('accepts a clean customs file with USD and ZiG lots', () => {
    const csv = [
      HEADER,
      'ZIMRA-BB-0001,Toyota Hilux 2.4 2017,Seized at Beitbridge; no keys,vehicles,used,as_is,,USD,"2,500",,,,1',
      'ZIMRA-BB-0002,Carton of 40 phone chargers,Sealed cartons,general,new,sealed_packing,,ZWG,1500,3000,2000,4000,40',
    ].join('\n');
    const r = validateBulkUpload(csv, { ...VOCAB, snapshot: plain });
    expect(r.errors).toEqual([]);
    expect(r.lots.map((l) => [l.externalRef, l.currency, l.startingBidMinor, l.reserveMinor, l.quantity])).toEqual([
      ['ZIMRA-BB-0001', 'USD', 250_000n, null, 1],
      ['ZIMRA-BB-0002', 'ZWG', 150_000n, 300_000n, 40],
    ]);
  });

  it('reports every error with its row and column, and accepts nothing', () => {
    const csv = [
      HEADER,
      'R1,Laptop,Fine,it,used,like new,,USD,100,,,,1',
      'R1,Desk,Wooden desk,furniture,used,working,,EUR,abc,50,,,0',
      ',Chair set,Six chairs,furniture,used,working,,USD,100,80,,,1',
    ].join('\n');
    const r = validateBulkUpload(csv, { ...VOCAB, snapshot: plain });
    expect(r.lots).toEqual([]);
    expect(r.errors).toEqual([
      { row: 1, field: 'condition', message: '"like new" is not in the condition vocabulary' },
      { row: 2, field: 'external_ref', message: '"R1" appears more than once in this file' },
      { row: 2, field: 'title', message: 'needs at least 5 characters' },
      { row: 2, field: 'currency', message: 'must be USD or ZWG (ZiG)' },
      { row: 2, field: 'starting_bid', message: '"abc" is not an amount' },
      { row: 2, field: 'quantity', message: 'must be a whole number of 1 or more' },
      { row: 3, field: 'external_ref', message: 'is required' },
      { row: 3, field: 'reserve', message: 'must be above the starting bid, or left empty' },
    ]);
  });

  it('rejects a file without the required columns', () => {
    expect(validateBulkUpload('title,category\nX,it', { ...VOCAB, snapshot: plain }).errors.map((e) => e.field)).toEqual(
      expect.arrayContaining(['external_ref', 'description', 'item_state', 'condition', 'currency', 'starting_bid']),
    );
  });
});

describe('consignment note', () => {
  const input = {
    consignmentId: 'c-1',
    sellerName: 'Tendai Moyo',
    consignmentType: 'commission' as const,
    branch: 'HRE',
    lots: [{ lotRef: 'HRE-26-0001', title: 'Dell laptop', condition: 'working', currency: 'USD' as const, reserveMinor: 15_000n }],
    date: new Date('2026-11-01T09:00:00Z'),
  };

  it('cannot be produced for signing until commission is published (Q3)', () => {
    expect(() => consignmentNote({ ...input, snapshot: plain })).toThrow(CommissionNotPublishedError);
  });

  it('states the published terms in plain words and hashes the exact text', () => {
    const note = consignmentNote({ ...input, snapshot: withCommission });
    expect(note.text).toContain('HRE-26-0001: Dell laptop (working); reserve US$150.00; sold in USD');
    expect(note.text).toContain('Commission: Charged on the whole price: from US$0.00 10%');
    expect(note.text).toContain(`Rules: version ${DOC.label}`);
    expect(note.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('any change to the lots changes the hash', () => {
    const a = consignmentNote({ ...input, snapshot: withCommission });
    const b = consignmentNote({ ...input, lots: [{ ...input.lots[0]!, reserveMinor: 20_000n }], snapshot: withCommission });
    expect(a.sha256).not.toBe(b.sha256);
  });
});

describe('statement totals', () => {
  it('splits paid, upcoming (with the next due date) and held, per currency', () => {
    const t = statementTotals([
      { payoutId: '1', currency: 'USD', status: 'paid', dueDate: '2026-11-03', grossMinor: 0n, deductionsMinor: 0n, netMinor: 10_000n },
      { payoutId: '2', currency: 'USD', status: 'scheduled', dueDate: '2026-11-10', grossMinor: 0n, deductionsMinor: 0n, netMinor: 5_000n },
      { payoutId: '3', currency: 'USD', status: 'scheduled', dueDate: '2026-11-08', grossMinor: 0n, deductionsMinor: 0n, netMinor: 2_000n },
      { payoutId: '4', currency: 'USD', status: 'held', dueDate: '2026-11-05', grossMinor: 0n, deductionsMinor: 0n, netMinor: 700n },
    ]);
    expect(t).toEqual([{ currency: 'USD', paidMinor: 10_000n, upcomingMinor: 7_000n, heldMinor: 700n, nextDueDate: '2026-11-08' }]);
  });
});

describe('WhatsApp intake conversation', () => {
  const opts: IntakeOptions = {
    categories: [
      { code: 'it', name: 'IT and electronics' },
      { code: 'vehicles', name: 'Vehicles' },
    ],
    conditions: [
      { code: 'working', label: 'Working' },
      { code: 'damaged', label: 'Damaged' },
    ],
    snapshot: plain,
  };

  function send(state: IntakeState, text: string, imageIds?: string[]) {
    return handleIntakeMessage(state, { text, ...(imageIds ? { imageIds } : {}) }, opts);
  }

  it('walks a seller from category to a confirmed draft', () => {
    let { state, reply } = startIntake(opts);
    expect(reply).toContain('1. IT and electronics');
    ({ state, reply } = send(state, '7'));
    expect(reply).toBe('Please reply with a number from 1 to 2.');
    ({ state } = send(state, '1'));
    ({ state } = send(state, 'Dell Latitude laptop'));
    ({ state, reply } = send(state, '1'));
    expect(reply).toContain('at least 4 clear photos');
    ({ state } = send(state, '', ['img1', 'img2']));
    ({ state, reply } = send(state, 'DONE'));
    expect(reply).toBe('We have 2 photos; please send at least 2 more.');
    ({ state } = send(state, '', ['img3', 'img4']));
    ({ state } = send(state, 'done'));
    ({ state, reply } = send(state, '300'));
    expect(reply).toContain('Reserve: US$300.00');
    ({ state, reply } = send(state, 'YES'));
    expect(state.step).toBe('done');
    expect(state.draft).toEqual({
      category: 'it',
      title: 'Dell Latitude laptop',
      condition: 'working',
      photoIds: ['img1', 'img2', 'img3', 'img4'],
      reserve: { currency: 'USD', minor: 30_000n },
    });
  });

  it('asks vehicles for 35 photos, understands ZiG reserves, and STOP cancels', () => {
    let { state } = startIntake(opts);
    ({ state } = send(state, '2'));
    ({ state } = send(state, 'Toyota Hilux 2019'));
    const r = send(state, '2');
    expect(r.reply).toContain('at least 35 clear photos');
    const photos = Array.from({ length: 35 }, (_, i) => `p${i}`);
    let s = send(send(r.state, '', photos).state, 'DONE').state;
    const reserve = send(s, 'ZiG 5,000');
    expect(reserve.reply).toContain('Reserve: ZiG 5,000.00');
    s = send(reserve.state, 'STOP').state;
    expect(s.step).toBe('cancelled');
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('seller service against PostgreSQL', () => {
  let t: TestDatabase;
  let service: SellerService;
  let rulebook: RulebookStore;
  let seller: string;
  let zimra: string;
  const sellerActor = () => ({ type: 'account' as const, id: seller, name: 'Seller' });

  beforeAll(async () => {
    t = await createTestDatabase();
    await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true, overrides: [COMMISSION] });
    rulebook = new RulebookStore(t.db);
    service = new SellerService(t.db, rulebook);
    seller = await createAccount(t.db, { name: 'Tendai Moyo' });
    zimra = await createAccount(t.db, { name: 'ZIMRA Beitbridge' });
  });
  afterAll(async () => {
    await t?.drop();
  });

  const draft = {
    title: 'Dell Latitude laptop',
    description: 'i5, 16 GB RAM, 512 GB SSD, charger included.',
    category: 'it',
    itemState: 'used',
    condition: 'working',
    currency: 'USD' as const,
    startingBidMinor: 5_000n,
    reserveMinor: 15_000n,
    estimateLowMinor: null,
    estimateHighMinor: null,
    quantity: 1,
  };

  it('consign, preview the note, and sign it; a stale preview is refused', async () => {
    const consignmentId = await service.createConsignment(sellerActor(), { sellerId: seller, type: 'commission', channel: 'app', branch: 'HRE' });
    await service.addLot(sellerActor(), consignmentId, draft);
    const preview = await service.previewNote(consignmentId);

    await service.addLot(sellerActor(), consignmentId, { ...draft, title: 'Second laptop' });
    const stale = await service.sign(sellerActor(), consignmentId, { shownSha256: preview.sha256, signatureReference: 'sig-1', noteObjectKey: 'notes/1.pdf' });
    expect(stale).toEqual({ signed: false, reason: 'note_changed' });

    const fresh = await service.previewNote(consignmentId);
    expect(await service.sign(sellerActor(), consignmentId, { shownSha256: fresh.sha256, signatureReference: 'sig-1', noteObjectKey: 'notes/1.pdf' })).toEqual({ signed: true });
    const row = await t.db.query<{ status: string; hash: string }>(`SELECT status, encode(note_sha256, 'hex') AS hash FROM seller.consignment WHERE id = $1`, [consignmentId]);
    expect(row.rows[0]).toEqual({ status: 'signed', hash: fresh.sha256 });
    await expect(service.addLot(sellerActor(), consignmentId, draft)).rejects.toThrow(/after the consignment note is signed/);
  });

  it('only the seller can sign their own consignment', async () => {
    const consignmentId = await service.createConsignment(sellerActor(), { sellerId: seller, type: 'commission', channel: 'app', branch: 'HRE' });
    await service.addLot(sellerActor(), consignmentId, draft);
    const note = await service.previewNote(consignmentId);
    expect(await service.sign({ type: 'account', id: zimra, name: 'Someone else' }, consignmentId, { shownSha256: note.sha256, signatureReference: 's', noteObjectKey: 'k' })).toEqual({
      signed: false,
      reason: 'not_owner',
    });
  });

  it('bulk upload: errors create nothing; a clean file creates lots; re-uploads never duplicate', async () => {
    const actor = { type: 'account' as const, id: zimra, name: 'ZIMRA' };
    const bad = await service.bulkUpload(actor, { sellerId: zimra, batchRef: 'BB-2026-11-A', csv: `${HEADER}\nX1,Tyres,Four tyres,general,used,mint,,USD,10,,,,4`, branch: 'BYO' });
    expect(bad).toMatchObject({ ok: false, errors: [{ row: 1, field: 'condition' }] });
    expect((await t.db.query('SELECT 1 FROM catalogue.lot WHERE seller_account_id = $1', [zimra])).rowCount).toBe(0);

    const csv = [
      HEADER,
      'ZIMRA-BB-0001,Toyota Hilux 2.4 2017,Seized at Beitbridge,vehicles,used,as_is,,USD,2500,,,,1',
      'ZIMRA-BB-0002,Carton of 40 chargers,Sealed cartons,general,new,sealed_packing,,ZWG,1500,3000,,,40',
    ].join('\n');
    const first = await service.bulkUpload(actor, { sellerId: zimra, batchRef: 'BB-2026-11-B', csv, branch: 'BYO' });
    expect(first).toMatchObject({ ok: true, created: 2, skippedExisting: 0, repeatedBatch: false });
    const again = await service.bulkUpload(actor, { sellerId: zimra, batchRef: 'BB-2026-11-B', csv, branch: 'BYO' });
    expect(again).toMatchObject({ ok: true, repeatedBatch: true });
    const renamed = await service.bulkUpload(actor, { sellerId: zimra, batchRef: 'BB-2026-11-C', csv, branch: 'BYO' });
    expect(renamed).toMatchObject({ ok: true, created: 0, skippedExisting: 2 });

    const lots = await t.db.query<{ external_ref: string; settlement_currency: string; is_vehicle: boolean; tax_class: string; state: string }>(
      'SELECT external_ref, settlement_currency, is_vehicle, tax_class, state FROM catalogue.lot WHERE seller_account_id = $1 ORDER BY external_ref',
      [zimra],
    );
    expect(lots.rows).toEqual([
      { external_ref: 'ZIMRA-BB-0001', settlement_currency: 'USD', is_vehicle: true, tax_class: 'vehicle_standard', state: 'draft' },
      { external_ref: 'ZIMRA-BB-0002', settlement_currency: 'ZWG', is_vehicle: false, tax_class: 'goods_standard', state: 'draft' },
    ]);
  });

  it('shows the seller live bids on their lots, with their own reserve', async () => {
    const staff = await createAccount(t.db, { name: 'Staff' });
    const bidder = await createAccount(t.db, { name: 'Bidder', verification: 'full' });
    const end = new Date(Date.now() + 3_600_000);
    const a = await createAuction(t.db, { createdBy: staff, lots: [{ sellerId: seller, startingBidMinor: 5_000n, reserveMinor: 20_000n, endsAt: end, title: 'Office chair set' }] });
    const registrations = new RegistrationService(rulebook);
    const bidding = new BiddingService(t.db, rulebook, registrations);
    const versionId = await bidding.openAuction(SYSTEM, a.auctionId);
    await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: bidder, auctionId: a.auctionId }));
    const total = quoteLot({ lot: { currency: 'USD', taxClass: 'goods_standard', categoryPath: ['it'], isVehicle: false }, hammerMinor: 10_000n, snapshot: await rulebook.snapshot(versionId), taxRates: await rulebook.taxRates(), at: new Date() }).totalMinor;
    await bidding.placeBid({ type: 'account', id: bidder, name: 'Bidder' }, { accountId: bidder, auctionLotId: a.lots[0]!.auctionLotId, maxMinor: 10_000n, clientRequestId: randomUUID(), quotedTotalMinor: total, quotedRuleVersionId: versionId, channel: 'pwa' });

    const live = await service.liveLots(t.db, seller);
    expect(live.find((l) => l.title === 'Office chair set')).toMatchObject({
      state: 'live', currentPriceMinor: 5_000n, bids: 1, uniqueBidders: 1, reserveMinor: 20_000n, reserveMet: false, endsAt: end,
    });
  });

  it('values a lot from the realised-price archive once there are enough sales', async () => {
    expect(await service.valuation(t.db, 'it', 'USD')).toBeNull(); // no sales yet
  });

  it('statement lists payouts with due dates and totals', async () => {
    await t.db.tx(SYSTEM, async (c) => {
      for (const [status, net, due] of [['paid', 23_400n, '2026-11-03'], ['scheduled', 9_000n, '2026-11-12']] as const) {
        const p = await c.query<{ id: string }>(
          `INSERT INTO payout.payout (seller_account_id, currency, status, due_date, gross_minor, deductions_minor, net_minor)
           VALUES ($1, 'USD', 'held', $2, $3, 0, $3) RETURNING id`,
          [seller, due, net.toString()],
        );
        await c.query(`INSERT INTO payout.payout_line (payout_id, line_type, description, amount_minor) VALUES ($1, 'hammer', 'Hammer', $2)`, [p.rows[0]!.id, net.toString()]);
        if (status === 'scheduled') await c.query(`UPDATE payout.payout SET status = 'scheduled' WHERE id = $1`, [p.rows[0]!.id]);
        else await c.query(`UPDATE payout.payout SET status = 'cancelled' WHERE id = $1`, [p.rows[0]!.id]);
      }
    });
    const s = await service.statement(t.db, seller);
    expect(s.payouts.map((p) => [p.status, p.dueDate, p.netMinor])).toEqual([
      ['cancelled', '2026-11-03', 23_400n],
      ['scheduled', '2026-11-12', 9_000n],
    ]);
    expect(s.totals).toEqual([{ currency: 'USD', paidMinor: 0n, upcomingMinor: 9_000n, heldMinor: 0n, nextDueDate: '2026-11-12' }]);
  });
});
