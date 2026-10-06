'use client';

import { BellAlertIcon, BookmarkIcon, CheckIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Save the docket's current filters, with an alert when new lots match (catalogue.saved_search). */
export function SaveSearch({ query, suggested, signedIn, next }: { query: Record<string, string>; suggested: string; signedIn: boolean; next: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(suggested.slice(0, 60));
  const [alerts, setAlerts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!signedIn) return <Link href={`/sign-in?next=${encodeURIComponent(next)}`} className="btn sm ghost"><BookmarkIcon /> Save this search</Link>;
  if (msg?.ok) return <span className="status good"><CheckIcon /> {msg.text} <Link href="/account/watching" className="link">Manage</Link></span>;
  if (!open) return <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}><BookmarkIcon /> Save this search</button>;
  return (
    <form className="save-search" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      const res = await fetch('/api/me/saved-searches', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), query, alerts }) });
      const json = (await res.json().catch(() => null)) as { message?: string; matches?: number } | null;
      setBusy(false);
      setMsg(res.ok ? { ok: true, text: alerts ? 'Saved. We will tell you when new lots match.' : 'Saved.' } : { ok: false, text: json?.message ?? 'Not saved.' });
      if (res.ok) router.refresh();
    }}>
      <input className="input" style={{ height: 32, width: 240 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Name this search" maxLength={60} autoFocus />
      <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={alerts} onChange={(e) => setAlerts(e.target.checked)} /> <BellAlertIcon width={14} /> Alert me to new lots</label>
      <div className="btn-group">
        <button className="btn sm ink" disabled={busy || name.trim().length < 2}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {msg && !msg.ok && <span className="small" style={{ color: 'var(--bad)' }}>{msg.text}</span>}
    </form>
  );
}
