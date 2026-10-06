'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

/**
 * Keeps an open lot page current: polls the lot's live figures and refreshes the
 * server-rendered page when the price, bid count or end time changes. Polling (not a
 * socket) degrades gracefully on weak connections and pauses in background tabs.
 */
export function LiveRefresher({ lotRef, intervalMs = 5000 }: { lotRef: string; intervalMs?: number }) {
  const router = useRouter();
  const last = useRef<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/lots/${encodeURIComponent(lotRef)}/live`, { cache: 'no-store' });
        if (!res.ok) return;
        const j = (await res.json()) as { currentPrice: { minor: string } | null; bids: number; endsAt: string; closed: boolean };
        const sig = `${j.currentPrice?.minor ?? '-'}|${j.bids}|${j.endsAt}|${j.closed}`;
        if (last.current !== null && last.current !== sig && !stopped) router.refresh();
        last.current = sig;
      } catch {
        // offline: try again next tick
      }
    };
    void tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [lotRef, intervalMs, router]);
  return null;
}
