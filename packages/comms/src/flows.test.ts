import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BiddingService } from '@abc/bidding';
import { createAccount, createAuction, createTestDatabase, DB_TESTS_ENABLED, loadPublishedRuleSetForTests, readRuleSetDocument, RulebookStore, SYSTEM, type Actor, type TestDatabase } from '@abc/db';
import { IdentityService } from '@abc/identity';
import { gatewaySettlement, postJournal } from '@abc/ledger';
import { lotPricing, RegistrationService } from '@abc/limits';
import { PaymentService } from '@abc/payments';
import { quoteLot } from '@abc/quote';
import type { RuleRecord } from '@abc/rules';
import { SellerService } from '@abc/seller';
import { SettlementService } from '@abc/settlement';
import { VehicleService } from '@abc/vehicles';
import {
  ChannelRegistry,
  Dispatcher,
  EmailChannel,
  EndingSoonAlerts,
  FakeChannel,
  InAppChannel,
  INTAKE_MESSAGES,
  LogEmailTransport,
  TemplateCatalogue,
  WhatsAppIntake,
} from './index';

/**
 * Communications end to end, against PostgreSQL, driven by the real services:
 * every person hears what the blueprint says they should, on the right channel,
 * once. Times are real (the services use the clock), so quiet hours are moved
 * well away from now for this test.
 */

const DOC = readRuleSetDocument();
const OTP_SECRET = 'test-otp-secret-0123456789abcdef';
const HOUR = 3_600_000;

const COMMISSION = {
  key: 'commission.schedule', scope: { type: 'global', ref: '*' },
  value: { basis: 'flat_band', bands: { USD: [{ from: 0, rateBp: 1000 }], ZWG: null }, minimumPerLot: { USD: 0, ZWG: null } },
  provenance: 'assumption', source: 'TEST ONLY: illustrative commission pending Q3',
} as RuleRecord;

function quietHoursAwayFromNow(): RuleRecord {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Harare', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const hh = (n: number) => `${String(n % 24).padStart(2, '0')}:00`;
  return { key: 'comms.quiet_hours', scope: { type: 'global', ref: '*' }, value: { start: hh(h + 8), end: hh(h + 9), timeZone: 'Africa/Harare' }, provenance: 'proposed', source: 'TEST ONLY' };
}

describe.skipIf(!DB_TESTS_ENABLED)('communications end to end', () => {
  let t: TestDatabase;
  let rulebook: RulebookStore;
  let versionId: string;
  let wa: FakeChannel;
  let push: FakeChannel;
  let sms: FakeChannel;
  let mail: LogEmailTransport;
  let dispatcher: Dispatcher;
  let registrations: RegistrationService;
  let bidding: BiddingService;
  let settlement: SettlementService;
  let payments: PaymentService;
  let vehicles: VehicleService;
  let staff: Actor & { type: 'staff' };
  let deskId: string;
  let seller: string;
  let alice: string;
  let bob: string;

  const as = (id: string, name: string): Actor => ({ type: 'account', id, name });
  const run = () => dispatcher.run(new Date());

  async function person(name: string, verification: 'partial' | 'full' = 'full'): Promise<string> {
    const id = await createAccount(t.db, { name, verification });
    await t.db.tx(SYSTEM, async (c) => {
      for (const ch of ['whatsapp', 'sms', 'email', 'push']) {
        await c.query(`INSERT INTO identity.contact_consent (account_id, channel, granted, source) VALUES ($1, $2, true, 'signup_form')`, [id, ch]);
      }
    });
    return id;
  }

  async function heard(accountId: string, channel = 'whatsapp'): Promise<string[]> {
    const r = await t.db.query<{ template_key: string }>(
      `SELECT template_key FROM comms.message WHERE recipient_account_id = $1 AND channel = $2 AND status IN ('sent', 'delivered', 'read') ORDER BY sent_at, outbox_id, template_key`,
      [accountId, channel],
    );
    return r.rows.map((x) => x.template_key);
  }

  async function bid(accountId: string, auctionLotId: string, lotId: string, maxMinor: bigint) {
    const snapshot = await rulebook.snapshot(versionId);
    const total = quoteLot({ lot: await lotPricing(t.db, lotId), hammerMinor: maxMinor, snapshot, taxRates: await rulebook.taxRates(), at: new Date() }).totalMinor;
    return bidding.placeBid(as(accountId, 'Bidder'), { accountId, auctionLotId, maxMinor, clientRequestId: randomUUID(), quotedTotalMinor: total, quotedRuleVersionId: versionId, channel: 'android' });
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    versionId = await loadPublishedRuleSetForTests(t.db, DOC, { activateTaxRates: true, overrides: [COMMISSION, quietHoursAwayFromNow()] });
    rulebook = new RulebookStore(t.db);
    const templates = await TemplateCatalogue.load(t.db);
    wa = new FakeChannel('whatsapp', templates);
    push = new FakeChannel('push', templates);
    sms = new FakeChannel('sms', templates);
    mail = new LogEmailTransport(() => undefined);
    const registry = new ChannelRegistry()
      .register('whatsapp-fake', wa).register('push-fake', push).register('sms-fake', sms)
      .register('email-log', new EmailChannel(templates, mail, 'ABC Auctions <no-reply@abcauctions.example>'))
      .register('in_app', new InAppChannel(templates));
    dispatcher = new Dispatcher(t.db, rulebook, registry, templates, { webBaseUrl: 'https://abcauctions.example', otpSecret: OTP_SECRET });
    registrations = new RegistrationService(rulebook);
    bidding = new BiddingService(t.db, rulebook, registrations);
    settlement = new SettlementService(t.db, rulebook, { gatePassSecret: 'gate-pass-secret' });
    payments = new PaymentService(t.db, rulebook, []);
    vehicles = new VehicleService(t.db, rulebook);

    const staffId = await person('Gate staff');
    deskId = await person('Vehicle desk');
    await t.db.tx(SYSTEM, (c) => c.query(`INSERT INTO identity.staff_role (account_id, role, granted_by) VALUES ($1, 'vehicle_desk', $2), ($2, 'ops', $1)`, [deskId, staffId]));
    staff = { type: 'staff', id: staffId, name: 'Gate staff' };
    seller = await person('Borrowdale Motors');
    alice = await person('Alice');
    bob = await person('Bob');
    await t.db.tx(SYSTEM, (c) =>
      c.query(`INSERT INTO payout.destination (account_id, method, currency, details_enc, details_hmac, verified_at, cooling_off_until) VALUES ($1, 'ecocash', 'USD', '\\x01', '\\x02', now(), now() - interval '1 day')`, [seller]),
    );
    for (const [who, n] of [[alice, 1], [bob, 2]] as const) {
      await payments.recordBranchCash(staff, { cashierId: staffId, branch: 'HRE', accountId: who, currency: 'USD', amountMinor: 1_000_000n, receiptNumber: `COMMS-${n}` });
    }
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('from registration to the seller being paid, each person hears each step once', async () => {
    const end = new Date(Date.now() + HOUR);
    const a = await createAuction(t.db, {
      createdBy: staff.id, depositRequired: true,
      lots: [
        { sellerId: seller, startingBidMinor: 5_000n, endsAt: end, title: 'Dell laptop' },
        { sellerId: seller, category: 'vehicles', startingBidMinor: 100_000n, endsAt: end, title: 'Toyota Hilux 2019' },
      ],
    });
    const [laptop, hilux] = a.lots as [{ lotId: string; auctionLotId: string }, { lotId: string; auctionLotId: string }];
    await bidding.openAuction(SYSTEM, a.auctionId);
    for (const who of [alice, bob]) await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: who, auctionId: a.auctionId, deposit: { USD: 300_000n } }));
    await run();
    expect(await heard(alice)).toEqual(['registration_approved']);

    expect(await bid(bob, laptop.auctionLotId, laptop.lotId, 25_000n)).toMatchObject({ accepted: true });
    expect(await bid(alice, laptop.auctionLotId, laptop.lotId, 30_000n)).toMatchObject({ accepted: true, receipt: { youAreLeading: true } });
    expect(await bid(alice, hilux.auctionLotId, hilux.lotId, 150_000n)).toMatchObject({ accepted: true });
    await run();
    expect(await heard(bob)).toEqual(['registration_approved', 'outbid']);
    expect(wa.lastTo((await t.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM identity.account WHERE id = $1', [bob])).rows[0]!.phone_e164)?.text)
      .toMatch(/^ABC Auctions: You were outbid on Dell laptop\. It is now US\$260\.00\. Bid again: https:\/\/abcauctions\.example\/lots\/TEST-/);

    // Half an hour before the close, both bidders on the laptop get an ending-soon alert, once.
    const soon = new EndingSoonAlerts(t.db, rulebook);
    expect(await soon.queue(new Date(end.getTime() - 30 * 60_000))).toBe(3);
    expect(await soon.queue(new Date(end.getTime() - 20 * 60_000))).toBe(0);
    await run();
    expect(await heard(bob)).toContain('ending_soon_watching');
    expect(await heard(alice)).toEqual(expect.arrayContaining(['ending_soon_leading']));

    await bidding.closeDueLots(new Date(end.getTime() + 1_000));
    await run();
    expect(await heard(bob)).toEqual(['registration_approved', 'outbid', 'ending_soon_watching', 'lost']);
    expect((await heard(alice)).filter((k) => k === 'won')).toHaveLength(2);

    const [invoice] = await settlement.settleClosedAuction(a.auctionId);
    const issuedAt = (await t.db.query<{ issued_at: Date }>('SELECT issued_at FROM settlement.invoice WHERE id = $1', [invoice!.invoiceId])).rows[0]!.issued_at;
    await settlement.queueDueReminders(new Date(issuedAt.getTime() + 12 * HOUR + 1000));
    await settlement.queueDueReminders(new Date(issuedAt.getTime() + 36 * HOUR + 1000));
    await run();
    expect(await heard(alice)).toEqual(expect.arrayContaining(['invoice_issued', 'payment_reminder', 'payment_reminder_final']));
    // Transactional messages also go by email, for the record; alerts do not.
    expect(await heard(alice, 'email')).toEqual(expect.arrayContaining(['registration_approved', 'won', 'invoice_issued', 'payment_reminder', 'payment_reminder_final']));
    expect(await heard(alice, 'email')).not.toContain('ending_soon_leading');

    const paid = await settlement.payFromWallet(as(alice, 'Alice'), { invoiceId: invoice!.invoiceId, accountId: alice, clientKey: 'pay-comms-1' });
    expect(paid).toMatchObject({ paid: true });
    await run();
    // The Hilux waits for its papers, so no gate-pass message yet.
    expect(await heard(alice)).toContain('payment_received');
    expect(await heard(alice)).not.toContain('gate_pass_ready');

    const caseId = (await t.db.query<{ id: string }>('SELECT id FROM logistics.title_case WHERE lot_id = $1', [hilux.lotId])).rows[0]!.id;
    await vehicles.alertOverdueTitleSteps(new Date(Date.now() + 15 * 24 * HOUR));
    await run();
    // Staff tasks go to the app first (rule comms.fallback: staff_task push → WhatsApp → SMS).
    expect(await heard(deskId, 'push')).toEqual(['title_step_overdue', 'title_step_overdue', 'title_step_overdue']);
    const desk = { type: 'staff' as const, id: deskId, name: 'Vehicle desk' };
    for (const step of ['zrp_clearance', 'zimra_clearance', 'cvr_change_of_ownership'] as const) await vehicles.completeTitleStep(desk, caseId, step, `evidence/${step}.pdf`);
    await run();
    expect(await heard(alice)).toContain('title_complete');

    const released = await settlement.releaseAtGate(staff, (paid as { gatePassToken: string }).gatePassToken);
    expect(released).toMatchObject({ released: true });
    const payoutId = (released as { payouts: string[] }).payouts[0]!;
    // Money reaches the trust account from the gateway before finance pays the seller.
    await t.db.tx(SYSTEM, (c) => postJournal(c, gatewaySettlement({ settlementId: randomUUID(), gateway: 'paynow', currency: 'USD', amountMinor: 1_000_000n })));
    await settlement.markPayoutPaid(staff, payoutId, 'CBZ-20261013-0042');
    await run();
    expect(await heard(seller)).toEqual(['payout_scheduled', 'payout_paid']);
    const sellerPhone = (await t.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM identity.account WHERE id = $1', [seller])).rows[0]!.phone_e164;
    expect(wa.lastTo(sellerPhone)?.text).toMatch(/^ABC Auctions: We have sent your payout of US\$[\d,.]+\. Reference CBZ-20261013-0042\.$/);

    // Every message names the outbox event behind it, and nobody heard anything twice.
    const dup = await t.db.query(`SELECT message_key, channel, recipient_account_id FROM comms.message GROUP BY 1, 2, 3 HAVING count(*) > 1`);
    expect(dup.rowCount).toBe(0);
  });

  it('an unpaid invoice: overdue warning, then the deposit is forfeited and the buyer is told how much', async () => {
    const end = new Date(Date.now() + HOUR);
    const a = await createAuction(t.db, { createdBy: staff.id, depositRequired: true, lots: [{ sellerId: seller, startingBidMinor: 5_000n, endsAt: end, title: 'Office desk' }] });
    await bidding.openAuction(SYSTEM, a.auctionId);
    const carol = await person('Carol');
    await payments.recordBranchCash(staff, { cashierId: staff.id, branch: 'HRE', accountId: carol, currency: 'USD', amountMinor: 100_000n, receiptNumber: 'COMMS-3' });
    await t.db.tx(SYSTEM, (c) => registrations.join(c, { accountId: carol, auctionId: a.auctionId, deposit: { USD: 50_000n } }));
    await bid(carol, a.lots[0]!.auctionLotId, a.lots[0]!.lotId, 20_000n);
    await bidding.closeDueLots(new Date(end.getTime() + 1000));
    const [inv] = await settlement.settleClosedAuction(a.auctionId);
    const due = (await t.db.query<{ due_at: Date }>('SELECT due_at FROM settlement.invoice WHERE id = $1', [inv!.invoiceId])).rows[0]!.due_at;
    await settlement.runDefaultLadder(due);
    await settlement.runDefaultLadder(new Date(due.getTime() + 24 * HOUR));
    await run();
    expect(await heard(carol)).toEqual(expect.arrayContaining(['default_warning', 'deposit_forfeited']));
    const phone = (await t.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM identity.account WHERE id = $1', [carol])).rows[0]!.phone_e164;
    expect(wa.lastTo(phone)?.text).toMatch(/^ABC Auctions: Invoice TEST-[0-9a-f]{8}-0001 was not paid in time\. It is cancelled and your deposit of US\$500\.00 is forfeited\.$/);
  });

  it('sign-in codes: WhatsApp first, SMS when WhatsApp fails, email codes by email; the code is never stored', async () => {
    const identity = new IdentityService(t.db, rulebook, { otpSecret: OTP_SECRET, signalSecret: 'signal-secret-0123456789abcdef01' });
    wa.failNext('permanent');
    const start = await identity.startOtp({ contact: '0773 000 111', ip: '196.43.1.2' });
    if (!start.ok) throw new Error('start failed');
    await run();
    const smsText = sms.lastTo('+263773000111')?.text ?? '';
    const code = /code is (\d{6})/.exec(smsText)?.[1];
    expect(code).toBeDefined();
    const rows = await t.db.query<{ channel: string; status: string; params: Record<string, string> }>(
      `SELECT channel, status, params FROM comms.message WHERE template_key = 'otp_code' AND recipient_address = '+263773000111' ORDER BY fallback_of NULLS FIRST`,
    );
    expect(rows.rows.map((r) => [r.channel, r.status])).toEqual([['whatsapp', 'failed'], ['sms', 'sent']]);
    expect(rows.rows.every((r) => JSON.stringify(r.params) === JSON.stringify({ challengeId: start.challengeId }))).toBe(true);
    const ok = await identity.verifyOtp({ challengeId: start.challengeId, code: code!, signUp: { displayName: 'New bidder', consent: { whatsapp: true, sms: true } } });
    expect(ok).toMatchObject({ ok: true, created: true });

    const byEmail = await identity.startOtp({ contact: 'new.bidder@example.test' });
    if (!byEmail.ok) throw new Error('start failed');
    await run();
    const email = mail.outbox.find((m) => m.to === 'new.bidder@example.test')!;
    expect(email.subject).toBe('Your ABC Auctions sign-in code');
    const emailCode = /code is (\d{6})/.exec(email.text)![1]!;
    const signedIn = await identity.verifyOtp({ challengeId: byEmail.challengeId, code: emailCode, signUp: { displayName: 'New bidder', consent: {} } });
    expect(signedIn).toMatchObject({ ok: true });
  });

  it('a seller consigns by WhatsApp chat, end to end, with replies through the dispatcher', async () => {
    const sellers = new SellerService(t.db, rulebook);
    const intake = new WhatsAppIntake(t.db, rulebook, sellers, { branch: 'HRE', provider: 'whatsapp-fake' });
    const tendai = await person('Tendai (seller)');
    const phone = (await t.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM identity.account WHERE id = $1', [tendai])).rows[0]!.phone_e164;
    let n = 0;
    const say = async (text: string, imageIds?: string[]) => {
      const r = await intake.handleInbound({ providerMessageId: `wamid.in-${++n}`, from: phone, kind: imageIds ? 'image' : 'text', text, ...(imageIds ? { imageIds } : {}), at: new Date() });
      await run();
      return { result: r, reply: wa.lastTo(phone)?.text ?? '' };
    };

    expect((await say('Hello')).reply).toBe(INTAKE_MESSAGES.help);
    const start = await say('SELL');
    expect(start.reply).toMatch(/^Welcome to ABC Auctions selling\. What are you selling\? Reply with a number:\n1\. Vehicles\n/);
    const it = start.reply.split('\n').find((l) => l.endsWith('IT and electronics'))!.split('.')[0]!;
    expect((await say(it)).reply).toMatch(/^IT and electronics\. In a few words, what is it\?/);
    expect((await say('Samsung 55-inch TV')).reply).toMatch(/^What condition is it in\?/);
    expect((await say('2')).reply).toBe('Please send at least 4 clear photos, including the whole item and any label or serial number. Reply DONE when finished.');
    for (let i = 1; i <= 4; i++) await say('', [`MEDIA-${i}`]);
    expect((await say('DONE')).reply).toMatch(/^Do you want a reserve/);
    expect((await say('300')).reply).toBe('Please check:\nSamsung 55-inch TV\nIT and electronics · Working\n4 photos\nReserve: US$300.00\nReply YES to send this to our intake team, or NO to start again.');

    // A webhook retry of the same message changes nothing.
    expect(await intake.handleInbound({ providerMessageId: `wamid.in-${n}`, from: phone, kind: 'text', text: '300', at: new Date() })).toBe('duplicate');

    const done = await say('YES');
    expect(done.result).toBe('submitted');
    const lot = (await t.db.query<{ id: string; lot_ref: string; title: string; condition: string; reserve_minor: bigint; state: string; intake_channel: string }>(
      `SELECT l.id, l.lot_ref, l.title, l.condition, l.reserve_minor, l.state, k.intake_channel
         FROM catalogue.lot l JOIN seller.consignment k ON k.id = l.consignment_id WHERE l.seller_account_id = $1`, [tendai],
    )).rows[0]!;
    expect(lot).toMatchObject({ title: 'Samsung 55-inch TV', condition: 'working', reserve_minor: 30_000n, state: 'draft', intake_channel: 'whatsapp' });
    const replies = wa.sent.filter((s) => s.to === phone).map((s) => s.templateKey);
    expect(replies.slice(-2)).toEqual(['chat_reply', 'consignment_received']);
    expect(wa.lastTo(phone)?.text).toBe(`ABC Auctions: We have received the details of Samsung 55-inch TV (ref ${lot.lot_ref}). Our intake team will send your valuation and consignment note.`);
    const conv = (await t.db.query<{ step: string; lot_id: string; state: { draft: { photoIds: string[] } } }>(`SELECT step, lot_id, state FROM comms.conversation WHERE address = $1`, [phone])).rows[0]!;
    expect(conv).toMatchObject({ step: 'done', lot_id: lot.id });
    expect(conv.state.draft.photoIds).toEqual(['MEDIA-1', 'MEDIA-2', 'MEDIA-3', 'MEDIA-4']);
    expect(await intake.resumeSubmissions(new Date(Date.now() + HOUR))).toBe(0);

    // Someone without an account is asked to sign in first.
    await intake.handleInbound({ providerMessageId: 'wamid.stranger', from: '+263779999999', kind: 'text', text: 'sell', at: new Date() });
    await run();
    expect(wa.lastTo('+263779999999')?.text).toBe(INTAKE_MESSAGES.signInFirst);
  });
});
