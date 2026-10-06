import { Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import type { Db } from '@abc/db';
import type { VehicleService } from '@abc/vehicles';
import { CurrentAccount, OptionalAccount, type SessionAccount } from '../session';
import { DB, VEHICLES } from '../tokens';

/** Bookable viewings instead of phone calls (deliverable 14 §5). */
@Controller()
export class ViewingsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(VEHICLES) private readonly vehicles: VehicleService,
  ) {}

  @Get('lots/:ref/viewings')
  async slots(@Param('ref') ref: string, @OptionalAccount() account: SessionAccount | null) {
    const lot = await this.db.query<{ id: string; location_branch: string }>('SELECT id, location_branch FROM catalogue.lot WHERE lot_ref = $1', [ref]);
    if (!lot.rows[0]) throw new NotFoundException({ code: 'lot_not_found', message: 'We could not find that lot.' });
    const r = await this.db.query<{ id: string; starts_at: Date; ends_at: Date; capacity: number; booked: bigint; mine: string | null }>(
      `SELECT s.id, s.starts_at, s.ends_at, s.capacity,
              (SELECT count(*) FROM catalogue.viewing_booking b WHERE b.slot_id = s.id AND b.status = 'booked') AS booked,
              (SELECT b.id::text FROM catalogue.viewing_booking b WHERE b.slot_id = s.id AND b.status = 'booked' AND b.account_id = $3) AS mine
         FROM catalogue.viewing_slot s
        WHERE (s.lot_id = $1 OR (s.lot_id IS NULL AND s.branch_code = $2)) AND s.starts_at > now()
        ORDER BY s.starts_at LIMIT 24`,
      [lot.rows[0].id, lot.rows[0].location_branch, account?.id ?? '00000000-0000-0000-0000-000000000000'],
    );
    return r.rows.map((s) => ({ id: s.id, startsAt: s.starts_at.toISOString(), endsAt: s.ends_at.toISOString(), capacity: s.capacity, remaining: Math.max(0, s.capacity - Number(s.booked)), bookingId: s.mine }));
  }

  @Post('viewings/:slotId/book')
  async book(@Param('slotId') slotId: string, @CurrentAccount() account: SessionAccount) {
    if (!/^[0-9a-f-]{36}$/.test(slotId)) throw new NotFoundException();
    const r = await this.vehicles.bookViewing({ type: 'account', id: account.id, name: 'Bidder' }, slotId);
    const message = r.booked ? 'Booked. Bring your ID to the branch.' : { full: 'That slot is full. Choose another.', already_booked: 'You already have this slot.', past: 'That slot has passed.' }[r.reason];
    return { ...r, message };
  }

  @Post('viewings/bookings/:id/cancel')
  async cancel(@Param('id') id: string, @CurrentAccount() account: SessionAccount) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException();
    await this.vehicles.cancelViewing({ type: 'account', id: account.id, name: 'Bidder' }, id);
    return { cancelled: true, message: 'Cancelled. The place is free for someone else.' };
  }
}
