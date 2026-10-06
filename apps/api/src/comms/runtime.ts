import type { Db, RulebookStore } from '@abc/db';
import {
  ChannelRegistry,
  Dispatcher,
  EmailChannel,
  EndingSoonAlerts,
  FakeChannel,
  HttpSmsChannel,
  InAppChannel,
  LogEmailTransport,
  NotificationFeed,
  PreferenceService,
  TemplateCatalogue,
  WhatsAppCloudChannel,
  WhatsAppIntake,
} from '@abc/comms';
import { IdentityService } from '@abc/identity';
import { SellerService } from '@abc/seller';

/**
 * Communications and sign-in, wired from the environment (docs/16 §11). Shared by
 * the API and the worker. Secrets come from the environment or the secrets
 * manager, never the repository.
 *
 * Outside production, channels without provider credentials are FAKES that send
 * nothing (the demo and tests read what they would have sent). In production a
 * channel without credentials is simply not registered, and the fallback order
 * skips it. The WhatsApp and SMS adapters are unverified (A43, A44).
 */

export const COMMS = Symbol('COMMS');

export interface CommsRuntime {
  templates: TemplateCatalogue;
  channels: ChannelRegistry;
  dispatcher: Dispatcher;
  identity: IdentityService;
  preferences: PreferenceService;
  feed: NotificationFeed;
  intake: WhatsAppIntake;
  endingSoon: EndingSoonAlerts;
  /** Verifies and parses WhatsApp webhooks (needs WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN). */
  whatsappWebhook: WhatsAppCloudChannel | null;
  /** Verifies and parses SMS delivery reports (needs SMS_STATUS_SECRET). */
  smsWebhook: HttpSmsChannel | null;
  /** The fake channels in use, by channel (development, demo and tests only). */
  fakes: Partial<Record<'whatsapp' | 'sms' | 'push' | 'email', FakeChannel>>;
  emailLog: LogEmailTransport | null;
}

function secret(env: NodeJS.ProcessEnv, name: string, devDefault: string): string {
  const v = env[name] ?? (env.APP_ENV === 'production' ? '' : devDefault);
  if (!v || (env.APP_ENV === 'production' && v.length < 32)) throw new Error(`${name} (32+ characters) is required in production.`);
  return v;
}

export function buildCommsRuntime(db: Db, rulebook: RulebookStore, env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (l) => console.log(l)): CommsRuntime {
  const production = env.APP_ENV === 'production';
  const otpSecret = secret(env, 'OTP_SECRET', 'dev-only-otp-secret-change-me-0123456789');
  const signalSecret = secret(env, 'LINK_SIGNAL_SECRET', 'dev-only-link-signal-secret-change-me-01');
  const templates = new TemplateCatalogue();
  const channels = new ChannelRegistry();
  const fakes: CommsRuntime['fakes'] = {};

  const wa = env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN
    ? new WhatsAppCloudChannel(templates, {
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
        accessToken: env.WHATSAPP_ACCESS_TOKEN ?? '',
        appSecret: env.WHATSAPP_APP_SECRET,
        verifyToken: env.WHATSAPP_VERIFY_TOKEN,
        ...(env.WHATSAPP_GRAPH_VERSION ? { graphVersion: env.WHATSAPP_GRAPH_VERSION } : {}),
      })
    : null;
  if (wa && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) channels.register('whatsapp', wa);
  else if (!production) channels.register('whatsapp', (fakes.whatsapp = new FakeChannel('whatsapp', templates)));

  const sms = env.SMS_STATUS_SECRET
    ? new HttpSmsChannel(templates, {
        url: env.SMS_HTTP_URL ?? '',
        from: env.SMS_SENDER_ID ?? 'ABCAuction',
        statusSecret: env.SMS_STATUS_SECRET,
        ...(env.SMS_HTTP_TOKEN ? { headers: { Authorization: `Bearer ${env.SMS_HTTP_TOKEN}` } } : {}),
      })
    : null;
  if (sms && env.SMS_HTTP_URL) channels.register('sms', sms);
  else if (!production) channels.register('sms', (fakes.sms = new FakeChannel('sms', templates)));

  // No push provider is chosen yet (A48): a fake outside production, nothing in production.
  if (!production) channels.register('push', (fakes.push = new FakeChannel('push', templates)));

  // Email: a provider transport plugs in here when one is chosen (A48). Until then the log
  // transport, which sends nothing: so in production only if explicitly asked for (EMAIL_TRANSPORT=log).
  const emailLog = !production || env.EMAIL_TRANSPORT === 'log' ? new LogEmailTransport(log, !production) : null;
  if (emailLog) channels.register('email', new EmailChannel(templates, emailLog, env.EMAIL_FROM ?? 'ABC Auctions <no-reply@localhost>'));
  channels.register('in_app', new InAppChannel(templates));

  const dispatcher = new Dispatcher(db, rulebook, channels, templates, {
    webBaseUrl: env.PUBLIC_WEB_URL ?? 'http://localhost:3000',
    otpSecret,
    log,
  });
  return {
    templates,
    channels,
    dispatcher,
    identity: new IdentityService(db, rulebook, { otpSecret, signalSecret }),
    preferences: new PreferenceService(db, rulebook),
    feed: new NotificationFeed(db, templates),
    intake: new WhatsAppIntake(db, rulebook, new SellerService(db, rulebook), { branch: env.WHATSAPP_INTAKE_BRANCH ?? 'HRE', provider: 'whatsapp' }),
    endingSoon: new EndingSoonAlerts(db, rulebook),
    whatsappWebhook: wa,
    smsWebhook: sms,
    fakes,
    emailLog,
  };
}
