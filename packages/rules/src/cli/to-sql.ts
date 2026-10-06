/**
 * Turns a rule set document into SQL that loads it as a DRAFT version into
 * rulebook.rule_set_version / rule_value / tax_rate. Publishing is a separate,
 * two-person step (docs/03-rulebook-service.md §6), never done by this script.
 *
 * Usage: tsx src/cli/to-sql.ts <rule-set.json> [--author <uuid>] > out.sql
 * Exits non-zero, printing the errors, if the document fails validation.
 */
import { readFileSync } from 'node:fs';
import { validateRuleSet } from '../validate';
import type { RuleSetDocument } from '../types';

const SYSTEM_AUTHOR = '00000000-0000-0000-0000-000000000000';

function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function toSql(doc: RuleSetDocument, author: string = SYSTEM_AUTHOR): string {
  const lines: string[] = [];
  lines.push('-- Generated from a rule set document. Loads a DRAFT version; publishing needs two people.');
  lines.push('BEGIN;');
  lines.push(`SELECT audit.set_actor('system', ${lit(author)}, 'Rule set import', ${lit(`import ${doc.label}`)});`);
  lines.push(
    `INSERT INTO rulebook.rule_set_version (label, effective_from, status, authored_by, notes)\n` +
      `VALUES (${lit(doc.label)}, ${lit(doc.effectiveFrom)}, 'draft', ${lit(author)}, ${doc.notes ? lit(doc.notes) : 'NULL'});`,
  );
  const rows = doc.rules.map(
    (r) =>
      `  (${lit(r.key)}, ${lit(r.scope.type)}, ${lit(r.scope.ref)}, ${lit(JSON.stringify(r.value))}::jsonb, ${lit(r.provenance)}, ${lit(r.source)})`,
  );
  lines.push(
    `INSERT INTO rulebook.rule_value (version_id, rule_key, scope_type, scope_ref, value, provenance, source_note)\n` +
      `SELECT v.id, r.rule_key, r.scope_type, r.scope_ref, r.value, r.provenance, r.source_note\n` +
      `  FROM rulebook.rule_set_version v,\n` +
      `       (VALUES\n${rows.join(',\n')}\n       ) AS r(rule_key, scope_type, scope_ref, value, provenance, source_note)\n` +
      ` WHERE v.label = ${lit(doc.label)};`,
  );
  for (const t of doc.taxRates) {
    if (t.active) throw new Error('Tax rates are imported inactive; finance activates them with an approval');
    lines.push(
      `INSERT INTO rulebook.tax_rate (tax_code, tax_class, currency, rate_bp, base, effective_from, effective_to, active, provenance, source_note)\n` +
        `VALUES (${lit(t.taxCode)}, ${lit(t.taxClass)}, ${lit(t.currency)}, ${t.rateBp}, ${lit(t.base)}, ${lit(t.effectiveFrom)}, ` +
        `${t.effectiveTo ? lit(t.effectiveTo) : 'NULL'}, false, ${lit(t.provenance)}, ${lit(t.source)});`,
    );
  }
  lines.push('COMMIT;');
  return lines.join('\n') + '\n';
}

function main(argv: string[]): void {
  const file = argv[0];
  if (!file) {
    console.error('Usage: to-sql <rule-set.json> [--author <uuid>]');
    process.exit(2);
  }
  const authorIdx = argv.indexOf('--author');
  const author = authorIdx >= 0 ? argv[authorIdx + 1] : undefined;
  const doc = JSON.parse(readFileSync(file, 'utf8')) as RuleSetDocument;
  const { errors, warnings } = validateRuleSet(doc);
  for (const w of warnings) console.error(`warning: ${w.message}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e.message}`);
    process.exit(1);
  }
  process.stdout.write(toSql(doc, author));
}

if (process.argv[1] && /to-sql\.ts$/.test(process.argv[1])) main(process.argv.slice(2));
