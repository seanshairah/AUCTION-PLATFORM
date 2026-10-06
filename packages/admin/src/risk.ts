import type { Currency } from '@abc/domain';
import { isCurrency } from '@abc/domain';
import { big, type Db, type RulebookStore } from '@abc/db';
import type { RegistrationService } from '@abc/limits';
import { RuleMissingError, type RuleValue } from '@abc/rules';
import type { OverrideHandler } from './overrides';
import { AdminError, requirePermission, requireReason, staffActor, type StaffMember } from './permissions';

/**
 * The risk console (docs/18 §5): the registration review queue, linked-account
 * clusters, bid anomalies and restricted accounts. Anomaly thresholds are rules
 * (risk.bid_up_pattern, risk.shared_signal_pattern), read from the rule set in force.
 * Changing an account's tier or limit is an override with a reason (R3).
 */

export interface PendingRegistration {
  registrationId: string;
  account: { id: string; name: string; tier: string; verification: string };
  auction: { id: string; code: string; title: string; branch: string };
  reasons: string[];
  waitingSeconds: number;
  targetMinutes: number | null;
  linkedAccounts: Array<{ id: string; name: string; sharedSignals: string[]; isSellerInAuction: boolean }>;
  history: { invoicesPaid: number; defaults: number };
}

export interface LinkCluster {
  accounts: Array<{ id: string; name: string; tier: string; status: string; isSeller: boolean }>;
  signalTypes: string[];
  size: number;
}

export interface BidUpAnomaly {
  kind: 'bid_up_pattern';
  bidder: { id: string; name: string };
  seller: { id: string; name: string };
  lotsBid: number;
  lotsWon: number;
  linkedToSeller: boolean;
}

export interface SharedSignalAnomaly {
  kind: 'shared_signal';
  signalType: string;
  signal: string;
  accounts: Array<{ id: string; name: string }>;
}

export interface RestrictedAccount {
  id: string;
  name: string;
  tier: string;
  status: string;
  restrictedUntil: Date | null;
  since: Date | null;
  reason: string | null;
}

const UUID = /^[0-9a-f-]{36}$/;

export class RiskConsole {
  constructor(
    private readonly db: Db,
    private readonly rulebook: RulebookStore,
    private readonly registrations: RegistrationService,
  ) {}

  private async rule<K extends 'risk.bid_up_pattern' | 'risk.shared_signal_pattern' | 'registration.target_decision_minutes'>(key: K): Promise<RuleValue<K> | null> {
    try {
      const snapshot = await this.rulebook.snapshot(await this.rulebook.activeVersionId(new Date()));
      return snapshot.get(key);
    } catch (e) {
      if (e instanceof RuleMissingError || (e instanceof Error && /No published rule set/.test(e.message))) return null;
      throw e;
    }
  }

  async pendingRegistrations(now: Date = new Date()): Promise<PendingRegistration[]> {
    const target = await this.rule('registration.target_decision_minutes');
    const r = await this.db.query<{
      id: string; account_id: string; display_name: string; tier: string; verification_level: string;
      auction_id: string; code: string; title: string; branch_code: string; flag_reasons: string[]; created_at: Date;
      paid: bigint; defaults: bigint;
    }>(
      `SELECT r.id, r.account_id, a.display_name, a.tier, a.verification_level, r.auction_id, au.code, au.title, au.branch_code,
              r.flag_reasons, r.created_at,
              (SELECT count(*) FROM settlement.invoice i WHERE i.buyer_account_id = r.account_id AND i.status = 'paid') AS paid,
              (SELECT count(*) FROM settlement.default_case dc JOIN settlement.invoice i ON i.id = dc.invoice_id
                WHERE i.buyer_account_id = r.account_id) AS defaults
         FROM registration.registration r
         JOIN identity.account a ON a.id = r.account_id
         JOIN auction.auction au ON au.id = r.auction_id
        WHERE r.status = 'pending_review'
        ORDER BY r.created_at`,
    );
    const out: PendingRegistration[] = [];
    for (const row of r.rows) {
      const linked = await this.db.query<{ id: string; display_name: string; signals: string[]; seller_in_auction: boolean }>(
        `SELECT o.account_id AS id, a.display_name, array_agg(DISTINCT o.signal_type ORDER BY o.signal_type) AS signals,
                EXISTS (SELECT 1 FROM auction.auction_lot al JOIN catalogue.lot l ON l.id = al.lot_id
                         WHERE al.auction_id = $2 AND l.seller_account_id = o.account_id) AS seller_in_auction
           FROM identity.link_signal mine
           JOIN identity.link_signal o ON o.signal_type = mine.signal_type AND o.signal_hmac = mine.signal_hmac AND o.account_id <> mine.account_id
           JOIN identity.account a ON a.id = o.account_id
          WHERE mine.account_id = $1
          GROUP BY o.account_id, a.display_name
          ORDER BY a.display_name`,
        [row.account_id, row.auction_id],
      );
      out.push({
        registrationId: row.id,
        account: { id: row.account_id, name: row.display_name, tier: row.tier, verification: row.verification_level },
        auction: { id: row.auction_id, code: row.code, title: row.title, branch: row.branch_code },
        reasons: row.flag_reasons,
        waitingSeconds: Math.max(0, Math.round((now.getTime() - row.created_at.getTime()) / 1000)),
        targetMinutes: target,
        linkedAccounts: linked.rows.map((l) => ({ id: l.id, name: l.display_name, sharedSignals: l.signals, isSellerInAuction: l.seller_in_auction })),
        history: { invoicesPaid: Number(row.paid), defaults: Number(row.defaults) },
      });
    }
    return out;
  }

  /** Approve or refuse a registration in the review queue, with a reason. */
  async decideRegistration(staff: StaffMember, registrationId: string, decision: 'approved' | 'rejected', reasonInput: string) {
    requirePermission(staff, 'risk.decide_registration');
    if (!UUID.test(registrationId)) throw new AdminError('invalid', 'That is not a registration reference.');
    if (decision !== 'approved' && decision !== 'rejected') throw new AdminError('invalid', 'Decide "approved" or "rejected".');
    const reason = requireReason(reasonInput);
    try {
      return await this.db.tx(staffActor(staff, reason), (c) => this.registrations.decideReview(c, { registrationId, staffId: staff.id, decision, note: reason }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found/.test(msg)) throw new AdminError('not_found', 'We could not find that registration.');
      if (/already/.test(msg)) throw new AdminError('conflict', 'This registration has already been decided.');
      throw e;
    }
  }

  /** Accounts connected by any shared link signal (device, phone, ID, payment source, payout destination, address, network). */
  async linkClusters(): Promise<LinkCluster[]> {
    const pairs = await this.db.query<{ a: string; b: string; signal_type: string }>(
      `SELECT DISTINCT x.account_id AS a, y.account_id AS b, x.signal_type
         FROM identity.link_signal x
         JOIN identity.link_signal y ON y.signal_type = x.signal_type AND y.signal_hmac = x.signal_hmac AND y.account_id > x.account_id`,
    );
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let p = parent.get(x) ?? x;
      while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
      parent.set(x, p);
      return p;
    };
    const signals = new Map<string, Set<string>>();
    for (const { a, b } of pairs.rows) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }
    const groups = new Map<string, Set<string>>();
    for (const { a, b, signal_type } of pairs.rows) {
      const root = find(a);
      const g = groups.get(root) ?? new Set<string>();
      g.add(a).add(b);
      groups.set(root, g);
      const s = signals.get(root) ?? new Set<string>();
      s.add(signal_type);
      signals.set(root, s);
    }
    const ids = [...new Set(pairs.rows.flatMap((p) => [p.a, p.b]))];
    const info = await this.db.query<{ id: string; display_name: string; tier: string; status: string; is_seller: boolean }>(
      `SELECT a.id, a.display_name, a.tier, a.status,
              EXISTS (SELECT 1 FROM seller.consignment s WHERE s.seller_account_id = a.id) AS is_seller
         FROM identity.account a WHERE a.id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(info.rows.map((r) => [r.id, r]));
    return [...groups.entries()]
      .map(([root, members]) => ({
        accounts: [...members].sort().map((id) => {
          const a = byId.get(id)!;
          return { id, name: a.display_name, tier: a.tier, status: a.status, isSeller: a.is_seller };
        }),
        signalTypes: [...(signals.get(root) ?? [])].sort(),
        size: members.size,
      }))
      .sort((x, y) => y.size - x.size);
  }

  /** Bid anomalies by the thresholds in the rule set in force. */
  async anomalies(now: Date = new Date()): Promise<{ thresholds: Record<string, unknown>; bidUp: BidUpAnomaly[]; sharedSignals: SharedSignalAnomaly[] }> {
    const bidUpRule = await this.rule('risk.bid_up_pattern');
    const sharedRule = await this.rule('risk.shared_signal_pattern');
    const bidUp: BidUpAnomaly[] = [];
    const sharedSignals: SharedSignalAnomaly[] = [];
    if (bidUpRule) {
      const since = new Date(now.getTime() - bidUpRule.windowDays * 86_400_000);
      const r = await this.db.query<{ bidder: string; bidder_name: string; seller: string; seller_name: string; lots: bigint; wins: bigint; linked: boolean }>(
        `WITH b AS (
           SELECT DISTINCT bd.account_id, l.seller_account_id, al.id AS auction_lot_id, al.winner_account_id
             FROM bidding.bid bd
             JOIN auction.auction_lot al ON al.id = bd.auction_lot_id
             JOIN catalogue.lot l ON l.id = al.lot_id
            WHERE bd.outcome_at_placement <> 'rejected' AND bd.server_received_at >= $1
              AND al.result <> 'pending' AND bd.account_id <> l.seller_account_id)
         SELECT b.account_id AS bidder, ba.display_name AS bidder_name, b.seller_account_id AS seller, sa.display_name AS seller_name,
                count(*) AS lots, count(*) FILTER (WHERE b.winner_account_id = b.account_id) AS wins,
                EXISTS (SELECT 1 FROM identity.link_signal x JOIN identity.link_signal y
                          ON y.signal_type = x.signal_type AND y.signal_hmac = x.signal_hmac
                         WHERE x.account_id = b.account_id AND y.account_id = b.seller_account_id) AS linked
           FROM b JOIN identity.account ba ON ba.id = b.account_id JOIN identity.account sa ON sa.id = b.seller_account_id
          GROUP BY b.account_id, ba.display_name, b.seller_account_id, sa.display_name
         HAVING count(*) >= $2 AND count(*) FILTER (WHERE b.winner_account_id = b.account_id) <= $3
          ORDER BY count(*) DESC`,
        [since, bidUpRule.minLots, bidUpRule.maxWins],
      );
      for (const x of r.rows) {
        bidUp.push({ kind: 'bid_up_pattern', bidder: { id: x.bidder, name: x.bidder_name }, seller: { id: x.seller, name: x.seller_name }, lotsBid: Number(x.lots), lotsWon: Number(x.wins), linkedToSeller: x.linked });
      }
    }
    if (sharedRule) {
      const since = new Date(now.getTime() - sharedRule.windowDays * 86_400_000);
      const r = await this.db.query<{ signal_type: string; signal: string; ids: string[]; names: string[] }>(
        `WITH bidders AS (SELECT DISTINCT account_id FROM bidding.bid WHERE server_received_at >= $1),
         by_signal AS (
           SELECT ls.signal_type, encode(ls.signal_hmac, 'hex') AS signal, ls.account_id
             FROM identity.link_signal ls JOIN bidders USING (account_id)
            WHERE ls.signal_type = ANY($3::text[])
           UNION
           SELECT 'bid_network', host(network(set_masklen(n.ip, CASE family(n.ip) WHEN 4 THEN $4::int ELSE $5::int END)))
                  || '/' || CASE family(n.ip) WHEN 4 THEN $4::int ELSE $5::int END, b.account_id
             FROM bidding.bid_network n JOIN bidding.bid b ON b.id = n.bid_id
            WHERE b.server_received_at >= $1 AND n.ip IS NOT NULL)
         SELECT s.signal_type, s.signal, array_agg(a.id ORDER BY a.display_name) AS ids, array_agg(a.display_name ORDER BY a.display_name) AS names
           FROM by_signal s JOIN identity.account a ON a.id = s.account_id
          GROUP BY s.signal_type, s.signal
         HAVING count(DISTINCT s.account_id) >= $2
          ORDER BY count(DISTINCT s.account_id) DESC`,
        [since, sharedRule.minAccounts, sharedRule.signalTypes, sharedRule.ipv4PrefixLength, sharedRule.ipv6PrefixLength],
      );
      for (const x of r.rows) {
        sharedSignals.push({
          kind: 'shared_signal', signalType: x.signal_type,
          // Keyed hashes are shown shortened: enough to tell groups apart, never the underlying value.
          signal: x.signal_type === 'bid_network' ? x.signal : x.signal.slice(0, 12),
          accounts: x.ids.map((id, i) => ({ id, name: x.names[i]! })),
        });
      }
    }
    return { thresholds: { bidUp: bidUpRule, sharedSignals: sharedRule }, bidUp, sharedSignals };
  }

  async restrictedAccounts(): Promise<RestrictedAccount[]> {
    const r = await this.db.query<{ id: string; display_name: string; tier: string; status: string; restricted_until: Date | null; since: Date | null; reason: string | null }>(
      `SELECT a.id, a.display_name, a.tier, a.status, a.restricted_until, e.occurred_at AS since, e.reason
         FROM identity.account a
         LEFT JOIN LATERAL (SELECT occurred_at, reason FROM audit.event
                             WHERE entity_type = 'identity.account' AND entity_id = a.id::text
                               AND ((action = 'tier_change' AND to_state = 'restricted') OR (action = 'status_change' AND to_state = 'suspended'))
                             ORDER BY id DESC LIMIT 1) e ON true
        WHERE a.tier = 'restricted' OR a.status = 'suspended'
        ORDER BY e.occurred_at DESC NULLS LAST`,
    );
    return r.rows.map((x) => ({ id: x.id, name: x.display_name, tier: x.tier, status: x.status, restrictedUntil: x.restricted_until, since: x.since, reason: x.reason }));
  }
}

async function accountRow(c: import('@abc/db').Client, id: string) {
  if (!UUID.test(id)) throw new AdminError('invalid', 'Name the account by its reference.');
  const r = await c.query<{ id: string; display_name: string; tier: string; verification_level: string; status: string }>(
    'SELECT id, display_name, tier, verification_level, status FROM identity.account WHERE id = $1',
    [id],
  );
  if (!r.rows[0]) throw new AdminError('not_found', 'We could not find that account.');
  return r.rows[0];
}

/** A staff limit override (registration.limit_override, which the database ties to an approved request). */
export const limitChangeHandler: OverrideHandler = {
  kind: 'limit_change',
  requestPermission: 'override.limit_change.request',
  approvePermission: 'override.limit_change.approve',
  async prepare(c, _staff, input) {
    const account = await accountRow(c, String(input.accountId ?? ''));
    const currency = input.currency;
    if (!isCurrency(currency)) throw new AdminError('invalid', 'Choose USD or ZWG.');
    const limit = typeof input.limitMinor === 'string' && /^\d{1,15}$/.test(input.limitMinor) ? BigInt(input.limitMinor) : null;
    if (limit === null) throw new AdminError('invalid', 'Give the limit in whole minor units, as a string of digits.');
    const until = new Date(String(input.validUntil ?? ''));
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) throw new AdminError('invalid', 'Give a future date until which the limit applies.');
    return {
      actionType: 'limit_change', entityType: 'identity.account', entityId: account.id, currency: currency as Currency, amountMinor: limit,
      payload: { accountId: account.id, currency, limitMinor: limit.toString(), validUntil: until.toISOString() },
      alwaysTwoPerson: false, dedupeKey: `limit:${currency}`,
      summary: `Set ${account.display_name}'s ${currency} limit to ${limit.toString()} minor units until ${until.toISOString().slice(0, 10)}`,
    };
  },
  async execute(c, request) {
    const p = request.payload as unknown as { accountId: string; currency: Currency; limitMinor: string; validUntil: string };
    const r = await c.query<{ id: string }>(
      `INSERT INTO registration.limit_override (account_id, currency, limit_minor, valid_until, override_request_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [p.accountId, p.currency, big(BigInt(p.limitMinor)), p.validUntil, request.id],
    );
    return { limitOverrideId: r.rows[0]!.id };
  },
};

/**
 * Restricting an account, or lifting a restriction. Tier changes carry no money amount
 * but always need a second person (A58). Trusted is reached only by the nightly job.
 */
export function tierChangeHandler(rulebook: RulebookStore): OverrideHandler {
  return {
    kind: 'tier_change',
    requestPermission: 'override.tier_change.request',
    approvePermission: 'override.tier_change.approve',
    async prepare(c, _staff, input) {
      const account = await accountRow(c, String(input.accountId ?? ''));
      const toTier = input.toTier;
      if (toTier !== 'restricted' && toTier !== 'verified') throw new AdminError('invalid', 'Staff can restrict an account or lift a restriction (back to verified).');
      if (account.tier === toTier) throw new AdminError('conflict', `The account is already ${toTier}.`);
      if (toTier === 'verified' && account.verification_level === 'none') throw new AdminError('conflict', 'The account has not verified its email and phone yet.');
      if (toTier === 'verified' && account.tier !== 'restricted') throw new AdminError('conflict', 'Only a restricted account can be lifted back to verified.');
      return {
        actionType: 'tier_change', entityType: 'identity.account', entityId: account.id, currency: null, amountMinor: null,
        payload: { accountId: account.id, fromTier: account.tier, toTier }, alwaysTwoPerson: true, dedupeKey: `tier:${toTier}`,
        summary: toTier === 'restricted' ? `Restrict ${account.display_name}` : `Lift the restriction on ${account.display_name}`,
      };
    },
    async execute(c, request) {
      const p = request.payload as unknown as { accountId: string; toTier: 'restricted' | 'verified' };
      let until: Date | null = null;
      if (p.toTier === 'restricted') {
        const snapshot = await rulebook.snapshot(await rulebook.activeVersionId(new Date(), c), c);
        const months = snapshot.get('tier.restricted_review_after_months');
        until = new Date();
        until.setMonth(until.getMonth() + months);
      }
      await c.query(`UPDATE identity.account SET tier = $2, restricted_until = $3 WHERE id = $1`, [p.accountId, p.toTier, until]);
      return { accountId: p.accountId, tier: p.toTier, restrictedUntil: until };
    },
  };
}
