import type { Provider } from '@nestjs/common';
import type { Db, RulebookStore } from '@abc/db';
import { OtpController } from '../auth/otp.controller';
import { MeCommsController } from './me.controller';
import { buildCommsRuntime, COMMS } from './runtime';
import { WebhooksController } from './webhooks.controller';

/** Communications and one-time-code sign-in, as appended to the API module in app.ts. */
export const COMMS_CONTROLLERS = [OtpController, MeCommsController, WebhooksController];

export function commsProviders(db: Db, rulebook: RulebookStore, env: NodeJS.ProcessEnv = process.env): Provider[] {
  return [{ provide: COMMS, useValue: buildCommsRuntime(db, rulebook, env) }];
}

export { COMMS, type CommsRuntime } from './runtime';
