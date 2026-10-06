import type { Actor, Client, Db, RulebookStore } from '@abc/db';
import { OtpCodeSource } from '@abc/identity';
import { PREFERENCE_CHANNELS, type RuleSnapshot } from '@abc/rules';
import { ChannelError, type ChannelRegistry, type DeliveryStatus, type Recipient, type TemplateCatalogue } from './channel';
import { DEFAULT_LOCALE, templateDefinition, type Channel, type TemplateDefinition } from './library';
import { effectivePreferences, fallbackAfterSeconds, fallbackOrder, sendAfter, wantsEmailRecord, type PreferenceChannel, type PreferenceMatrix } from './policy';
import { MessageTooLongError, MissingParamError } from './render';
import { HANDLED_TOPICS, PLANNERS, type OutboxEvent, type Plan } from './topics';

/**
 * The dispatcher (docs/16 §4–5). One run:
 *   1. claims outbox events it knows (FOR UPDATE SKIP LOCKED), turns each into
 *      comms.message rows (one per person and channel, R4) and marks it dispatched,
 *      in one transaction;
 *   2. queues the next channel for messages that were sent but not delivered in time;
 *   3. sends due messages outside any transaction (docs/01 §6.1), recording each
 *      outcome afterwards; a failure moves to the next channel in the rulebook's order.
 * Any number of dispatchers can run at once: claims skip rows another one holds.
 */

const COMMS: Actor = { type: 'system', id: 'comms', name: 'Communications' };

export interface DispatcherOptions {
  /** Base of links in messages, e.g. https://www.abcauctions.co.zw (PUBLIC_WEB_URL). */
  webBaseUrl: string;
  /** Same OTP_SECRET as the identity service: sign-in codes are derived at send time. */
  otpSecret: string;
  batchSize?: number;
  log?: (line: string) => void;
}

export interface DispatchReport {
  events: number;
  eventErrors: number;
  queued: number;
  sent: number;
  retried: number;
  failed: number;
  suppressed: number;
  fallbacks: number;
}

interface MessageRow {
  id: string;
  message_key: string;
  recipient_account_id: string | null;
  recipient_address: string | null;
  channel: Channel;
  template_key: string;
  template_version: number;
  locale: string;
  params: Record<string, string>;
  status: string;
  attempts: number;
  expires_at: Date | null;
}

interface Who {
  id: string;
  status: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  consent: Partial<Record<string, boolean>>;
  prefs: PreferenceMatrix;
}

type Usable = { ok: true } | { ok: false; reason: 'no_provider' | 'no_address' | 'no_consent' | 'preference_off' | 'not_offered' };

const isEmail = (a: string) => a.includes('@');

export class Dispatcher {
  private readonly otpCodes: OtpCodeSource;
  private readonly batch: number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    private readonly channels: ChannelRegistry,
    private readonly templates: TemplateCatalogue,
    private readonly options: DispatcherOptions,
  ) {
    this.otpCodes = new OtpCodeSource(options.otpSecret);
    this.batch = options.batchSize ?? 100;
    this.log = options.log ?? (() => undefined);
  }

  private async rules(now: Date): Promise<RuleSnapshot> {
    return this.rulebook.snapshot(await this.rulebook.activeVersionId(now));
  }

  /** One full pass. Safe to call as often as wanted, from as many processes as wanted. */
  async run(now: Date = new Date()): Promise<DispatchReport> {
    const report: DispatchReport = { events: 0, eventErrors: 0, queued: 0, sent: 0, retried: 0, failed: 0, suppressed: 0, fallbacks: 0 };
    await this.templates.refresh(this.db, 60_000);
    const rules = await this.rules(now);
    await this.planPending(rules, now, report);
    await this.queueTimedOutFallbacks(rules, now, report);
    for (let round = 0; round < 5; round++) {
      if ((await this.sendDue(rules, now, report)) === 0) break;
    }
    return report;
  }

  // --- 1. Outbox → messages -------------------------------------------------------------

  private async planPending(rules: RuleSnapshot, now: Date, report: DispatchReport): Promise<void> {
    const maxAttempts = rules.get('comms.retry').outboxAttempts;
    const timeZone = rules.get('comms.quiet_hours').timeZone;
    await this.db.tx(COMMS, async (c) => {
      const events = await c.query<OutboxEvent>(
        `SELECT id::text AS id, topic, aggregate_type, aggregate_id, payload FROM core.outbox
          WHERE dispatched_at IS NULL AND topic = ANY($1::text[]) AND attempts < $2
          ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [HANDLED_TOPICS, maxAttempts, this.batch],
      );
      for (const e of events.rows) {
        await c.query('SAVEPOINT outbox_event');
        try {
          const plans = await PLANNERS[e.topic]!(e, { c, rules, rulebook: this.rulebook, webBaseUrl: this.options.webBaseUrl, timeZone, now });
          for (const p of plans) report.queued += await this.enqueue(c, p, e.id, rules, now);
          await c.query('UPDATE core.outbox SET dispatched_at = $2, attempts = attempts + 1 WHERE id = $1', [e.id, now]);
          await c.query('RELEASE SAVEPOINT outbox_event');
          report.events++;
        } catch (err) {
          await c.query('ROLLBACK TO SAVEPOINT outbox_event');
          await c.query('UPDATE core.outbox SET attempts = attempts + 1 WHERE id = $1', [e.id]);
          report.eventErrors++;
          this.log(`outbox ${e.id} (${e.topic}) not dispatched: ${(err as Error).message}`);
        }
      }
    });
  }

  private async who(c: Client, accountId: string | null, rules: RuleSnapshot): Promise<Who | null> {
    if (!accountId) return null;
    const a = await c.query<{ id: string; status: string; display_name: string; phone_e164: string | null; phone_verified_at: Date | null; email: string | null; email_verified_at: Date | null }>(
      'SELECT id, status, display_name, phone_e164, phone_verified_at, email, email_verified_at FROM identity.account WHERE id = $1',
      [accountId],
    );
    const row = a.rows[0];
    if (!row) return null;
    const consent = await c.query<{ channel: string; granted: boolean }>('SELECT channel, granted FROM identity.contact_consent WHERE account_id = $1', [accountId]);
    const prefs = await c.query<{ category: string; channel: string; enabled: boolean }>('SELECT category, channel, enabled FROM comms.preference WHERE account_id = $1', [accountId]);
    return {
      id: row.id,
      status: row.status,
      displayName: row.display_name,
      phone: row.phone_verified_at ? row.phone_e164 : null,
      email: row.email_verified_at ? row.email : null,
      consent: Object.fromEntries(consent.rows.map((r) => [r.channel, r.granted])),
      prefs: effectivePreferences(rules, prefs.rows),
    };
  }

  /**
   * May this message use this channel? A provider must carry it, there must be an
   * address, and unless the message cannot be switched off (sign-in codes, chat
   * replies) the person must have consented to the channel and left it on.
   */
  private usable(channel: Channel, def: TemplateDefinition, address: string | null, who: Who | null): Usable {
    if (!def.channels.includes(channel)) return { ok: false, reason: 'not_offered' };
    if (!this.channels.has(channel)) return { ok: false, reason: 'no_provider' };
    const phone = address && !isEmail(address) ? address : (who?.phone ?? null);
    const email = address && isEmail(address) ? address : (who?.email ?? null);
    if ((channel === 'whatsapp' || channel === 'sms') && !phone) return { ok: false, reason: 'no_address' };
    if (channel === 'email' && !email) return { ok: false, reason: 'no_address' };
    if ((channel === 'push' || channel === 'in_app') && !who) return { ok: false, reason: 'no_address' };
    if (def.preference === null || channel === 'in_app') return { ok: true };
    if (!who || who.consent[channel] !== true) return { ok: false, reason: 'no_consent' };
    if ((PREFERENCE_CHANNELS as readonly string[]).includes(channel) && !who.prefs[def.preference][channel as PreferenceChannel]) {
      return { ok: false, reason: 'preference_off' };
    }
    return { ok: true };
  }

  private async insertMessage(
    c: Client,
    p: { messageKey: string; accountId: string | null; address: string | null; channel: Channel; def: TemplateDefinition; params: Record<string, string>; expiresAt: Date | null; outboxId: string | null; fallbackOf: string | null },
    rules: RuleSnapshot,
    now: Date,
    suppressedReason?: string,
  ): Promise<number> {
    const next = sendAfter(now, p.channel, p.def, rules.get('comms.quiet_hours'), p.expiresAt);
    const r = await c.query(
      `INSERT INTO comms.message (message_key, recipient_account_id, recipient_address, channel, template_key, template_version, locale, params,
                                  status, failure_reason, outbox_id, fallback_of, next_attempt_at, expires_at, queued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT DO NOTHING`,
      [p.messageKey, p.accountId, p.address, p.channel, p.def.key, p.def.version, DEFAULT_LOCALE, JSON.stringify(p.params),
       suppressedReason ? 'suppressed' : 'queued', suppressedReason ?? null, p.outboxId, p.fallbackOf, next, p.expiresAt, now],
    );
    return r.rowCount ?? 0;
  }

  private async enqueue(c: Client, plan: Plan, outboxId: string, rules: RuleSnapshot, now: Date): Promise<number> {
    const def = templateDefinition(plan.templateKey);
    const who = await this.who(c, plan.accountId, rules);
    if (plan.accountId && (!who || who.status === 'closed')) return 0;
    const destination = plan.address ? (isEmail(plan.address) ? 'email' : 'phone') : undefined;
    const order = fallbackOrder(def, rules, destination);
    const base = { messageKey: plan.messageKey, accountId: plan.accountId, address: plan.address, def, params: plan.params, expiresAt: plan.expiresAt, outboxId, fallbackOf: null };

    const first = order.find((ch) => this.usable(ch, def, plan.address, who).ok);
    let n = 0;
    if (first) n += await this.insertMessage(c, { ...base, channel: first }, rules, now);
    // The in-app feed always gets a copy; transactional messages also get an email for the record.
    const records: Channel[] = [];
    if (who && def.preference !== null && this.usable('in_app', def, null, who).ok) records.push('in_app');
    if (wantsEmailRecord(def) && first !== 'email' && this.usable('email', def, plan.address, who).ok) records.push('email');
    for (const ch of records) n += await this.insertMessage(c, { ...base, channel: ch }, rules, now);

    if (!first && records.length === 0) {
      // Nobody can be reached: keep a suppressed row saying why, so "were they told?" has an answer.
      const channel = order[0] ?? def.channels[0]!;
      const why = this.usable(channel, def, plan.address, who);
      n += await this.insertMessage(c, { ...base, channel }, rules, now, why.ok ? 'no_channel' : why.reason);
    }
    return n;
  }

  // --- 2. Fallbacks -------------------------------------------------------------------------

  private orderFor(def: TemplateDefinition, rules: RuleSnapshot, m: Pick<MessageRow, 'recipient_address'>): Channel[] {
    const destination = m.recipient_address ? (isEmail(m.recipient_address) ? 'email' : 'phone') : undefined;
    return fallbackOrder(def, rules, destination);
  }

  /** Queues the same message on the next usable channel after this one, linked by fallback_of. */
  private async queueFallback(c: Client, m: MessageRow, rules: RuleSnapshot, now: Date): Promise<number> {
    const def = templateDefinition(m.template_key);
    const order = this.orderFor(def, rules, m);
    const at = order.indexOf(m.channel);
    if (at < 0) return 0;
    const used = new Set(
      (await c.query<{ channel: Channel }>(
        `SELECT channel FROM comms.message WHERE message_key = $1 AND recipient_account_id IS NOT DISTINCT FROM $2::uuid AND recipient_address IS NOT DISTINCT FROM $3::text`,
        [m.message_key, m.recipient_account_id, m.recipient_address],
      )).rows.map((r) => r.channel),
    );
    const who = await this.who(c, m.recipient_account_id, rules);
    for (const ch of order.slice(at + 1)) {
      if (used.has(ch) || !this.usable(ch, def, m.recipient_address, who).ok) continue;
      return this.insertMessage(
        c,
        { messageKey: m.message_key, accountId: m.recipient_account_id, address: m.recipient_address, channel: ch, def, params: m.params, expiresAt: m.expires_at, outboxId: null, fallbackOf: m.id },
        rules,
        now,
      );
    }
    return 0;
  }

  private async queueTimedOutFallbacks(rules: RuleSnapshot, now: Date, report: DispatchReport): Promise<void> {
    await this.db.tx(COMMS, async (c) => {
      const due = await c.query<MessageRow>(
        `SELECT * FROM comms.message WHERE status = 'sent' AND fallback_due_at <= $1 ORDER BY fallback_due_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, this.batch],
      );
      for (const m of due.rows) {
        report.fallbacks += await this.queueFallback(c, m, rules, now);
        await c.query('UPDATE comms.message SET fallback_due_at = NULL WHERE id = $1', [m.id]);
      }
    });
  }

  // --- 3. Sending ---------------------------------------------------------------------------

  private async sendDue(rules: RuleSnapshot, now: Date, report: DispatchReport): Promise<number> {
    const lease = new Date(now.getTime() + rules.get('comms.retry').leaseSeconds * 1000);
    // Claim with a lease: another dispatcher skips these rows until the lease runs out.
    const claimed = await this.db.tx(COMMS, (c) =>
      c.query<MessageRow>(
        `UPDATE comms.message SET next_attempt_at = $2, attempts = attempts + 1
          WHERE id IN (SELECT id FROM comms.message WHERE status = 'queued' AND next_attempt_at <= $1
                        ORDER BY next_attempt_at, queued_at LIMIT $3 FOR UPDATE SKIP LOCKED)
          RETURNING id, message_key, recipient_account_id, recipient_address, channel, template_key, template_version, locale, params, status, attempts, expires_at`,
        [now, lease, this.batch],
      ),
    );
    for (const m of claimed.rows) await this.sendOne(m, rules, now, report);
    return claimed.rowCount ?? 0;
  }

  private async finish(m: MessageRow, sql: string, params: unknown[], fallback: boolean, rules: RuleSnapshot, now: Date, report: DispatchReport): Promise<void> {
    await this.db.tx(COMMS, async (c) => {
      const r = await c.query(sql, [m.id, ...params]);
      if (r.rowCount && fallback) report.fallbacks += await this.queueFallback(c, m, rules, now);
    });
  }

  private async recipient(m: MessageRow): Promise<Recipient> {
    let phone: string | null = null;
    let email: string | null = null;
    let displayName: string | null = null;
    if (m.recipient_account_id) {
      const a = await this.db.query<{ display_name: string; phone_e164: string | null; phone_verified_at: Date | null; email: string | null; email_verified_at: Date | null }>(
        'SELECT display_name, phone_e164, phone_verified_at, email, email_verified_at FROM identity.account WHERE id = $1',
        [m.recipient_account_id],
      );
      const r = a.rows[0];
      if (r) {
        displayName = r.display_name;
        phone = r.phone_verified_at ? r.phone_e164 : null;
        email = r.email_verified_at ? r.email : null;
      }
    }
    if (m.recipient_address) {
      if (isEmail(m.recipient_address)) email = m.recipient_address;
      else phone = m.recipient_address;
    }
    return { accountId: m.recipient_account_id, phoneE164: phone, email, displayName };
  }

  private async sendOne(m: MessageRow, rules: RuleSnapshot, now: Date, report: DispatchReport): Promise<void> {
    const suppress = async (reason: string) => {
      report.suppressed++;
      await this.finish(m, `UPDATE comms.message SET status = 'suppressed', failure_reason = $2 WHERE id = $1 AND status = 'queued'`, [reason], false, rules, now, report);
    };
    if (m.expires_at && m.expires_at <= now) return suppress('expired');
    const reg = this.channels.get(m.channel);
    const params = { ...m.params };
    if (m.template_key === 'otp_code') {
      const code = await this.otpCodes.codeFor(this.db, params.challengeId ?? '', now);
      if (!code) return suppress('code_no_longer_valid');
      params.code = code.code;
      params.minutes = String(code.minutes);
    }

    try {
      if (!reg) throw new ChannelError(`no provider for ${m.channel}`, true);
      const { providerMessageId } = await reg.adapter.send({
        messageId: m.id, recipient: await this.recipient(m), templateKey: m.template_key, templateVersion: m.template_version, locale: m.locale, params,
      });
      const def = templateDefinition(m.template_key);
      const order = this.orderFor(def, rules, m);
      const after = fallbackAfterSeconds(def, rules);
      const hasNext = order.indexOf(m.channel) >= 0 && order.indexOf(m.channel) < order.length - 1;
      const inApp = m.channel === 'in_app';
      report.sent++;
      await this.finish(
        m,
        `UPDATE comms.message SET status = $2, sent_at = $3, delivered_at = $4, provider = $5, provider_message_id = $6, fallback_due_at = $7
          WHERE id = $1 AND status = 'queued'`,
        [inApp ? 'delivered' : 'sent', now, inApp ? now : null, reg.provider, providerMessageId,
         !inApp && hasNext && after ? new Date(now.getTime() + after * 1000) : null],
        false, rules, now, report,
      );
    } catch (e) {
      const permanent = e instanceof ChannelError ? e.permanent : e instanceof MissingParamError || e instanceof MessageTooLongError;
      const retry = rules.get('comms.retry');
      if (!permanent && m.attempts < retry.sendAttempts) {
        const wait = retry.backoffSeconds[Math.min(m.attempts - 1, retry.backoffSeconds.length - 1)]!;
        report.retried++;
        await this.finish(m, `UPDATE comms.message SET next_attempt_at = $2 WHERE id = $1 AND status = 'queued'`, [new Date(now.getTime() + wait * 1000)], false, rules, now, report);
      } else {
        report.failed++;
        this.log(`message ${m.id} (${m.template_key}/${m.channel}) failed: ${(e as Error).message}`);
        await this.finish(m, `UPDATE comms.message SET status = 'failed', failure_reason = $2 WHERE id = $1 AND status = 'queued'`, [(e as Error).message.slice(0, 500)], true, rules, now, report);
      }
    }
  }

  // --- Delivery status ------------------------------------------------------------------------

  /**
   * Applies a provider's delivery report. Status only moves forward (a late "sent"
   * after "delivered" changes nothing); a failure queues the next channel.
   */
  async recordStatus(provider: string, s: DeliveryStatus, now: Date = new Date()): Promise<'updated' | 'ignored' | 'unknown'> {
    const rules = await this.rules(now);
    return this.db.tx({ type: 'gateway', id: provider, name: provider, reason: `delivery report: ${s.status}` }, async (c) => {
      const r = await c.query<MessageRow & { provider_message_id: string }>(
        'SELECT * FROM comms.message WHERE provider = $1 AND provider_message_id = $2 FOR UPDATE',
        [provider, s.providerMessageId],
      );
      const m = r.rows[0];
      if (!m) return 'unknown';
      const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };
      if (s.status === 'failed') {
        if (m.status !== 'sent') return 'ignored';
        await c.query(`UPDATE comms.message SET status = 'failed', failure_reason = $2, fallback_due_at = NULL WHERE id = $1`, [m.id, (s.failureReason ?? 'failed').slice(0, 500)]);
        await this.queueFallback(c, m, rules, now);
        return 'updated';
      }
      if (!(m.status in rank) || rank[s.status]! <= rank[m.status]!) return 'ignored';
      await c.query(
        `UPDATE comms.message
            SET status = $2, delivered_at = CASE WHEN $2 IN ('delivered', 'read') THEN coalesce(delivered_at, $3) ELSE delivered_at END,
                read_at = CASE WHEN $2 = 'read' THEN $3 ELSE read_at END, fallback_due_at = NULL
          WHERE id = $1`,
        [m.id, s.status, s.at],
      );
      return 'updated';
    });
  }
}
