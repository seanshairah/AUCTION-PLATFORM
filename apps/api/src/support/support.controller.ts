import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DISPUTE_CATEGORIES, REMEDIES, TICKET_CATEGORIES, TICKET_PRIORITIES, type DisputeView, type SupportService, type TicketView } from '@abc/support';
import { maybeMoney, moneyJson, parseMinor } from '../http';
import { parse } from '../logistics/logistics.controller';
import { SUPPORT } from '../logistics/tokens';
import { CurrentAccount, type SessionAccount } from '../session';
import { CurrentStaff, StaffOnly, staffActor, type StaffSession } from '../staff-guard';

/**
 * Support and disputes endpoints (docs/17-support-disputes.md): buyers raise claims
 * and tickets; staff work the queues, decide claims (with a second approver above
 * the rulebook threshold) and reply to tickets.
 */

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'must be an id');
const Minor = z.string().regex(/^\d{1,15}$/, 'must be whole minor units');
const ClientKey = z.string().min(8).max(100);

const DisputeBody = z.object({
  lotId: UUID,
  category: z.enum(DISPUTE_CATEGORIES),
  description: z.string().trim().min(10).max(2_000),
  claimedCondition: z.string().max(40).optional(),
  evidence: z.array(z.object({ kind: z.enum(['photo', 'video', 'document']), objectKey: z.string().min(3).max(300) }).strict()).max(20).default([]),
  clientKey: ClientKey,
});
const TicketBody = z.object({
  channel: z.enum(['web', 'whatsapp']).default('web'),
  category: z.enum(TICKET_CATEGORIES),
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(5_000),
  lotId: UUID.optional(),
  invoiceId: UUID.optional(),
  disputeId: UUID.optional(),
  clientKey: ClientKey.optional(),
});
const StaffTicketBody = TicketBody.extend({ accountId: UUID, channel: z.enum(['web', 'whatsapp', 'phone', 'branch']), priority: z.enum(TICKET_PRIORITIES).optional() });
const MessageBody = z.object({ body: z.string().trim().min(1).max(5_000), clientKey: ClientKey.optional() });
const StaffMessageBody = MessageBody.extend({ internal: z.boolean().optional(), resolve: z.boolean().optional() });
const AssignTicketBody = z.object({ ownerStaffId: UUID, priority: z.enum(TICKET_PRIORITIES).optional() });
const AssignDisputeBody = z.object({ ownerStaffId: UUID.optional() });
const Findings = z.object({
  chassisNumberFound: z.string().max(40).optional(),
  engineNumberFound: z.string().max(40).optional(),
  odometerKmFound: z.number().int().nonnegative().optional(),
  failingItems: z.array(z.string().max(60)).max(40).optional(),
}).strict();
const DecisionBody = z.object({
  remedy: z.enum(REMEDIES),
  decision: z.string().trim().min(10).max(2_000),
  refundMinor: Minor.optional(),
  findings: Findings.optional(),
  overrideRequestId: UUID.optional(),
});
const ApprovalRequestBody = z.object({ remedy: z.enum(['partial_refund', 'full_refund_and_return']), refundMinor: Minor.optional(), reason: z.string().trim().min(10).max(1_000) });
const ApprovalBody = z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() });
const ReturnBody = z.object({ outcome: z.enum(['withdrawn', 'listed']) });
const DisputeQueueQuery = z.object({ status: z.enum(['open', 'under_review', 'decided', 'all']).optional() });
const TicketQueueQuery = z.object({ status: z.enum(['open', 'pending_customer', 'resolved', 'closed', 'active']).optional(), owner: UUID.optional() });

function notFound(message: string): never {
  throw new NotFoundException({ code: 'not_found', message });
}

function disputeJson(d: DisputeView) {
  return { ...d, refund: maybeMoney(d.refundMinor, d.currency), refundMinor: undefined };
}

function ticketJson(t: TicketView) {
  return t;
}

@Controller()
export class SupportController {
  constructor(@Inject(SUPPORT) private readonly support: SupportService) {}

  /** A claim against a lot you bought, within the claim window after release. */
  @Post('disputes')
  async raise(@Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = parse(DisputeBody, body);
    const r = await this.support.raiseDispute({ type: 'account', id: account.id, name: 'Buyer' }, {
      lotId: b.lotId, category: b.category, description: b.description, evidence: b.evidence, clientKey: b.clientKey,
      ...(b.claimedCondition ? { claimedCondition: b.claimedCondition } : {}),
    });
    if (!r.raised && r.reason === 'not_found') notFound(r.message);
    return r;
  }

  @Get('me/disputes')
  async myDisputes(@CurrentAccount() account: SessionAccount) {
    return (await this.support.myDisputes(account.id)).map(disputeJson);
  }

  @Post('tickets')
  async open(@Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = parse(TicketBody, body);
    const r = await this.support.openTicket({ type: 'account', id: account.id, name: 'Customer' }, { ...stripUndefined(b), accountId: account.id });
    if (!r.opened && r.reason === 'not_found') notFound(r.message);
    return r;
  }

  @Get('me/tickets')
  async myTickets(@CurrentAccount() account: SessionAccount) {
    return (await this.support.myTickets(account.id)).map(ticketJson);
  }

  @Post('tickets/:id/messages')
  async message(@Param('id') id: string, @Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = parse(MessageBody, body);
    const r = await this.support.addMessage({ type: 'account', id: account.id, name: 'Customer' }, id, stripUndefined(b));
    if (!r.added && r.reason === 'not_found') notFound(r.message);
    return r;
  }
}

const AGENTS = ['support', 'ops', 'admin'] as const;

@Controller('staff')
export class SupportStaffController {
  constructor(@Inject(SUPPORT) private readonly support: SupportService) {}

  @Get('disputes')
  @StaffOnly(...AGENTS, 'finance', 'risk')
  async disputes(@Query() query: unknown) {
    const q = parse(DisputeQueueQuery, query);
    return (await this.support.disputeQueue(q.status ? { status: q.status } : {})).map(disputeJson);
  }

  @Post('disputes/:id/assign')
  @StaffOnly(...AGENTS)
  async assignDispute(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffSession) {
    const b = parse(AssignDisputeBody, body);
    const r = await this.support.assignDispute(staffActor(staff, 'claim assigned'), id, b.ownerStaffId ?? staff.id);
    if (r.reason === 'not_found') notFound('We could not find that claim.');
    return r;
  }

  /** Asks a second staff member to approve a refund above the threshold (rule dispute.refund_second_approver_threshold). */
  @Post('disputes/:id/refund-approval')
  @StaffOnly(...AGENTS)
  async requestApproval(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffSession) {
    const b = parse(ApprovalRequestBody, body);
    const r = await this.support.requestRefundApproval(staffActor(staff, b.reason), id, {
      remedy: b.remedy, reason: b.reason, ...(b.refundMinor ? { refundMinor: parseMinor(b.refundMinor)! } : {}),
    });
    if (!r.requested && r.reason === 'not_found') notFound(r.message);
    return r.requested ? { ...r, amount: moneyJson(r.amountMinor, r.currency), amountMinor: undefined } : r;
  }

  /** The second person approves or rejects a refund. */
  @Post('refund-approvals/:id')
  @StaffOnly('finance', 'admin')
  async decideApproval(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffSession) {
    const b = parse(ApprovalBody, body);
    const r = await this.support.decideRefundApproval(staffActor(staff, b.note ?? (b.approve ? 'refund approved' : 'refund rejected')), id, { approve: b.approve, ...(b.note ? { note: b.note } : {}) });
    if (r.reason === 'not_found') notFound('We could not find that approval request.');
    return r.ok ? r : { ...r, message: r.reason === 'same_person' ? 'The person who asked cannot approve their own refund.' : 'This request has already been decided.' };
  }

  @Post('disputes/:id/decision')
  @StaffOnly(...AGENTS)
  async decide(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffSession) {
    const b = parse(DecisionBody, body);
    const r = await this.support.decideDispute(staffActor(staff, b.decision), id, {
      remedy: b.remedy, decision: b.decision,
      ...(b.refundMinor ? { refundMinor: parseMinor(b.refundMinor)! } : {}),
      ...(b.findings ? { findings: stripUndefined(b.findings) } : {}),
      ...(b.overrideRequestId ? { overrideRequestId: b.overrideRequestId } : {}),
    });
    if (!r.decided && r.reason === 'not_found') notFound(r.message);
    if (r.decided) return { ...r, refund: moneyJson(r.refundMinor, r.currency), refundMinor: undefined };
    return { ...r, ...(r.refundMinor !== undefined ? { refund: r.refundMinor.toString() } : {}), refundMinor: undefined, maxMinor: r.maxMinor?.toString() };
  }

  @Post('disputes/:id/return')
  @StaffOnly(...AGENTS)
  async recordReturn(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffSession) {
    const b = parse(ReturnBody, body);
    const r = await this.support.recordReturn(staffActor(staff, `goods returned: ${b.outcome}`), id, b.outcome);
    if (r.reason === 'not_found') notFound('We could not find that claim.');
    return r;
  }

  @Get('tickets')
  @StaffOnly(...AGENTS)
  async tickets(@Query() query: unknown) {
    const q = parse(TicketQueueQuery, query);
    return (await this.support.ticketQueue({ ...(q.status ? { status: q.status } : {}), ...(q.owner ? { ownerStaffId: q.owner } : {}) })).map(ticketJson);
  }

  @Get('tickets/:id')
  @StaffOnly(...AGENTS)
  async ticket(@Param('id') id: string, @CurrentStaff() staff: StaffSession) {
    const t = await this.support.ticket(id, { accountId: staff.id, staff: true });
    if (!t) notFound('We could not find that ticket.');
    return ticketJson(t);
  }

  /** A ticket for a customer on the phone or at the branch counter. */
  @Post('tickets')
  @StaffOnly(...AGENTS, 'cashier')
  async openForCustomer(@Body() body: unknown, @CurrentStaff() staff: StaffSession) {
    const b = parse(StaffTicketBody, body);
    const r = await this.support.openTicket(staffActor(staff, `ticket logged (${b.channel})`), stripUndefined(b));
    if (!r.opened && r.reason === 'not_found') notFound(r.message);
    return r;
  }

  @Post('tickets/:id/messages')
  @StaffOnly(...AGENTS)
  async reply(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffSession) {
    const b = parse(StaffMessageBody, body);
    const r = await this.support.addMessage(staffActor(staff), id, stripUndefined(b));
    if (!r.added && r.reason === 'not_found') notFound(r.message);
    return r;
  }

  @Post('tickets/:id/assign')
  @StaffOnly(...AGENTS)
  async assign(@Param('id') id: string, @Body() body: unknown, @CurrentStaff() staff: StaffSession) {
    const b = parse(AssignTicketBody, body);
    const r = await this.support.assignTicket(staffActor(staff, 'ticket assigned'), id, stripUndefined(b));
    if (r.reason === 'not_found') notFound('We could not find that ticket.');
    if (r.reason === 'not_staff') throw new BadRequestException({ code: 'not_staff', message: 'Tickets can only be assigned to staff.' });
    return r;
  }
}

/** zod leaves absent optional keys as undefined; the services take them as absent. */
function stripUndefined<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}
