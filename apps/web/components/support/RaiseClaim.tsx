'use client';

import { ShieldExclamationIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

const CATEGORIES = [['not_as_described', 'Not as described'], ['inspection_inaccuracy', 'Inspection report was wrong (vehicles)'], ['missing', 'Something is missing'], ['damaged_in_custody', 'Damaged while ABC held it'], ['other', 'Something else']] as const;

/** A claim within the claim window after release; the seller's payout waits while it is open. */
export function RaiseClaim({ lotId, lotTitle }: { lotId: string; lotTitle: string }) {
  const router = useRouter();
  const [category, setCategory] = useState<string>('not_as_described');
  const [description, setDescription] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function raise() {
    setBusy(true);
    const r = await fetch('/api/disputes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lotId, category, description, evidence: [], clientKey: crypto.randomUUID() }) });
    const j = (await r.json()) as { raised?: boolean; message?: string };
    setBusy(false);
    setMsg({ ok: Boolean(j.raised), text: j.raised ? 'Claim raised. Staff will reply within the response time shown, and the seller is not paid while it is open.' : j.message ?? 'Could not raise the claim.' });
    if (j.raised) router.refresh();
  }
  return (
    <div className="nest">
      <div className="nest-head"><ShieldExclamationIcon /><h3>Report a problem: {lotTitle}</h3></div>
      <div className="nest-body stack">
        <div className="field"><label htmlFor="c-cat">What is wrong</label><select id="c-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="c-desc">Tell us what you found</label><textarea id="c-desc" className="input" style={{ height: 110, padding: 12 }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Be specific: the item, what the listing said, what you found." /></div>
        {msg && <div className={`notice ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
        <div><button className="btn" disabled={busy || description.trim().length < 10} onClick={raise}>{busy ? 'Sending…' : 'Raise claim'}</button></div>
      </div>
    </div>
  );
}
