import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from './db';
import { migrate, migrationStatus, migrationSteps, resetDatabase } from './migrate';
import { DB_TESTS_ENABLED } from './testing';

describe('migration steps', () => {
  it('start with the baseline (schema plus seed) and list numbered migrations in order', () => {
    const steps = migrationSteps();
    expect(steps[0]!.id).toBe('0000_baseline');
    expect(steps[0]!.sql).not.toMatch(/^\s*(BEGIN|COMMIT);\s*$/m);
    const ids = steps.slice(1).map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain('0001_vehicle_body_and_drive');
  });
});

describe.skipIf(!DB_TESTS_ENABLED)('migrating a database', () => {
  const name = `abc_mig_${randomBytes(5).toString('hex')}`;
  let db: Db;
  const admin = () => new pg.Client({ database: process.env.PGDATABASE_ADMIN ?? 'postgres' });

  beforeAll(async () => {
    const a = admin();
    await a.connect();
    await a.query(`CREATE DATABASE ${name}`);
    await a.end();
    db = new Db(new pg.Pool({ database: name, max: 2 }));
  });
  afterAll(async () => {
    await db?.close();
    const a = admin();
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });

  it('builds an empty database from the baseline and records later migrations as already included', async () => {
    const lines: string[] = [];
    expect(await migrate(db, undefined, (l) => lines.push(l))).toEqual(['0000_baseline']);
    expect(lines).toContain('recorded 0001_vehicle_body_and_drive (already in db/schema.sql)');
    const s = await migrationStatus(db);
    expect(s.pending).toEqual([]);
    expect(s.baselineDrift).toBe(false);
    expect(await migrate(db)).toEqual([]);
  });

  it('applies a new migration once, and refuses one edited after it was applied', async () => {
    const steps = [...migrationSteps(), { id: '9999_test', sql: 'CREATE TABLE core.migration_probe (id int)', sha256: 'a' }];
    expect(await migrate(db, steps)).toEqual(['9999_test']);
    expect(await migrate(db, steps)).toEqual([]);
    steps[steps.length - 1] = { ...steps[steps.length - 1]!, sha256: 'b' };
    await expect(migrate(db, steps)).rejects.toThrow(/edited/);
  });

  it('a failing migration leaves nothing behind', async () => {
    const steps = [...migrationSteps(), { id: '9998_broken', sql: 'CREATE TABLE core.half (id int); SELECT 1/0', sha256: 'c' }];
    await expect(migrate(db, steps)).rejects.toThrow(/division by zero/);
    const r = await db.query(`SELECT to_regclass('core.half') AS t, (SELECT count(*) FROM public.schema_migration WHERE id = '9998_broken') AS n`);
    expect(r.rows[0]).toEqual({ t: null, n: 0n });
  });

  it('refuses to run the baseline over existing schemas without a migration record', async () => {
    await db.query(`DELETE FROM public.schema_migration`);
    await expect(migrate(db)).rejects.toThrow(/refusing/);
  });

  it('reset needs the database name, is refused in production, and leaves a database migrate can rebuild', async () => {
    await expect(resetDatabase(db, 'some_other_db', {})).rejects.toThrow(/--confirm/);
    await expect(resetDatabase(db, name, { APP_ENV: 'production' })).rejects.toThrow(/production/);
    await resetDatabase(db, name, {});
    expect((await db.query(`SELECT count(*) AS n FROM pg_namespace WHERE nspname IN ('core', 'ledger')`)).rows[0]).toEqual({ n: 0n });
    expect(await migrate(db)).toEqual(['0000_baseline']);
  });
});
