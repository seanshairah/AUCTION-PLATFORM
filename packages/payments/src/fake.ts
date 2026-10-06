import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Currency } from '@abc/domain';
import { PAYMENT_METHODS, type PaymentMethod } from '@abc/rules';
import {
  GatewayDeclinedError,
  type Capability,
  type GatewayStatus,
  type InitiateRequest,
  type InitiateResult,
  type PaymentGateway,
  type StatementLine,
  type StatusResult,
  type VerifiedCallback,
} from './gateway';

/**
 * An in-memory gateway for tests and local development. It behaves like a mobile
 * money gateway: initiate prompts the payer, the payer approves or declines, and a
 * signed callback follows. Never registered in production.
 */
export class FakeGateway implements PaymentGateway {
  private n = 0;
  private readonly payments = new Map<string, { paymentId: string; amountMinor: bigint; currency: Currency; status: GatewayStatus }>();
  healthy = true;
  declineNext = false;
  /** Simulates a gateway that has lost track (status calls fail). */
  statusFails = false;

  constructor(
    readonly id: string,
    private readonly secret: string,
    private readonly caps: readonly Capability[] = FakeGateway.allMethods(),
  ) {}

  static allMethods(maxMinor = 100_000_000n): Capability[] {
    return (['USD', 'ZWG'] as Currency[]).flatMap((currency) =>
      PAYMENT_METHODS.map((method: PaymentMethod) => ({ currency, method, minMinor: 100n, maxMinor })),
    );
  }

  capabilities(): readonly Capability[] {
    return this.caps;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async initiate(req: InitiateRequest): Promise<InitiateResult> {
    if (this.declineNext) {
      this.declineNext = false;
      throw new GatewayDeclinedError(this.id, 'service unavailable');
    }
    const ref = `${this.id}-${++this.n}`;
    this.payments.set(ref, { paymentId: req.paymentId, amountMinor: req.amountMinor, currency: req.currency, status: 'pending' });
    return { gatewayReference: ref, approval: req.method === 'card' ? 'redirect' : 'phone_prompt', instructions: 'Approve the payment on your phone.' };
  }

  async status(gatewayReference: string): Promise<StatusResult> {
    if (this.statusFails) throw new Error('gateway timeout');
    const p = this.payments.get(gatewayReference);
    if (!p) throw new Error(`Unknown reference ${gatewayReference}`);
    return { gatewayReference, status: p.status, amountMinor: p.amountMinor, currency: p.currency };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('hex');
  }

  /** The payer approves (or declines) on their phone; returns the callback the gateway would send. */
  payerResponds(gatewayReference: string, approve: boolean, overrideAmountMinor?: bigint): { headers: Record<string, string>; body: string } {
    const p = this.payments.get(gatewayReference);
    if (!p) throw new Error(`Unknown reference ${gatewayReference}`);
    p.status = approve ? 'paid' : 'cancelled';
    if (overrideAmountMinor !== undefined) p.amountMinor = overrideAmountMinor;
    const body = JSON.stringify({ reference: p.paymentId, gatewayReference, status: p.status });
    return { headers: { 'x-signature': this.sign(body) }, body };
  }

  verifyCallback(headers: Record<string, string>, rawBody: string): VerifiedCallback | null {
    const given = Buffer.from(headers['x-signature'] ?? '', 'hex');
    const expected = Buffer.from(this.sign(rawBody), 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const b = JSON.parse(rawBody) as { reference: string; gatewayReference: string; status: GatewayStatus };
    return { merchantReference: b.reference, gatewayReference: b.gatewayReference, status: b.status };
  }

  async statement(_date: string, currency: Currency): Promise<StatementLine[]> {
    return [...this.payments.entries()]
      .filter(([, p]) => p.status === 'paid' && p.currency === currency)
      .map(([ref, p]) => ({ gatewayReference: ref, amountMinor: p.amountMinor, currency }));
  }

  /** Test helper: a payment the gateway took that the System never recorded. */
  injectUnknownPaid(currency: Currency, amountMinor: bigint): string {
    const ref = `${this.id}-${++this.n}`;
    this.payments.set(ref, { paymentId: 'unknown', amountMinor, currency, status: 'paid' });
    return ref;
  }
}
