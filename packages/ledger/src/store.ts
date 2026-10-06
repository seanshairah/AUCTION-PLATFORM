import type { Currency } from '@abc/domain';
import { big, run, type Client, type Queryable } from '@abc/db';
import { CHART, placeHold, releaseHold, forfeitHold, type AccountRef, type JournalSpec } from './recipes';

/**
 * The ledger module's only write path (docs/08-wallet-ledger.md §2). Book accounts
 * are created on first use from the chart of accounts. Every journal goes through
 * ledger.post_journal(), which is idempotent on the journal key; the database
 * rejects unbalanced, mixed-currency or overdrawing journals.
 */

function ownerColumns(ref: AccountRef): { type: string; id: string | null } {
  const o = ref.owner;
  return { type: o.type, id: o.type === 'platform' ? null : o.id };
}

export async function bookAccountId(c: Client, ref: AccountRef, currency: Currency): Promise<string> {
  const { type, id } = ownerColumns(ref);
  const chart = CHART[ref.purpose];
  const sub = ref.sub ?? '';
  await c.query(
    `INSERT INTO ledger.book_account (owner_type, owner_id, purpose, sub_code, currency, normal_side, allow_negative)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (owner_type, owner_id, purpose, sub_code, currency) DO NOTHING`,
    [type, id, ref.purpose, sub, currency, chart.normalSide, chart.allowNegative],
  );
  const r = await c.query<{ id: string }>(
    `SELECT id FROM ledger.book_account
      WHERE owner_type = $1 AND owner_id IS NOT DISTINCT FROM $2 AND purpose = $3 AND sub_code = $4 AND currency = $5`,
    [type, id, ref.purpose, sub, currency],
  );
  return r.rows[0]!.id;
}

/** Posts a journal. A repeat with the same idempotency key returns the original id and posts nothing. */
export async function postJournal(c: Client, spec: JournalSpec): Promise<string> {
  const lines = [];
  for (const l of spec.lines) {
    lines.push({ account: await bookAccountId(c, l.account, spec.currency), amount: big(l.amountMinor) });
  }
  const r = await c.query<{ id: string }>(
    'SELECT ledger.post_journal($1, $2, $3, $4, $5::jsonb, $6, $7, $8) AS id',
    [spec.kind, spec.currency, spec.idempotencyKey, spec.description, JSON.stringify(lines), spec.referenceType ?? null, spec.referenceId ?? null, spec.reversesJournalId ?? null],
  );
  return r.rows[0]!.id;
}

export interface Wallet {
  currency: Currency;
  availableMinor: bigint;
  heldMinor: bigint;
}

export async function wallet(q: Queryable, accountId: string, currency: Currency): Promise<Wallet> {
  const r = await run<{ available_minor: bigint; held_minor: bigint }>(
    q,
    'SELECT available_minor, held_minor FROM ledger.v_wallet WHERE account_id = $1 AND currency = $2',
    [accountId, currency],
  );
  return { currency, availableMinor: r.rows[0]?.available_minor ?? 0n, heldMinor: r.rows[0]?.held_minor ?? 0n };
}

export async function balance(q: Queryable, ref: AccountRef, currency: Currency): Promise<bigint> {
  const { type, id } = ownerColumns(ref);
  const r = await run<{ balance_minor: bigint }>(
    q,
    `SELECT balance_minor FROM ledger.book_account
      WHERE owner_type = $1 AND owner_id IS NOT DISTINCT FROM $2 AND purpose = $3 AND sub_code = $4 AND currency = $5`,
    [type, id, ref.purpose, ref.sub ?? '', currency],
  );
  return r.rows[0]?.balance_minor ?? 0n;
}

// --- Holds ---------------------------------------------------------------------

export interface Hold {
  id: string;
  accountId: string;
  currency: Currency;
  amountMinor: bigint;
  status: 'active' | 'released' | 'forfeited';
  referenceType: string | null;
  referenceId: string | null;
}

/** Moves money from available to held and records why. Fails if the wallet cannot cover it. */
export async function createHold(
  c: Client,
  p: { accountId: string; currency: Currency; amountMinor: bigint; referenceType: string; referenceId: string },
): Promise<Hold> {
  const holdId = (await c.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
  const journalId = await postJournal(c, placeHold({ holdId, accountId: p.accountId, currency: p.currency, amountMinor: p.amountMinor }));
  await c.query(
    `INSERT INTO ledger.hold (id, account_id, currency, amount_minor, purpose, reference_type, reference_id, placed_journal_id)
     VALUES ($1, $2, $3, $4, 'auction_deposit', $5, $6, $7)`,
    [holdId, p.accountId, p.currency, big(p.amountMinor), p.referenceType, p.referenceId, journalId],
  );
  return { id: holdId, accountId: p.accountId, currency: p.currency, amountMinor: p.amountMinor, status: 'active', referenceType: p.referenceType, referenceId: p.referenceId };
}

async function lockActiveHold(c: Client, holdId: string): Promise<Hold | null> {
  const r = await c.query<{ id: string; account_id: string; currency: Currency; amount_minor: bigint; status: Hold['status']; reference_type: string | null; reference_id: string | null }>(
    'SELECT id, account_id, currency, amount_minor, status, reference_type, reference_id FROM ledger.hold WHERE id = $1 FOR UPDATE',
    [holdId],
  );
  const h = r.rows[0];
  if (!h || h.status !== 'active') return null;
  return { id: h.id, accountId: h.account_id, currency: h.currency, amountMinor: h.amount_minor, status: h.status, referenceType: h.reference_type, referenceId: h.reference_id };
}

/** Returns a held deposit to the available balance. Safe to call twice. */
export async function releaseHoldById(c: Client, holdId: string): Promise<boolean> {
  const h = await lockActiveHold(c, holdId);
  if (!h) return false;
  const journalId = await postJournal(c, releaseHold({ holdId, accountId: h.accountId, currency: h.currency, amountMinor: h.amountMinor }));
  await c.query(`UPDATE ledger.hold SET status = 'released', closed_journal_id = $2, closed_at = now() WHERE id = $1`, [holdId, journalId]);
  return true;
}

/** Forfeits a held deposit (default ladder step 2). Safe to call twice. */
export async function forfeitHoldById(c: Client, holdId: string, seller?: { sellerId: string; shareMinor: bigint }): Promise<string | null> {
  const h = await lockActiveHold(c, holdId);
  if (!h) return null;
  const journalId = await postJournal(
    c,
    forfeitHold({
      holdId,
      accountId: h.accountId,
      currency: h.currency,
      amountMinor: h.amountMinor,
      ...(seller && seller.shareMinor > 0n ? { sellerId: seller.sellerId, sellerShareMinor: seller.shareMinor } : {}),
    }),
  );
  await c.query(`UPDATE ledger.hold SET status = 'forfeited', closed_journal_id = $2, closed_at = now() WHERE id = $1`, [holdId, journalId]);
  return journalId;
}

export async function activeHolds(q: Queryable, accountId: string, currency: Currency): Promise<Hold[]> {
  const r = await run<{ id: string; amount_minor: bigint; reference_type: string | null; reference_id: string | null }>(
    q,
    `SELECT id, amount_minor, reference_type, reference_id FROM ledger.hold
      WHERE account_id = $1 AND currency = $2 AND status = 'active' ORDER BY created_at`,
    [accountId, currency],
  );
  return r.rows.map((h) => ({ id: h.id, accountId, currency, amountMinor: h.amount_minor, status: 'active', referenceType: h.reference_type, referenceId: h.reference_id }));
}

/**
 * Daily reconciliation checks (docs/08 §6): active holds equal held balances, and
 * customer money is covered by trust bank + gateway clearing + branch cash.
 * Returns the problems found, empty when the books are sound.
 */
export async function reconcileLedger(q: Queryable): Promise<string[]> {
  const problems: string[] = [];
  const holds = await run<{ account_id: string; currency: Currency; held: bigint; holds: bigint }>(
    q,
    `SELECT w.account_id, w.currency, w.held_minor AS held, coalesce(h.total, 0)::bigint AS holds
       FROM ledger.v_wallet w
       LEFT JOIN (SELECT account_id, currency, sum(amount_minor) AS total FROM ledger.hold WHERE status = 'active' GROUP BY 1, 2) h
         ON h.account_id = w.account_id AND h.currency = w.currency
      WHERE w.held_minor <> coalesce(h.total, 0)`,
  );
  for (const r of holds.rows) problems.push(`holds_mismatch: ${r.account_id} ${r.currency} held ${r.held} vs active holds ${r.holds}`);

  // Customer money = wallets + seller proceeds that buyers have actually paid. A seller
  // payable created by a still-unpaid invoice is not yet funded, so unpaid hammer
  // amounts are subtracted (read from settlement, as a finance report may).
  const safeguard = await run<{ currency: Currency; owed: bigint; covered: bigint }>(
    q,
    `WITH unpaid AS (
       SELECT i.currency, sum(l.amount_minor) AS hammer
         FROM settlement.invoice_line l JOIN settlement.invoice i ON i.id = l.invoice_id
        WHERE l.line_type = 'hammer' AND i.status IN ('issued', 'overdue', 'defaulted')
        GROUP BY i.currency)
     SELECT b.currency,
            (coalesce(sum(b.balance_minor) FILTER (WHERE b.purpose IN ('wallet_available', 'wallet_held', 'seller_payable')), 0)
              - coalesce(max(u.hammer), 0))::bigint AS owed,
            coalesce(sum(b.balance_minor) FILTER (WHERE b.purpose IN ('trust_bank', 'gateway_clearing', 'branch_cash')), 0)::bigint AS covered
       FROM ledger.book_account b LEFT JOIN unpaid u ON u.currency = b.currency
      GROUP BY b.currency`,
  );
  for (const r of safeguard.rows) {
    if (r.owed > r.covered) problems.push(`safeguarding: ${r.currency} customer funds ${r.owed} exceed cash and clearing ${r.covered}`);
  }
  return problems;
}

/**
 * Posts the exact mirror of a journal already in the ledger, pointing at it
 * (kind 'reversal'). Idempotent: a journal is reversed at most once, and a repeat
 * returns the first reversal.
 */
export async function reverseJournalById(c: Client, journalId: string, reason: string): Promise<string> {
  const existing = await c.query<{ id: string }>('SELECT id FROM ledger.journal WHERE reverses_journal_id = $1', [journalId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const j = await c.query<{ currency: Currency; reference_type: string | null; reference_id: string | null; kind: string }>(
    'SELECT currency, reference_type, reference_id, kind FROM ledger.journal WHERE id = $1',
    [journalId],
  );
  const original = j.rows[0];
  if (!original) throw new Error(`Journal ${journalId} not found`);
  if (original.kind === 'reversal') throw new Error(`Journal ${journalId} is itself a reversal`);
  const postings = await c.query<{ book_account_id: string; amount_minor: bigint }>(
    'SELECT book_account_id, amount_minor FROM ledger.posting WHERE journal_id = $1 ORDER BY id',
    [journalId],
  );
  const lines = postings.rows.map((p) => ({ account: p.book_account_id, amount: big(-p.amount_minor) }));
  const r = await c.query<{ id: string }>(
    'SELECT ledger.post_journal($1, $2, $3, $4, $5::jsonb, $6, $7, $8) AS id',
    ['reversal', original.currency, `reversal:${journalId}`, `Reversal: ${reason}`, JSON.stringify(lines), original.reference_type, original.reference_id, journalId],
  );
  return r.rows[0]!.id;
}
