/** Injection tokens. Explicit tokens keep DI independent of emitted decorator metadata. */
export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');
export const RULEBOOK = Symbol('RULEBOOK');
export const CATALOGUE = Symbol('CATALOGUE');
export const BID_DESK = Symbol('BID_DESK');

export interface ApiConfig {
  port: number;
  /** HMAC key for session tokens. */
  sessionSecret: string;
  /** Development and staging only: sign in as a demo bidder (A42). */
  demoSignIn: boolean;
  /** Cookies get the Secure flag outside local development. */
  secureCookies: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const production = env.APP_ENV === 'production';
  const sessionSecret = env.SESSION_SECRET ?? (production ? '' : 'dev-only-session-secret-change-me');
  if (!sessionSecret || (production && sessionSecret.length < 32)) throw new Error('SESSION_SECRET (32+ characters) is required in production.');
  const demoSignIn = env.DEMO_SIGN_IN === '1';
  if (production && demoSignIn) throw new Error('DEMO_SIGN_IN cannot be enabled in production.');
  return {
    port: Number(env.PORT ?? 4000),
    sessionSecret,
    demoSignIn,
    secureCookies: env.APP_ENV !== undefined && env.APP_ENV !== 'development' && env.APP_ENV !== 'test',
  };
}
