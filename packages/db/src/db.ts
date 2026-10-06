import pg from 'pg';

/**
 * Database access shared by the money modules. Every write runs inside `tx`,
 * which sets the audit actor first, so the schema's audit triggers can attribute
 * every state change (architecture rule R3). Without an actor, audited writes fail.
 */

// int8 columns are money and sequence numbers: read them as bigint, never as float.
pg.types.setTypeParser(20, (v) => BigInt(v));

export type ActorType = 'account' | 'staff' | 'system' | 'gateway';

export interface Actor {
  type: ActorType;
  id: string;
  name: string;
  reason?: string;
  requestId?: string;
}

export type Client = pg.PoolClient;

export const SYSTEM: Actor = { type: 'system', id: 'system', name: 'System' };

export class Db {
  constructor(readonly pool: pg.Pool) {}

  async tx<T>(actor: Actor, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT audit.set_actor($1, $2, $3, $4, $5)', [
        actor.type,
        actor.id,
        actor.name,
        actor.reason ?? null,
        actor.requestId ?? null,
      ]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Read-only queries outside a transaction. */
  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(sql, params as unknown[]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export type Queryable = Client | Db;

/** Runs a query on either a transaction client or the pool. */
export function run<R extends pg.QueryResultRow = pg.QueryResultRow>(
  q: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  return q instanceof Db ? q.query<R>(sql, params) : (q as Client).query<R>(sql, params as unknown[]);
}

/** Money and other bigints go to Postgres as text; node-postgres does not serialise bigint. */
export function big(value: bigint): string {
  return value.toString();
}

export function connect(config: pg.PoolConfig = {}): Db {
  return new Db(new pg.Pool({ max: 10, ...config }));
}

/** Postgres error helper: true when `e` is a unique-constraint violation. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string };
  return err?.code === '23505' && (constraint === undefined || err.constraint === constraint);
}
