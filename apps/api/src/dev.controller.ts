import { Controller, ForbiddenException, Get, Inject, Query } from '@nestjs/common';
import { COMMS, type CommsRuntime } from './comms/runtime';
import { CONFIG, type ApiConfig } from './tokens';

/**
 * Development and demo only (A42): the messages the fake channels would have sent to a
 * phone number or email address, so sign-in by code can be tried without a real phone.
 * Refused whenever demo sign-in is off, and production never registers fake channels.
 */
@Controller('dev')
export class DevController {
  constructor(
    @Inject(COMMS) private readonly comms: CommsRuntime,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('inbox')
  inbox(@Query('to') to = '') {
    if (!this.config.demoSignIn) throw new ForbiddenException({ code: 'not_available', message: 'Not available here.' });
    const wanted = to.trim().toLowerCase();
    const digits = wanted.replace(/\D/g, '');
    const matches = (dest: string | null) => !!dest && (dest.toLowerCase() === wanted || (digits.length >= 9 && dest.replace(/\D/g, '').endsWith(digits.slice(-9))));
    return Object.entries(this.comms.fakes)
      .flatMap(([channel, fake]) => (fake?.sent ?? []).filter((s) => matches(s.to)).map((s) => ({ channel, to: s.to, template: s.templateKey, subject: s.subject ?? null, text: s.text })))
      .slice(-5)
      .reverse();
  }
}
