import { formatMinor, type Currency } from '@abc/domain';
import type { Client, RulebookStore } from '@abc/db';
import type { RuleSnapshot } from '@abc/rules';
import { formatLocalDate, formatLocalDateTime } from './policy';

/**
 * Who hears about each outbox event, with which template and values (docs/16 §4).
 * One planner per topic. A planner only reads; the dispatcher writes the messages.
 * Message keys name the business event, so the same event queued twice is still
 * one message per channel and person (R4).
 */

export interface OutboxEvent {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
}

export interface Plan {
  messageKey: string;
  templateKey: string;
  /** The account to tell. null for someone without an account yet (a sign-up code, an unknown chat number). */
  accountId: string | null;
  /** Send here instead of the account's verified contact (a sign-in code goes where it was asked for). */
  address: string | null;
  params: Record<string, string>;
  /** After this the message is useless (the lot has closed, the code has expired). */
  expiresAt: Date | null;
}

export interface PlanContext {
  c: Client;
  rules: RuleSnapshot;
  rulebook: RulebookStore;
  webBaseUrl: string;
  timeZone: string;
  now: Date;
}

type Planner = (e: OutboxEvent, ctx: PlanContext) => Promise<Plan[]>;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const money = (minor: unknown, currency: Currency) => formatMinor(BigInt(str(minor) || '0'), currency);

function plan(messageKey: string, templateKey: string, accountId: string | null, params: Record<string, string>, expiresAt: Date | null = null, address: string | null = null): Plan {
  return { messageKey, templateKey, accountId, address, params, expiresAt };
}

interface LotInfo {
  title: string;
  lot_ref: string;
  currency: Currency;
  current_price_minor: bigint | null;
  current_end_at: Date;
}

async function auctionLot(ctx: PlanContext, auctionLotId: string): Promise<LotInfo> {
  const r = await ctx.c.query<LotInfo>(
    `SELECT l.title, l.lot_ref, al.currency, al.current_price_minor, al.current_end_at
       FROM auction.auction_lot al JOIN catalogue.lot l ON l.id = al.lot_id WHERE al.id = $1`,
    [auctionLotId],
  );
  if (!r.rows[0]) throw new Error(`auction lot ${auctionLotId} not found`);
  return r.rows[0];
}

interface InvoiceInfo {
  id: string;
  invoice_number: string;
  buyer_account_id: string;
  auction_id: string;
  currency: Currency;
  total_minor: bigint;
  due_at: Date;
  collect_by_at: Date;
  rule_version_id: string;
}

async function invoice(ctx: PlanContext, invoiceId: string): Promise<InvoiceInfo> {
  const r = await ctx.c.query<InvoiceInfo>(
    'SELECT id, invoice_number, buyer_account_id, auction_id, currency, total_minor, due_at, collect_by_at, rule_version_id FROM settlement.invoice WHERE id = $1',
    [invoiceId],
  );
  if (!r.rows[0]) throw new Error(`invoice ${invoiceId} not found`);
  return r.rows[0];
}

const lotLink = (ctx: PlanContext, ref: string) => `${ctx.webBaseUrl}/lots/${encodeURIComponent(ref)}`;
const invoiceLink = (ctx: PlanContext, number: string) => `${ctx.webBaseUrl}/invoices/${encodeURIComponent(number)}`;
const when = (ctx: PlanContext, at: Date) => formatLocalDateTime(at, ctx.timeZone);

const STEP_LABEL: Record<string, string> = {
  zrp_clearance: 'ZRP police clearance',
  zimra_clearance: 'ZIMRA clearance',
  cvr_change_of_ownership: 'CVR change of ownership',
};

const PAYOUT_BLOCK_REASON: Record<string, string> = {
  commission_not_published: 'commission rates are still being confirmed',
};

async function branchOfInvoice(ctx: PlanContext, invoiceId: string): Promise<string> {
  const r = await ctx.c.query<{ city: string }>(
    `SELECT b.city FROM settlement.invoice_line il JOIN catalogue.lot l ON l.id = il.lot_id JOIN core.branch b ON b.code = l.location_branch
      WHERE il.invoice_id = $1 ORDER BY il.sort LIMIT 1`,
    [invoiceId],
  );
  return r.rows[0]?.city ?? 'ABC';
}

export const PLANNERS: Record<string, Planner> = {
  'bid.outbid': async (e, ctx) => {
    const lot = await auctionLot(ctx, e.aggregate_id);
    return [
      plan(`outbid:${e.id}`, 'outbid', str(e.payload.accountId), {
        lot: lot.title, price: money(e.payload.priceMinor, lot.currency), link: lotLink(ctx, lot.lot_ref),
      }, lot.current_end_at),
    ];
  },

  'lot.ending_soon': async (e, ctx) => {
    const lot = await auctionLot(ctx, e.aggregate_id);
    const leading = e.payload.leading === true;
    // Someone who saved the lot to their watch list but has not bid hears a watch-list alert.
    const template = leading ? 'ending_soon_leading' : e.payload.watching === true ? 'ending_soon_saved' : 'ending_soon_watching';
    return [
      plan(`ending_soon:${e.aggregate_id}`, template, str(e.payload.accountId), {
        lot: lot.title,
        minutes: String(Math.max(1, Math.round((lot.current_end_at.getTime() - ctx.now.getTime()) / 60_000))),
        price: money(lot.current_price_minor ?? 0n, lot.currency),
        link: lotLink(ctx, lot.lot_ref),
      }, lot.current_end_at),
    ];
  },

  // A saved search found lots that were not there when the person last heard (apps/api watch/saved-search-alerts.ts).
  'saved_search.matched': async (e) => {
    const count = Number(e.payload.count ?? 0);
    if (count < 1) return [];
    return [
      plan(`saved_search:${e.aggregate_id}:${e.id}`, 'saved_search_match', str(e.payload.accountId), {
        matches: count === 1 ? '1 new lot' : `${count} new lots`,
        search: str(e.payload.search),
        lot: str(e.payload.lotTitle),
        price: money(e.payload.priceMinor, str(e.payload.currency) === 'ZWG' ? 'ZWG' : 'USD'),
        link: str(e.payload.link),
      }),
    ];
  },

  'lot.closed': async (e, ctx) => {
    const lot = await auctionLot(ctx, e.aggregate_id);
    const result = str(e.payload.result);
    if (result === 'unsold') return [];
    const winner = result === 'sold' ? str(e.payload.winnerAccountId) : null;
    const plans: Plan[] = [];
    if (winner) {
      plans.push(plan(`lot.closed:${e.aggregate_id}`, 'won', winner, { lot: lot.title, price: money(e.payload.hammerMinor, lot.currency), link: lotLink(ctx, lot.lot_ref) }));
    }
    const others = await ctx.c.query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM bidding.bid
        WHERE auction_lot_id = $1 AND origin = 'bidder' AND outcome_at_placement <> 'rejected' AND account_id IS DISTINCT FROM $2::uuid`,
      [e.aggregate_id, winner],
    );
    for (const o of others.rows) plans.push(plan(`lot.closed:${e.aggregate_id}`, 'lost', o.account_id, { lot: lot.title, link: `${ctx.webBaseUrl}/auctions` }));
    return plans;
  },

  'invoice.issued': async (e, ctx) => {
    const inv = await invoice(ctx, e.aggregate_id);
    return [plan(`invoice.issued:${inv.id}`, 'invoice_issued', inv.buyer_account_id, {
      invoice: inv.invoice_number, total: money(inv.total_minor, inv.currency), due: when(ctx, inv.due_at), link: invoiceLink(ctx, inv.invoice_number),
    })];
  },

  'invoice.reminder': async (e, ctx) => {
    const inv = await invoice(ctx, e.aggregate_id);
    const offsets = (await ctx.rulebook.snapshot(inv.rule_version_id, ctx.c)).get('settlement.reminder_offsets_hours');
    const offset = Number(e.payload.offsetHours);
    const final = offsets.length > 1 && offset === Math.max(...offsets);
    return [plan(`invoice.reminder:${inv.id}:${offset}`, final ? 'payment_reminder_final' : 'payment_reminder', inv.buyer_account_id, {
      invoice: inv.invoice_number, total: money(inv.total_minor, inv.currency), due: when(ctx, inv.due_at), link: invoiceLink(ctx, inv.invoice_number),
    }, inv.due_at)];
  },

  'invoice.paid': async (e, ctx) => {
    const inv = await invoice(ctx, e.aggregate_id);
    return [plan(`invoice.paid:${inv.id}`, 'payment_received', inv.buyer_account_id, { invoice: inv.invoice_number, amount: money(inv.total_minor, inv.currency) })];
  },

  'collection.ready': async (e, ctx) => {
    // Vehicles wait for their papers: the buyer hears "title complete" instead (title.complete).
    const held = await ctx.c.query(
      `SELECT 1 FROM logistics.collection_lot cl JOIN logistics.title_case tc ON tc.lot_id = cl.lot_id
        WHERE cl.collection_id = $1 AND tc.status <> 'complete' LIMIT 1`,
      [e.aggregate_id],
    );
    if (held.rowCount) return [];
    const inv = await invoice(ctx, str(e.payload.invoiceId));
    return [plan(`collection.ready:${e.aggregate_id}`, 'gate_pass_ready', inv.buyer_account_id, {
      invoice: inv.invoice_number, branch: await branchOfInvoice(ctx, inv.id), collectBy: when(ctx, inv.collect_by_at), link: invoiceLink(ctx, inv.invoice_number),
    })];
  },

  'default.warning': async (e, ctx) => {
    const inv = await invoice(ctx, e.aggregate_id);
    return [plan(`default.warning:${inv.id}`, 'default_warning', inv.buyer_account_id, {
      invoice: inv.invoice_number, total: money(inv.total_minor, inv.currency), link: invoiceLink(ctx, inv.invoice_number),
    })];
  },

  // The default ladder's forfeit step cancels the invoice and offers the lots again.
  'lot.relist_required': async (e, ctx) => {
    const inv = await invoice(ctx, e.aggregate_id);
    const f = await ctx.c.query<{ amount: bigint }>(
      `SELECT coalesce(sum(h.amount_minor), 0)::bigint AS amount
         FROM registration.registration r
         JOIN ledger.hold h ON h.reference_type = 'registration' AND h.reference_id = r.id::text
        WHERE r.account_id = $1 AND r.auction_id = $2 AND h.status = 'forfeited' AND h.currency = $3`,
      [inv.buyer_account_id, inv.auction_id, inv.currency],
    );
    const amount = f.rows[0]!.amount;
    return [amount > 0n
      ? plan(`default.forfeit:${inv.id}`, 'deposit_forfeited', inv.buyer_account_id, { invoice: inv.invoice_number, deposit: money(amount, inv.currency) })
      : plan(`default.forfeit:${inv.id}`, 'invoice_cancelled', inv.buyer_account_id, { invoice: inv.invoice_number })];
  },

  'title.step_overdue': async (e, ctx) => {
    const r = await ctx.c.query<{ step: string; due_at: Date; owner_staff_id: string | null; title: string }>(
      `SELECT s.step, s.due_at, s.owner_staff_id, l.title
         FROM logistics.title_step s JOIN logistics.title_case tc ON tc.id = s.title_case_id JOIN catalogue.lot l ON l.id = tc.lot_id
        WHERE s.id = $1`,
      [e.aggregate_id],
    );
    const s = r.rows[0];
    if (!s) return [];
    const staff = s.owner_staff_id
      ? [s.owner_staff_id]
      : (await ctx.c.query<{ account_id: string }>(`SELECT account_id FROM identity.staff_role WHERE role = 'vehicle_desk' ORDER BY account_id`)).rows.map((x) => x.account_id);
    return staff.map((id) => plan(`title.step_overdue:${e.aggregate_id}`, 'title_step_overdue', id, { step: STEP_LABEL[s.step] ?? s.step, lot: s.title, due: when(ctx, s.due_at) }));
  },

  'title.complete': async (e, ctx) => {
    const r = await ctx.c.query<{ buyer_account_id: string; title: string; branch: string; invoice_number: string | null }>(
      `SELECT tc.buyer_account_id, l.title, b.city AS branch,
              (SELECT i.invoice_number FROM settlement.invoice_line il JOIN settlement.invoice i ON i.id = il.invoice_id
                WHERE il.lot_id = l.id AND i.status = 'paid' LIMIT 1) AS invoice_number
         FROM logistics.title_case tc JOIN catalogue.lot l ON l.id = tc.lot_id JOIN core.branch b ON b.code = l.location_branch
        WHERE tc.id = $1`,
      [e.aggregate_id],
    );
    const t = r.rows[0];
    if (!t) return [];
    return [plan(`title.complete:${e.aggregate_id}`, 'title_complete', t.buyer_account_id, {
      lot: t.title, branch: t.branch, link: t.invoice_number ? invoiceLink(ctx, t.invoice_number) : `${ctx.webBaseUrl}/bids`,
    })];
  },

  'payout.scheduled': async (e, ctx) => {
    const r = await ctx.c.query<{ seller_account_id: string; currency: Currency; net_minor: bigint; due_date: string }>(
      `SELECT seller_account_id, currency, net_minor, to_char(due_date, 'YYYY-MM-DD') AS due_date FROM payout.payout WHERE id = $1`, [e.aggregate_id],
    );
    const p = r.rows[0];
    if (!p) return [];
    return [plan(`payout.scheduled:${e.aggregate_id}`, 'payout_scheduled', p.seller_account_id, {
      amount: money(p.net_minor, p.currency), due: formatLocalDate(new Date(`${p.due_date}T12:00:00Z`), ctx.timeZone),
    })];
  },

  'payout.paid': async (e, ctx) => {
    const r = await ctx.c.query<{ seller_account_id: string; currency: Currency; net_minor: bigint; gateway_reference: string | null }>(
      'SELECT seller_account_id, currency, net_minor, gateway_reference FROM payout.payout WHERE id = $1', [e.aggregate_id],
    );
    const p = r.rows[0];
    if (!p) return [];
    return [plan(`payout.paid:${e.aggregate_id}`, 'payout_paid', p.seller_account_id, {
      amount: money(p.net_minor, p.currency), reference: p.gateway_reference ?? str(e.payload.reference),
    })];
  },

  'payout.blocked': async (e, ctx) => {
    const inv = await invoice(ctx, e.aggregate_id);
    const seller = str(e.payload.sellerId);
    const reason = str(e.payload.reason);
    return [plan(`payout.blocked:${inv.id}:${seller}`, 'payout_blocked', seller, {
      invoice: inv.invoice_number, reason: PAYOUT_BLOCK_REASON[reason] ?? 'it needs a check by our finance team',
    })];
  },

  'registration.decided': async (e, ctx) => {
    const status = str(e.payload.status);
    if (status !== 'approved' && status !== 'pending_review') return [];
    const a = await ctx.c.query<{ title: string }>('SELECT title FROM auction.auction WHERE id = $1', [str(e.payload.auctionId)]);
    return [plan(`registration:${e.aggregate_id}:${status}`, status === 'approved' ? 'registration_approved' : 'registration_review', str(e.payload.accountId), {
      auction: a.rows[0]?.title ?? 'the auction',
    })];
  },

  'consignment.received': async (e) => [
    plan(`consignment.received:${e.aggregate_id}`, 'consignment_received', str(e.payload.sellerId), { title: str(e.payload.title), ref: str(e.payload.lotRef) }),
  ],

  // The code itself is derived at the moment of sending (docs/16 §9); only the challenge id is stored.
  'otp.requested': async (e, ctx) => {
    const r = await ctx.c.query<{ destination: string; account_id: string | null; expires_at: Date; status: string }>(
      'SELECT destination, account_id, expires_at, status FROM identity.otp_challenge WHERE id = $1', [str(e.payload.challengeId)],
    );
    const ch = r.rows[0];
    if (!ch || ch.status !== 'pending') return [];
    return [plan(`otp:${e.aggregate_id}:${str(e.payload.send)}`, 'otp_code', ch.account_id, { challengeId: e.aggregate_id }, ch.expires_at, ch.destination)];
  },

  'chat.reply': async (e) => [
    plan(`chat.reply:${str(e.payload.inReplyTo)}`, 'chat_reply', (e.payload.accountId as string | null) ?? null, { text: str(e.payload.text) }, null, str(e.payload.address)),
  ],
};

export const HANDLED_TOPICS: readonly string[] = Object.keys(PLANNERS);
