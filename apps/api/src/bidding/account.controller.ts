import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { parseMinor } from '../http';
import { CurrentAccount, type SessionAccount } from '../session';
import { BID_DESK } from '../tokens';
import { BidDesk } from './bid-desk';

const JoinBody = z.object({ depositMinor: z.string().optional() });

@Controller()
export class AccountController {
  constructor(@Inject(BID_DESK) private readonly desk: BidDesk) {}

  @Get('me')
  async me(@CurrentAccount() account: SessionAccount) {
    const me = await this.desk.me(account.id);
    if (!me) throw new NotFoundException({ code: 'account_not_found', message: 'Account not found.' });
    return me;
  }

  @Get('me/bids')
  bids(@CurrentAccount() account: SessionAccount) {
    return this.desk.myBids(account.id);
  }

  @Get('me/wallet')
  wallet(@CurrentAccount() account: SessionAccount) {
    return this.desk.wallet(account.id);
  }

  /** One-tap registration (deliverable 11), holding the deposit from the wallet. */
  @Post('auctions/:id/join')
  async join(@Param('id') auctionId: string, @Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const parsed = JoinBody.safeParse(body ?? {});
    if (!parsed.success || !/^[0-9a-f-]{36}$/.test(auctionId)) throw new BadRequestException({ code: 'invalid_request', message: 'Invalid request.' });
    const deposit = parsed.data.depositMinor === undefined ? null : parseMinor(parsed.data.depositMinor);
    if (parsed.data.depositMinor !== undefined && deposit === null) throw new BadRequestException({ code: 'invalid_amount', message: 'Deposit must be whole minor units.' });
    const me = await this.desk.me(account.id);
    if (!me) throw new NotFoundException({ code: 'account_not_found', message: 'Account not found.' });
    const r = await this.desk.join({ id: account.id, name: me.name }, auctionId, deposit);
    if (!r) throw new NotFoundException({ code: 'auction_not_found', message: 'We could not find that auction.' });
    return r;
  }
}
