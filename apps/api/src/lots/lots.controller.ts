import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BidDesk } from '../bidding/bid-desk';
import { parseMinor } from '../http';
import { CurrentAccount, OptionalAccount, type SessionAccount } from '../session';
import { BID_DESK, CATALOGUE } from '../tokens';
import { CatalogueReader } from './catalogue-reader';
import { filtersFrom, ListQuery } from './filters';


const PreviewBody = z.object({ typed: z.string().max(30) });

const BidBody = z.object({
  maxMinor: z.string(),
  quotedTotalMinor: z.string(),
  quotedRuleVersionId: z.string().uuid(),
  clientRequestId: z.string().min(8).max(100).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new BadRequestException({ code: 'invalid_request', message: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  return r.data;
}

@Controller('lots')
export class LotsController {
  constructor(
    @Inject(CATALOGUE) private readonly catalogue: CatalogueReader,
    @Inject(BID_DESK) private readonly desk: BidDesk,
  ) {}

  @Get()
  async list(@Query() query: unknown, @OptionalAccount() account: SessionAccount | null) {
    return this.catalogue.liveLots(filtersFrom(parse(ListQuery, query)), account?.id ?? null);
  }

  @Get('facets')
  facets() {
    return this.catalogue.facets();
  }

  @Get(':ref/live')
  async live(@Param('ref') ref: string, @OptionalAccount() account: SessionAccount | null) {
    const l = await this.catalogue.live(ref, account?.id ?? null);
    if (!l) throw new NotFoundException({ code: 'lot_not_found', message: 'We could not find that lot.' });
    return l;
  }

  @Get(':ref')
  async detail(@Param('ref') ref: string, @OptionalAccount() account: SessionAccount | null) {
    const lot = await this.catalogue.lotDetail(ref, account?.id ?? null);
    if (!lot) throw new NotFoundException({ code: 'lot_not_found', message: 'We could not find that lot.' });
    return lot;
  }

  /** The commit screen: the full price for a typed maximum, from the same function as the invoice. */
  @Post(':ref/preview')
  async preview(@Param('ref') ref: string, @Body() body: unknown, @OptionalAccount() account: SessionAccount | null) {
    const { typed } = parse(PreviewBody, body);
    const p = await this.desk.preview(ref, typed, account?.id ?? null);
    if (!p) throw new NotFoundException({ code: 'lot_not_found', message: 'We could not find that lot.' });
    return p;
  }

  @Post(':ref/bids')
  async bid(@Param('ref') ref: string, @Body() body: unknown, @CurrentAccount() account: SessionAccount) {
    const b = parse(BidBody, body);
    const maxMinor = parseMinor(b.maxMinor);
    const quotedTotalMinor = parseMinor(b.quotedTotalMinor);
    if (maxMinor === null || quotedTotalMinor === null) throw new BadRequestException({ code: 'invalid_amount', message: 'Amounts must be whole minor units.' });
    const me = await this.desk.me(account.id);
    if (!me) throw new NotFoundException({ code: 'account_not_found', message: 'Account not found.' });
    const out = await this.desk.placeBid({ id: account.id, name: me.name }, ref, {
      maxMinor,
      quotedTotalMinor,
      quotedRuleVersionId: b.quotedRuleVersionId,
      clientRequestId: b.clientRequestId ?? randomUUID(),
    });
    if (!out) throw new NotFoundException({ code: 'lot_not_found', message: 'We could not find that lot.' });
    return out;
  }
}

@Controller('auctions')
export class AuctionsController {
  constructor(@Inject(CATALOGUE) private readonly catalogue: CatalogueReader) {}

  @Get()
  list() {
    return this.catalogue.auctions();
  }
}
