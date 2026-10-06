import { Controller, ForbiddenException, Get, Header, HttpCode, Inject, Post, Query, Req, UnauthorizedException, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { COMMS, type CommsRuntime } from './runtime';

/**
 * Provider webhooks (docs/16 §5, §10). Every body is checked against the provider's
 * signature over the exact bytes received before anything is read from it.
 * WhatsApp sends delivery statuses and inbound chat messages to the same URL.
 */

function headers(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') out[k] = v;
  return out;
}

function raw(req: RawBodyRequest<Request>): Buffer {
  return req.rawBody ?? Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
}

@Controller('webhooks')
export class WebhooksController {
  constructor(@Inject(COMMS) private readonly comms: CommsRuntime) {}

  /** Meta's subscription handshake: echo hub.challenge when hub.verify_token is ours. */
  @Get('whatsapp')
  @Header('Content-Type', 'text/plain')
  handshake(@Query() query: Record<string, unknown>) {
    const challenge = this.comms.whatsappWebhook?.verifySubscription(query) ?? null;
    if (challenge === null) throw new ForbiddenException({ code: 'verify_token_mismatch', message: 'Verification failed.' });
    return challenge;
  }

  @Post('whatsapp')
  @HttpCode(200)
  async whatsapp(@Req() req: RawBodyRequest<Request>) {
    const parsed = this.comms.whatsappWebhook?.parseWebhook(headers(req), raw(req)) ?? null;
    if (!parsed) throw new UnauthorizedException({ code: 'bad_signature', message: 'Signature check failed.' });
    let statuses = 0;
    for (const s of parsed.statuses) if ((await this.comms.dispatcher.recordStatus('whatsapp', s)) === 'updated') statuses++;
    let inbound = 0;
    for (const m of parsed.inbound) if ((await this.comms.intake.handleInbound(m)) !== 'duplicate') inbound++;
    // Replies and fallbacks go out now, not at the worker's next tick.
    if (parsed.inbound.length || statuses) await this.comms.dispatcher.run().catch((e: unknown) => console.error('dispatch after webhook failed:', e instanceof Error ? e.message : e));
    return { ok: true, statuses, inbound };
  }

  @Post('sms-status')
  @HttpCode(200)
  async smsStatus(@Req() req: RawBodyRequest<Request>) {
    const status = this.comms.smsWebhook?.parseStatusWebhook(headers(req), raw(req)) ?? null;
    if (!status) throw new UnauthorizedException({ code: 'bad_signature', message: 'Signature check failed.' });
    const result = await this.comms.dispatcher.recordStatus('sms', status);
    return { ok: true, result };
  }
}
