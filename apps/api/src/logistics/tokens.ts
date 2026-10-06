/** Injection tokens for the logistics and support controllers (deliverables 15 and 17). */
export const LOGISTICS = Symbol('LOGISTICS');
export const SUPPORT = Symbol('SUPPORT');

/** The QR gate-pass key, shared by the API and the worker. Required in production. */
export function gatePassSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.GATE_PASS_SECRET ?? (env.APP_ENV === 'production' ? '' : 'dev-only-gate-pass-secret');
  if (!secret) throw new Error('GATE_PASS_SECRET is required in production.');
  return secret;
}
