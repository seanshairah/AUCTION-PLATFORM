import { createHash } from 'node:crypto';
import type { Currency } from '@abc/domain';
import { isUniqueViolation, run, type Client, type Db, type Queryable } from '@abc/db';
import { isRuleKey, RULES, validateRuleSet, type Issue, type RuleRecord, type RuleSetDocument, type TaxRateRecord } from '@abc/rules';
import type { OverrideHandler } from './overrides';
import { AdminError, requirePermission, requireReason, staffActor, type StaffMember, type StaffRole } from './permissions';

/**
 * The rule set publication workflow (docs/03 §6, docs/18 §4):
 *
 *   draft (loaded by `pnpm db:rulebook`) → validate → every warning acknowledged by name,
 *   with a reason, by the approver → the approver (not the author) publishes with an
 *   effective time → superseded versions are retired.
 *
 * Errors block publication. The approver must hold the owning role of every rule that
 * changed against the version in force (finance, ops, risk; product rules need admin),
 * or be an admin (A59). The database enforces approver ≠ author, immutability once
 * published, append-only acknowledgements, and one effective version at any moment.
 */

const OWNER_ROLE: Record<string, StaffRole> = { finance: 'finance', operations: 'ops', risk: 'risk', product: 'admin' };

export interface WarningView {
  id: string;
  code: string;
  key: string | null;
  message: string;
  acknowledgements: Array<{ by: string; name: string | null; reason: string; at: Date }>;
}

export interface RuleSetValidation {
  versionId: string;
  label: string;
  status: string;
  authoredBy: string;
  effectiveFrom: Date;
  errors: Issue[];
  warnings: WarningView[];
  changedKeys: string[];
  /** Roles the approver needs (any one of them is not enough: all, unless admin). */
  approverRoles: StaffRole[];
}

export interface RuleSetVersionView {
  id: string;
  label: string;
  status: string;
  effectiveFrom: Date;
  authoredBy: string;
  approvedBy: string | null;
  publishedAt: Date | null;
  rules: number;
  inForce: boolean;
}

/** A warning's stable name: the same warning on the same draft always gets the same id. */
export function warningId(issue: Issue): string {
  return `${issue.code}:${issue.key ?? '-'}:${createHash('sha256').update(issue.message).digest('hex').slice(0, 10)}`;
}

interface VersionRow {
  id: string;
  label: string;
  status: string;
  effective_from: Date;
  authored_by: string;
  approved_by: string | null;
  published_at: Date | null;
  notes: string | null;
}

async function records(q: Queryable, versionId: string): Promise<RuleRecord[]> {
  const r = await run<{ rule_key: string; scope_type: RuleRecord['scope']['type']; scope_ref: string; value: unknown; provenance: RuleRecord['provenance']; source_note: string | null }>(
    q,
    'SELECT rule_key, scope_type, scope_ref, value, provenance, source_note FROM rulebook.rule_value WHERE version_id = $1 ORDER BY id',
    [versionId],
  );
  return r.rows.map((x) => ({ key: x.rule_key, scope: { type: x.scope_type, ref: x.scope_ref }, value: x.value, provenance: x.provenance, source: x.source_note ?? '' }));
}

async function taxRates(q: Queryable): Promise<TaxRateRecord[]> {
  const r = await run<{ id: string; tax_code: TaxRateRecord['taxCode']; tax_class: string; currency: Currency; rate_bp: number; base: TaxRateRecord['base']; effective_from: Date; effective_to: Date | null; active: boolean; provenance: TaxRateRecord['provenance']; source_note: string | null }>(
    q,
    'SELECT * FROM rulebook.tax_rate ORDER BY effective_from',
  );
  return r.rows.map((t) => ({
    id: t.id, taxCode: t.tax_code, taxClass: t.tax_class, currency: t.currency, rateBp: t.rate_bp, base: t.base,
    effectiveFrom: t.effective_from.toISOString(), effectiveTo: t.effective_to?.toISOString() ?? null, active: t.active,
    provenance: t.provenance, source: t.source_note ?? '',
  }));
}

function byKey(rs: readonly RuleRecord[]): Map<string, string> {
  const m = new Map<string, string[]>();
  for (const r of rs) {
    const list = m.get(r.key) ?? [];
    list.push(JSON.stringify([r.scope.type, r.scope.ref, r.value, r.provenance]));
    m.set(r.key, list);
  }
  return new Map([...m].map(([k, v]) => [k, v.sort().join('|')]));
}

export class RuleSetPublication {
  constructor(private readonly db: Db) {}

  async versions(): Promise<RuleSetVersionView[]> {
    const r = await this.db.query<VersionRow & { rules: bigint; in_force: boolean }>(
      `SELECT v.*, (SELECT count(*) FROM rulebook.rule_value rv WHERE rv.version_id = v.id) AS rules,
              v.id = (SELECT id FROM rulebook.rule_set_version WHERE status = 'published' AND effective_from <= now()
                       ORDER BY effective_from DESC LIMIT 1) AS in_force
         FROM rulebook.rule_set_version v ORDER BY v.effective_from DESC`,
    );
    return r.rows.map((v) => ({
      id: v.id, label: v.label, status: v.status, effectiveFrom: v.effective_from, authoredBy: v.authored_by,
      approvedBy: v.approved_by, publishedAt: v.published_at, rules: Number(v.rules), inForce: Boolean(v.in_force),
    }));
  }

  private async version(q: Queryable, versionId: string, lock = false): Promise<VersionRow> {
    const r = await run<VersionRow>(q, `SELECT * FROM rulebook.rule_set_version WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [versionId]);
    if (!r.rows[0]) throw new AdminError('not_found', 'We could not find that rule set.');
    return r.rows[0];
  }

  /** The draft as a rule set document, with every tax rate row, ready for validateRuleSet. */
  async document(q: Queryable, versionId: string, effectiveFrom?: Date): Promise<RuleSetDocument> {
    const v = await this.version(q, versionId);
    return {
      label: v.label,
      effectiveFrom: (effectiveFrom ?? v.effective_from).toISOString(),
      ...(v.notes ? { notes: v.notes } : {}),
      rules: await records(q, versionId),
      taxRates: await taxRates(q),
    };
  }

  async validation(versionId: string, options: { effectiveFrom?: Date; q?: Queryable } = {}): Promise<RuleSetValidation> {
    const q = options.q ?? this.db;
    const v = await this.version(q, versionId);
    const doc = await this.document(q, versionId, options.effectiveFrom);
    const categories = await run<{ code: string; tax_class: string }>(q, 'SELECT code, tax_class FROM catalogue.category');
    const result = validateRuleSet(doc, { catalogue: { categories: categories.rows.map((c) => ({ code: c.code, taxClass: c.tax_class })) } });
    const acks = await run<{ warning_id: string; acknowledged_by: string; name: string | null; reason: string; acknowledged_at: Date }>(
      q,
      `SELECT w.warning_id, w.acknowledged_by, a.display_name AS name, w.reason, w.acknowledged_at
         FROM rulebook.warning_acknowledgement w LEFT JOIN identity.account a ON a.id = w.acknowledged_by
        WHERE w.version_id = $1 ORDER BY w.acknowledged_at`,
      [versionId],
    );
    const warnings: WarningView[] = [];
    const seen = new Set<string>();
    for (const w of result.warnings) {
      const id = warningId(w);
      if (seen.has(id)) continue; // the same sentence twice is one thing to acknowledge
      seen.add(id);
      warnings.push({
        id, code: w.code, key: w.key ?? null, message: w.message,
        acknowledgements: acks.rows.filter((a) => a.warning_id === id).map((a) => ({ by: a.acknowledged_by, name: a.name, reason: a.reason, at: a.acknowledged_at })),
      });
    }
    const changedKeys = await this.changedKeys(q, versionId);
    const approverRoles = [...new Set(changedKeys.filter(isRuleKey).map((k) => OWNER_ROLE[RULES[k].owner]!))].sort();
    return {
      versionId, label: v.label, status: v.status, authoredBy: v.authored_by, effectiveFrom: options.effectiveFrom ?? v.effective_from,
      errors: result.errors, warnings, changedKeys, approverRoles,
    };
  }

  /** Keys whose records differ from the version in force now (every key, if none is in force). */
  async changedKeys(q: Queryable, versionId: string): Promise<string[]> {
    const current = await run<{ id: string }>(
      q,
      `SELECT id FROM rulebook.rule_set_version WHERE status = 'published' AND effective_from <= now() AND id <> $1
        ORDER BY effective_from DESC LIMIT 1`,
      [versionId],
    );
    const mine = byKey(await records(q, versionId));
    const theirs = current.rows[0] ? byKey(await records(q, current.rows[0].id)) : new Map<string, string>();
    return [...new Set([...mine.keys(), ...theirs.keys()])].filter((k) => mine.get(k) !== theirs.get(k)).sort();
  }

  private checkApprover(staff: StaffMember, v: VersionRow, approverRoles: readonly StaffRole[]): void {
    requirePermission(staff, 'rulebook.approve');
    if (staff.id === v.authored_by) {
      throw new AdminError('forbidden', 'You wrote this rule set, so a second person must acknowledge its warnings and approve it.');
    }
    if (!staff.roles.includes('admin')) {
      const missing = approverRoles.filter((r) => !staff.roles.includes(r));
      if (missing.length > 0) {
        throw new AdminError('forbidden', `This rule set changes rules owned by ${missing.join(', ')}. The approver must hold those roles, or be an admin.`, { missing });
      }
    }
  }

  /** The approver acknowledges one warning by its name, with a reason (stored, append-only). */
  async acknowledge(staff: StaffMember, versionId: string, id: string, reasonInput: string, effectiveFrom?: Date): Promise<WarningView> {
    const reason = requireReason(reasonInput);
    const validation = await this.validation(versionId, effectiveFrom ? { effectiveFrom } : {});
    const v = await this.version(this.db, versionId);
    if (v.status !== 'draft') throw new AdminError('conflict', `This rule set is ${v.status}; only a draft's warnings are acknowledged.`);
    this.checkApprover(staff, v, validation.approverRoles);
    const warning = validation.warnings.find((w) => w.id === id);
    if (!warning) throw new AdminError('not_found', 'That warning is not on this rule set (it may have been resolved).');
    if (warning.acknowledgements.some((a) => a.by === staff.id)) return warning;
    await this.db.tx(staffActor(staff, `acknowledge rule set warning ${id}`), (c) =>
      c.query(
        `INSERT INTO rulebook.warning_acknowledgement (version_id, warning_id, code, rule_key, message, reason, acknowledged_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [versionId, id, warning.code, warning.key, warning.message, reason, staff.id],
      ),
    );
    return (await this.validation(versionId, effectiveFrom ? { effectiveFrom } : {})).warnings.find((w) => w.id === id)!;
  }

  /** The second person publishes the draft with its effective time. */
  async approveAndPublish(staff: StaffMember, versionId: string, effectiveFrom: Date, now: Date = new Date()): Promise<RuleSetVersionView & { retired: string[] }> {
    if (Number.isNaN(effectiveFrom.getTime())) throw new AdminError('invalid', 'Give the date and time the rule set takes effect.');
    if (effectiveFrom.getTime() < now.getTime() - 60_000) {
      throw new AdminError('invalid', 'A rule set cannot take effect in the past. Choose now or a later time.');
    }
    const v0 = await this.version(this.db, versionId);
    if (v0.status === 'published' && v0.approved_by === staff.id) {
      return { ...(await this.versions()).find((x) => x.id === versionId)!, retired: [] };
    }
    try {
      return await this.db.tx(staffActor(staff, `publish rule set ${v0.label}`), async (c) => {
        const v = await this.version(c, versionId, true);
        if (v.status !== 'draft') throw new AdminError('conflict', `This rule set is already ${v.status}.`);
        const validation = await this.validation(versionId, { effectiveFrom, q: c });
        this.checkApprover(staff, v, validation.approverRoles);
        if (validation.errors.length > 0) {
          throw new AdminError('conflict', `The rule set has ${validation.errors.length} error(s) and cannot be published.`, { errors: validation.errors });
        }
        const missing = validation.warnings.filter((w) => !w.acknowledgements.some((a) => a.by === staff.id)).map((w) => w.id);
        if (missing.length > 0) {
          throw new AdminError('conflict', `Acknowledge each warning before publishing: ${missing.length} still open.`, { missing });
        }
        await c.query(
          `UPDATE rulebook.rule_set_version SET status = 'published', approved_by = $2, published_at = now(), effective_from = $3 WHERE id = $1`,
          [versionId, staff.id, effectiveFrom],
        );
        const retired = await this.retireSupersededIn(c, now);
        await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('rulebook.published', 'rule_set_version', $1, $2::jsonb)`, [
          versionId,
          JSON.stringify({ label: v.label, effectiveFrom, warningsAcknowledged: validation.warnings.length, changedKeys: validation.changedKeys }),
        ]);
        const after = await this.version(c, versionId);
        return {
          id: after.id, label: after.label, status: after.status, effectiveFrom: after.effective_from, authoredBy: after.authored_by,
          approvedBy: after.approved_by, publishedAt: after.published_at, rules: (await records(c, versionId)).length,
          inForce: after.effective_from.getTime() <= now.getTime(), retired,
        };
      });
    } catch (e) {
      if (isUniqueViolation(e, 'rule_set_version_one_effective_idx')) {
        throw new AdminError('conflict', 'Another published rule set takes effect at exactly that time. Choose a different time.');
      }
      throw e;
    }
  }

  private async retireSupersededIn(c: Client, at: Date): Promise<string[]> {
    const r = await c.query<{ id: string }>(
      `UPDATE rulebook.rule_set_version SET status = 'retired'
        WHERE status = 'published'
          AND effective_from < (SELECT max(effective_from) FROM rulebook.rule_set_version WHERE status = 'published' AND effective_from <= $1)
        RETURNING id`,
      [at],
    );
    return r.rows.map((x) => x.id);
  }

  /** Retires published versions superseded by one now in force (also run by the worker). */
  async retireSuperseded(at: Date = new Date()): Promise<string[]> {
    return this.db.tx({ type: 'system', id: 'rulebook', name: 'Rulebook', reason: 'superseded by a later published rule set' }, (c) => this.retireSupersededIn(c, at));
  }

  async taxRateList(): Promise<Array<TaxRateRecord & { approvedBy: string | null; pendingActivation: string | null }>> {
    const rates = await taxRates(this.db);
    const extra = await this.db.query<{ id: string; approved_by: string | null; pending: string | null }>(
      `SELECT t.id, t.approved_by,
              (SELECT o.id FROM audit.override_request o WHERE o.action_type = 'tax_rate_activation' AND o.entity_id = t.id::text
                  AND o.status = 'pending' ORDER BY o.requested_at DESC LIMIT 1) AS pending
         FROM rulebook.tax_rate t`,
    );
    const m = new Map(extra.rows.map((x) => [x.id, x]));
    return rates.map((r) => ({ ...r, approvedBy: m.get(r.id!)?.approved_by ?? null, pendingActivation: m.get(r.id!)?.pending ?? null }));
  }
}

/** Finance activates a tax rate with a second finance approver (Q9). */
export const taxRateActivationHandler: OverrideHandler = {
  kind: 'tax_rate_activation',
  requestPermission: 'tax_rate.activation.request',
  approvePermission: 'tax_rate.activation.approve',
  async prepare(c, _staff, input) {
    const id = String(input.taxRateId ?? '');
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AdminError('invalid', 'Name the tax rate to activate.');
    const r = await c.query<{ tax_code: string; tax_class: string; currency: Currency; rate_bp: number; active: boolean; effective_from: Date; effective_to: Date | null }>(
      'SELECT tax_code, tax_class, currency, rate_bp, active, effective_from, effective_to FROM rulebook.tax_rate WHERE id = $1',
      [id],
    );
    const t = r.rows[0];
    if (!t) throw new AdminError('not_found', 'We could not find that tax rate.');
    if (t.active) throw new AdminError('conflict', 'That tax rate is already active.');
    if (t.effective_to && t.effective_to.getTime() <= Date.now()) throw new AdminError('conflict', 'That tax rate has already ended.');
    const overlap = await c.query(
      `SELECT 1 FROM rulebook.tax_rate WHERE active AND tax_code = $1 AND tax_class = $2 AND currency = $3
          AND tstzrange(effective_from, effective_to) && tstzrange($4::timestamptz, $5::timestamptz)`,
      [t.tax_code, t.tax_class, t.currency, t.effective_from, t.effective_to],
    );
    if (overlap.rowCount) throw new AdminError('conflict', 'Another active rate covers the same tax, class, currency and dates. Close it first.');
    return {
      actionType: 'tax_rate_activation', entityType: 'rulebook.tax_rate', entityId: id, currency: null, amountMinor: null,
      payload: { taxRateId: id }, alwaysTwoPerson: true, dedupeKey: 'activate',
      summary: `Activate ${t.tax_code} at ${(t.rate_bp / 100).toFixed(2)} % for ${t.tax_class} in ${t.currency}`,
    };
  },
  async execute(c, request, by) {
    await c.query(`UPDATE rulebook.tax_rate SET active = true, approved_by = $2, activation_override_id = $3 WHERE id = $1`, [request.entity_id, by.id, request.id]);
    return { taxRateId: request.entity_id, active: true };
  },
};
