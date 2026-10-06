import { randomUUID } from 'node:crypto';
import type { Currency } from '@abc/domain';
import { SYSTEM, type Db } from './db';

/**
 * TEST FIXTURES ONLY: accounts, consignments, lots and auctions created directly,
 * for integration tests of the money path. Production intake goes through the
 * seller portal and admin console (deliverables 13 and 18).
 */

let phone = 263_771_000_000;

export async function createAccount(
  db: Db,
  p: { name?: string; tier?: 'guest' | 'verified' | 'trusted' | 'restricted'; verification?: 'none' | 'partial' | 'full' } = {},
): Promise<string> {
  const id = randomUUID();
  const verification = p.verification ?? 'partial';
  await db.tx(SYSTEM, (c) =>
    c.query(
      `INSERT INTO identity.account (id, email, phone_e164, email_verified_at, phone_verified_at, display_name,
                                     verification_level, tier, national_id_hmac, national_id_enc)
       VALUES ($1, $2, $3, now(), now(), $4, $5, $6, $7, $8)`,
      [
        id,
        `${id}@example.test`,
        `+${++phone}`,
        p.name ?? 'Test account',
        verification,
        p.tier ?? (verification === 'none' ? 'guest' : 'verified'),
        verification === 'full' ? Buffer.from(id) : null,
        verification === 'full' ? Buffer.from(`enc-${id}`) : null,
      ],
    ),
  );
  return id;
}

export interface LotFixture {
  lotId: string;
  auctionLotId: string;
}

export interface AuctionFixture {
  auctionId: string;
  lots: LotFixture[];
}

/**
 * An auction in 'scheduled' state with lots in 'listed' state, ready to open.
 * Each lot: { sellerId, category, currency, startingBidMinor, reserveMinor?, endsAt }.
 */
export async function createAuction(
  db: Db,
  p: {
    createdBy: string;
    depositRequired?: boolean;
    softCloseSeconds?: number;
    lots: Array<{ sellerId: string; category?: string; currency?: Currency; startingBidMinor: bigint; reserveMinor?: bigint; endsAt: Date; title?: string }>;
  },
): Promise<AuctionFixture> {
  const auctionId = randomUUID();
  const code = `TEST-${auctionId.slice(0, 8)}`;
  return db.tx(SYSTEM, async (c) => {
    const firstClose = p.lots.reduce((m, l) => (l.endsAt < m ? l.endsAt : m), p.lots[0]!.endsAt);
    await c.query(
      `INSERT INTO auction.auction (id, code, title, format, branch_code, status, opens_at, first_close_at, soft_close_seconds, deposit_required, created_by)
       VALUES ($1, $2, 'Test auction', 'timed_online', 'HRE', 'scheduled', now() - interval '1 hour', $3, $4, $5, $6)`,
      [auctionId, code, firstClose, p.softCloseSeconds ?? null, p.depositRequired ?? false, p.createdBy],
    );
    const lots: LotFixture[] = [];
    let n = 0;
    for (const l of p.lots) {
      n++;
      const lotId = randomUUID();
      const auctionLotId = randomUUID();
      const category = l.category ?? 'it';
      const cat = await c.query<{ is_vehicle: boolean; tax_class: string }>('SELECT is_vehicle, tax_class FROM catalogue.category WHERE code = $1', [category]);
      const consignment = randomUUID();
      await c.query(
        `INSERT INTO seller.consignment (id, seller_account_id, consignment_type, intake_channel) VALUES ($1, $2, 'commission', 'branch')`,
        [consignment, l.sellerId],
      );
      const currency = l.currency ?? 'USD';
      await c.query(
        `INSERT INTO catalogue.lot (id, lot_ref, consignment_id, seller_account_id, category_code, is_vehicle, title, description,
                                    item_state, condition, location_branch, settlement_currency, tax_class, starting_bid_minor, reserve_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Test lot description long enough to be useful.', 'used', 'working', 'HRE', $8, $9, $10, $11)`,
        [lotId, `${code}-${n}`, consignment, l.sellerId, category, cat.rows[0]!.is_vehicle, l.title ?? `Lot ${n}`, currency, cat.rows[0]!.tax_class,
         l.startingBidMinor.toString(), l.reserveMinor?.toString() ?? null],
      );
      await c.query(`UPDATE catalogue.lot SET state = 'listed' WHERE id = $1`, [lotId]);
      await c.query(
        `INSERT INTO auction.auction_lot (id, auction_id, lot_id, currency, lot_number, starting_bid_minor, reserve_minor, scheduled_end_at, current_end_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [auctionLotId, auctionId, lotId, currency, n, l.startingBidMinor.toString(), l.reserveMinor?.toString() ?? null, l.endsAt],
      );
      await c.query('UPDATE catalogue.lot SET current_auction_lot_id = $2 WHERE id = $1', [lotId, auctionLotId]);
      lots.push({ lotId, auctionLotId });
    }
    return { auctionId, lots };
  });
}
