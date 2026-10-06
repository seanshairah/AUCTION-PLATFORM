/**
 * Database operations against DATABASE_URL (see connect-url.ts for drivers).
 *
 *   tsx src/cli/db.ts status          applied and pending migrations
 *   tsx src/cli/db.ts migrate         apply pending migrations (baseline first)
 *   tsx src/cli/db.ts load-rulebook   validate rulebook/initial-rule-set.json and load it as a DRAFT version
 *   tsx src/cli/db.ts sql <file>      run a SQL file (multi-statement) in one round trip
 *   tsx src/cli/db.ts reset --confirm <database>
 *                                     drop every System schema (removes demo data; refused in production)
 *
 * Reads .env at the repository root if present (untracked; holds DATABASE_URL).
 */
import { readFileSync } from 'node:fs';
import { validateRuleSet } from '@abc/rules';
import { toSql } from '@abc/rules/src/cli/to-sql';
import { connectUrl } from '../connect-url';
import { loadDotEnv } from '../env';
import { migrate, migrationStatus, resetDatabase } from '../migrate';
import { readRuleSetDocument } from '../testing';

async function main(argv: string[]): Promise<void> {
  loadDotEnv();
  const db = connectUrl(undefined, { max: 2 });
  try {
    switch (argv[0]) {
      case 'status': {
        const s = await migrationStatus(db);
        for (const a of s.applied) console.log(`applied  ${a.id}  ${a.appliedAt.toISOString()}`);
        for (const p of s.pending) console.log(`pending  ${p}`);
        for (const c of s.changed) console.log(`CHANGED  ${c}  (edited after it was applied)`);
        if (s.baselineDrift) console.log('note     db/schema.sql has changed since this database was built');
        break;
      }
      case 'migrate': {
        const done = await migrate(db, undefined, (l) => console.log(l));
        console.log(done.length ? `${done.length} step(s) applied` : 'up to date');
        break;
      }
      case 'load-rulebook': {
        const doc = readRuleSetDocument();
        const { errors, warnings } = validateRuleSet(doc);
        console.log(`${warnings.length} warning(s) to acknowledge at publication`);
        if (errors.length) throw new Error(errors.map((e) => e.message).join('\n'));
        const exists = await db.query('SELECT 1 FROM rulebook.rule_set_version WHERE label = $1', [doc.label]);
        if (exists.rowCount) {
          console.log(`rule set ${doc.label} is already loaded`);
          break;
        }
        await db.query(toSql(doc));
        console.log(`loaded ${doc.label} as a draft (${doc.rules.length} rules); publishing needs two people`);
        break;
      }
      case 'sql': {
        if (!argv[1]) throw new Error('usage: db sql <file>');
        await db.query(readFileSync(argv[1], 'utf8'));
        console.log('ok');
        break;
      }
      case 'reset': {
        const at = argv.indexOf('--confirm');
        await resetDatabase(db, at >= 0 ? (argv[at + 1] ?? '') : '');
        console.log('reset: all System schemas dropped; run migrate to rebuild');
        break;
      }
      default:
        console.error('usage: db status | migrate | load-rulebook | sql <file> | reset --confirm <database>');
        process.exitCode = 2;
    }
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
