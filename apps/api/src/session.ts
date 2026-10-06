import { createHmac, timingSafeEqual } from 'node:crypto';
import { createParamDecorator, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Session tokens: `<accountId>.<expiresAtEpochSeconds>.<hmac>`, carried in an
 * HttpOnly cookie. Only the server can mint one.
 *
 * Sign-in itself (email and phone OTP, then KYC for full verification) belongs to
 * the identity module and is not built yet. Until it is, development and staging
 * can enable DEMO_SIGN_IN to pick one of the demo bidders (assumption A42). The
 * session format and every check downstream are the ones real sign-in will use.
 */

export const SESSION_COOKIE = 'abc_session';
const DEFAULT_TTL_SECONDS = 12 * 3600;

export interface SessionAccount {
  id: string;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function mintSession(accountId: string, secret: string, now = Date.now(), ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const payload = `${accountId}.${Math.floor(now / 1000) + ttlSeconds}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string | undefined, secret: string, now = Date.now()): SessionAccount | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [accountId, exp, mac] = parts as [string, string, string];
  const expected = Buffer.from(sign(`${accountId}.${exp}`, secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
  if (!/^[0-9a-f-]{36}$/.test(accountId)) return null;
  return { id: accountId };
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export type RequestWithAccount = Request & { account?: SessionAccount | null };

/** The signed-in account, or null. */
export const OptionalAccount = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<RequestWithAccount>().account ?? null;
});

/** The signed-in account; 401 when there is none. */
export const CurrentAccount = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const account = ctx.switchToHttp().getRequest<RequestWithAccount>().account;
  if (!account) throw new UnauthorizedException({ code: 'sign_in_required', message: 'Sign in to continue.' });
  return account;
});
