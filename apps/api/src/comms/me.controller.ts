import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { PREFERENCE_CATEGORIES, PREFERENCE_CHANNELS } from '@abc/rules';
import { CurrentAccount, type SessionAccount } from '../session';
import { COMMS, type CommsRuntime } from './runtime';

/** The preference centre and the in-app notification feed (docs/16 §6, §8). */

const PreferencesBody = z.object({
  changes: z
    .array(z.object({ category: z.enum(PREFERENCE_CATEGORIES).exclude(['staff_tasks']), channel: z.enum(PREFERENCE_CHANNELS), enabled: z.boolean() }))
    .min(1)
    .max(40),
});

const FeedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().datetime({ offset: true }).optional(),
});

@Controller('me')
export class MeCommsController {
  constructor(@Inject(COMMS) private readonly comms: CommsRuntime) {}

  @Get('preferences')
  preferences(@CurrentAccount() account: SessionAccount) {
    return this.comms.preferences.get(account.id);
  }

  @Put('preferences')
  async updatePreferences(@Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const parsed = PreferencesBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException({ code: 'invalid_request', message: 'Send changes as a list of category, channel and on or off.' });
    const r = await this.comms.preferences.update({ type: 'account', id: account.id, name: 'Account holder', reason: 'preference centre' }, account.id, parsed.data.changes);
    if (!r.ok) {
      throw new BadRequestException({ code: r.reason, category: r.category, message: 'Messages about your bids, money and goods need at least one way to reach you.' });
    }
    return r.view;
  }

  @Get('notifications')
  async notifications(@Query() query: Record<string, string>, @CurrentAccount() account: SessionAccount) {
    const parsed = FeedQuery.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException({ code: 'invalid_request', message: 'Invalid request.' });
    const feed = await this.comms.feed.list(account.id, {
      ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.before ? { before: new Date(parsed.data.before) } : {}),
    });
    return { unread: feed.unread, items: feed.items.map((i) => ({ ...i, at: i.at.toISOString() })) };
  }

  @Post('notifications/:id/read')
  async markRead(@Param('id') id: string, @CurrentAccount() account: SessionAccount) {
    const ok = await this.comms.feed.markRead({ type: 'account', id: account.id, name: 'Account holder' }, account.id, id);
    if (!ok) throw new NotFoundException({ code: 'not_found', message: 'We could not find that notification.' });
    return { ok: true };
  }
}
