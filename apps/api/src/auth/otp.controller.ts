import { BadRequestException, Body, Controller, ForbiddenException, HttpException, HttpStatus, Inject, NotFoundException, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Db } from '@abc/db';
import { COMMS, type CommsRuntime } from '../comms/runtime';
import { mintSession, OptionalAccount, SESSION_COOKIE, type SessionAccount } from '../session';
import { CONFIG, DB, type ApiConfig } from '../tokens';

/**
 * Sign-in by one-time code (docs/16 §9). Start sends a code to a phone (WhatsApp,
 * then SMS) or an email address; verify checks it and sets the same session cookie
 * as every other sign-in (session.ts is unchanged). Signed in, `add_contact` adds
 * the second contact, which makes the account `partial`.
 */

const StartBody = z.object({
  contact: z.string().trim().min(3).max(254),
  purpose: z.enum(['sign_in', 'add_contact']).optional(),
});

const VerifyBody = z.object({
  challengeId: z.string().uuid(),
  code: z.string().trim().regex(/^\d{4,10}$/),
  displayName: z.string().trim().min(1).max(120).optional(),
  consent: z.object({ whatsapp: z.boolean(), sms: z.boolean(), email: z.boolean(), push: z.boolean() }).partial().optional(),
  device: z.object({ fingerprint: z.string().min(8).max(200), platform: z.enum(['android', 'ios', 'web', 'pwa']), label: z.string().max(80).optional() }).optional(),
});

const MESSAGES: Record<string, string> = {
  invalid_contact: 'Enter a mobile number or an email address.',
  not_a_mobile: 'Codes go to mobile numbers. Enter a mobile number or an email address.',
  contact_in_use: 'That number or email address belongs to another account.',
  account_closed: 'This account is closed. Please contact ABC Auctions.',
  rate_limited: 'Too many codes requested. Please wait and try again.',
  resend_too_soon: 'Please wait a moment before asking for another code.',
  wrong_code: 'That code is not right. Check the message and try again.',
  details_required: 'Tell us your name and how we may contact you to create your account.',
  expired: 'That code has expired. Ask for a new one.',
  used: 'That code has already been used. Ask for a new one.',
  locked: 'Too many wrong tries. Ask for a new code.',
  not_yours: 'This code was sent for a different account.',
  not_found: 'We could not find that code. Ask for a new one.',
};

export function clientIp(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

@Controller('auth/otp')
export class OtpController {
  constructor(
    @Inject(COMMS) private readonly comms: CommsRuntime,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Sends the code now rather than at the worker's next tick. A send problem never fails the request. */
  private async sendNow(): Promise<void> {
    await this.comms.dispatcher.run().catch((e: unknown) => console.error('dispatch after OTP start failed:', e instanceof Error ? e.message : e));
  }

  @Post('start')
  async start(@Body() body: unknown, @Req() req: Request, @OptionalAccount() account: SessionAccount | null) {
    const parsed = StartBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException({ code: 'invalid_request', message: MESSAGES.invalid_contact });
    const purpose = parsed.data.purpose ?? 'sign_in';
    if (purpose === 'add_contact' && !account) throw new UnauthorizedException({ code: 'sign_in_required', message: 'Sign in to continue.' });
    const r = await this.comms.identity.startOtp({ contact: parsed.data.contact, ip: clientIp(req), purpose, ...(account ? { accountId: account.id } : {}) });
    if (!r.ok) {
      if (r.reason === 'rate_limited' || r.reason === 'resend_too_soon') {
        throw new HttpException({ code: r.reason, message: MESSAGES[r.reason], retryAfterSeconds: r.retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
      }
      if (r.reason === 'contact_in_use') throw new ForbiddenException({ code: r.reason, message: MESSAGES[r.reason] });
      throw new BadRequestException({ code: r.reason, message: MESSAGES[r.reason] });
    }
    await this.sendNow();
    return {
      challengeId: r.challengeId,
      sentTo: r.maskedDestination,
      via: r.destinationType === 'phone' ? 'whatsapp_or_sms' : 'email',
      expiresAt: r.expiresAt.toISOString(),
      resendAfter: r.resendAfter.toISOString(),
      resent: r.resent,
    };
  }

  @Post('verify')
  async verify(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response, @OptionalAccount() account: SessionAccount | null) {
    const parsed = VerifyBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException({ code: 'invalid_request', message: 'Enter the code from your message.' });
    const d = parsed.data;
    const r = await this.comms.identity.verifyOtp({
      challengeId: d.challengeId,
      code: d.code,
      ip: clientIp(req),
      ...(d.device ? { device: d.device } : {}),
      ...(d.displayName && d.consent ? { signUp: { displayName: d.displayName, consent: d.consent } } : {}),
      ...(account ? { accountId: account.id } : {}),
    });
    if (!r.ok) {
      const payload = { code: r.reason, message: MESSAGES[r.reason] ?? 'Sign-in failed.', ...(r.reason === 'wrong_code' ? { attemptsLeft: r.attemptsLeft } : {}) };
      if (r.reason === 'not_found') throw new NotFoundException(payload);
      if (r.reason === 'not_yours' || r.reason === 'contact_in_use' || r.reason === 'account_closed') throw new ForbiddenException(payload);
      throw new BadRequestException(payload);
    }
    res.cookie(SESSION_COOKIE, mintSession(r.accountId, this.config.sessionSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secureCookies,
      maxAge: 12 * 3600 * 1000,
      path: '/',
    });
    const name = await this.db.query<{ display_name: string }>('SELECT display_name FROM identity.account WHERE id = $1', [r.accountId]);
    return { id: r.accountId, name: name.rows[0]?.display_name ?? null, created: r.created, verificationLevel: r.verificationLevel, tier: r.tier, newDevice: r.newDevice };
  }
}
