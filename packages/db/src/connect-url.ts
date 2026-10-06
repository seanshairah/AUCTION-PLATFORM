import { neonConfig, Pool as NeonPool, types as neonTypes } from '@neondatabase/serverless';
import { HttpsProxyAgent } from 'https-proxy-agent';
import pg from 'pg';
import WebSocket from 'ws';
import { Db } from './db';

/**
 * Opens the application database from DATABASE_URL.
 *
 * Driver (DB_DRIVER):
 *   pg       node-postgres over TCP 5432. The default, and what production uses.
 *   neon-ws  Neon's driver: the same Postgres wire protocol, carried over a
 *            WebSocket on 443. For networks that allow only HTTPS (some CI and
 *            sandbox environments). Honours HTTPS_PROXY.
 *
 * The connection string is a secret: it comes from the environment (an untracked
 * .env locally, the secrets manager elsewhere), never from the repository.
 */
export type DbDriver = 'pg' | 'neon-ws';

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Put it in .env (untracked) or the environment.');
  return url;
}

export function driverFromEnv(env: NodeJS.ProcessEnv = process.env): DbDriver {
  const d = env.DB_DRIVER ?? 'pg';
  if (d !== 'pg' && d !== 'neon-ws') throw new Error(`DB_DRIVER must be pg or neon-ws, not ${d}`);
  return d;
}

let neonConfigured = false;

function configureNeon(env: NodeJS.ProcessEnv): void {
  if (neonConfigured) return;
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  if (proxy) {
    const agent = new HttpsProxyAgent(proxy);
    class ProxiedWebSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { agent });
      }
    }
    neonConfig.webSocketConstructor = ProxiedWebSocket as unknown as typeof WebSocket;
  } else {
    neonConfig.webSocketConstructor = WebSocket;
  }
  // int8 columns are money and sequence numbers: bigint, as with node-postgres (db.ts).
  neonTypes.setTypeParser(20, (v: string) => BigInt(v));
  neonConfigured = true;
}

export function connectUrl(
  url: string = databaseUrl(),
  options: { driver?: DbDriver; max?: number; env?: NodeJS.ProcessEnv } = {},
): Db {
  const env = options.env ?? process.env;
  const driver = options.driver ?? driverFromEnv(env);
  const max = options.max ?? 10;
  if (driver === 'neon-ws') {
    configureNeon(env);
    // API-compatible with pg.Pool for everything Db uses (connect, query, end).
    return new Db(new NeonPool({ connectionString: url, max }) as unknown as pg.Pool);
  }
  return new Db(new pg.Pool({ connectionString: url, max }));
}
