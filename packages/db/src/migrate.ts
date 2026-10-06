import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './db';

/**
 * Schema migrations for long-lived databases (staging, production).
 *
 * The baseline is db/schema.sql followed by db/seed.sql, exactly what tests and
 * CI build from. Changes after a database exists go in db/migrations/NNNN_name.sql
 * (no BEGIN/COMMIT inside: each file runs in its own transaction) and are also
 * folded into db/schema.sql, so fresh databases and migrated ones match. A database
 * built from the baseline therefore records every existing migration as applied.
 *
 * Every applied step is recorded with its SHA-256 in public.schema_migration.
 * Editing a step that has already been applied is refused; so is running the
 * baseline on a database that already has the System's schemas.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ADVISORY_LOCK = 72_011_026; // any constant: serialises concurrent migrators

export interface MigrationStep {
  id: string;
  sql: string;
  sha256: string;
}

export interface MigrationStatus {
  applied: Array<{ id: string; sha256: string; appliedAt: Date }>;
  pending: string[];
  /** Applied steps whose file has changed since. Never re-run; investigate. */
  changed: string[];
  /** db/schema.sql (plus seed) differs from the baseline this database was built from. */
  baselineDrift: boolean;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Removes a file's own top-level BEGIN; / COMMIT; lines so the runner owns the transaction. */
function withoutTransactionLines(sql: string): string {
  return sql.replace(/^\s*(BEGIN|COMMIT);\s*$/gim, '');
}

export function migrationSteps(root: string = ROOT): MigrationStep[] {
  const baseline = readFileSync(`${root}db/schema.sql`, 'utf8') + '\n' + readFileSync(`${root}db/seed.sql`, 'utf8');
  const steps: MigrationStep[] = [{ id: '0000_baseline', sql: withoutTransactionLines(baseline), sha256: sha256(baseline) }];
  const dir = `${root}db/migrations`;
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort()) {
      const sql = readFileSync(`${dir}/${file}`, 'utf8');
      if (/^\s*(BEGIN|COMMIT);\s*$/im.test(sql)) throw new Error(`${file}: remove BEGIN/COMMIT; the runner wraps each migration in a transaction`);
      steps.push({ id: file.replace(/\.sql$/, ''), sql, sha256: sha256(sql) });
    }
  }
  return steps;
}

const TRACKING_DDL = `CREATE TABLE IF NOT EXISTS public.schema_migration (
  id          text PRIMARY KEY,
  sha256      text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_by  text NOT NULL DEFAULT current_user
)`;

async function appliedSteps(db: Db): Promise<Map<string, { sha256: string; appliedAt: Date }>> {
  await db.query(TRACKING_DDL);
  const r = await db.query<{ id: string; sha256: string; applied_at: Date }>('SELECT id, sha256, applied_at FROM public.schema_migration ORDER BY id');
  return new Map(r.rows.map((x) => [x.id, { sha256: x.sha256, appliedAt: x.applied_at }]));
}

export async function migrationStatus(db: Db, steps: MigrationStep[] = migrationSteps()): Promise<MigrationStatus> {
  const applied = await appliedSteps(db);
  const status: MigrationStatus = { applied: [], pending: [], changed: [], baselineDrift: false };
  for (const s of steps) {
    const a = applied.get(s.id);
    if (!a) status.pending.push(s.id);
    else {
      status.applied.push({ id: s.id, sha256: a.sha256, appliedAt: a.appliedAt });
      if (a.sha256 !== s.sha256) {
        if (s.id === '0000_baseline') status.baselineDrift = true;
        else status.changed.push(s.id);
      }
    }
  }
  return status;
}

/**
 * Applies pending steps in order, each in one transaction with its record.
 * Returns the ids applied. Throws, applying nothing further, on the first problem.
 */
export async function migrate(db: Db, steps: MigrationStep[] = migrationSteps(), log: (line: string) => void = () => undefined): Promise<string[]> {
  const status = await migrationStatus(db, steps);
  if (status.changed.length > 0) {
    throw new Error(`Applied migrations have been edited since: ${status.changed.join(', ')}. Write a new migration instead.`);
  }
  if (status.baselineDrift) {
    log('note: db/schema.sql has changed since this database was built; changes reach it only through db/migrations.');
  }
  const done: string[] = [];
  for (const id of status.pending) {
    if (done.includes(id) || (status.pending.includes('0000_baseline') && id !== '0000_baseline')) continue;
    const step = steps.find((s) => s.id === id)!;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK]);
      const again = await client.query('SELECT 1 FROM public.schema_migration WHERE id = $1', [id]);
      if (again.rowCount === 0) {
        if (id === '0000_baseline') {
          const exists = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname IN ('core', 'ledger', 'rulebook')`);
          if ((exists.rowCount ?? 0) > 0) throw new Error('This database already has the System’s schemas but no migration record; refusing to run the baseline over it.');
        }
        await client.query(step.sql);
        await client.query('INSERT INTO public.schema_migration (id, sha256) VALUES ($1, $2)', [id, step.sha256]);
        done.push(id);
        log(`applied ${id}`);
        if (id === '0000_baseline') {
          // db/schema.sql already contains every migration (the convention above), so a
          // database built from it is at the latest version: record them, don't run them.
          for (const later of steps.slice(1)) {
            await client.query('INSERT INTO public.schema_migration (id, sha256) VALUES ($1, $2)', [later.id, later.sha256]);
            log(`recorded ${later.id} (already in db/schema.sql)`);
          }
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  return done;
}

/** The System's schemas, as created by db/schema.sql. */
export const SYSTEM_SCHEMAS = ['core', 'audit', 'rulebook', 'identity', 'ledger', 'payment', 'payout', 'seller', 'catalogue', 'auction',
  'registration', 'bidding', 'settlement', 'logistics', 'support', 'comms'] as const;

/**
 * Drops every System schema and the migration record: the only way to remove
 * demo data, because the ledger and audit log are append-only by design.
 * Refused in production, and only when the caller names the database it means.
 */
export async function resetDatabase(db: Db, confirmDatabaseName: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.APP_ENV === 'production') throw new Error('Refusing to reset a database with APP_ENV=production.');
  const r = await db.query<{ name: string }>('SELECT current_database() AS name');
  if (r.rows[0]!.name !== confirmDatabaseName) throw new Error(`Connected to ${r.rows[0]!.name}; pass --confirm ${r.rows[0]!.name} to reset it.`);
  await db.query(`DROP SCHEMA IF EXISTS ${SYSTEM_SCHEMAS.join(', ')} CASCADE; DROP TABLE IF EXISTS public.schema_migration;`);
}
