import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Currency } from '@abc/domain';
import type { DeliveryQuote, LogisticsService, Purchase } from '@abc/logistics';
import { moneyJson, parseMinor } from '../http';
import { CurrentAccount, type SessionAccount } from '../session';
import { CurrentStaff, StaffOnly, staffActor, type StaffSession } from '../staff-guard';
import { LOGISTICS } from './tokens';

/**
 * Logistics endpoints (docs/15-logistics.md): what the buyer sees after winning,
 * collection slots, door delivery, and the staff side (gate, courier hand-over,
 * delivery status). Thin: every rule lives in @abc/logistics and @abc/settlement.
 */

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be an id');
const SizeClass = z.enum(['small', 'medium', 'large']);
const SlotBody = z.object({ slotId: UUID, clientKey: z.string().min(8).max(100).optional() });
const QuoteBody = z.object({ town: z.string().trim().min(1).max(60), sizeClass: SizeClass });
const DeliveryBody = QuoteBody.extend({
  address: z.object({
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    suburb: z.string().trim().max(100).optional(),
    phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).optional(),
    notes: z.string().trim().max(300).optional(),
  }).strict(),
  quotedTotalMinor: z.string(),
  clientKey: z.string().min(8).max(100),
  partnerId: UUID.optional(),
});
const GateBody = z.object({ token: z.string().min(10).max(200) });
const DeliveryStatusBody = z.object({
  status: z.enum(['in_transit', 'delivered', 'failed', 'cancelled']),
  proofObjectKey: z.string().min(3).max(300).optional(),
  note: z.string().trim().max(500).optional(),
});

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new BadRequestException({ code: 'invalid_request', message: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  return r.data;
}

function notFound(message: string): never {
  throw new NotFoundException({ code: 'not_found', message });
}

const SLOT_TEXT: Record<string, string> = {
  not_bookable: 'These goods are not waiting for a collection slot.',
  wrong_branch: 'That slot is at a different branch from your goods.',
  past: 'That slot has already started. Choose a later one.',
  full: 'That slot has just filled up. Choose another.',
};

const RELEASE_TEXT: Record<string, string> = {
  invalid_pass: 'This pass is not valid.',
  not_ready: 'These goods have already been released, or are not ready.',
  title_incomplete: 'This vehicle is held until police, ZIMRA and change-of-ownership steps are complete.',
  charges_due: 'Storage is due before release. The buyer can top up and pay in the app or at the counter.',
  not_booked: 'This delivery is not waiting for pickup.',
};

function quoteJson(q: DeliveryQuote) {
  return {
    town: q.town,
    sizeClass: q.sizeClass,
    lines: q.lines.map((l) => ({ type: l.type, description: l.description, amount: moneyJson(l.amountMinor, q.currency) })),
    total: moneyJson(q.totalMinor, q.currency),
    ruleVersionId: q.ruleVersionId,
  };
}

export function purchaseJson(p: Purchase) {
  const m = (v: bigint) => moneyJson(v, p.currency);
  const c = p.collection;
  return {
    invoiceId: p.invoiceId,
    invoiceNumber: p.invoiceNumber,
    auction: p.auctionTitle,
    status: p.status,
    total: m(p.totalMinor),
    issuedAt: p.issuedAt,
    dueAt: p.dueAt,
    paidAt: p.paidAt,
    lots: p.lots.map((l) => ({
      id: l.id, ref: l.ref, title: l.title, state: l.state, isVehicle: l.isVehicle, branch: l.branch,
      lines: l.lines.map((x) => ({ type: x.type, description: x.description, amount: m(x.amountMinor) })),
      titleCase: l.titleCase, dispute: l.dispute,
    })),
    collection: c && {
      id: c.id, status: c.status, method: c.method, branch: c.branch, gatePass: c.gatePass, releasedAt: c.releasedAt, slot: c.slot,
      storage: c.storage && {
        enabled: c.storage.enabled, clockFrom: c.storage.clockFrom, collectBy: c.storage.collectBy, freeUntil: c.storage.freeUntil,
        days: c.storage.days, dailyFee: m(c.storage.dailyFeeMinor), accrued: m(c.storage.accruedMinor),
        charged: c.storage.chargedMinor === null ? null : m(c.storage.chargedMinor), asOf: c.storage.asOf,
      },
      delivery: c.delivery && { ...c.delivery, charge: m(c.delivery.chargeMinor), chargeMinor: undefined },
    },
  };
}

@Controller()
export class LogisticsController {
  constructor(@Inject(LOGISTICS) private readonly logistics: LogisticsService) {}

  /** Invoices with lines, status, collection, gate pass, storage clock and vehicle title progress. */
  @Get('me/purchases')
  async purchases(@CurrentAccount() account: SessionAccount) {
    return (await this.logistics.purchases(account.id)).map(purchaseJson);
  }

  @Get('branches/:code/collection-slots')
  async slots(@Param('code') code: string) {
    const slots = await this.logistics.availableSlots(code.toUpperCase());
    if (!slots) notFound('We could not find that branch.');
    return { branch: code.toUpperCase(), slots };
  }

  @Post('collections/:id/slot')
  async bookSlot(@Param('id') id: string, @Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = parse(SlotBody, body);
    const r = await this.logistics.bookSlot({ type: 'account', id: account.id, name: 'Buyer' }, { collectionId: id, slotId: b.slotId, ...(b.clientKey ? { clientKey: b.clientKey } : {}) });
    if (!r.booked && r.reason === 'not_found') notFound('We could not find that collection or slot.');
    return r.booked ? r : { ...r, message: SLOT_TEXT[r.reason] };
  }

  @Post('collections/:id/delivery-quote')
  async quote(@Param('id') id: string, @Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = parse(QuoteBody, body);
    const r = await this.logistics.quoteDelivery(account.id, { collectionId: id, ...b });
    if (!r.ok && r.reason === 'not_found') notFound(r.message);
    return r.ok ? { ok: true, quote: quoteJson(r.quote), expectedOn: r.expectedOn } : r;
  }

  @Post('collections/:id/delivery')
  async book(@Param('id') id: string, @Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = parse(DeliveryBody, body);
    const quoted = parseMinor(b.quotedTotalMinor);
    if (quoted === null) throw new BadRequestException({ code: 'invalid_amount', message: 'quotedTotalMinor must be whole minor units.' });
    const r = await this.logistics.bookDelivery({ type: 'account', id: account.id, name: 'Buyer' }, {
      collectionId: id, town: b.town, sizeClass: b.sizeClass, address: b.address, quotedTotalMinor: quoted, clientKey: b.clientKey,
      ...(b.partnerId ? { partnerId: b.partnerId } : {}),
    });
    if (r.booked) return { ...r, charge: moneyJson(r.chargeMinor, r.currency), chargeMinor: undefined };
    if (r.reason === 'not_found') notFound(r.message);
    if (r.reason === 'price_changed') return { ...r, quote: quoteJson(r.quote) };
    if (r.reason === 'insufficient_funds') return { ...r, shortfall: moneyJson(r.shortfallMinor, r.currency as Currency), shortfallMinor: undefined };
    return r;
  }
}

@Controller('staff')
export class LogisticsStaffController {
  constructor(@Inject(LOGISTICS) private readonly logistics: LogisticsService) {}

  /** Scan the buyer's QR pass at the gate. Storage due is charged from the wallet first. */
  @Post('gate/release')
  @StaffOnly('ops', 'cashier', 'vehicle_desk', 'admin')
  async release(@Body() body: unknown, @CurrentStaff() staff: StaffSession) {
    const b = parse(GateBody, body);
    const r = await this.logistics.releaseAtGate(staffActor(staff, 'gate release'), b.token);
    if (r.released) return r;
    return { ...r, message: RELEASE_TEXT[r.reason], ...('amountMinor' in r ? { amount: moneyJson(r.amountMinor, r.currency), amountMinor: undefined } : {}) };
  }

  /** Hand the goods to the courier the buyer booked. */
  @Post('deliveries/:id/hand-over')
  @StaffOnly('ops', 'admin')
  async handOver(@Param('id') id: string, @CurrentStaff() staff: StaffSession) {
    if (!UUID.safeParse(id).success) notFound('We could not find that delivery.');
    const r = await this.logistics.handOverToCourier(staffActor(staff, 'courier hand-over'), id);
    if (!r.released && r.reason === 'not_found') notFound('We could not find that delivery.');
    if (r.released) return r;
    return { ...r, message: RELEASE_TEXT[r.reason], ...('amountMinor' in r ? { amount: moneyJson(r.amountMinor, r.currency), amountMinor: undefined } : {}) };
  }

  /** Courier status with proof of delivery (an object key). */
  @Post('deliveries/:id/status')
  @StaffOnly('ops', 'admin')
  async status(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffSession) {
    const b = parse(DeliveryStatusBody, body);
    if (!UUID.safeParse(id).success) notFound('We could not find that delivery.');
    const r = await this.logistics.updateDelivery(staffActor(staff, b.note ?? `delivery ${b.status}`), id, {
      status: b.status, ...(b.proofObjectKey ? { proofObjectKey: b.proofObjectKey } : {}), ...(b.note ? { note: b.note } : {}),
    });
    if (!r.updated && r.reason === 'not_found') notFound(r.message);
    return r;
  }
}
