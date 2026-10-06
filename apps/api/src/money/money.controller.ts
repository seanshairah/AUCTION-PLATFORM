import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { Db } from '@abc/db';
import type { Currency } from '@abc/domain';
import { FakeGateway, NoRouteError, type PaymentService } from '@abc/payments';
import type { SettlementService } from '@abc/settlement';
import { moneyJson, parseMinor } from '../http';
import { CurrentAccount, type SessionAccount } from '../session';
import { CONFIG, DB, FAKE_GATEWAYS, PAYMENTS, SETTLEMENT, type ApiConfig } from '../tokens';

const METHODS = ['ecocash', 'onemoney', 'innbucks', 'omari', 'zimswitch', 'card'] as const;
const TopUpBody = z.object({
  amountMinor: z.string(),
  currency: z.enum(['USD', 'ZWG']).default('USD'),
  method: z.enum(METHODS),
  phone: z.string().regex(/^\+?[0-9 ]{9,16}$/).optional(),
  clientKey: z.string().min(8).max(100),
});

/**
 * Money in and invoices out. Every external payment is a wallet top-up confirmed by
 * the gateway (docs/09); an invoice is then paid from the wallet in one tap (docs/11).
 */
@Controller()
export class MoneyController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENTS) private readonly payments: PaymentService,
    @Inject(SETTLEMENT) private readonly settlement: SettlementService,
    @Inject(FAKE_GATEWAYS) private readonly fakes: Map<string, FakeGateway>,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  private async name(id: string): Promise<string> {
    const r = await this.db.query<{ display_name: string; phone_e164: string | null }>('SELECT display_name, phone_e164 FROM identity.account WHERE id = $1', [id]);
    return r.rows[0]?.display_name ?? 'Account';
  }

  @Post('me/top-ups')
  async topUp(@Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = TopUpBody.safeParse(body ?? {});
    if (!b.success) throw new BadRequestException({ code: 'invalid_request', message: 'Check the amount, method and phone number.' });
    const amount = parseMinor(b.data.amountMinor);
    if (!amount || amount < 100n) throw new BadRequestException({ code: 'invalid_amount', message: 'Top up at least 1.00.' });
    try {
      const r = await this.payments.startTopUp(
        { type: 'account', id: account.id, name: await this.name(account.id), requestId: b.data.clientKey },
        { accountId: account.id, currency: b.data.currency as Currency, amountMinor: amount, method: b.data.method, clientKey: b.data.clientKey, ...(b.data.phone ? { payerPhone: b.data.phone.replace(/\s/g, '') } : {}) },
      );
      return { ...r, simulated: r.gateway !== null && this.fakes.has(r.gateway) };
    } catch (e) {
      if (e instanceof NoRouteError) return { paymentId: null, status: 'failed', gateway: null, message: 'Payments by this method are not available right now. Try another method or pay at a branch.', simulated: false };
      throw e;
    }
  }

  @Get('me/top-ups/:id')
  async topUpStatus(@Param('id') id: string, @CurrentAccount() account: SessionAccount) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException();
    const r = await this.db.query<{ status: string; currency: Currency; amount_minor: bigint; method: string; confirmed_at: Date | null; failure_reason: string | null }>(
      'SELECT status, currency, amount_minor, method, confirmed_at, failure_reason FROM payment.payment WHERE id = $1 AND account_id = $2',
      [id, account.id],
    );
    const p = r.rows[0];
    if (!p) throw new NotFoundException({ code: 'payment_not_found', message: 'Payment not found.' });
    return { status: p.status, amount: moneyJson(p.amount_minor, p.currency), method: p.method, confirmedAt: p.confirmed_at?.toISOString() ?? null };
  }

  /**
   * Development and demo only: plays the payer's phone for the in-memory gateway, so a
   * top-up can be approved end to end. The real flow is the payer approving on EcoCash.
   */
  @Post('dev/fake-gateway/payments/:id/approve')
  async simulateApproval(@Param('id') id: string, @Body() body: { approve?: boolean }, @CurrentAccount() account: SessionAccount) {
    if (!this.config.demoSignIn) throw new ForbiddenException({ code: 'not_available', message: 'Not available here.' });
    const r = await this.db.query<{ gateway: string; gateway_reference: string | null }>('SELECT gateway, gateway_reference FROM payment.payment WHERE id = $1 AND account_id = $2', [id, account.id]);
    const p = r.rows[0];
    const fake = p ? this.fakes.get(p.gateway) : undefined;
    if (!p?.gateway_reference || !fake) throw new NotFoundException({ code: 'payment_not_found', message: 'Payment not found.' });
    const cb = fake.payerResponds(p.gateway_reference, body?.approve !== false);
    return this.payments.handleCallback(p.gateway, cb.headers, cb.body);
  }

  /** Gateway callbacks: verified, recorded and confirmed by a status check before any credit. */
  @Post('webhooks/payments/:gateway')
  async callback(@Param('gateway') gateway: string, @Req() req: Request & { rawBody?: Buffer }) {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')]));
    const out = await this.payments.handleCallback(gateway, headers, req.rawBody?.toString('utf8') ?? '');
    return { ok: out.outcome !== 'rejected' };
  }

  /** One-tap payment of an invoice from the wallet; the deposit counts towards it. */
  @Post('me/invoices/:id/pay')
  async pay(@Param('id') id: string, @Body() body: { clientKey?: string }, @CurrentAccount() account: SessionAccount) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException();
    const clientKey = typeof body?.clientKey === 'string' && body.clientKey.length >= 8 ? body.clientKey : `pay-${id}`;
    const owner = await this.db.query<{ currency: Currency }>('SELECT currency FROM settlement.invoice WHERE id = $1 AND buyer_account_id = $2', [id, account.id]);
    if (!owner.rows[0]) throw new NotFoundException({ code: 'invoice_not_found', message: 'Invoice not found.' });
    const c = owner.rows[0].currency;
    const r = await this.settlement.payFromWallet({ type: 'account', id: account.id, name: await this.name(account.id), requestId: clientKey }, { invoiceId: id, accountId: account.id, clientKey });
    if (r.paid) return { paid: true, alreadyPaid: r.alreadyPaid, gatePassToken: r.gatePassToken, message: r.alreadyPaid ? 'This invoice is already paid.' : 'Paid. Your gate pass is ready.' };
    if (r.reason === 'insufficient_funds') {
      return { paid: false, reason: r.reason, shortfall: moneyJson(r.shortfallMinor, c), available: moneyJson(r.availableMinor, c), total: moneyJson(r.totalMinor, c), message: `Top up ${moneyJson(r.shortfallMinor, c).text} to pay this invoice.` };
    }
    return { paid: false, reason: r.reason, message: 'This invoice cannot be paid now.' };
  }
}
