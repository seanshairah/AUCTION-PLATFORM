import { RuleSnapshot, type RuleRecord, type RuleSetDocument, type TaxRateRecord } from '@abc/rules';
import { run, type Client, type Db } from './db';

/**
 * Reads rule set versions and tax rates from the rulebook schema
 * (docs/03-rulebook-service.md §7). Versions are immutable, so loaded snapshots
 * are cached by version id for the life of the process.
 */
export class RulebookStore {
  private readonly cache = new Map<string, RuleSnapshot>();

  constructor(private readonly db: Db) {}

  /** The most recent published version effective at `at`. */
  async activeVersionId(at: Date, client?: Client): Promise<string> {
    const r = await run<{ id: string }>(client ?? this.db,
      `SELECT id FROM rulebook.rule_set_version
        WHERE status = 'published' AND effective_from <= $1
        ORDER BY effective_from DESC LIMIT 1`,
      [at],
    );
    if (!r.rows[0]) throw new Error(`No published rule set is effective at ${at.toISOString()}`);
    return r.rows[0].id;
  }

  async snapshot(versionId: string, client?: Client): Promise<RuleSnapshot> {
    const cached = this.cache.get(versionId);
    if (cached) return cached;
    const q = client ?? this.db;
    const v = await run<{ label: string }>(q, 'SELECT label FROM rulebook.rule_set_version WHERE id = $1', [versionId]);
    if (!v.rows[0]) throw new Error(`Rule set version ${versionId} not found`);
    const rows = await run<{ rule_key: string; scope_type: RuleRecord['scope']['type']; scope_ref: string; value: unknown; provenance: RuleRecord['provenance']; source_note: string | null }>(
      q,
      'SELECT rule_key, scope_type, scope_ref, value, provenance, source_note FROM rulebook.rule_value WHERE version_id = $1',
      [versionId],
    );
    const snapshot = new RuleSnapshot(
      versionId,
      v.rows[0].label,
      rows.rows.map((r) => ({
        key: r.rule_key,
        scope: { type: r.scope_type, ref: r.scope_ref },
        value: r.value,
        provenance: r.provenance,
        source: r.source_note ?? '',
      })),
    );
    this.cache.set(versionId, snapshot);
    return snapshot;
  }

  /** Active tax rate rows (the quote filters by date itself). */
  async taxRates(client?: Client): Promise<TaxRateRecord[]> {
    const r = await run<{
      id: string; tax_code: TaxRateRecord['taxCode']; tax_class: string; currency: TaxRateRecord['currency'];
      rate_bp: number; base: TaxRateRecord['base']; effective_from: Date; effective_to: Date | null;
      active: boolean; provenance: TaxRateRecord['provenance']; source_note: string | null;
    }>(client ?? this.db, 'SELECT * FROM rulebook.tax_rate WHERE active');
    return r.rows.map((t) => ({
      id: t.id,
      taxCode: t.tax_code,
      taxClass: t.tax_class,
      currency: t.currency,
      rateBp: t.rate_bp,
      base: t.base,
      effectiveFrom: t.effective_from.toISOString(),
      effectiveTo: t.effective_to ? t.effective_to.toISOString() : null,
      active: t.active,
      provenance: t.provenance,
      source: t.source_note ?? '',
    }));
  }
}

/**
 * TEST AND DEVELOPMENT ONLY. Loads a rule set as an already-published version and,
 * optionally, activates its tax rates. Production publishing is the two-person
 * workflow in docs/03 §6; this helper exists so integration tests can run the
 * money path before finance has answered Q9.
 */
export async function loadPublishedRuleSetForTests(
  db: Db,
  doc: RuleSetDocument,
  options: { activateTaxRates?: boolean; overrides?: RuleRecord[] } = {},
): Promise<string> {
  const author = '00000000-0000-0000-0000-00000000aaa1';
  const approver = '00000000-0000-0000-0000-00000000aaa2';
  return db.tx({ type: 'system', id: 'test-loader', name: 'Test rule loader', reason: 'integration test fixture' }, async (c) => {
    const v = await c.query<{ id: string }>(
      `INSERT INTO rulebook.rule_set_version (label, effective_from, status, authored_by)
       VALUES ($1, $2, 'draft', $3) RETURNING id`,
      [`${doc.label}-test-${Date.now()}`, '2000-01-01T00:00:00Z', author],
    );
    const versionId = v.rows[0]!.id;
    const overrides = options.overrides ?? [];
    const records = [
      ...doc.rules.filter((r) => !overrides.some((o) => o.key === r.key && o.scope.type === r.scope.type && o.scope.ref === r.scope.ref)),
      ...overrides,
    ];
    for (const r of records) {
      await c.query(
        `INSERT INTO rulebook.rule_value (version_id, rule_key, scope_type, scope_ref, value, provenance, source_note)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [versionId, r.key, r.scope.type, r.scope.ref, JSON.stringify(r.value), r.provenance, r.source],
      );
    }
    await c.query(
      `UPDATE rulebook.rule_set_version SET status = 'published', approved_by = $2, published_at = now() WHERE id = $1`,
      [versionId, approver],
    );
    if (options.activateTaxRates) {
      for (const t of doc.taxRates) {
        await c.query(
          `INSERT INTO rulebook.tax_rate (tax_code, tax_class, currency, rate_bp, base, effective_from, effective_to, active, provenance, owner, approved_by, source_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, 'finance', $9, $10)`,
          [t.taxCode, t.taxClass, t.currency, t.rateBp, t.base, t.effectiveFrom, t.effectiveTo ?? null, t.provenance, approver, t.source],
        );
      }
    }
    return versionId;
  });
}
