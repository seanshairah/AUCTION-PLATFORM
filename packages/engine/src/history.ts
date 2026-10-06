import type { LoggedBid } from './engine';

/**
 * The public bid history on a lot page. Shows amounts and times, never anyone's
 * maximum, and labels bidders "Bidder 1, 2, …" in order of first bid. The viewer
 * sees their own bids as "You". Rejected attempts are not shown publicly.
 */
export interface PublicBid {
  seq: bigint;
  bidder: string;
  amountMinor: bigint;
  auto: boolean;
  at: Date;
}

export function publicHistory(bids: readonly LoggedBid[], viewerAccountId?: string): PublicBid[] {
  const labels = new Map<string, string>();
  const shown: PublicBid[] = [];
  for (const b of bids) {
    if (b.outcome === 'rejected') continue;
    if (!labels.has(b.accountId)) labels.set(b.accountId, `Bidder ${labels.size + 1}`);
    shown.push({
      seq: b.seq,
      bidder: b.accountId === viewerAccountId ? 'You' : labels.get(b.accountId)!,
      amountMinor: b.amountMinor,
      auto: b.origin === 'proxy',
      at: b.at,
    });
  }
  return shown.reverse(); // newest first
}
