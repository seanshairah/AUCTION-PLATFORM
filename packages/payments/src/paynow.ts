import { createHash } from 'node:crypto';
import type { Currency } from '@abc/domain';
import type { PaymentMethod } from '@abc/rules';
import {
  GatewayDeclinedError,
  type Capability,
  type GatewayStatus,
  type InitiateRequest,
  type InitiateResult,
  type PaymentGateway,
  type StatusResult,
  type VerifiedCallback,
} from './gateway';

/**
 * Paynow adapter.
 *
 * UNVERIFIED (A32): written from Paynow's public integration documentation
 * (URL-encoded messages, an upper-case SHA-512 hash over the field values in order
 * followed by the integration key, "remote transaction" for mobile money and
 * "initiate transaction" for card redirects, a poll URL for status). It has not
 * been run against Paynow's sandbox from this repository. It must pass sandbox
 * tests, including both USD and ZiG integrations, before it is registered in
 * production. Field names, method codes and status strings are the points to verify.
 */

const BASE = 'https://www.paynow.co.zw/interface';

export interface PaynowConfig {
  /** One integration (id + key) per currency, as Paynow issues them. */
  integrations: Partial<Record<Currency, { id: string; key: string }>>;
  resultUrl: string;
  returnUrl: string;
  authEmail?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  capabilities?: readonly Capability[];
}

const MOBILE_METHOD: Partial<Record<PaymentMethod, string>> = {
  ecocash: 'ecocash',
  onemoney: 'onemoney',
  innbucks: 'innbucks',
  omari: 'omari',
};

export function paynowHash(fields: ReadonlyArray<[string, string]>, integrationKey: string): string {
  const values = fields.filter(([k]) => k.toLowerCase() !== 'hash').map(([, v]) => v).join('');
  return createHash('sha512').update(values + integrationKey, 'utf8').digest('hex').toUpperCase();
}

export function parseUrlEncoded(body: string): Array<[string, string]> {
  return [...new URLSearchParams(body).entries()];
}

function field(fields: ReadonlyArray<[string, string]>, name: string): string | undefined {
  return fields.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
}

function verifies(fields: ReadonlyArray<[string, string]>, key: string): boolean {
  const given = field(fields, 'hash');
  return given !== undefined && given.toUpperCase() === paynowHash(fields, key);
}

export function mapPaynowStatus(status: string): GatewayStatus {
  switch (status.toLowerCase()) {
    case 'paid':
    case 'awaiting delivery':
    case 'delivered':
      return 'paid';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'refunded':
    case 'disputed':
      return 'reversed';
    default:
      return 'pending'; // created, sent, and anything unknown: keep polling
  }
}

function decimal(minor: bigint): string {
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
}

function toMinor(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.');
  return BigInt(whole || '0') * 100n + BigInt((frac + '00').slice(0, 2));
}

export class PaynowGateway implements PaymentGateway {
  readonly id = 'paynow';
  private readonly http: typeof fetch;

  constructor(private readonly config: PaynowConfig) {
    this.http = config.fetch ?? fetch;
  }

  capabilities(): readonly Capability[] {
    return this.config.capabilities ?? [];
  }

  isHealthy(): boolean {
    return true;
  }

  private integration(currency: Currency) {
    const i = this.config.integrations[currency];
    if (!i) throw new GatewayDeclinedError(this.id, `no ${currency} integration configured`);
    return i;
  }

  async initiate(req: InitiateRequest): Promise<InitiateResult> {
    const integration = this.integration(req.currency);
    const mobile = MOBILE_METHOD[req.method];
    const fields: Array<[string, string]> = [
      ['id', integration.id],
      ['reference', req.paymentId],
      ['amount', decimal(req.amountMinor)],
      ['additionalinfo', 'ABC Auctions wallet top-up'],
      ['returnurl', this.config.returnUrl],
      ['resulturl', this.config.resultUrl],
      ['authemail', req.payerEmail ?? this.config.authEmail ?? ''],
      ...(mobile ? ([['phone', req.payerPhone ?? ''], ['method', mobile]] as Array<[string, string]>) : []),
      ['status', 'Message'],
    ];
    fields.push(['hash', paynowHash(fields, integration.key)]);
    const url = `${this.config.baseUrl ?? BASE}/${mobile ? 'remotetransaction' : 'initiatetransaction'}`;
    const res = await this.http(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
    const reply = parseUrlEncoded(await res.text());
    const status = field(reply, 'status') ?? '';
    if (status.toLowerCase() !== 'ok') throw new GatewayDeclinedError(this.id, field(reply, 'error') ?? `status ${status}`);
    if (!verifies(reply, integration.key)) throw new Error('Paynow reply failed hash verification');
    const pollUrl = field(reply, 'pollurl');
    if (!pollUrl) throw new Error('Paynow reply has no poll URL');
    const redirect = field(reply, 'browserurl');
    return {
      gatewayReference: pollUrl, // the poll URL identifies the transaction for status checks
      approval: mobile ? 'phone_prompt' : 'redirect',
      ...(redirect && !mobile ? { redirectUrl: redirect } : {}),
      ...(field(reply, 'instructions') ? { instructions: field(reply, 'instructions')! } : {}),
    };
  }

  async status(gatewayReference: string, currency: Currency): Promise<StatusResult> {
    const integration = this.integration(currency);
    const res = await this.http(gatewayReference, { method: 'POST' });
    const reply = parseUrlEncoded(await res.text());
    if (!verifies(reply, integration.key)) throw new Error('Paynow status failed hash verification');
    return {
      gatewayReference,
      status: mapPaynowStatus(field(reply, 'status') ?? ''),
      amountMinor: toMinor(field(reply, 'amount') ?? '0'),
      currency,
    };
  }

  verifyCallback(_headers: Record<string, string>, rawBody: string): VerifiedCallback | null {
    const fields = parseUrlEncoded(rawBody);
    const ok = Object.values(this.config.integrations).some((i) => i && verifies(fields, i.key));
    if (!ok) return null;
    const reference = field(fields, 'reference');
    const pollUrl = field(fields, 'pollurl');
    if (!reference || !pollUrl) return null;
    return { merchantReference: reference, gatewayReference: pollUrl, status: mapPaynowStatus(field(fields, 'status') ?? '') };
  }
}
