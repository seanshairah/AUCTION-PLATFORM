'use client';

import { ClockIcon } from '@heroicons/react/20/solid';
import { useEffect, useState } from 'react';
import { timeLeft } from '@/lib/format';

function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Time left to the lot's current end, which soft close may extend. */
export function Countdown({ endsAt, icon = true }: { endsAt: string; icon?: boolean }) {
  const now = useNow();
  const t = timeLeft(endsAt, now ?? 0);
  return (
    <span className={`timer${now !== null && t.urgent ? ' urgent' : ''}`} suppressHydrationWarning>
      {icon && <ClockIcon />}
      {now === null ? '––' : t.text}
    </span>
  );
}

/** The large segmented clock on event pages: days, hours, minutes, seconds. */
export function SegmentClock({ to, label }: { to: string; label: string }) {
  const now = useNow();
  const ms = Math.max(0, new Date(to).getTime() - (now ?? 0));
  const s = Math.floor(ms / 1000);
  const parts = now === null ? ['––', '––', '––', '––'] : [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0'));
  return (
    <div>
      <div className="clock-label">{label}</div>
      <div className="clock" role="timer" aria-live="off">
        {['Days', 'Hours', 'Min', 'Sec'].map((u, i) => (
          <div key={u} className="seg"><b suppressHydrationWarning>{parts[i]}</b><i>{u}</i></div>
        ))}
      </div>
    </div>
  );
}
