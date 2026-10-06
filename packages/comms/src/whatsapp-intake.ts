import type { Currency } from '@abc/domain';
import type { Actor, Client, Db, RulebookStore } from '@abc/db';
import { handleIntakeMessage, startIntake, type IntakeOptions, type IntakeState, type SellerService } from '@abc/seller';
import type { InboundWhatsApp } from './adapters/whatsapp';

/**
 * WhatsApp transport for seller intake (docs/16 §10). packages/seller decides the
 * conversation (a pure state machine); this carries it: each inbound WhatsApp
 * message is handled once (comms.inbound_message), the conversation state lives in
 * comms.conversation between messages, and every reply goes out through the
 * outbox and the dispatcher like any other message (template chat_reply).
 *
 * A conversation starts when a person whose verified phone is this number sends
 * SELL (A49). When the seller confirms, the transport creates a WhatsApp
 * consignment with one draft lot through SellerService, and the seller hears
 * "consignment received". Intake staff complete the lot; nothing goes live from chat.
 */

export interface IntakeTransportOptions {
  /** Branch for WhatsApp consignments until the seller or staff choose another (A49). */
  branch: string;
  provider?: string;
}

const ACTOR: Actor = { type: 'system', id: 'whatsapp-intake', name: 'WhatsApp intake' };

export const INTAKE_MESSAGES = {
  help: 'Hello from ABC Auctions. To sell an item with us, reply SELL. For bids, invoices and payments, please use the ABC Auctions app.',
  signInFirst: 'To sell by WhatsApp, first sign in to the ABC Auctions app with this phone number, then reply SELL.',
  busy: 'We are saving your item. You will get a message in a moment.',
} as const;

/** State as stored: the draft's reserve is a bigint, kept as a string in JSON. */
interface StoredState {
  step: IntakeState['step'];
  draft: Omit<IntakeState['draft'], 'reserve'> & { reserve?: { currency: Currency; minor: string } | null };
  pendingReply?: string;
  inReplyTo?: string;
}

function toStored(s: IntakeState, extra: Pick<StoredState, 'pendingReply' | 'inReplyTo'> = {}): StoredState {
  const { reserve, ...rest } = s.draft;
  return {
    step: s.step,
    draft: { ...rest, ...(reserve === undefined ? {} : { reserve: reserve === null ? null : { currency: reserve.currency, minor: reserve.minor.toString() } }) },
    ...extra,
  };
}

function fromStored(s: StoredState): IntakeState {
  const { reserve, ...rest } = s.draft;
  return {
    step: s.step,
    draft: { ...rest, ...(reserve === undefined ? {} : { reserve: reserve === null ? null : { currency: reserve.currency, minor: BigInt(reserve.minor) } }) },
  };
}

interface ConversationRow {
  id: string;
  account_id: string;
  step: string;
  state: StoredState;
  consignment_id: string | null;
  lot_id: string | null;
}

export type InboundResult = 'duplicate' | 'replied' | 'submitted';

export class WhatsAppIntake {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    private readonly sellers: SellerService,
    private readonly options: IntakeTransportOptions,
  ) {}

  private get provider(): string {
    return this.options.provider ?? 'whatsapp';
  }

  private async intakeOptions(c: Client, now: Date): Promise<IntakeOptions> {
    const snapshot = await this.rulebook.snapshot(await this.rulebook.activeVersionId(now, c), c);
    const categories = await c.query<{ code: string; name: string }>('SELECT code, name FROM catalogue.category WHERE parent_code IS NULL ORDER BY is_vehicle DESC, name');
    const conditions = await c.query<{ code: string; label: string }>('SELECT code, label FROM catalogue.condition_term ORDER BY sort');
    return { categories: categories.rows, conditions: conditions.rows, snapshot };
  }

  private async reply(c: Client, to: string, accountId: string | null, text: string, inReplyTo: string): Promise<void> {
    await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('chat.reply', 'inbound_message', $1, $2::jsonb)`, [
      inReplyTo, JSON.stringify({ address: to, accountId, text, inReplyTo }),
    ]);
  }

  /** Handles one inbound WhatsApp message. Provider retries of the same message are ignored. */
  async handleInbound(msg: InboundWhatsApp, now: Date = new Date()): Promise<InboundResult> {
    const outcome = await this.db.tx(ACTOR, async (c): Promise<{ result: InboundResult; submit?: string }> => {
      const fresh = await c.query(
        `INSERT INTO comms.inbound_message (provider, provider_message_id, from_address, kind, received_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [this.provider, msg.providerMessageId, msg.from, msg.kind, now],
      );
      if (!fresh.rowCount) return { result: 'duplicate' };

      const text = (msg.text ?? '').trim();
      const account = (await c.query<{ id: string }>(
        `SELECT id FROM identity.account WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL AND status = 'active'`, [msg.from],
      )).rows[0] ?? null;
      const conv = (await c.query<ConversationRow>(
        `SELECT id, account_id, step, state, consignment_id, lot_id FROM comms.conversation WHERE channel = 'whatsapp' AND address = $1 AND ended_at IS NULL FOR UPDATE`,
        [msg.from],
      )).rows[0];

      if (!conv) {
        if (!/^sell$/i.test(text)) {
          await this.reply(c, msg.from, account?.id ?? null, INTAKE_MESSAGES.help, msg.providerMessageId);
          return { result: 'replied' };
        }
        if (!account) {
          await this.reply(c, msg.from, null, INTAKE_MESSAGES.signInFirst, msg.providerMessageId);
          return { result: 'replied' };
        }
        const start = startIntake(await this.intakeOptions(c, now));
        await c.query(
          `INSERT INTO comms.conversation (channel, address, account_id, flow, step, state, started_at, updated_at) VALUES ('whatsapp', $1, $2, 'seller_intake', $3, $4::jsonb, $5, $5)`,
          [msg.from, account.id, start.state.step, JSON.stringify(toStored(start.state)), now],
        );
        await this.reply(c, msg.from, account.id, start.reply, msg.providerMessageId);
        return { result: 'replied' };
      }

      if (conv.step === 'submitting') {
        await this.reply(c, msg.from, conv.account_id, INTAKE_MESSAGES.busy, msg.providerMessageId);
        return { result: 'replied' };
      }
      const next = handleIntakeMessage(fromStored(conv.state), { text, ...(msg.imageIds ? { imageIds: msg.imageIds } : {}) }, await this.intakeOptions(c, now));
      if (next.state.step === 'done') {
        // Saved in two steps (consignment, then lot) through the seller service; the reply waits until both exist.
        await c.query(`UPDATE comms.conversation SET step = 'submitting', state = $2::jsonb, updated_at = $3 WHERE id = $1`, [
          conv.id, JSON.stringify(toStored(next.state, { pendingReply: next.reply, inReplyTo: msg.providerMessageId })), now,
        ]);
        return { result: 'submitted', submit: conv.id };
      }
      await c.query(`UPDATE comms.conversation SET step = $2, state = $3::jsonb, updated_at = $4, ended_at = $5 WHERE id = $1`, [
        conv.id, next.state.step, JSON.stringify(toStored(next.state)), now, next.state.step === 'cancelled' ? now : null,
      ]);
      await this.reply(c, msg.from, conv.account_id, next.reply, msg.providerMessageId);
      return { result: 'replied' };
    });
    if (outcome.submit) await this.submit(outcome.submit, now);
    return outcome.result;
  }

  /** Creates the consignment and draft lot for a confirmed conversation. Safe to repeat after a crash. */
  async submit(conversationId: string, now: Date = new Date()): Promise<void> {
    const r = await this.db.query<ConversationRow & { address: string; display_name: string }>(
      `SELECT c.id, c.account_id, c.step, c.state, c.consignment_id, c.lot_id, c.address, a.display_name
         FROM comms.conversation c JOIN identity.account a ON a.id = c.account_id WHERE c.id = $1`,
      [conversationId],
    );
    const conv = r.rows[0];
    if (!conv || conv.step !== 'submitting') return;
    const seller: Actor = { type: 'account', id: conv.account_id, name: conv.display_name, reason: 'consigned by WhatsApp' };
    const draft = fromStored(conv.state).draft;
    const externalRef = `whatsapp:${conv.id}`;

    let consignmentId = conv.consignment_id;
    if (!consignmentId) {
      consignmentId = await this.sellers.createConsignment(seller, { sellerId: conv.account_id, type: 'commission', channel: 'whatsapp', branch: this.options.branch });
      await this.db.tx(ACTOR, (c) => c.query('UPDATE comms.conversation SET consignment_id = $2, updated_at = $3 WHERE id = $1', [conv.id, consignmentId, now]));
    }
    let lot = (await this.db.query<{ id: string; lot_ref: string }>('SELECT id, lot_ref FROM catalogue.lot WHERE seller_account_id = $1 AND external_ref = $2', [conv.account_id, externalRef])).rows[0];
    if (!lot) {
      const photos = draft.photoIds.length;
      const lotId = await this.sellers.addLot(seller, consignmentId, {
        externalRef,
        title: draft.title!,
        description: `${draft.title}. Sent by WhatsApp with ${photos} photo${photos === 1 ? '' : 's'}; intake staff to check and complete the description.`,
        category: draft.category!,
        itemState: 'used',
        condition: draft.condition!,
        currency: draft.reserve?.currency ?? 'USD',
        startingBidMinor: 0n,
        reserveMinor: draft.reserve?.minor ?? null,
        estimateLowMinor: null,
        estimateHighMinor: null,
        quantity: 1,
      });
      lot = (await this.db.query<{ id: string; lot_ref: string }>('SELECT id, lot_ref FROM catalogue.lot WHERE id = $1', [lotId])).rows[0]!;
    }
    await this.db.tx(ACTOR, async (c) => {
      const done = await c.query(
        `UPDATE comms.conversation SET step = 'done', lot_id = $2, ended_at = $3, updated_at = $3 WHERE id = $1 AND step = 'submitting'`,
        [conv.id, lot!.id, now],
      );
      if (!done.rowCount) return;
      await this.reply(c, conv.address, conv.account_id, conv.state.pendingReply ?? 'Thank you. Our intake team will be in touch.', conv.state.inReplyTo ?? conv.id);
      await c.query(`INSERT INTO core.outbox (topic, aggregate_type, aggregate_id, payload) VALUES ('consignment.received', 'consignment', $1, $2::jsonb)`, [
        consignmentId, JSON.stringify({ sellerId: conv.account_id, title: draft.title, lotRef: lot!.lot_ref, lotId: lot!.id, channel: 'whatsapp' }),
      ]);
    });
  }

  /** Finishes submissions interrupted part-way (the worker calls this). */
  async resumeSubmissions(now: Date = new Date(), olderThanSeconds = 60): Promise<number> {
    const r = await this.db.query<{ id: string }>(
      `SELECT id FROM comms.conversation WHERE step = 'submitting' AND updated_at < $1`,
      [new Date(now.getTime() - olderThanSeconds * 1000)],
    );
    for (const { id } of r.rows) await this.submit(id, now);
    return r.rowCount ?? 0;
  }
}
