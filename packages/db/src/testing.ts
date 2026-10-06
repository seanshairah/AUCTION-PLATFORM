import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Db } from './db';

/**
 * Throwaway databases for integration tests, built from the canonical
 * db/schema.sql and db/seed.sql. Connection settings come from the usual PG*
 * environment variables. Tests skip when PGHOST is not set; CI sets it.
 */

export const DB_TESTS_ENABLED = Boolean(process.env.PGHOST);

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface TestDatabase {
  db: Db;
  name: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `abc_it_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ database: process.env.PGDATABASE_ADMIN ?? 'postgres' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const setup = new pg.Client({ database: name });
  await setup.connect();
  await setup.query(readFileSync(`${ROOT}db/schema.sql`, 'utf8'));
  await setup.query(readFileSync(`${ROOT}db/seed.sql`, 'utf8'));
  await setup.end();

  const db = new Db(new pg.Pool({ database: name, max: 5 }));
  return {
    db,
    name,
    async drop() {
      await db.close();
      const a = new pg.Client({ database: process.env.PGDATABASE_ADMIN ?? 'postgres' });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export function readRuleSetDocument(): import('@abc/rules').RuleSetDocument {
  return JSON.parse(readFileSync(`${ROOT}rulebook/initial-rule-set.json`, 'utf8'));
}
