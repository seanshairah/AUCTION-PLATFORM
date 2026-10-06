import type { Currency } from '@abc/domain';
import type { PaymentMethod, PaymentRouting } from '@abc/rules';

/**
 * The gateway abstraction (docs/09-payments.md §2). Bought rails (blueprint §9:
 * payment gateway = Buy) sit behind this interface so two gateways, two
 * currencies and every mobile-money method are designed in from day one.
 */

export type GatewayStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'reversed';

export interface Capability {
  currency: Currency;
  method: PaymentMethod;
  minMinor: bigint;
  maxMinor: bigint;
}

export interface InitiateRequest {
  /** Our payment id, sent as the merchant reference. */
  paymentId: string;
  currency: Currency;
  amountMinor: bigint;
  method: PaymentMethod;
  payerPhone?: string;
  payerEmail?: string;
}

export interface InitiateResult {
  gatewayReference: string;
  /** How the payer approves: a prompt on their phone, or a redirect (cards, 3-D Secure). */
  approval: 'phone_prompt' | 'redirect';
  redirectUrl?: string;
  instructions?: string;
}

export interface StatusResult {
  gatewayReference: string;
  status: GatewayStatus;
  amountMinor: bigint;
  currency: Currency;
}

export interface VerifiedCallback {
  merchantReference: string;
  gatewayReference: string;
  status: GatewayStatus;
}

export interface StatementLine {
  gatewayReference: string;
  amountMinor: bigint;
  currency: Currency;
}

/**
 * Thrown when a gateway refuses a payment before the payer has been prompted.
 * Only this error allows failover to the next gateway: once a payer may have
 * seen a prompt, trying another gateway risks charging them twice.
 */
export class GatewayDeclinedError extends Error {
  constructor(readonly gatewayId: string, reason: string) {
    super(`${gatewayId} declined: ${reason}`);
    this.name = 'GatewayDeclinedError';
  }
}

export interface PaymentGateway {
  readonly id: string;
  capabilities(): readonly Capability[];
  isHealthy(): boolean;
  initiate(req: InitiateRequest): Promise<InitiateResult>;
  /** Server-to-server status check. A callback is never trusted without one. */
  status(gatewayReference: string, currency: Currency): Promise<StatusResult>;
  /** Returns null when the signature does not verify. */
  verifyCallback(headers: Record<string, string>, rawBody: string): VerifiedCallback | null;
  statement?(date: string, currency: Currency): Promise<StatementLine[]>;
}

export class NoRouteError extends Error {
  constructor(currency: Currency, method: PaymentMethod) {
    super(`No gateway can take ${method} in ${currency}`);
    this.name = 'NoRouteError';
  }
}

/**
 * Picks gateways for a payment, in failover order: those the routing rule lists for
 * this currency and method, that are registered, healthy and accept the amount.
 */
export function route(
  req: { currency: Currency; method: PaymentMethod; amountMinor: bigint },
  routing: PaymentRouting,
  gateways: ReadonlyMap<string, PaymentGateway>,
): PaymentGateway[] {
  const ids = routing[req.currency][req.method] ?? [];
  const candidates = ids
    .map((id) => gateways.get(id))
    .filter((g): g is PaymentGateway => g !== undefined && g.isHealthy())
    .filter((g) =>
      g.capabilities().some((cap) => cap.currency === req.currency && cap.method === req.method && req.amountMinor >= cap.minMinor && req.amountMinor <= cap.maxMinor),
    );
  if (candidates.length === 0) throw new NoRouteError(req.currency, req.method);
  return candidates;
}

/** Methods to offer for a currency: listed in the routing rule with at least one gateway. */
export function methodsFor(currency: Currency, routing: PaymentRouting): PaymentMethod[] {
  return (Object.entries(routing[currency]) as Array<[PaymentMethod, string[] | undefined]>)
    .filter(([, ids]) => (ids?.length ?? 0) > 0)
    .map(([m]) => m);
}

/** Allowed payment status changes (docs/09 §4). */
const TRANSITIONS: Record<string, readonly string[]> = {
  initiated: ['pending', 'failed', 'cancelled', 'expired'],
  pending: ['succeeded', 'failed', 'cancelled', 'expired'],
  succeeded: ['reversed'],
  failed: [],
  cancelled: [],
  expired: ['succeeded'], // a late confirmed payment is still credited (found by poll or reconciliation)
  reversed: [],
};

export function canTransition(from: string, to: string): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}
