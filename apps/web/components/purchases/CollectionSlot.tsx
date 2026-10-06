'use client';

import { CalendarDaysIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Slot { id: string; startsAt: string; endsAt: string; capacity: number; booked: number; available: number }
const day = (iso: string) => new Date(iso).toLocaleDateString('en-ZW', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Harare' });
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-ZW', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare' });

/** Choose when to collect; capacity holds under simultaneous bookings (docs/15). */
export function CollectionSlot({ collectionId, branch, current }: { collectionId: string; branch: string; current: { startsAt: string } | null }) {
  const router = useRouter();
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [open, setOpen] = useState(!current);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    void fetch(`/api/branches/${branch}/collection-slots`).then(async (r) => setSlots(r.ok ? ((await r.json()) as { slots: Slot[] }).slots : []));
  }, [open, branch]);
  async function book(id: string) {
    const r = await fetch(`/api/collections/${collectionId}/slot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slotId: id, clientKey: crypto.randomUUID() }) });
    const j = (await r.json()) as { booked: boolean; message?: string };
    if (j.booked) { setOpen(false); router.refresh(); } else setMsg(j.message ?? 'Could not book that slot.');
  }
  if (!open) return <button className="btn sm ghost" onClick={() => setOpen(true)}><CalendarDaysIcon /> Change collection time</button>;
  if (slots === null) return <p className="small muted">Loading collection times…</p>;
  if (slots.length === 0) return <p className="small muted">No collection times are open yet. Come during branch hours with your gate pass, or check back shortly.</p>;
  const days = [...new Set(slots.map((s) => day(s.startsAt)))].slice(0, 4);
  return (
    <div className="stack-8">
      {msg && <div className="notice bad">{msg}</div>}
      {days.map((d) => (
        <div key={d} className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="micro" style={{ width: 92 }}>{d}</span>
          {slots.filter((s) => day(s.startsAt) === d).slice(0, 8).map((s) => (
            <button key={s.id} className="btn sm ghost" disabled={s.available === 0} onClick={() => book(s.id)}><span className="mono">{time(s.startsAt)}</span></button>
          ))}
        </div>
      ))}
    </div>
  );
}
