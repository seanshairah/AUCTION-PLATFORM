import { run, type Actor, type Db, type Queryable, type RulebookStore } from '@abc/db';
import {
  assessGrossInaccuracy,
  normaliseIdNumber,
  summariseInspection,
  validateInspection,
  type ClaimFindings,
  type InspectionInput,
  type InspectionIssue,
  type TitleStepName,
} from './inspection';

/**
 * Vehicle module service (docs/13-vehicle-module.md): vehicle details, inspection
 * reports, viewing slots, the title tracker and towing partners.
 */

export interface VehicleDetails {
  make: string;
  model: string;
  year?: number;
  chassisNumber: string;
  engineNumber?: string;
  registrationNumber?: string;
  zimbabweRegistered: boolean;
  odometerKm?: number;
  documentsStatus: 'complete' | 'incomplete' | 'unknown';
}

type Staff = Actor & { type: 'staff' };

export class VehicleService {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
  ) {}

  private async snapshot() {
    return this.rulebook.snapshot(await this.rulebook.activeVersionId(new Date()));
  }

  async setDetails(staff: Staff, lotId: string, d: VehicleDetails): Promise<void> {
    await this.db.tx(staff, (c) =>
      c.query(
        `INSERT INTO catalogue.vehicle (lot_id, make, model, year, chassis_number, engine_number, registration_number, zimbabwe_registered, odometer_km, documents_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (lot_id) DO UPDATE SET make = $2, model = $3, year = $4, chassis_number = $5, engine_number = $6,
           registration_number = $7, zimbabwe_registered = $8, odometer_km = $9, documents_status = $10`,
        [lotId, d.make, d.model, d.year ?? null, normaliseIdNumber(d.chassisNumber), d.engineNumber ? normaliseIdNumber(d.engineNumber) : null,
         d.registrationNumber ?? null, d.zimbabweRegistered, d.odometerKm ?? null, d.documentsStatus],
      ),
    );
  }

  private async vehicle(q: Queryable, lotId: string) {
    const r = await run<{ chassis_number: string; engine_number: string | null }>(q, 'SELECT chassis_number, engine_number FROM catalogue.vehicle WHERE lot_id = $1', [lotId]);
    if (!r.rows[0]) throw new Error(`No vehicle details for lot ${lotId}`);
    return { chassisNumber: r.rows[0].chassis_number, engineNumber: r.rows[0].engine_number };
  }

  /**
   * Files an inspection report as a draft. Returns the issues that block publishing
   * (empty when it can be published).
   */
  async submitInspection(staff: Staff, lotId: string, report: InspectionInput): Promise<{ reportId: string; issues: InspectionIssue[] }> {
    const snapshot = await this.snapshot();
    return this.db.tx(staff, async (c) => {
      const v = await this.vehicle(c, lotId);
      const issues = validateInspection(report, v, snapshot);
      const r = await c.query<{ id: string }>(
        `INSERT INTO catalogue.inspection_report (lot_id, checklist_version, inspector_id, inspected_at, chassis_verified, engine_verified,
                                                  chassis_number_seen, engine_number_seen, odometer_km, items, photo_count, has_video, summary)
         VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12) RETURNING id`,
        [lotId, report.checklistVersion, staff.id,
         !issues.some((i) => i.code.startsWith('chassis')), !issues.some((i) => i.code.startsWith('engine')),
         report.chassisNumberSeen, report.engineNumberSeen, report.odometerKm, JSON.stringify(report.answers),
         report.photoCount, report.hasVideo, summariseInspection(report).text],
      );
      return { reportId: r.rows[0]!.id, issues };
    });
  }

  private async loadReport(q: Queryable, reportId: string): Promise<{ lotId: string; report: InspectionInput; publishedAt: Date | null }> {
    const r = await run<{
      lot_id: string; checklist_version: string; items: InspectionInput['answers']; photo_count: number; has_video: boolean;
      chassis_number_seen: string | null; engine_number_seen: string | null; odometer_km: number | null; published_at: Date | null;
    }>(q, 'SELECT * FROM catalogue.inspection_report WHERE id = $1', [reportId]);
    const x = r.rows[0];
    if (!x) throw new Error(`Inspection report ${reportId} not found`);
    return {
      lotId: x.lot_id,
      publishedAt: x.published_at,
      report: {
        checklistVersion: x.checklist_version,
        answers: x.items,
        photoCount: x.photo_count,
        hasVideo: x.has_video,
        chassisNumberSeen: x.chassis_number_seen ?? '',
        engineNumberSeen: x.engine_number_seen ?? '',
        odometerKm: x.odometer_km,
      },
    };
  }

  /** Publishes a report that passes validation. After this it can never change (database trigger). */
  async publishInspection(staff: Staff, reportId: string): Promise<{ published: boolean; issues: InspectionIssue[] }> {
    const snapshot = await this.snapshot();
    return this.db.tx(staff, async (c) => {
      const { lotId, report, publishedAt } = await this.loadReport(c, reportId);
      if (publishedAt) return { published: true, issues: [] };
      const issues = validateInspection(report, await this.vehicle(c, lotId), snapshot);
      if (issues.length) return { published: false, issues };
      await c.query('UPDATE catalogue.inspection_report SET published_at = now() WHERE id = $1', [reportId]);
      return { published: true, issues: [] };
    });
  }

  /** Assesses a verified claim against the latest published report for the lot. */
  async assessClaim(lotId: string, findings: ClaimFindings): Promise<{ qualifies: boolean; reasons: string[]; reportId: string } | null> {
    const latest = await this.db.query<{ id: string }>(
      'SELECT id FROM catalogue.inspection_report WHERE lot_id = $1 AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1',
      [lotId],
    );
    if (!latest.rows[0]) return null;
    const { report } = await this.loadReport(this.db, latest.rows[0].id);
    return { ...assessGrossInaccuracy(report, findings, await this.snapshot()), reportId: latest.rows[0].id };
  }

  // --- Viewing slots -----------------------------------------------------------------

  /** Creates consecutive viewing slots using the rulebook's default length and capacity. */
  async createViewingSlots(staff: Staff, p: { branch: string; lotId?: string; firstStart: Date; count: number }): Promise<string[]> {
    const defaults = (await this.snapshot()).get('viewing.slot_defaults');
    return this.db.tx(staff, async (c) => {
      const ids: string[] = [];
      for (let i = 0; i < p.count; i++) {
        const start = new Date(p.firstStart.getTime() + i * defaults.minutes * 60_000);
        const end = new Date(start.getTime() + defaults.minutes * 60_000);
        const r = await c.query<{ id: string }>(
          'INSERT INTO catalogue.viewing_slot (branch_code, lot_id, starts_at, ends_at, capacity) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [p.branch, p.lotId ?? null, start, end, defaults.capacity],
        );
        ids.push(r.rows[0]!.id);
      }
      return ids;
    });
  }

  async bookViewing(account: Actor & { type: 'account' }, slotId: string): Promise<{ booked: true; bookingId: string } | { booked: false; reason: 'full' | 'already_booked' | 'past' }> {
    try {
      return await this.db.tx(account, async (c) => {
        const slot = await c.query<{ starts_at: Date }>('SELECT starts_at FROM catalogue.viewing_slot WHERE id = $1', [slotId]);
        if (!slot.rows[0] || slot.rows[0].starts_at.getTime() < Date.now()) return { booked: false, reason: 'past' } as const;
        const r = await c.query<{ id: string }>('INSERT INTO catalogue.viewing_booking (slot_id, account_id) VALUES ($1, $2) RETURNING id', [slotId, account.id]);
        return { booked: true, bookingId: r.rows[0]!.id } as const;
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === '23505') return { booked: false, reason: 'already_booked' };
      if (err.message?.includes('is full')) return { booked: false, reason: 'full' };
      throw e;
    }
  }

  async cancelViewing(account: Actor & { type: 'account' }, bookingId: string): Promise<void> {
    await this.db.tx(account, (c) =>
      c.query(`UPDATE catalogue.viewing_booking SET status = 'cancelled' WHERE id = $1 AND account_id = $2 AND status = 'booked'`, [bookingId, account.id]),
    );
  }

  // --- Title tracker -------------------------------------------------------------------

  /**
   * Records a title step as done with its evidence. Steps happen in order (database
   * trigger); when all three are done the case completes and the vehicle can be
   * released at the gate.
   */
  async completeTitleStep(staff: Staff, titleCaseId: string, step: TitleStepName, evidenceObjectKey: string): Promise<{ caseStatus: 'open' | 'in_progress' | 'complete' }> {
    return this.db.tx(staff, async (c) => {
      const r = await c.query(
        `UPDATE logistics.title_step SET status = 'done', evidence_object_key = $3, completed_by = $4, completed_at = now()
          WHERE title_case_id = $1 AND step = $2 AND status <> 'done'`,
        [titleCaseId, step, evidenceObjectKey, staff.id],
      );
      const remaining = await c.query<{ n: bigint }>(`SELECT count(*) AS n FROM logistics.title_step WHERE title_case_id = $1 AND status <> 'done'`, [titleCaseId]);
      if (remaining.rows[0]!.n === 0n) {
        await c.query(`UPDATE logistics.title_case SET status = 'complete', completed_at = now() WHERE id = $1 AND status <> 'complete'`, [titleCaseId]);
        await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('title.complete', 'title_case', $1, '{}')`, [titleCaseId]);
        return { caseStatus: 'complete' as const };
      }
      if (r.rowCount) await c.query(`UPDATE logistics.title_case SET status = 'in_progress' WHERE id = $1 AND status = 'open'`, [titleCaseId]);
      const s = await c.query<{ status: 'open' | 'in_progress' | 'complete' }>('SELECT status FROM logistics.title_case WHERE id = $1', [titleCaseId]);
      return { caseStatus: s.rows[0]!.status };
    });
  }

  /** Finds overdue title steps and alerts the vehicle desk once per step. */
  async alertOverdueTitleSteps(now: Date = new Date()): Promise<Array<{ titleCaseId: string; step: TitleStepName }>> {
    return this.db.tx({ type: 'system', id: 'title-tracker', name: 'Title tracker' }, async (c) => {
      const r = await c.query<{ title_case_id: string; step: TitleStepName; id: string }>(
        `SELECT s.title_case_id, s.step, s.id FROM logistics.title_step s JOIN logistics.title_case tc ON tc.id = s.title_case_id
          WHERE s.status <> 'done' AND s.due_at < $1 AND tc.status NOT IN ('complete', 'cancelled')
            AND NOT EXISTS (SELECT 1 FROM core.outbox o WHERE o.topic = 'title.step_overdue' AND o.aggregate_id = s.id::text)`,
        [now],
      );
      for (const x of r.rows) {
        await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('title.step_overdue', 'title_step', $1, $2::jsonb)`, [
          x.id,
          JSON.stringify({ titleCaseId: x.title_case_id, step: x.step }),
        ]);
      }
      return r.rows.map((x) => ({ titleCaseId: x.title_case_id, step: x.step }));
    });
  }

  // --- Towing partners -------------------------------------------------------------------

  async towingPartners(q: Queryable, branch: string): Promise<Array<{ name: string; phone: string; notes: string | null }>> {
    const r = await run<{ name: string; phone_e164: string; notes: string | null }>(
      q,
      `SELECT name, phone_e164, notes FROM logistics.partner WHERE kind = 'towing' AND active AND $1 = ANY(branches) ORDER BY name`,
      [branch],
    );
    return r.rows.map((x) => ({ name: x.name, phone: x.phone_e164, notes: x.notes }));
  }
}
