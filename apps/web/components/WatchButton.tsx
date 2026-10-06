'use client';

import { HeartIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Save a lot to the watch list (catalogue.watch). Watchers get the ending-soon alert.
 * Signed-out visitors are sent to sign in and brought back to the lot.
 */
export function WatchButton({ lotRef, watching, signedIn, variant = 'fab' }: { lotRef: string; watching: boolean; signedIn: boolean; variant?: 'fab' | 'button' | 'night' }) {
  const router = useRouter();
  const [on, setOn] = useState(watching);
  const [busy, setBusy] = useState(false);
  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!signedIn) { router.push(`/sign-in?next=${encodeURIComponent(`/lots/${lotRef}`)}`); return; }
    const next = !on;
    setOn(next);
    setBusy(true);
    const res = await fetch(`/api/me/watch/${encodeURIComponent(lotRef)}`, { method: next ? 'PUT' : 'DELETE' });
    setBusy(false);
    if (!res.ok) setOn(!next);
    router.refresh();
  }
  const label = on ? 'Remove from watch list' : 'Add to watch list';
  if (variant !== 'fab') {
    return (
      <button type="button" className={variant === 'night' ? 'btn sm outline-night' : 'btn ghost'} aria-pressed={on} disabled={busy} onClick={toggle}>
        <HeartIcon style={{ color: on ? 'var(--accent)' : 'var(--muted)' }} /> {on ? 'Watching' : 'Watch'}
      </button>
    );
  }
  return (
    <button type="button" className={`watch-fab${on ? ' on' : ''}`} aria-pressed={on} aria-label={label} title={label} disabled={busy} onClick={toggle}>
      <HeartIcon />
    </button>
  );
}
