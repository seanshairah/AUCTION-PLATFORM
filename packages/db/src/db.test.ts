import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, DB_TESTS_ENABLED, loadPublishedRuleSetForTests, readRuleSetDocument, RulebookStore, SYSTEM, type TestDatabase } from './index';

describe.skipIf(!DB_TESTS_ENABLED)('database helpers', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('builds a database from the canonical schema and seed', async () => {
    const r = await t.db.query<{ n: bigint }>('SELECT count(*) AS n FROM catalogue.condition_term');
    expect(r.rows[0]!.n).toBe(9n);
  });

  it('sets the audit actor inside every transaction and rolls back on error', async () => {
    await expect(
      t.db.tx(SYSTEM, async (c) => {
        await c.query("INSERT INTO core.branch (code, name, city) VALUES ('TST', 'Test', 'Test')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const r = await t.db.query("SELECT 1 FROM core.branch WHERE code = 'TST'");
    expect(r.rowCount).toBe(0);
    const actor = await t.db.tx(SYSTEM, async (c) => (await c.query<{ a: string }>("SELECT current_setting('app.actor_type') AS a")).rows[0]!.a);
    expect(actor).toBe('system');
  });

  it('loads a published rule set and its snapshot from the database', async () => {
    const versionId = await loadPublishedRuleSetForTests(t.db, readRuleSetDocument(), { activateTaxRates: true });
    const store = new RulebookStore(t.db);
    expect(await store.activeVersionId(new Date())).toBe(versionId);
    const snapshot = await store.snapshot(versionId);
    expect(snapshot.get('settlement.pay_window_hours')).toBe(48);
    expect((await store.taxRates()).length).toBe(5);
  });
});
