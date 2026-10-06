/**
 * Staggered end times and the outage rule (rulebook: bidding.stagger_seconds,
 * operations.outage_extension).
 */

/** Lot n (0-based, in lot-number order) closes `n × staggerSeconds` after the first. */
export function scheduleEndTimes(firstCloseAt: Date, staggerSeconds: number, lotCount: number): Date[] {
  return Array.from({ length: lotCount }, (_, i) => new Date(firstCloseAt.getTime() + i * staggerSeconds * 1000));
}

/**
 * Rule 'outage_plus_soft_close': a lot that was due to close during an outage is
 * extended by the outage's length plus the soft-close time. Lots ending before or
 * after the outage are unchanged.
 */
export function endAfterOutage(endAt: Date, outageStart: Date, outageEnd: Date, softCloseSeconds: number): Date {
  const t = endAt.getTime();
  if (t < outageStart.getTime() || t > outageEnd.getTime()) return endAt;
  const outageMs = outageEnd.getTime() - outageStart.getTime();
  return new Date(t + outageMs + softCloseSeconds * 1000);
}
