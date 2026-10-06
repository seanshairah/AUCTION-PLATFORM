import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { RuleSnapshot } from '@abc/rules';
import {
  assessGrossInaccuracy,
  CHECKLISTS,
  nextTitleStep,
  overdueTitleSteps,
  summariseInspection,
  validateInspection,
  VehicleService,
  type InspectionInput,
} from './index';

const DOC = readRuleSetDocument();
const snapshot = new RuleSnapshot('v', DOC.label, DOC.rules);
const VEHICLE = { chassisNumber: 'AHTKB8CD802912345', engineNumber: '2GD1234567' };

function goodReport(overrides: Partial<InspectionInput> = {}): InspectionInput {
  const answers: InspectionInput['answers'] = {};
  for (const it of CHECKLISTS['vehicle-v1']!) answers[it.id] = { answer: 'ok' };
  answers.tyres = { answer: 'attention', note: 'Rear tyres at 3 mm' };
  answers.zimra_clearance = { answer: 'not_applicable' };
  return {
    checklistVersion: 'vehicle-v1',
    answers,
    photoCount: 38,
    hasVideo: true,
    chassisNumberSeen: 'ahtkb8cd80 2912345',
    engineNumberSeen: '2GD-1234567',
    odometerKm: 142_000,
    ...overrides,
  };
}

describe('inspection report validation', () => {
  it('passes a complete report; numbers match ignoring spaces, dashes and case', () => {
    expect(validateInspection(goodReport(), VEHICLE, snapshot)).toEqual([]);
  });

  it('requires every item, notes on problems, and only allowed not-applicable answers', () => {
    const r = goodReport();
    delete r.answers.brakes;
    r.answers.gearbox = { answer: 'fail' };
    r.answers.engine_starts = { answer: 'not_applicable' };
    expect(validateInspection(r, VEHICLE, snapshot).map((i) => i.code)).toEqual(['not_applicable_not_allowed', 'note_required', 'unanswered']);
  });

  it('needs 35 photos, the video and the odometer', () => {
    expect(validateInspection(goodReport({ photoCount: 20, hasVideo: false, odometerKm: null }), VEHICLE, snapshot).map((i) => i.code)).toEqual([
      'too_few_photos',
      'video_missing',
      'odometer_missing',
    ]);
  });

  it('blocks publication when the numbers on the vehicle do not match the record', () => {
    const issues = validateInspection(goodReport({ chassisNumberSeen: 'XYZ999', engineNumberSeen: '' }), VEHICLE, snapshot);
    expect(issues.map((i) => i.code)).toEqual(['chassis_mismatch', 'engine_not_read']);
  });

  it('summarises in plain words for the lot page', () => {
    expect(summariseInspection(goodReport()).text).toBe('27 checks fine, 1 need attention, 0 failed. Odometer 142,000 km.\nTyres: Rear tyres at 3 mm');
  });
});

describe('gross inaccuracy remedy', () => {
  const report = goodReport();

  it('qualifies when the odometer is off by more than 10 %', () => {
    expect(assessGrossInaccuracy(report, { odometerKmFound: 160_000 }, snapshot)).toEqual({
      qualifies: true,
      reasons: ['The odometer reads 160,000 km against 142,000 km in the report.'],
    });
    expect(assessGrossInaccuracy(report, { odometerKmFound: 150_000 }, snapshot).qualifies).toBe(false); // 5.6 %
  });

  it('qualifies when a material item reported fine fails, but not for minor items', () => {
    expect(assessGrossInaccuracy(report, { failingItems: ['gearbox'] }, snapshot).reasons).toEqual(['"Gearbox" was reported fine but fails.']);
    expect(assessGrossInaccuracy(report, { failingItems: ['paint', 'tyres'] }, snapshot).qualifies).toBe(false);
  });

  it('qualifies when the chassis or engine number differs', () => {
    expect(assessGrossInaccuracy(report, { chassisNumberFound: 'AHTKB8CD80 2912345' }, snapshot).qualifies).toBe(false);
    expect(assessGrossInaccuracy(report, { engineNumberFound: '1KD0000000' }, snapshot).qualifies).toBe(true);
  });
});

describe('title steps', () => {
  const due = new Date('2026-11-20T00:00:00Z');
  it('go in order: ZRP, then ZIMRA, then CVR', () => {
    expect(nextTitleStep([{ step: 'zrp_clearance', status: 'pending', dueAt: due }])).toBe('zrp_clearance');
    expect(
      nextTitleStep([
        { step: 'zrp_clearance', status: 'done', dueAt: due },
        { step: 'zimra_clearance', status: 'in_progress', dueAt: due },
        { step: 'cvr_change_of_ownership', status: 'pending', dueAt: due },
      ]),
    ).toBe('zimra_clearance');
  });

  it('flags steps past their due date', () => {
    expect(overdueTitleSteps([{ step: 'zrp_clearance', status: 'pending', dueAt: due }], new Date('2026-11-21T00:00:00Z'))).toEqual(['zrp_clearance']);
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('vehicle service against PostgreSQL', () => {
  let t: TestDatabase;
  let service: VehicleService;
  let staff: { type: 'staff'; id: string; name: string };
  let lotId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true });
    service = new VehicleService(t.db, new RulebookStore(t.db));
    const staffId = await createAccount(t.db, { name: 'Vehicle desk' });
    staff = { type: 'staff', id: staffId, name: 'Vehicle desk' };
    const seller = await createAccount(t.db, { name: 'Seller' });
    const a = await createAuction(t.db, { createdBy: staffId, lots: [{ sellerId: seller, category: 'vehicles', startingBidMinor: 100_000n, endsAt: new Date(Date.now() + 86_400_000), title: 'Toyota Hilux 2019' }] });
    lotId = a.lots[0]!.lotId;
    await service.setDetails(staff, lotId, { make: 'Toyota', model: 'Hilux 2.4 GD-6', year: 2019, chassisNumber: VEHICLE.chassisNumber, engineNumber: VEHICLE.engineNumber, zimbabweRegistered: true, odometerKm: 142_000, documentsStatus: 'complete' });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('a report with a mismatched chassis number is filed but cannot be published', async () => {
    const { reportId, issues } = await service.submitInspection(staff, lotId, goodReport({ chassisNumberSeen: 'WRONG123' }));
    expect(issues.map((i) => i.code)).toEqual(['chassis_mismatch']);
    expect(await service.publishInspection(staff, reportId)).toMatchObject({ published: false });
    const row = await t.db.query<{ chassis_verified: boolean }>('SELECT chassis_verified FROM catalogue.inspection_report WHERE id = $1', [reportId]);
    expect(row.rows[0]!.chassis_verified).toBe(false);
  });

  it('a good report publishes and can then never change', async () => {
    const { reportId, issues } = await service.submitInspection(staff, lotId, goodReport());
    expect(issues).toEqual([]);
    expect(await service.publishInspection(staff, reportId)).toEqual({ published: true, issues: [] });
    await expect(t.db.tx(staff, (c) => c.query(`UPDATE catalogue.inspection_report SET odometer_km = 90000 WHERE id = $1`, [reportId]))).rejects.toThrow(/cannot change/);
  });

  it('assesses a claim against the latest published report', async () => {
    expect(await service.assessClaim(lotId, { odometerKmFound: 200_000 })).toMatchObject({ qualifies: true });
    expect(await service.assessClaim(lotId, { failingItems: ['paint'] })).toMatchObject({ qualifies: false });
  });

  it('viewing slots take bookings up to capacity, once per person, even when booked at the same moment', async () => {
    const [slot] = await service.createViewingSlots(staff, { branch: 'HRE', lotId, firstStart: new Date(Date.now() + 86_400_000), count: 1 });
    const people = await Promise.all(Array.from({ length: 6 }, (_, i) => createAccount(t.db, { name: `Viewer ${i}` })));
    const results = await Promise.all(people.map((id) => service.bookViewing({ type: 'account', id, name: 'Viewer' }, slot!)));
    expect(results.filter((r) => r.booked).length).toBe(4); // default capacity
    expect(results.filter((r) => !r.booked).map((r) => (r as { reason: string }).reason)).toEqual(['full', 'full']);
    expect(await service.bookViewing({ type: 'account', id: people[0]!, name: 'Viewer' }, slot!)).toMatchObject({ booked: false });

    const booked = results.find((r) => r.booked) as { bookingId: string };
    const who = people[results.indexOf(booked as never)]!;
    await service.cancelViewing({ type: 'account', id: who, name: 'Viewer' }, booked.bookingId);
    expect(await service.bookViewing({ type: 'account', id: people[5]!, name: 'Viewer' }, slot!)).toMatchObject({ booked: true });
  });

  it('title tracker: steps only in order; the case completes after CVR; overdue steps alert once', async () => {
    const buyer = await createAccount(t.db, { name: 'Buyer' });
    const titleCaseId = await t.db.tx(SYSTEM, async (c) => {
      const tc = await c.query<{ id: string }>('INSERT INTO logistics.title_case (lot_id, buyer_account_id, deadline_at) VALUES ($1, $2, $3) RETURNING id', [lotId, buyer, new Date(Date.now() - 3_600_000)]);
      for (const [step, sort] of [['zrp_clearance', 1], ['zimra_clearance', 2], ['cvr_change_of_ownership', 3]] as const) {
        await c.query('INSERT INTO logistics.title_step (title_case_id, step, sort, owner_party, due_at) VALUES ($1, $2, $3, $4, $5)', [tc.rows[0]!.id, step, sort, 'abc', new Date(Date.now() - 3_600_000)]);
      }
      return tc.rows[0]!.id;
    });

    expect((await service.alertOverdueTitleSteps()).length).toBe(3);
    expect(await service.alertOverdueTitleSteps()).toEqual([]); // once per step

    await expect(service.completeTitleStep(staff, titleCaseId, 'zimra_clearance', 'ev/zimra.pdf')).rejects.toThrow(/earlier steps/);
    expect(await service.completeTitleStep(staff, titleCaseId, 'zrp_clearance', 'ev/zrp.pdf')).toEqual({ caseStatus: 'in_progress' });
    expect(await service.completeTitleStep(staff, titleCaseId, 'zimra_clearance', 'ev/zimra.pdf')).toEqual({ caseStatus: 'in_progress' });
    expect(await service.completeTitleStep(staff, titleCaseId, 'cvr_change_of_ownership', 'ev/cvr.pdf')).toEqual({ caseStatus: 'complete' });
  });

  it('lists towing partners for the branch', async () => {
    await t.db.tx(SYSTEM, (c) =>
      c.query(`INSERT INTO logistics.partner (kind, name, phone_e164, branches) VALUES ('towing', 'Harare Tow Co', '+263772000000', '{HRE}'), ('towing', 'Bulawayo Recovery', '+263773000000', '{BYO}')`),
    );
    expect(await service.towingPartners(t.db, 'HRE')).toEqual([{ name: 'Harare Tow Co', phone: '+263772000000', notes: null }]);
  });
});
