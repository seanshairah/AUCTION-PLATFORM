'use client';

import { RocketLaunchIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Approve and publish a draft rule set from a date (the second person; R2). */
export function Publish({ versionId, defaultFrom }: { versionId: string; defaultFrom: string }) {
  const router = useRouter();
  const [from, setFrom] = useState(defaultFrom.slice(0, 16));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="act-form">
      <div className="field">
        <label htmlFor="pub-from">In force from (Harare time)</label>
        <input id="pub-from" className="input mono" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <button type="button" className="btn" disabled={busy} onClick={async () => {
        if (!window.confirm('Publish this rule set? Every quote and auction from that date uses it.')) return;
        setBusy(true);
        const res = await fetch(`/api/staff/rule-sets/${versionId}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effectiveFrom: new Date(from).toISOString() }) });
        const json = (await res.json().catch(() => null)) as { message?: string } | null;
        setBusy(false);
        setMsg(res.ok ? { ok: true, text: 'Published.' } : { ok: false, text: json?.message ?? 'Not published.' });
        if (res.ok) router.refresh();
      }}><RocketLaunchIcon /> {busy ? 'Publishing…' : 'Approve and publish'}</button>
      {msg && <span className={msg.ok ? 'act-ok' : 'act-err'}>{msg.text}</span>}
    </div>
  );
}
