import { formatMinor, parseAmountInput } from '@abc/domain';
import { checkBidAmount, ladderFor, type LotPriceState } from '@abc/rules';
import { QuoteError, quoteLot, type Quote, type QuoteInput } from './quote';

/**
 * What the commit screen shows as the bidder types (blueprint module 6: "the bid
 * field shows the total as the amount is typed"). The same function runs on the
 * device for instant feedback and on the server before a bid is accepted; the
 * server's answer is the one that counts. Full screen spec: deliverable 7.
 */

export interface CommitPreviewInput extends Omit<QuoteInput, 'hammerMinor'> {
  typed: string;
  lotState: LotPriceState;
  /** From the registration and limits service (limit − exposure), when known. */
  availableToBidMinor?: bigint;
}

export type CommitPreview =
  | { status: 'empty'; message: string }
  | { status: 'invalid'; message: string }
  | { status: 'below_minimum'; minimumMinor: bigint; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'over_limit'; amountMinor: bigint; quote: Quote; availableToBidMinor: bigint; message: string }
  | { status: 'ok'; amountMinor: bigint; quote: Quote; message: string };

const INVALID_MESSAGE: Record<string, string> = {
  not_a_number: 'Enter an amount in numbers, for example 250 or 250.50.',
  too_many_decimals: 'Use at most two decimal places.',
  negative: 'A bid cannot be negative.',
};

export function commitPreview(input: CommitPreviewInput): CommitPreview {
  const { lot, snapshot } = input;
  const c = lot.currency;

  const parsed = parseAmountInput(input.typed);
  if (!parsed.ok) {
    return parsed.reason === 'empty'
      ? { status: 'empty', message: 'Enter your maximum bid.' }
      : { status: 'invalid', message: INVALID_MESSAGE[parsed.reason]! };
  }
  const amountMinor = parsed.minor;

  let check;
  try {
    check = checkBidAmount(amountMinor, input.lotState, ladderFor(snapshot, c, { categoryPath: lot.categoryPath }));
  } catch {
    return { status: 'unavailable', message: 'Bidding in this currency is not open yet.' };
  }
  if (!check.ok) {
    return {
      status: 'below_minimum',
      minimumMinor: check.minimumMinor,
      message: `The lowest bid you can place is ${formatMinor(check.minimumMinor, c)}.`,
    };
  }

  let quote: Quote;
  try {
    quote = quoteLot({ ...input, hammerMinor: amountMinor });
  } catch (e) {
    if (e instanceof QuoteError) {
      return {
        status: 'unavailable',
        message:
          e.code === 'DELIVERY_UNAVAILABLE'
            ? 'Delivery is not available for this lot and address. Choose collection instead.'
            : 'We cannot show the full price for this lot right now, so bidding is paused.',
      };
    }
    throw e;
  }

  const total = formatMinor(quote.totalMinor, c);
  if (input.availableToBidMinor !== undefined && quote.totalMinor > input.availableToBidMinor) {
    return {
      status: 'over_limit',
      amountMinor,
      quote,
      availableToBidMinor: input.availableToBidMinor,
      message:
        `At ${formatMinor(amountMinor, c)} you would pay ${total} in total. ` +
        `You can bid up to ${formatMinor(input.availableToBidMinor, c)} in total. Add a deposit to bid higher.`,
    };
  }

  return {
    status: 'ok',
    amountMinor,
    quote,
    message: `If you win at ${formatMinor(amountMinor, c)}, you pay ${total} in total. You may win for less.`,
  };
}
