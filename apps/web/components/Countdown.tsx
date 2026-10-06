'use client';

import { Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { timeLeft } from '@/lib/format';

/** Time left to the lot's current end (which soft close may have extended). */
export function Countdown({ endsAt, icon = true }: { endsAt: string; icon?: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const t = timeLeft(endsAt, now ?? new Date(endsAt).getTime() - 1);
  return (
    <span className={`timer${t.urgent ? ' urgent' : ''}`} suppressHydrationWarning>
      {icon && <Clock size={13} />}
      {now === null ? '…' : t.text}
    </span>
  );
}
