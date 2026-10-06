'use client';

import { CalendarDaysIcon, CheckBadgeIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

interface Slot { id: string; startsAt: string; endsAt: string; capacity: number; remaining: number; bookingId: string | null }

const day = (iso: string) => new Date(iso).toLocaleDateString('en-ZW', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Africa/Harare' });
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-ZW', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare' });

/** Bookable viewing slots instead of phone calls; capacity is enforced by the database. */
export function Viewings({ lotRef, signedIn, branch }: { lotRef: string; signedIn: boolean; branch: string }) {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch(`/api/lots/${encodeURIComponent(lotRef)}/viewings`, { cache: 'no-store' });
    setSlots(r.ok ? ((await r.json()) as Slot[]) : []);
  }, [lotRef]);
  useEffect(() => { void load(); }, [load]);

  async function act(s: Slot) {
    setBusy(s.id);
    const url = s.bookingId ? `/api/viewings/bookings/${s.bookingId}/cancel` : `/api/viewings/${s.id}/book`;
    const r = await fetch(url, { method: 'POST' });
    const j = (await r.json().catch(() => ({}))) as { booked?: boolean; cancelled?: boolean; message?: string };
    setMsg({ ok: Boolean(j.booked || j.cancelled), text: j.message ?? 'Something went wrong.' });
    setBusy(null);
    await load();
  }

  if (slots === null) return <p className="muted small">Loading viewing times…</p>;
  if (slots.length === 0) return <p className="muted small">No viewing slots are open for this lot. Message us on WhatsApp to arrange one.</p>;
  const days = [...new Set(slots.map((s) => day(s.startsAt)))];
  return (
    <div className="stack">
      {msg && <div className={`notice ${msg.ok ? 'good' : 'bad'}`}><CheckBadgeIcon /><span>{msg.text}</span></div>}
      {days.map((d) => (
        <div key={d}>
          <div className="micro" style={{ marginBottom: 8 }}><CalendarDaysIcon width={13} style={{ verticalAlign: '-2px' }} /> {d} · {branch}</div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {slots.filter((s) => day(s.startsAt) === d).map((s) => (
              signedIn ? (
                <button key={s.id} type="button" className={`btn sm ${s.bookingId ? 'ink' : 'ghost'}`} disabled={busy !== null || (!s.bookingId && s.remaining === 0)} onClick={() => act(s)} title={s.bookingId ? 'Cancel this booking' : `${s.remaining} of ${s.capacity} places left`}>
                  <span className="mono">{time(s.startsAt)}</span>
                  <span className="badge" style={s.bookingId ? { background: 'rgba(255,255,255,.15)', color: 'inherit' } : undefined}>{s.bookingId ? 'Booked' : `${s.remaining} left`}</span>
                </button>
              ) : (
                <span key={s.id} className="chip"><span className="mono">{time(s.startsAt)}</span> {s.remaining} left</span>
              )
            ))}
          </div>
        </div>
      ))}
      {!signedIn && <p className="small"><Link className="link" href={`/sign-in?next=/lots/${encodeURIComponent(lotRef)}`}>Sign in</Link> to book a viewing.</p>}
    </div>
  );
}
