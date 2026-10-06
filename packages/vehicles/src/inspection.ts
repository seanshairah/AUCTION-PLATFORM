import type { RuleSnapshot } from '@abc/rules';

/**
 * Vehicle inspection reports (blueprint module 8: "Inspection report on a standard
 * checklist with photos and video; chassis and engine numbers; document status"),
 * the gross-inaccuracy remedy (Ritchie Bros BENCHMARK: refunds for substantial
 * inaccuracies), and title-step ordering. Specification: docs/13-vehicle-module.md.
 */

export type Answer = 'ok' | 'attention' | 'fail' | 'not_applicable';

export interface ChecklistItem {
  id: string;
  section: 'identity' | 'documents' | 'exterior' | 'interior' | 'mechanical' | 'structure' | 'road_test';
  label: string;
  /** A wrong "ok" on a material item is a gross inaccuracy (refund remedy). */
  material: boolean;
  allowNotApplicable: boolean;
}

const item = (id: string, section: ChecklistItem['section'], label: string, material = false, allowNotApplicable = false): ChecklistItem => ({
  id,
  section,
  label,
  material,
  allowNotApplicable,
});

/** Checklist vehicle-v1 (PROPOSED; rule vehicle.inspection_checklist_version). */
export const CHECKLISTS: Record<string, readonly ChecklistItem[]> = {
  'vehicle-v1': [
    item('chassis_plate_legible', 'identity', 'Chassis number plate present and legible'),
    item('engine_number_legible', 'identity', 'Engine number present and legible'),
    item('number_plates', 'identity', 'Number plates fitted', false, true),
    item('registration_book', 'documents', 'Registration book present', true),
    item('police_clearance', 'documents', 'Police clearance obtainable (no flags)', true),
    item('zimra_clearance', 'documents', 'ZIMRA clearance (imported vehicles)', true, true),
    item('service_history', 'documents', 'Service history', false, true),
    item('body_panels', 'exterior', 'Body panels'),
    item('paint', 'exterior', 'Paint'),
    item('glass', 'exterior', 'Windscreen and windows'),
    item('lights', 'exterior', 'Lights and indicators'),
    item('tyres', 'exterior', 'Tyres'),
    item('spare_wheel', 'exterior', 'Spare wheel and jack', false, true),
    item('seats', 'interior', 'Seats and trim'),
    item('warning_lights', 'interior', 'Dashboard warning lights'),
    item('air_conditioning', 'interior', 'Air conditioning', false, true),
    item('electrics', 'interior', 'Windows, locks and electrics'),
    item('engine_starts', 'mechanical', 'Engine starts', true),
    item('engine_runs', 'mechanical', 'Engine runs smoothly'),
    item('gearbox', 'mechanical', 'Gearbox', true),
    item('clutch', 'mechanical', 'Clutch', false, true),
    item('brakes', 'mechanical', 'Brakes', true),
    item('steering', 'mechanical', 'Steering', true),
    item('suspension', 'mechanical', 'Suspension'),
    item('leaks', 'mechanical', 'Oil, coolant and fuel leaks'),
    item('chassis_frame', 'structure', 'Chassis and frame free of structural damage', true),
    item('accident_damage', 'structure', 'No major accident repair', true),
    item('flood_damage', 'structure', 'No flood or fire damage', true),
    item('drives', 'road_test', 'Drives under its own power', true, true),
  ],
};

export interface InspectionInput {
  checklistVersion: string;
  answers: Record<string, { answer: Answer; note?: string }>;
  photoCount: number;
  hasVideo: boolean;
  chassisNumberSeen: string;
  engineNumberSeen: string;
  odometerKm: number | null;
}

export interface VehicleRecord {
  chassisNumber: string;
  engineNumber: string | null;
}

export interface InspectionIssue {
  code: string;
  message: string;
}

/** Chassis and engine numbers compared without spaces, dashes or case. */
export function normaliseIdNumber(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Can this report be published? Every item answered (with a note on anything not
 * fine), enough photos, the video, the odometer, and the numbers read off the vehicle.
 * A chassis or engine number that does not match the record is not an error to fix
 * in the form: it blocks publication until the vehicle desk resolves it.
 */
export function validateInspection(report: InspectionInput, vehicle: VehicleRecord, snapshot: RuleSnapshot): InspectionIssue[] {
  const issues: InspectionIssue[] = [];
  const expected = snapshot.get('vehicle.inspection_checklist_version');
  if (report.checklistVersion !== expected) {
    issues.push({ code: 'wrong_checklist', message: `Use checklist ${expected}, not ${report.checklistVersion}.` });
  }
  const checklist = CHECKLISTS[report.checklistVersion];
  if (!checklist) return [...issues, { code: 'unknown_checklist', message: `Checklist ${report.checklistVersion} does not exist.` }];

  for (const it of checklist) {
    const a = report.answers[it.id];
    if (!a) {
      issues.push({ code: 'unanswered', message: `Answer "${it.label}".` });
      continue;
    }
    if (a.answer === 'not_applicable' && !it.allowNotApplicable) issues.push({ code: 'not_applicable_not_allowed', message: `"${it.label}" cannot be marked not applicable.` });
    if ((a.answer === 'attention' || a.answer === 'fail') && !(a.note && a.note.trim().length >= 5)) {
      issues.push({ code: 'note_required', message: `Describe the problem with "${it.label}".` });
    }
  }
  const unknown = Object.keys(report.answers).filter((id) => !checklist.some((i) => i.id === id));
  if (unknown.length) issues.push({ code: 'unknown_items', message: `Unknown checklist items: ${unknown.join(', ')}.` });

  const minPhotos = snapshot.get('catalogue.min_photos', { categoryPath: ['vehicles'] });
  if (report.photoCount < minPhotos) issues.push({ code: 'too_few_photos', message: `The report has ${report.photoCount} photos; at least ${minPhotos} are needed.` });
  if (snapshot.get('vehicle.require_video') && !report.hasVideo) issues.push({ code: 'video_missing', message: 'Add the inspection video.' });
  if (report.odometerKm === null) issues.push({ code: 'odometer_missing', message: 'Record the odometer reading.' });

  if (!report.chassisNumberSeen.trim()) issues.push({ code: 'chassis_not_read', message: 'Read the chassis number off the vehicle.' });
  else if (normaliseIdNumber(report.chassisNumberSeen) !== normaliseIdNumber(vehicle.chassisNumber)) {
    issues.push({ code: 'chassis_mismatch', message: 'The chassis number on the vehicle does not match the record. Refer to the vehicle desk before publishing.' });
  }
  if (vehicle.engineNumber) {
    if (!report.engineNumberSeen.trim()) issues.push({ code: 'engine_not_read', message: 'Read the engine number off the vehicle.' });
    else if (normaliseIdNumber(report.engineNumberSeen) !== normaliseIdNumber(vehicle.engineNumber)) {
      issues.push({ code: 'engine_mismatch', message: 'The engine number on the vehicle does not match the record. Refer to the vehicle desk before publishing.' });
    }
  }
  return issues;
}

/** The plain summary shown above the bid button. */
export function summariseInspection(report: InspectionInput): { ok: number; attention: number; fail: number; text: string } {
  const checklist = CHECKLISTS[report.checklistVersion] ?? [];
  const count = (a: Answer) => checklist.filter((i) => report.answers[i.id]?.answer === a).length;
  const ok = count('ok');
  const attention = count('attention');
  const fail = count('fail');
  const problems = checklist
    .filter((i) => report.answers[i.id]?.answer === 'fail' || report.answers[i.id]?.answer === 'attention')
    .map((i) => `${i.label}: ${report.answers[i.id]!.note}`);
  const head = `${ok} checks fine, ${attention} need attention, ${fail} failed. Odometer ${report.odometerKm === null ? 'not recorded' : `${report.odometerKm.toLocaleString('en-US')} km`}.`;
  return { ok, attention, fail, text: problems.length ? `${head}\n${problems.join('\n')}` : head };
}

// --- Gross inaccuracy --------------------------------------------------------------

export interface ClaimFindings {
  chassisNumberFound?: string;
  engineNumberFound?: string;
  odometerKmFound?: number;
  /** Checklist items the buyer found failing (checked by staff at collection). */
  failingItems?: string[];
}

/**
 * Does a buyer's claim, as verified by staff, show a gross inaccuracy in the
 * published report? Qualifying findings: different chassis or engine number;
 * odometer off by more than the tolerance; a material item reported fine (or not
 * applicable) that fails. A gross inaccuracy supports a refund (deliverable 17).
 */
export function assessGrossInaccuracy(report: InspectionInput, findings: ClaimFindings, snapshot: RuleSnapshot): { qualifies: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (findings.chassisNumberFound && normaliseIdNumber(findings.chassisNumberFound) !== normaliseIdNumber(report.chassisNumberSeen)) {
    reasons.push('The chassis number differs from the inspection report.');
  }
  if (findings.engineNumberFound && normaliseIdNumber(findings.engineNumberFound) !== normaliseIdNumber(report.engineNumberSeen)) {
    reasons.push('The engine number differs from the inspection report.');
  }
  if (findings.odometerKmFound !== undefined && report.odometerKm !== null && report.odometerKm > 0) {
    const toleranceBp = snapshot.get('vehicle.odometer_tolerance_bp');
    const diff = Math.abs(findings.odometerKmFound - report.odometerKm);
    if (diff * 10_000 > report.odometerKm * toleranceBp) {
      reasons.push(`The odometer reads ${findings.odometerKmFound.toLocaleString('en-US')} km against ${report.odometerKm.toLocaleString('en-US')} km in the report.`);
    }
  }
  const checklist = CHECKLISTS[report.checklistVersion] ?? [];
  for (const id of findings.failingItems ?? []) {
    const it = checklist.find((i) => i.id === id);
    const reported = report.answers[id]?.answer;
    if (it?.material && (reported === 'ok' || reported === 'not_applicable')) reasons.push(`"${it.label}" was reported fine but fails.`);
  }
  return { qualifies: reasons.length > 0, reasons };
}

// --- Title steps ------------------------------------------------------------------------

export const TITLE_STEPS = ['zrp_clearance', 'zimra_clearance', 'cvr_change_of_ownership'] as const;
export type TitleStepName = (typeof TITLE_STEPS)[number];

export interface TitleStepState {
  step: TitleStepName;
  status: 'pending' | 'in_progress' | 'done' | 'rejected';
  dueAt: Date;
}

/** The step to work on now: the first not done, in order. Null when all are done. */
export function nextTitleStep(steps: readonly TitleStepState[]): TitleStepName | null {
  for (const name of TITLE_STEPS) {
    if (steps.find((s) => s.step === name)?.status !== 'done') return name;
  }
  return null;
}

export function overdueTitleSteps(steps: readonly TitleStepState[], now: Date): TitleStepName[] {
  return steps.filter((s) => s.status !== 'done' && s.dueAt.getTime() < now.getTime()).map((s) => s.step);
}
