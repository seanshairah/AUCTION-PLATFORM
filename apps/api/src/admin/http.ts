import { BadRequestException, Catch, ConflictException, ForbiddenException, HttpException, NotFoundException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminError } from '@abc/admin';
import { AnalyticsError } from '@abc/analytics';
import { isCurrency, type Currency } from '@abc/domain';
import { moneyJson } from '../http';

/** Parses a request part with zod; a bad request is a 400 with a readable message. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new BadRequestException({ code: 'invalid_request', message: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  return r.data;
}

export const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be a reference');

/** Turns the services' plain-language errors into HTTP answers. */
@Catch(AdminError, AnalyticsError)
export class StaffErrorFilter implements ExceptionFilter {
  catch(e: AdminError | AnalyticsError, host: ArgumentsHost): void {
    const body = { code: e.code, message: e.message, ...(e instanceof AdminError && e.details ? { details: e.details } : {}) };
    const http: HttpException =
      e.code === 'forbidden' ? new ForbiddenException(body)
      : e.code === 'not_found' ? new NotFoundException(body)
      : e.code === 'conflict' ? new ConflictException(body)
      : new BadRequestException(body);
    host.switchToHttp().getResponse<Response>().status(http.getStatus()).json(http.getResponse());
  }
}

/**
 * Wire format for staff screens. Every `<name>Minor` amount next to (or under) a
 * currency becomes `<name>: { minor, currency, text }` (../http.ts), so no screen
 * formats money; dates become ISO strings. Currencies are never mixed: an amount
 * takes the currency of the nearest object that has one.
 */
export function present(value: unknown, currency?: Currency): unknown {
  if (Array.isArray(value)) return value.map((v) => present(v, currency));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const cur = isCurrency(obj.currency) ? obj.currency : currency;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.endsWith('Minor') && k.length > 5 && (typeof v === 'bigint' || v === null)) {
        const name = k.slice(0, -5);
        out[name] = v === null ? null : cur ? moneyJson(v, cur) : v.toString();
      } else {
        out[k] = present(v, cur);
      }
    }
    return out;
  }
  return value;
}
